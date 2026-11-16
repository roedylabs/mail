//! HTTP handlers: operational endpoints (`/healthz`, `/readyz`) and the API
//! under `/api/v1` with JSON errors, CSRF protection, sessions and
//! `Cache-Control: no-store`.

pub mod audit;
pub mod auth;
pub mod backups;
pub mod branding;
pub mod directory;
pub mod email;
pub mod error;
pub mod health;
pub mod instance;
pub mod invites;
pub mod mail_accounts;
pub mod maintenance;
pub mod me;
pub mod mfa;
pub mod notifications;
pub mod password;
pub mod public;
pub mod push;
pub mod servers;
pub mod sessions;
pub mod settings;
pub mod setup;
pub mod system_mail;
pub mod tags;
pub mod updates;
pub mod users;

use axum::{
    Router,
    extract::{FromRequest, Request},
    http::{HeaderMap, HeaderValue, Method, header},
    middleware::{self, Next},
    response::{IntoResponse as _, Response},
};
use serde::{Deserialize, Deserializer, de::DeserializeOwned};
use tower_http::set_header::SetResponseHeaderLayer;

pub use error::{ApiError, FieldErrors};

use crate::{app::AppState, auth::extract, web};

/// Path under which [`router`] is mounted.
pub const PREFIX: &str = "/api/v1";

/// Required header for modifying requests (CSRF protection through
/// `SameSite` + `X-Requested-With`). A foreign form cannot set it, and a
/// foreign `fetch` with a custom header needs a CORS preflight, which the API
/// does not allow.
pub const CSRF_HEADER: &str = "x-requested-with";

pub fn router(state: AppState) -> Router<AppState> {
    let routes = servers::routes()
        .merge(setup::routes())
        .merge(auth::routes())
        .merge(me::routes())
        .merge(email::routes())
        .merge(password::routes())
        .merge(mfa::routes())
        .merge(sessions::routes())
        .merge(users::routes())
        .merge(invites::routes())
        .merge(directory::routes())
        .merge(settings::routes())
        .merge(mail_accounts::routes())
        .merge(tags::routes())
        .merge(notifications::routes())
        .merge(push::routes())
        .merge(instance::routes())
        .merge(branding::routes())
        .merge(system_mail::routes())
        .merge(updates::routes())
        .merge(maintenance::routes())
        .merge(backups::routes())
        .merge(audit::routes())
        .merge(public::routes());
    with_middleware(routes, state)
}

/// Wraps the API's fallback and middleware around `routes`. Tests put their
/// own routes behind the same stack this way.
pub fn with_middleware(routes: Router<AppState>, state: AppState) -> Router<AppState> {
    routes
        .fallback(not_found)
        // Order from inside to outside: maintenance mode (needs the
        // session), session, CSRF (before any database query), then
        // `no-store` for every response, errors included.
        .layer(middleware::from_fn_with_state(
            state.clone(),
            web::maintenance::guard,
        ))
        .layer(middleware::from_fn_with_state(state, extract::resolve))
        .layer(middleware::from_fn(require_csrf_header))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
}

async fn not_found() -> ApiError {
    ApiError::NotFound
}

/// Rejects modifying requests without a non-empty `X-Requested-With`, and
/// reading ones the browser loads as an image, stylesheet, font or the like:
/// an HTML mail with allowed images sits in a `blob:` iframe with the app's
/// origin, and its `<img src="https://<app>/api/v1/…">` would send the cookie.
/// The app itself calls the API only via `fetch` (`empty`) and downloads
/// backups via a link (`document`).
pub async fn require_csrf_header(request: Request, next: Next) -> Response {
    let safe = matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    );
    if safe && is_subresource(request.headers()) {
        return ApiError::Csrf.into_response();
    }
    if safe || has_csrf_header(request.headers()) {
        next.run(request).await
    } else {
        ApiError::Csrf.into_response()
    }
}

/// For reading endpoints that still trigger something – counting towards a
/// limit or refreshing at the mail server: requires `X-Requested-With` like
/// modifying requests (otherwise 403 `csrf`). A foreign `<img>`, an image in
/// a mail or a navigation from a foreign page sends the cookie
/// (`SameSite=Lax`), but never this header.
/// Call before any limit.
pub fn require_requested_with(headers: &HeaderMap) -> Result<(), ApiError> {
    if has_csrf_header(headers) {
        Ok(())
    } else {
        Err(ApiError::Csrf)
    }
}

fn has_csrf_header(headers: &HeaderMap) -> bool {
    headers.get(CSRF_HEADER).is_some_and(|v| !v.is_empty())
}

/// `Sec-Fetch-Dest` of an embedded resource (Fetch Metadata). Browsers
/// without the header get through, as before.
fn is_subresource(headers: &HeaderMap) -> bool {
    const SUBRESOURCES: [&str; 14] = [
        "image",
        "style",
        "font",
        "script",
        "audio",
        "video",
        "track",
        "object",
        "embed",
        "iframe",
        "frame",
        "xslt",
        "audioworklet",
        "paintworklet",
    ];
    headers
        .get("sec-fetch-dest")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|dest| SUBRESOURCES.iter().any(|d| dest.eq_ignore_ascii_case(d)))
}

/// JSON body of a request. If it does not fit, the API answers with 400
/// `bad_request` as JSON instead of axum's text response.
pub struct JsonBody<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for JsonBody<T> {
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        axum::Json::<T>::from_request(request, state)
            .await
            .map(|axum::Json(value)| Self(value))
            .map_err(|rejection| ApiError::BadRequest(rejection.body_text()))
    }
}

/// For `PATCH` fields that can be missing (`None`), `null` (`Some(None)`) or
/// have a value: `#[serde(default, deserialize_with = "nullable")]`.
pub fn nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}
