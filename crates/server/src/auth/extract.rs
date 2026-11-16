//! Session per request and extractors for handlers.
//!
//! [`resolve`] sits as middleware in front of the whole API: it reads the
//! session cookie, checks the session, puts the [`AuthUser`] into the
//! request extensions and renews or deletes the cookie in the response.
//! Handlers then require [`CurrentUser`] (else 401) or [`AdminUser`]
//! (else 401 or 403); `Option<CurrentUser>` for endpoints that work with and
//! without sign-in.

use axum::{
    extract::{FromRequestParts, OptionalFromRequestParts, Request, State},
    http::{header, request::Parts},
    middleware::Next,
    response::{IntoResponse as _, Response},
};

use super::session::{self, AuthUser, Token};
use crate::{api::ApiError, app::AppState, db, db::repo::sessions};

/// Middleware: resolve the session from the cookie.
pub async fn resolve(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    let mut renew = None;
    let mut clear = false;
    if let Some(value) = session::cookie_value(request.headers()) {
        let found = match Token::parse(value) {
            Some(token) => {
                let hash = token.hash();
                match db::call(&state.db, move |conn| sessions::authenticate(conn, &hash)).await {
                    Ok(found) => found.map(|found| (token, found)),
                    Err(error) => return ApiError::Internal(error).into_response(),
                }
            }
            None => None,
        };
        match found {
            Some((token, found)) => {
                if found.touched {
                    renew = Some((token, found.persistent));
                }
                request.extensions_mut().insert(found.user);
            }
            // Unknown, expired, revoked or user locked.
            None => clear = true,
        }
    }

    let mut response = next.run(request).await;
    // If the handler sets the cookie itself (sign-in, sign-out), its cookie wins.
    if !session::sets_cookie(response.headers()) {
        let cookie = match (renew, clear) {
            (Some((token, persistent)), _) => Some(token.cookie(persistent)),
            (None, true) => Some(session::clear_cookie()),
            (None, false) => None,
        };
        if let Some(cookie) = cookie {
            response.headers_mut().append(header::SET_COOKIE, cookie);
        }
    }
    response
}

/// Signed-in, active user.
#[derive(Debug, Clone)]
pub struct CurrentUser(pub AuthUser);

impl<S: Send + Sync> FromRequestParts<S> for CurrentUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<AuthUser>()
            .cloned()
            .map(Self)
            .ok_or(ApiError::Unauthorized)
    }
}

impl<S: Send + Sync> OptionalFromRequestParts<S> for CurrentUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Option<Self>, Self::Rejection> {
        Ok(parts.extensions.get::<AuthUser>().cloned().map(Self))
    }
}

/// Signed-in administrator.
#[derive(Debug, Clone)]
pub struct AdminUser(pub AuthUser);

impl<S: Send + Sync> FromRequestParts<S> for AdminUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let CurrentUser(user) =
            <CurrentUser as FromRequestParts<S>>::from_request_parts(parts, state).await?;
        if user.is_admin() {
            Ok(Self(user))
        } else {
            Err(ApiError::Forbidden)
        }
    }
}
