//! Maintenance mode (admin `maintenance`, Administration › Maintenance, notice
//! bar): while it is on, only administrators can use the app and other users
//! are signed out.
//!
//! The state lives in `app_settings.maintenance` (`{"on": …, "message": …}`)
//! and in memory ([`Maintenance`]); it is toggled via `admin/maintenance`
//! (`crate::api::maintenance`), which also ends the sessions without
//! administrator rights right away. Here:
//!
//! - [`guard`] in front of the API signs out a session without administrator
//!   rights that survived the toggle (it was created at the same time) on its
//!   first request (like `auth/logout`, cookie cleared); the request continues
//!   as if not signed in. That way public pages, links from mails and an
//!   administrator signing in from the same browser stay reachable; everything
//!   else answers 401 as after signing out.
//! - [`Maintenance::admit`] wherever sessions are created (sign-in, accepting
//!   an invitation): only for administrators, otherwise 503 `maintenance`
//!   (with `message` if a custom notice is set).

use std::sync::{PoisonError, RwLock};

use axum::{
    extract::{FromRequestParts as _, Request, State},
    http::header,
    middleware::Next,
    response::{IntoResponse as _, Response},
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::{
    api::{ApiError, auth::end_own_session},
    app::AppState,
    auth::{AuthUser, session},
    client_ip::ClientIp,
    db::{
        self,
        repo::{app_settings, users::Role},
    },
    instance,
};

/// Key in `app_settings`.
pub const KEY: &str = "maintenance";

/// State of the maintenance mode.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mode {
    pub on: bool,
    /// Custom notice; without it the web app shows its default text.
    #[serde(default)]
    pub message: Option<String>,
}

impl Mode {
    /// From the database; off without a (readable) entry.
    pub fn load(conn: &Connection) -> anyhow::Result<Self> {
        Ok(instance::load(conn, KEY, |_| Self::default())?.unwrap_or_default())
    }

    pub fn save(&self, conn: &Connection) -> anyhow::Result<()> {
        app_settings::set(conn, KEY, self)
    }
}

/// The state in memory; [`Self::set`] after every change.
#[derive(Default)]
pub struct Maintenance(RwLock<Current>);

#[derive(Default)]
struct Current {
    mode: Mode,
    /// Counts the times maintenance mode was turned on.
    period: u64,
}

impl Maintenance {
    pub fn current(&self) -> Mode {
        self.0
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .mode
            .clone()
    }

    pub fn set(&self, mode: Mode) {
        let mut state = self.0.write().unwrap_or_else(PoisonError::into_inner);
        if mode.on && !state.mode.on {
            state.period += 1;
        }
        state.mode = mode;
    }

    pub fn is_on(&self) -> bool {
        self.0
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .mode
            .on
    }

    /// While maintenance mode is on: which time it was turned on. Compared
    /// later, the same value means it stayed on in between (a restore needs
    /// that until it copies, `crate::backups::restore`).
    pub fn period(&self) -> Option<u64> {
        let state = self.0.read().unwrap_or_else(PoisonError::into_inner);
        state.mode.on.then_some(state.period)
    }

    /// Whether a session with this role may be created now; otherwise 503
    /// `maintenance`.
    pub fn admit(&self, role: Role) -> Result<(), ApiError> {
        if role == Role::Admin || !self.is_on() {
            return Ok(());
        }
        Err(ApiError::Maintenance(self.current().message))
    }
}

/// API middleware after `auth::extract::resolve`: in maintenance mode a
/// session without administrator rights ends, and the request counts as not
/// signed in.
pub async fn guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let user = request
        .extensions()
        .get::<AuthUser>()
        .filter(|user| !user.is_admin())
        .cloned();
    let Some(user) = user.filter(|_| state.maintenance.is_on()) else {
        return next.run(request).await;
    };
    let (mut parts, body) = request.into_parts();
    let ip = match ClientIp::from_request_parts(&mut parts, &state).await {
        Ok(ip) => ip,
        Err(error) => return error.into_response(),
    };
    let ended = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        end_own_session(&tx, &user, ip)?;
        tx.commit()?;
        Ok(())
    })
    .await;
    if let Err(error) = ended {
        return ApiError::from(error).into_response();
    }
    parts.extensions.remove::<AuthUser>();
    let mut response = next.run(Request::from_parts(parts, body)).await;
    // If the handler itself signs in (administrator in the same browser),
    // its cookie applies.
    if !session::sets_cookie(response.headers()) {
        response
            .headers_mut()
            .append(header::SET_COOKIE, session::clear_cookie());
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::users::tests::conn;

    #[test]
    fn off_without_setting_and_admins_only_when_on() {
        let conn = conn();
        assert_eq!(Mode::load(&conn).unwrap(), Mode::default());
        app_settings::set(&conn, KEY, &serde_json::json!({ "on": true })).unwrap();
        let mode = Mode::load(&conn).unwrap();
        assert_eq!(
            mode,
            Mode {
                on: true,
                message: None
            }
        );

        let maintenance = Maintenance::default();
        assert!(maintenance.admit(Role::User).is_ok());
        assert_eq!(maintenance.period(), None);
        maintenance.set(mode.clone());
        assert!(maintenance.admit(Role::Admin).is_ok());
        assert!(maintenance.admit(Role::User).is_err());
        let first = maintenance.period();
        assert!(first.is_some());

        // Staying on keeps the period, off and on again starts a new one.
        maintenance.set(mode.clone());
        assert_eq!(maintenance.period(), first);
        maintenance.set(Mode::default());
        assert_eq!(maintenance.period(), None);
        maintenance.set(mode);
        assert_ne!(maintenance.period(), first);
    }

    #[test]
    fn unreadable_setting_counts_as_off_and_can_be_replaced() {
        let conn = conn();
        app_settings::set(&conn, KEY, &"broken").unwrap();
        assert_eq!(Mode::load(&conn).unwrap(), Mode::default());

        let mode = Mode {
            on: true,
            message: None,
        };
        mode.save(&conn).unwrap();
        assert_eq!(Mode::load(&conn).unwrap(), mode);
    }
}
