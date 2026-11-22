//! Initial setup. As long as no administrator exists, the setup token from
//! the container log authorizes the steps; afterwards all endpoints answer
//! with 409 `setup_done`.
//!
//! - `POST setup/token` (`{token}`): checks the token.
//!
//! With the token in the header `X-Setup-Token`:
//!
//! - `POST setup/totp` (`{email}`): new secret for the authenticator app and
//!   ten recovery codes as the pending enrollment (`setup_totp`), in place of
//!   an earlier one; answers secret and otpauth URI.
//! - `POST setup/totp/verify` (`{code}`): confirms the pending enrollment
//!   with a code from the app and answers the recovery codes (the same ones
//!   on every confirmation of the same enrollment).
//! - `POST setup/complete`: needs a confirmed enrollment for the same
//!   address; creates the administrator with their appearance settings,
//!   authenticator app and recovery codes in one transaction, deletes token
//!   and enrollment and signs the administrator in.
//!
//! Nothing is stored for the administrator before `setup/complete`. Mail
//! servers and system emails are added afterwards under Administration; the
//! public address comes from `ROEDY_PUBLIC_URL`.
//!
//! Every token check counts towards the lockout (five failed attempts, then
//! 30 s, per client IP) – in the other steps too, otherwise it could be
//! guessed there without limit. Wrong codes from the app have their own
//! lockout and do not count towards it.

use std::time::Duration;

use axum::{
    Json, Router,
    extract::{FromRequestParts, State},
    http::{HeaderMap, HeaderValue, StatusCode, header, request::Parts},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{ApiError, FieldErrors, JsonBody, auth, me};
use crate::{
    app::AppState,
    auth::{AuthUser, recovery, session, totp},
    client_ip::ClientIp,
    db::{
        self,
        repo::{
            audit_log::{self, Category, Entry},
            known_devices, totp_devices,
            users::{self, NewUser, Role},
        },
    },
    events::{self, News},
    rate_limit::{Key, Policy},
    settings::{self, Accent, ColorScheme, Language, Settings},
    setup_token,
    setup_totp::{self, Confirm, Pending},
};

/// Header with the setup token for the steps after `setup/token`.
pub const TOKEN_HEADER: &str = "x-setup-token";

/// Five failed attempts, then a 30 s lockout. The page counts the attempts
/// without a time window; here they are forgotten after ten
/// minutes.
const TOKEN_LIMIT: Policy = Policy::lockout(
    "setup.token",
    5,
    Duration::from_secs(10 * 60),
    Duration::from_secs(30),
);
/// Wrong codes from the app in `setup/totp/verify`: five in 15 minutes, then
/// a 15-minute lockout (like `invites.code` and `auth.login.code`). One
/// counter for the setup, so that a new enrollment does not reset it.
const SETUP_CODE: Policy = Policy::lockout(
    "setup.code",
    5,
    Duration::from_secs(15 * 60),
    Duration::from_secs(15 * 60),
);

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/setup/token", post(token))
        .route("/setup/totp", post(enroll))
        .route("/setup/totp/verify", post(verify))
        .route("/setup/complete", post(complete))
}

fn setup_done() -> ApiError {
    ApiError::rejected(StatusCode::CONFLICT, "setup_done")
}

/// 422 `totp_required`: no (confirmed) enrollment for the administrator.
fn totp_required() -> ApiError {
    ApiError::rejected(StatusCode::UNPROCESSABLE_ENTITY, "totp_required")
}

/// Checks the token with a lockout after failed attempts. After the setup
/// 409 `setup_done` (also without a token); without a token 400; wrong 422
/// `invalid_token` with `remaining` (attempts until the lockout, "3 attempts
/// left"), at the fifth 429 `rate_limited` as during the lockout.
async fn check_token(state: &AppState, ip: ClientIp, input: Option<&str>) -> Result<(), ApiError> {
    let token = db::call(&state.db, |conn| setup_token::current(conn))
        .await?
        .ok_or_else(setup_done)?;
    let Some(input) = input else {
        return Err(ApiError::BadRequest("header X-Setup-Token missing".into()));
    };
    let key = Key::Ip(ip.network());
    // Reserve up front, so that even many concurrent attempts get no more
    // than five comparisons.
    let attempt = state.limiter.reserve(&TOKEN_LIMIT, key.clone())?;
    if setup_token::matches(&token, input) {
        // A correct token does not count.
        drop(attempt);
        return Ok(());
    }
    attempt.count();
    tracing::info!(ip = %ip.0, "setup token rejected");
    let remaining = state.limiter.remaining(&TOKEN_LIMIT, &key)?;
    Err(
        ApiError::rejected(StatusCode::UNPROCESSABLE_ENTITY, "invalid_token")
            .with("remaining", remaining),
    )
}

/// Valid setup token from the header `X-Setup-Token`. Comes
/// before the body, so that nothing else is checked without a token.
pub struct SetupToken;

impl FromRequestParts<AppState> for SetupToken {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let ip = ClientIp::from_request_parts(parts, state).await?;
        // A value that is not text cannot be the token and counts as a
        // failed attempt.
        let token = parts
            .headers
            .get(TOKEN_HEADER)
            .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned());
        check_token(state, ip, token.as_deref())
            .await
            .map(|()| Self)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenBody {
    token: String,
}

/// "Continue" with the token: answers `{}` when it matches.
async fn token(
    State(state): State<AppState>,
    ip: ClientIp,
    JsonBody(body): JsonBody<TokenBody>,
) -> Result<Json<Value>, ApiError> {
    check_token(&state, ip, Some(&body.token)).await?;
    Ok(Json(json!({})))
}

/// The pending enrollment. 409 `setup_done` if the setup has been completed
/// since the token check (it deletes the enrollment).
async fn pending(state: &AppState) -> Result<Option<Pending>, ApiError> {
    let (done, pending) = db::call(&state.db, |conn| {
        Ok((users::admin_exists(conn)?, setup_totp::get(conn)?))
    })
    .await?;
    if done {
        return Err(setup_done());
    }
    Ok(pending)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EnrollBody {
    email: String,
}

/// The administrator's address for the otpauth URI, checked like in
/// `setup/complete`.
fn enroll_email(body: EnrollBody) -> Result<String, FieldErrors> {
    let mut errors = FieldErrors::default();
    let email = body.email.trim();
    me::check_email(&mut errors, "email", email);
    if errors.is_empty() {
        Ok(email.to_owned())
    } else {
        Err(errors)
    }
}

/// "Authenticator app" step: new secret and recovery codes for `email` in
/// place of an earlier enrollment; answers the secret in Base32 and the
/// otpauth URI for the QR code, like `invites/{token}/totp`.
async fn enroll(
    State(state): State<AppState>,
    _: SetupToken,
    JsonBody(body): JsonBody<EnrollBody>,
) -> Result<Json<Value>, ApiError> {
    let email = enroll_email(body).map_err(FieldErrors::into_error)?;
    let secret = totp::generate_secret()?;
    let (base32, uri) = totp::enrollment(&secret, &state.brand().app, &email)?;
    let pending = Pending::new(&state.secrets, &email, &secret, recovery::generate()?)?;
    let stored = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        // Completed in the meantime: nothing to set up any more.
        if setup_token::current(&tx)?.is_none() {
            return Ok(false);
        }
        setup_totp::replace(&tx, &pending)?;
        tx.commit()?;
        Ok(true)
    })
    .await?;
    if !stored {
        return Err(setup_done());
    }
    Ok(Json(json!({ "secret": base32, "uri": uri })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VerifyBody {
    /// Code from the app.
    code: String,
}

/// Checks a code from the app against the pending enrollment and confirms
/// it; answers the enrollment's recovery codes. Without an enrollment 422
/// `totp_required`, a wrong code 422 `invalid_code` (five within 15 minutes
/// lock for 15 minutes), a time step that was already accepted 422
/// `code_used`.
async fn verify(
    State(state): State<AppState>,
    _: SetupToken,
    JsonBody(body): JsonBody<VerifyBody>,
) -> Result<Json<Value>, ApiError> {
    let pending = pending(&state).await?.ok_or_else(totp_required)?;
    let code = totp::compact(&body.code);
    // Not six digits: not an attempt, nothing to count.
    if !totp::is_well_formed(&code) {
        return Err(auth::invalid_code());
    }
    let attempt = state.limiter.reserve(&SETUP_CODE, Key::Global)?;
    let opened = pending.open(&state.secrets)?;
    let Some(step) = totp::matching_step(&opened.secret, &code, totp::now())? else {
        attempt.count();
        return Err(auth::invalid_code());
    };
    drop(attempt);
    let id = pending.id;
    let confirmed = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        if users::admin_exists(&tx)? {
            return Ok(None);
        }
        let confirmed = setup_totp::confirm(&tx, &id, step)?;
        tx.commit()?;
        Ok(Some(confirmed))
    })
    .await?;
    match confirmed.ok_or_else(setup_done)? {
        Confirm::Done => Ok(Json(json!({ "recovery_codes": opened.codes }))),
        Confirm::Used => Err(auth::code_used()),
        // A new secret in the meantime: the code belonged to the old one.
        Confirm::Gone => Err(auth::invalid_code()),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CompleteBody {
    name: String,
    email: String,
    password: String,
    settings: AppearanceBody,
}

/// Language and appearance from the first step; all three are required.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AppearanceBody {
    lang: Language,
    mode: ColorScheme,
    accent: Accent,
}

/// Checked setup data.
struct Plan {
    name: String,
    email: String,
    password: String,
    /// The administrator's own settings: the defaults with the appearance
    /// from the body.
    settings: Settings,
}

/// Checks name, email address and password like the steps of the page.
fn validate(body: CompleteBody) -> Result<Plan, FieldErrors> {
    let mut errors = FieldErrors::default();
    let name = body.name.trim();
    me::check_display_name(&mut errors, "name", name);
    let email = body.email.trim();
    me::check_email(&mut errors, "email", email);
    me::check_new_password(&mut errors, "password", &body.password);
    if !errors.is_empty() {
        return Err(errors);
    }
    let AppearanceBody { lang, mode, accent } = body.settings;
    Ok(Plan {
        name: name.to_owned(),
        email: email.to_owned(),
        password: body.password,
        settings: Settings {
            lang,
            mode: Some(mode),
            accent: Some(accent),
            ..Settings::default()
        },
    })
}

/// Result of the transaction in [`complete`].
enum Outcome {
    Done(AuthUser, HeaderValue),
    /// An administrator exists by now.
    SetupDone,
    /// The enrollment has been replaced or deleted since the check.
    TotpRequired,
}

/// "Finish setup": creates the administrator with their settings, the
/// authenticator app and the recovery codes of the confirmed enrollment in
/// one transaction, deletes token and enrollment and signs the administrator
/// in (201 with the session cookie).
async fn complete(
    State(state): State<AppState>,
    _: SetupToken,
    ip: ClientIp,
    headers: HeaderMap,
    JsonBody(body): JsonBody<CompleteBody>,
) -> Result<Response, ApiError> {
    let plan = validate(body).map_err(FieldErrors::into_error)?;
    let pending = pending(&state)
        .await?
        .filter(|pending| pending.step.is_some() && pending.email == plan.email)
        .ok_or_else(totp_required)?;

    // Before the transaction: hashing and sealing need no database.
    let opened = pending.open(&state.secrets)?;
    let password_hash = state.hasher.hash(&plan.password).await?;
    let device_id = db::new_id()?;
    let device_secret = state
        .secrets
        .seal(totp::SECRET_PURPOSE, &device_id, &opened.secret)?;
    let origin = auth::origin(&state, &headers, ip);

    let outcome = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        // Two concurrent completions: the second finds the administrator.
        if users::admin_exists(&tx)? {
            return Ok(Outcome::SetupDone);
        }
        // A new secret in the meantime: the check applied to a different
        // enrollment. The step as of now: a later confirmation may have
        // moved it on.
        let Some(step) = setup_totp::get(&tx)?
            .filter(|now| now.id == pending.id)
            .and_then(|now| now.step)
        else {
            return Ok(Outcome::TotpRequired);
        };
        let username = users::unique_username(&tx, &plan.email)?;
        let user_id = users::insert(
            &tx,
            &NewUser {
                username: &username,
                email: &plan.email,
                display_name: &plan.name,
                role: Role::Admin,
                password_hash: &password_hash,
            },
        )?;
        // A new account has no settings yet (version 0).
        if settings::save(&tx, &user_id, 0, &plan.settings)?.is_none() {
            anyhow::bail!("settings of the new administrator already exist");
        }
        // The code from the app's confirmation is used up: it cannot also
        // sign in.
        let app = totp::default_name(&[], plan.settings.lang);
        totp_devices::insert_confirmed(&tx, &device_id, &user_id, &app, &device_secret, step)?;
        recovery::store(&tx, &user_id, &opened.codes)?;
        let client = origin.client();
        let started = session::start(&tx, &user_id, &client, true)?;
        // The account's first device: known, without a notice.
        known_devices::remember(&tx, &user_id, &origin.device_hash)?;
        setup_token::delete(&tx)?;
        setup_totp::delete(&tx)?;
        let admin = AuthUser {
            id: user_id,
            username,
            email: plan.email.clone(),
            display_name: plan.name.clone(),
            role: Role::Admin,
            session_id: started.id.clone(),
        };
        // Shown as "completed the initial setup", then the sign-in.
        audit_log::insert(
            &tx,
            &Entry::new(Category::System, "setup.complete")
                .actor(&admin)
                .ip(ip.0),
        )?;
        audit_log::insert(
            &tx,
            &Entry::new(Category::Login, "auth.login")
                .actor(&admin)
                .client(&client)
                .target(&started.id)
                .details(json!({ "method": "setup" })),
        )?;
        events::news(&tx, &admin.id, News::Welcome)?;
        tx.commit()?;
        Ok(Outcome::Done(admin, started.cookie))
    })
    .await?;
    let (admin, cookie) = match outcome {
        Outcome::Done(admin, cookie) => (admin, cookie),
        Outcome::SetupDone => return Err(setup_done()),
        Outcome::TotpRequired => return Err(totp_required()),
    };
    tracing::info!(user = %admin.id, "setup completed");
    let body = Json(json!({ "user": auth::user_json(&admin) }));
    Ok((StatusCode::CREATED, [(header::SET_COOKIE, cookie)], body).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(value: Value) -> Result<CompleteBody, serde_json::Error> {
        serde_json::from_value(value)
    }

    fn valid() -> Value {
        json!({
            "name": " Max Smith ",
            "email": " max@example.com ",
            "password": "Summer2026!",
            "settings": { "lang": "de", "mode": "dark", "accent": "sage" },
        })
    }

    fn errors_of(value: Value) -> Value {
        match validate(body(value).unwrap()) {
            Ok(_) => panic!("expected errors"),
            Err(errors) => errors.into_value(),
        }
    }

    #[test]
    fn validates_and_takes_the_appearance() {
        let plan = validate(body(valid()).unwrap()).unwrap();
        assert_eq!(plan.name, "Max Smith");
        assert_eq!(plan.email, "max@example.com");
        assert_eq!(plan.settings.lang, Language::German);
        assert_eq!(plan.settings.mode, Some(ColorScheme::Dark));
        assert_eq!(plan.settings.accent, Some(Accent::Sage));
        // Everything else keeps the defaults.
        assert_eq!(
            Settings {
                lang: Language::default(),
                mode: None,
                accent: None,
                ..plan.settings
            },
            Settings::default()
        );
    }

    #[test]
    fn reports_every_field() {
        assert_eq!(
            errors_of(json!({
                "name": " ",
                "email": "max@example",
                "password": "short",
                "settings": { "lang": "en", "mode": "system", "accent": "apricot" },
            })),
            json!({
                "name": { "code": "required" },
                "email": { "code": "invalid" },
                "password": { "code": "policy", "rules": ["len", "case", "num"] },
            })
        );

        let mut long = valid();
        long["password"] = json!(format!("Aa1{}", "x".repeat(auth::MAX_PASSWORD)));
        long["name"] = json!("M".repeat(me::MAX_NAME + 1));
        assert_eq!(
            errors_of(long),
            json!({
                "name": { "code": "too_long" },
                "password": { "code": "too_long" },
            })
        );

        let mut digit = valid();
        digit["name"] = json!("Max Smith 2");
        assert_eq!(errors_of(digit), json!({ "name": { "code": "invalid" } }));
    }

    #[test]
    fn requires_all_three_settings_with_known_values() {
        for field in ["lang", "mode", "accent"] {
            let mut missing = valid();
            missing["settings"].as_object_mut().unwrap().remove(field);
            assert!(body(missing).is_err(), "without {field}");
        }
        for (field, value) in [("lang", "fr"), ("mode", "dim"), ("accent", "teal")] {
            let mut unknown = valid();
            unknown["settings"][field] = json!(value);
            assert!(body(unknown).is_err(), "{field}: {value}");
        }
        let mut without = valid();
        without.as_object_mut().unwrap().remove("settings");
        assert!(body(without).is_err());
    }

    #[test]
    fn enrollment_takes_only_a_valid_address() {
        let enroll = |value: Value| serde_json::from_value::<EnrollBody>(value);
        let email = enroll(json!({ "email": " max@example.com " })).unwrap();
        assert_eq!(enroll_email(email).unwrap(), "max@example.com");
        for (input, code) in [(" ", "required"), ("max@example", "invalid")] {
            let errors = enroll_email(enroll(json!({ "email": input })).unwrap()).unwrap_err();
            assert_eq!(
                errors.into_value(),
                json!({ "email": { "code": code } }),
                "{input}"
            );
        }
        assert!(enroll(json!({})).is_err());
        assert!(enroll(json!({ "email": "max@example.com", "name": "Max" })).is_err());
    }

    #[test]
    fn verification_takes_only_the_code() {
        let verify = |value: Value| serde_json::from_value::<VerifyBody>(value);
        assert_eq!(
            verify(json!({ "code": "123 456" })).unwrap().code,
            "123 456"
        );
        assert!(verify(json!({})).is_err());
        assert!(verify(json!({ "code": "123456", "email": "max@example.com" })).is_err());
        assert!(verify(json!({ "code": 123_456 })).is_err());
    }

    #[test]
    fn rejects_unknown_fields() {
        for (path, field) in [
            (None, "role"),
            (None, "server"),
            (None, "public_url"),
            (None, "system_mail"),
            (Some("settings"), "density"),
        ] {
            let mut extra = valid();
            let target = match path {
                Some(path) => &mut extra[path],
                None => &mut extra,
            };
            target[field] = json!("x");
            assert!(body(extra).is_err(), "{field}");
        }
    }
}
