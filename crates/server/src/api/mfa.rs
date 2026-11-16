//! Multi-factor authentication under Account › Security.
//!
//! - `GET auth/totp/devices`: authenticator apps and state of the recovery
//!   codes.
//! - `POST auth/totp/devices/enroll`: new secret (Base32 and `otpauth://`
//!   URI for the QR code), no device yet.
//! - `POST auth/totp/devices/confirm` (`{id, name?, password, code}`):
//!   password and code from the new app; with the first device the recovery
//!   codes are created (once, in the response).
//! - `DELETE auth/totp/devices/:id` (`{password, code}`): code of one of the
//!   apps; with the last device the recovery codes are dropped.
//! - `POST auth/recovery-codes` (`{password, code}`): new set.
//!
//! Responses with devices carry the whole state (`devices`, `recovery`), so
//! the page can render without another request.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{delete, get, post},
};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    ApiError, FieldErrors, JsonBody, auth,
    me::{
        CodeResult, Guard, Reauth, Stale, check_code, check_current_password, is_invisible,
        mfa_enabled,
    },
};
use crate::{
    app::AppState,
    auth::{
        AuthUser, CurrentUser, recovery,
        totp::{self, Confirm},
    },
    client_ip::ClientIp,
    db::{
        self,
        repo::{
            audit_log::{self, Category, Entry},
            recovery_codes, totp_devices,
        },
    },
    events::{self, Outbox, Security},
};

/// Longest name of an app (like the column).
const MAX_NAME: usize = 64;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/totp/devices", get(list))
        .route("/auth/totp/devices/enroll", post(enroll))
        .route("/auth/totp/devices/confirm", post(confirm))
        .route("/auth/totp/devices/{id}", delete(remove))
        .route("/auth/recovery-codes", post(regenerate))
}

/// Devices and recovery codes of the user (without the codes).
fn overview(conn: &Connection, user_id: &str) -> anyhow::Result<Value> {
    let devices: Vec<Value> = totp_devices::list(conn, user_id)?
        .into_iter()
        .map(|d| {
            json!({
                "id": d.id,
                "name": d.name,
                "created_at": d.created_at,
                "last_used_at": d.last_used_at,
            })
        })
        .collect();
    let recovery = recovery_codes::summary(conn, user_id)?
        .map(|s| json!({ "total": s.total, "unused": s.unused, "created_at": s.created_at }));
    Ok(json!({ "devices": devices, "recovery": recovery }))
}

async fn list(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<Value>, ApiError> {
    let overview = db::call(&state.db, move |conn| overview(conn, &user.id)).await?;
    Ok(Json(overview))
}

/// "Add app": create a secret and store it encrypted as pending. An
/// earlier unconfirmed enrollment is dropped.
async fn enroll(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<Value>, ApiError> {
    let id = db::new_id()?;
    let secret = totp::generate_secret()?;
    let sealed = state.secrets.seal(totp::SECRET_PURPOSE, &id, &secret)?;
    let (base32, uri) = totp::enrollment(&secret, &state.brand().app, &user.email)?;
    let (row, user_id) = (id.clone(), user.id.clone());
    db::call(&state.db, move |conn| {
        Ok(totp_devices::insert_pending(conn, &row, &user_id, &sealed)?)
    })
    .await?;
    Ok(Json(json!({ "id": id, "secret": base32, "uri": uri })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfirmBody {
    id: String,
    /// Empty: the default name ("Authenticator app", possibly with a number).
    name: Option<String>,
    password: String,
    code: String,
}

/// Name of the app: trimmed, empty = default. It appears in the security
/// notice to the person (`security_totp_add`): control characters, line
/// separators and invisible characters (direction changes, zero width) could
/// fake lines there or garble the text.
fn check_name(errors: &mut FieldErrors, name: Option<&str>) -> Option<String> {
    let name = name.map(str::trim).filter(|name| !name.is_empty())?;
    if name.chars().count() > MAX_NAME {
        errors.code("name", "too_long");
    } else if name.chars().any(|c| c.is_control() || is_invisible(c)) {
        errors.code("name", "invalid");
    }
    Some(name.to_owned())
}

/// Result of the transaction in [`confirm`].
enum Confirmed {
    Done(Value, Outbox),
    Invalid,
    NotFound,
    /// Session ended or password changed (see `me::Guard`).
    Stale(Stale),
}

/// "Add": password and code from the new app (a code from an existing app
/// is not needed, otherwise nobody who lost their phone could get to a new
/// app).
async fn confirm(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    ip: ClientIp,
    headers: HeaderMap,
    JsonBody(body): JsonBody<ConfirmBody>,
) -> Result<Json<Value>, ApiError> {
    let mut errors = FieldErrors::default();
    let name = check_name(&mut errors, body.name.as_deref());
    check_current_password(&mut errors, "password", &body.password);
    let code = check_code(&mut errors, true, Some(&body.code)).unwrap_or_default();
    if !errors.is_empty() {
        return Err(errors.into_error());
    }

    let reauth = Reauth::password(&state, &user, &body.password).await?;
    let guard = reauth.guard();
    let secrets = state.secrets.clone();
    let device_id = body.id;
    // Device and place of the request for the security notice.
    let origin = auth::origin(&state, &headers, ip);
    // Device, with the first one the recovery codes, event and audit log in
    // one transaction: never multi-factor without codes.
    let outcome = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        // Before the code: an ended session does not use it up.
        if let Err(stale) = guard.check(&tx, &user)? {
            return Ok(Confirmed::Stale(stale));
        }
        let confirmed = totp::confirm(
            &tx,
            &secrets,
            &user.id,
            &device_id,
            name.as_deref(),
            &code,
            totp::now(),
        )?;
        let (name, first) = match confirmed {
            Confirm::Done { name, first } => (name, first),
            Confirm::Invalid => return Ok(Confirmed::Invalid),
            Confirm::NotFound => return Ok(Confirmed::NotFound),
        };
        // The codes exist only now; the page shows them after adding.
        let codes = first
            .then(|| recovery::replace(&tx, &user.id))
            .transpose()?;
        let mut outbox = Outbox::default();
        let event = Security::TotpAdded {
            name: &name,
            first,
            at: (&origin).into(),
        };
        events::security(&tx, &mut outbox, (&user).into(), event)?;
        audit_log::insert(
            &tx,
            &Entry::new(Category::Login, "auth.totp_add")
                .actor(&user)
                .ip(ip.0)
                .target(&device_id)
                .details(json!({ "name": name, "first": first })),
        )?;
        let mut overview = overview(&tx, &user.id)?;
        tx.commit()?;
        overview["recovery_codes"] = json!(codes);
        Ok(Confirmed::Done(overview, outbox))
    })
    .await?;
    match outcome {
        Confirmed::Done(overview, outbox) => {
            outbox.send(&state);
            reauth.finish(CodeResult::Accepted)?;
            Ok(Json(overview))
        }
        Confirmed::Invalid => Err(reauth.reject()),
        // Without a started enrollment no code was checked.
        Confirmed::NotFound => Err(ApiError::NotFound),
        Confirmed::Stale(stale) => Err(stale.into()),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VerifyBody {
    password: String,
    code: String,
}

/// Password and code of one of the user's apps (removal, new codes).
async fn verify(state: &AppState, user: &AuthUser, body: VerifyBody) -> Result<Guard, ApiError> {
    let mut errors = FieldErrors::default();
    check_current_password(&mut errors, "password", &body.password);
    let code = check_code(&mut errors, true, Some(&body.code)).unwrap_or_default();
    if !errors.is_empty() {
        return Err(errors.into_error());
    }
    Reauth::password(state, user, &body.password)
        .await?
        .totp(state, user, code)
        .await
}

/// "Remove": confirmed with password and the code of one of the apps (the
/// one being removed included). With the last app multi-factor is off and
/// the recovery codes are dropped.
async fn remove(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    ip: ClientIp,
    headers: HeaderMap,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<VerifyBody>,
) -> Result<Json<Value>, ApiError> {
    let (user_id, device_id) = (user.id.clone(), id.clone());
    let exists = db::call(&state.db, move |conn| {
        Ok(totp_devices::name(conn, &user_id, &device_id)?.is_some())
    })
    .await?;
    if !exists {
        return Err(ApiError::NotFound);
    }
    let guard = verify(&state, &user, body).await?;
    let origin = auth::origin(&state, &headers, ip);
    let owner = user.id.clone();
    let result = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        if let Err(stale) = guard.check(&tx, &user)? {
            return Ok(Err(stale.into()));
        }
        let Some(name) = totp_devices::name(&tx, &user.id, &id)? else {
            return Ok(Err(ApiError::NotFound));
        };
        totp_devices::delete(&tx, &user.id, &id)?;
        let last = !totp_devices::has_confirmed(&tx, &user.id)?;
        if last {
            recovery_codes::delete_all(&tx, &user.id)?;
        }
        let mut outbox = Outbox::default();
        let event = Security::TotpRemoved {
            name: &name,
            last,
            at: (&origin).into(),
        };
        events::security(&tx, &mut outbox, (&user).into(), event)?;
        audit_log::insert(
            &tx,
            &Entry::new(Category::Login, "auth.totp_remove")
                .actor(&user)
                .ip(ip.0)
                .target(&id)
                .details(json!({ "name": name, "last": last })),
        )?;
        let overview = overview(&tx, &user.id)?;
        tx.commit()?;
        Ok(Ok((overview, outbox, last)))
    })
    .await?;
    let (overview, outbox, last) = result?;
    // Without an app no pending sign-in step applies any more; otherwise one
    // would come back to life as soon as a new app is confirmed within five
    // minutes (like `reset-mfa`).
    if last {
        state.challenges.discard_user(&owner);
    }
    outbox.send(&state);
    Ok(Json(overview))
}

/// "Generate new codes": replaces the set; the codes exist only in this
/// response. Without an authenticator app there are no codes (409
/// `mfa_disabled`) – checked up front and again in the transaction, in case
/// the last app was removed meanwhile. Reports "New recovery codes
/// generated" with a mail: the previous codes no longer work, including those
/// the person kept.
async fn regenerate(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    ip: ClientIp,
    headers: HeaderMap,
    JsonBody(body): JsonBody<VerifyBody>,
) -> Result<Json<Value>, ApiError> {
    if !mfa_enabled(&state, &user).await? {
        return Err(mfa_disabled());
    }
    let guard = verify(&state, &user, body).await?;
    let origin = auth::origin(&state, &headers, ip);
    let result = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        if let Err(stale) = guard.check(&tx, &user)? {
            return Ok(Err(stale.into()));
        }
        if !totp_devices::has_confirmed(&tx, &user.id)? {
            return Ok(Err(mfa_disabled()));
        }
        let codes = recovery::replace(&tx, &user.id)?;
        let mut outbox = Outbox::default();
        let event = Security::RecoveryCodesRenewed {
            at: (&origin).into(),
        };
        events::security(&tx, &mut outbox, (&user).into(), event)?;
        audit_log::insert(
            &tx,
            &Entry::new(Category::Login, "auth.recovery_codes")
                .actor(&user)
                .ip(ip.0)
                .target(&user.id),
        )?;
        let mut overview = overview(&tx, &user.id)?;
        tx.commit()?;
        overview["recovery_codes"] = json!(codes);
        Ok(Ok((overview, outbox)))
    })
    .await?;
    let (overview, outbox) = result?;
    outbox.send(&state);
    Ok(Json(overview))
}

pub(super) fn mfa_disabled() -> ApiError {
    ApiError::rejected(StatusCode::CONFLICT, "mfa_disabled")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_trimmed_and_limited() {
        let mut errors = FieldErrors::default();
        assert_eq!(check_name(&mut errors, None), None);
        assert_eq!(check_name(&mut errors, Some("  ")), None);
        assert_eq!(
            check_name(&mut errors, Some(" Phone ")).as_deref(),
            Some("Phone")
        );
        assert!(errors.is_empty());
        check_name(&mut errors, Some(&"é".repeat(65)));
        check_name(&mut errors, Some("Tab\there"));
        assert_eq!(
            errors.into_value(),
            json!({ "name": { "code": "too_long" } })
        );
        for name in [
            "Tab\there",
            "Phone\u{2028}That was you",
            "Phone\u{202E}nimdA",
            "Pho\u{200B}ne",
        ] {
            let mut errors = FieldErrors::default();
            check_name(&mut errors, Some(name));
            assert_eq!(
                errors.into_value(),
                json!({ "name": { "code": "invalid" } }),
                "{name:?}"
            );
        }
        let mut errors = FieldErrors::default();
        check_name(&mut errors, Some("Max’s iPhone – Café"));
        assert!(errors.is_empty());
    }
}
