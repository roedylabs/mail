//! Signed-in devices under Account › Security.
//!
//! - `GET auth/sessions`: valid sessions, the current one first, then the
//!   most recently active. Per session the device ("Firefox on Linux"), the
//!   kind for the icon, the place (GeoIP) or shortened IP address, start and
//!   last activity; for the installed app the system in `app` ("iPhone"),
//!   from which the page shows "‹App› for iPhone".
//! - `DELETE auth/sessions/:id`: signs out one session; the own one like
//!   "Sign out" (cookie cleared).
//! - `POST auth/sessions/revoke-others`: "Sign out all others", returns the
//!   count (`sessions_ended`) and discards open links from mails.
//!
//! "Undo" in the page's toast waits in the client before it sends the
//! request; here it takes effect immediately.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse as _, Response},
    routing::{delete, get, post},
};
use serde_json::{Value, json};

use super::{ApiError, auth};
use crate::{
    app::AppState,
    auth::{CurrentUser, device::Device, session},
    client_ip::ClientIp,
    db::{
        self,
        repo::{
            self,
            audit_log::{self, Category, Entry},
            sessions,
        },
    },
    mailer::format::short_ip,
    settings::{self, Language},
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/sessions", get(list))
        .route("/auth/sessions/{id}", delete(revoke))
        .route("/auth/sessions/revoke-others", post(revoke_others))
}

fn session_json(listed: &sessions::Listed, current: bool, lang: Language) -> Value {
    let device = Device::parse(listed.user_agent.as_deref());
    let ip = listed
        .ip
        .as_deref()
        .and_then(|ip| ip.parse().ok())
        .map(short_ip);
    json!({
        "id": listed.id,
        "current": current,
        "device": device.label(lang),
        "device_type": device.kind.as_str(),
        "app": listed.app.then_some(device.os).flatten(),
        "place": listed.place,
        "ip": ip,
        "created_at": listed.created_at,
        "last_seen_at": listed.last_seen_at,
    })
}

async fn list(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<Value>, ApiError> {
    let id = user.id.clone();
    let (mut listed, lang) = db::call(&state.db, move |conn| {
        Ok((sessions::list(conn, &id)?, settings::lang_of(conn, &id)?))
    })
    .await?;
    // The current one first, the rest stay sorted by last activity.
    listed.sort_by_key(|s| s.id != user.session_id);
    let sessions: Vec<Value> = listed
        .iter()
        .map(|s| session_json(s, s.id == user.session_id, lang))
        .collect();
    Ok(Json(json!({ "sessions": sessions })))
}

/// "Sign out" for one device. The own session ends like with
/// `auth/logout`; someone else's, an expired or an already ended one is 404.
async fn revoke(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    ip: ClientIp,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let current = id == user.session_id;
    let revoked = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        // As with "Sign out all others": only from a still valid session
        // (the list shows only valid ones).
        if !sessions::is_valid(&tx, &user.id, &user.session_id)? {
            return Ok(Err(ApiError::Unauthorized));
        }
        if current {
            auth::end_own_session(&tx, &user, ip)?;
        } else {
            if !sessions::is_valid(&tx, &user.id, &id)? {
                return Ok(Err(ApiError::NotFound));
            }
            sessions::delete(&tx, &user.id, &id)?;
            audit_log::insert(
                &tx,
                &Entry::new(Category::Login, "auth.session_revoke")
                    .actor(&user)
                    .ip(ip.0)
                    .target(&id),
            )?;
        }
        tx.commit()?;
        Ok(Ok(()))
    })
    .await?;
    revoked?;
    let mut response = StatusCode::NO_CONTENT.into_response();
    if current {
        response
            .headers_mut()
            .append(header::SET_COOKIE, session::clear_cookie());
    }
    Ok(response)
}

/// "Sign out all others": ends all sessions except the own one and discards
/// open links from mails (one of the steps `security_email` recommends). If the
/// own one has ended in the meantime (e.g. through a password change on another
/// device), the request is rejected (401).
async fn revoke_others(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    ip: ClientIp,
) -> Result<Json<Value>, ApiError> {
    let ended = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        if !sessions::is_valid(&tx, &user.id, &user.session_id)? {
            return Ok(None);
        }
        let ended = sessions::delete_for_user(&tx, &user.id, Some(&user.session_id))?;
        repo::discard_links(&tx, &user.id)?;
        audit_log::insert(
            &tx,
            &Entry::new(Category::Login, "auth.sessions_revoke")
                .actor(&user)
                .ip(ip.0)
                .target(&user.id)
                .details(json!({ "sessions_ended": ended })),
        )?;
        tx.commit()?;
        Ok(Some(ended))
    })
    .await?
    .ok_or(ApiError::Unauthorized)?;
    Ok(Json(json!({ "sessions_ended": ended })))
}
