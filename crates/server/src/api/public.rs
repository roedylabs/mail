//! `GET public/config`: what the web app
//! needs before any sign-in – start screen, sign-in, setup, invitation, error
//! pages and the notice bar (state module `session`). Readable
//! without a session; so nothing here concerns administrators only (system
//! mail: `auth/me`).
//!
//! - `name`: app name (without a custom name "Roedy Mail").
//! - `branding`: logo and sign-in page with the fields of `BRAND0`; `image`
//!   is the URL of the uploaded logo (`/branding/image/…`) or `null`.
//! - `org`: details of the organization like [`Org`] (name, website,
//!   help, support, legal notice, privacy, terms of use, source code),
//!   `null` = not given.
//! - `banner`: the administration's own banner for the notice bar (fields of
//!   [`Banner`] with `revision`), `null` while it is off. Whoever closes it
//!   remembers the revision.
//!
//!   Organization, banner and branding come from `AppState::instance`, from
//!   which `AppState::brand` also takes the details for mails – one source
//!   for mails and web app.
//! - `maintenance`: maintenance mode with a custom notice `message` (only
//!   while it is on; otherwise the web app shows `MAINT_MSG`).
//! - `version`: version of the server; `update`: state for everyone with
//!   `available` and `latest`, `null` while the display
//!   is off or the state is unknown.
//! - `client_cache_version`: version of the browsers' cache; when it changes,
//!   they renew it (`storage/compact`).
//! - `setup_required`: setup is pending (no administrator yet).

use std::sync::atomic::Ordering;

use axum::{Json, Router, extract::State, routing::get};
use serde_json::{Value, json};

use super::ApiError;
use crate::{
    app::AppState,
    db,
    db::repo::users,
    instance::{Banner, BrandingState, Org},
};

pub fn routes() -> Router<AppState> {
    Router::new().route("/public/config", get(config))
}

/// Branding with the fields of `admin/branding`, without app name and file details.
fn branding(state: &BrandingState) -> Value {
    let mut fields = super::branding::view(state);
    for field in super::branding::ADMIN_ONLY {
        fields.remove(field);
    }
    Value::Object(fields)
}

/// Organization with the fields of [`Org`].
fn org(org: &Org) -> Value {
    json!(org)
}

/// The banner without `on`; `null` while it is off.
fn banner(banner: &Banner) -> Value {
    if !banner.on {
        return Value::Null;
    }
    json!({
        "title": banner.title,
        "text": banner.text,
        "link": banner.link,
        "linkLabel": banner.link_label,
        "tone": banner.tone,
        "icon": banner.icon,
        "closable": banner.closable,
        "revision": banner.revision,
    })
}

/// Whether setup is pending. Once there is an administrator, it stays that
/// way – the own account can be neither removed nor demoted –, so only the
/// first call after that asks the database.
async fn setup_required(state: &AppState) -> anyhow::Result<bool> {
    if state.setup_done.load(Ordering::Relaxed) {
        return Ok(false);
    }
    let done = db::call(&state.db, |conn| Ok(users::admin_exists(conn)?)).await?;
    if done {
        state.setup_done.store(true, Ordering::Relaxed);
    }
    Ok(!done)
}

async fn config(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let setup_required = setup_required(&state).await?;
    let maintenance = state.maintenance.current();
    let message = maintenance.message.filter(|_| maintenance.on);
    let branding_state = state.instance.branding();
    Ok(Json(json!({
        "name": branding_state.branding.app_name(),
        "branding": branding(&branding_state),
        "org": org(&state.instance.org()),
        "banner": banner(&state.instance.banner()),
        "maintenance": { "on": maintenance.on, "message": message },
        "version": env!("CARGO_PKG_VERSION"),
        "update": state.instance.update(),
        "client_cache_version": state.instance.client_cache_version(),
        "setup_required": setup_required,
    })))
}
