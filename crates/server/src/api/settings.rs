//! Per-user settings (state module `prefs` in the web app). `crate::settings`
//! describes the document with its fields and values.
//!
//! - `GET settings`: `{version, settings}` with all fields; without stored
//!   settings the defaults with version 0.
//! - `PUT settings` (`{version, settings}`): takes over the given fields, the
//!   others stay. `version` is the version the change is based on; if another
//!   one applies by now (second tab, other device), 409 `version_conflict`
//!   with the current state (`version`, `settings`), so the client can apply
//!   its change to it again. Unknown fields and values the app does not
//!   offer are 422 `invalid` with `fields` (`settings.<field>`: `unknown` or
//!   `invalid`), and nothing changes; likewise a new `defaultAccount` that is
//!   not one of the user's own mail accounts. If nothing changes, the version
//!   stays too – unless the stored document contains something this version
//!   ignores; then it is rewritten.
//! - `POST settings/local-reset`: "Clear local data" (General › Data) –
//!   the browser deletes its data itself, the backend only writes
//!   the audit log.
//!
//! The browser builds the export (General › Data) from `GET settings` and
//! `GET auth/me`; there is no endpoint for it.

use std::time::Duration;

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{ApiError, FieldErrors, JsonBody};
use crate::{
    app::AppState,
    auth::CurrentUser,
    client_ip::ClientIp,
    db::{
        self,
        repo::{
            audit_log::{self, Category, Entry},
            mail_accounts,
        },
    },
    rate_limit::{Key, Policy},
    settings::{self, Rejected, Stored},
};

/// Every call writes to the audit log; nobody needs more.
const LOCAL_RESET_LIMIT: Policy =
    Policy::rate("settings.local_reset", 10, Duration::from_secs(10 * 60));

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/settings", get(get_settings).put(put_settings))
        .route("/settings/local-reset", post(local_reset))
}

fn stored_json(stored: &Stored) -> anyhow::Result<Value> {
    Ok(json!({
        "version": stored.version,
        "settings": serde_json::to_value(&stored.settings)?,
    }))
}

async fn get_settings(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<Value>, ApiError> {
    let stored = db::call(&state.db, move |conn| settings::load(conn, &user.id)).await?;
    Ok(Json(stored_json(&stored)?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PutBody {
    version: i64,
    settings: Map<String, Value>,
}

enum Outcome {
    Saved(Stored),
    Conflict(Stored),
    Invalid(FieldErrors),
}

async fn put_settings(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    JsonBody(body): JsonBody<PutBody>,
) -> Result<Json<Value>, ApiError> {
    let outcome = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        let current = settings::load(&tx, &user.id)?;
        let next = match current.settings.apply(&body.settings) {
            Ok(next) => next,
            Err(Rejected::Fields(fields)) => {
                let mut inner = FieldErrors::default();
                for (field, code) in fields {
                    inner.code(&field, code);
                }
                let mut errors = FieldErrors::default();
                errors.nest("settings", inner);
                return Ok(Outcome::Invalid(errors));
            }
            Err(Rejected::Internal(error)) => return Err(error.into()),
        };
        if body.version != current.version {
            return Ok(Outcome::Conflict(current));
        }
        // A new default account must be one of the user's own mail accounts.
        // A stored one that no longer exists does not hold up other changes.
        if let Some(id) = next.default_account.as_ref().and_then(|d| d.account_id())
            && next.default_account != current.settings.default_account
            && !mail_accounts::exists(&tx, &user.id, id)?
        {
            let mut inner = FieldErrors::default();
            inner.code("defaultAccount", "invalid");
            let mut errors = FieldErrors::default();
            errors.nest("settings", inner);
            return Ok(Outcome::Invalid(errors));
        }
        if next == current.settings && !current.rewrite {
            return Ok(Outcome::Saved(current));
        }
        // Read in the same transaction, so the version still applies.
        let version = settings::save(&tx, &user.id, current.version, &next)?
            .ok_or_else(|| anyhow::anyhow!("settings version has changed"))?;
        tx.commit()?;
        Ok(Outcome::Saved(Stored {
            version,
            settings: next,
            rewrite: false,
        }))
    })
    .await?;
    match outcome {
        Outcome::Saved(stored) => Ok(Json(stored_json(&stored)?)),
        Outcome::Conflict(current) => {
            let settings = serde_json::to_value(&current.settings).map_err(anyhow::Error::from)?;
            Err(ApiError::rejected(StatusCode::CONFLICT, "version_conflict")
                .with("version", current.version)
                .with("settings", settings))
        }
        Outcome::Invalid(errors) => Err(errors.into_error()),
    }
}

/// "Clear local data": only an audit log entry with the session on whose
/// device the browser deletes.
async fn local_reset(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    ip: ClientIp,
) -> Result<StatusCode, ApiError> {
    state
        .limiter
        .acquire(&LOCAL_RESET_LIMIT, Key::User(user.id.clone()))?;
    db::call(&state.db, move |conn| {
        audit_log::insert(
            conn,
            &Entry::new(Category::Settings, "settings.local_reset")
                .actor(&user)
                .ip(ip.0)
                .target(&user.session_id),
        )?;
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
