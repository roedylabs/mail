//! Automatic registration of the OAuth client (Dynamic Client Registration,
//! RFC 7591) with the
//! credentials of an administrator of the mail server – username and
//! app password, via HTTP Basic. They apply only to this one request and
//! are not stored.
//!
//! A **confidential** client is registered (`token_endpoint_auth_method:
//! client_secret_basic`): Stalwart v1 accepts public clients via DCR only
//! with a loopback or private-use redirect. Code exchange and refresh therefore
//! run in the backend; the secret never leaves it. Without
//! `scope` the client would get no scopes.

use std::{fmt, time::Duration};

use reqwest::{Client, StatusCode, header};
use serde::Deserialize;
use serde_json::json;
use url::Url;

use super::{oauth_error, probe, read_json, same_origin};

/// Scopes of the client, with Stalwart's names (`offline_access`,
/// `urn:ietf:params:oauth:scope:mail` …); contacts for the
/// recipient suggestions. The sign-in requests the same.
pub const SCOPE: &str = "offline_access urn:ietf:params:oauth:scope:mail \
                         urn:ietf:params:oauth:scope:contacts";
const CLIENT_NAME: &str = "Roedy Mail";
const AUTH_METHOD: &str = "client_secret_basic";
/// Like the registry fields `client_id` and `client_secret`.
const MAX_FIELD: usize = 1024;

pub struct Registration<'a> {
    /// Base URL of the mail server (origin only).
    pub base_url: &'a Url,
    /// `<origin of the app>/oauth/callback`
    pub redirect_uri: &'a str,
    /// Origin of the app
    pub client_uri: &'a str,
    pub username: &'a str,
    pub password: &'a str,
}

/// The registered client. The secret appears in no output.
pub struct ClientCredentials {
    pub client_id: String,
    pub client_secret: String,
}

impl fmt::Debug for ClientCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientCredentials")
            .field("client_id", &self.client_id)
            .finish_non_exhaustive()
    }
}

/// Why the registration failed; [`Error::reason`] is the key
/// for the API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Server or metadata not reachable.
    Unreachable,
    /// No OAuth metadata or no `registration_endpoint` on the
    /// server's origin.
    Unsupported,
    /// Metadata without the details of Stalwart v1; the
    /// credentials are then not sent.
    UnsupportedVersion,
    /// 401: user or password wrong.
    AuthFailed,
    /// 402: the account has a second factor; Basic then only works with an
    /// app password.
    MfaRequired,
    /// 403: the account may not create OAuth clients
    /// (`SysOAuthClientCreate`).
    Forbidden,
    /// 429: the mail server throttles requests from this address; wait time from
    /// `Retry-After`.
    Throttled(Duration),
    /// 400 with an error code per RFC 7591, e.g. `invalid_redirect_uri` or
    /// `invalid_client_metadata`.
    Rejected(String),
    /// Unexpected response, also without a secret.
    InvalidResponse,
}

impl Error {
    pub fn reason(&self) -> &'static str {
        match self {
            Self::Unreachable => "unreachable",
            Self::Unsupported => "unsupported",
            Self::UnsupportedVersion => "unsupported_version",
            Self::AuthFailed => "auth_failed",
            Self::MfaRequired => "mfa_required",
            Self::Forbidden => "forbidden",
            Self::Throttled(_) => "throttled",
            Self::Rejected(_) => "rejected",
            Self::InvalidResponse => "invalid_response",
        }
    }
}

#[derive(Deserialize)]
struct Response {
    client_id: String,
    client_secret: Option<String>,
    /// `0` or missing: does not expire (RFC 7591, section 3.2.1).
    client_secret_expires_at: Option<u64>,
}

/// A value the registry can store (like
/// `api::servers::check_client_field`).
fn valid_field(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_FIELD && !value.chars().any(char::is_control)
}

/// Registers the client and returns client ID and secret.
pub async fn register(
    http: &Client,
    registration: &Registration<'_>,
) -> Result<ClientCredentials, Error> {
    let metadata =
        probe::metadata(http, registration.base_url)
            .await
            .map_err(|error| match error {
                probe::MetadataError::Unreachable => Error::Unreachable,
                probe::MetadataError::Missing => Error::Unsupported,
                probe::MetadataError::Throttled(retry_after) => Error::Throttled(retry_after),
            })?;
    if !metadata.is_v1() {
        return Err(Error::UnsupportedVersion);
    }
    // The credentials only go to the server itself.
    let endpoint = metadata
        .registration_endpoint
        .and_then(|endpoint| same_origin(registration.base_url, &endpoint))
        .ok_or(Error::Unsupported)?;

    let response = http
        .post(endpoint)
        .basic_auth(registration.username, Some(registration.password))
        .header(header::ACCEPT, "application/json")
        .json(&json!({
            "redirect_uris": [registration.redirect_uri],
            "client_name": CLIENT_NAME,
            "client_uri": registration.client_uri,
            "application_type": "web",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": AUTH_METHOD,
            "scope": SCOPE,
        }))
        .send()
        .await
        .map_err(|_| Error::Unreachable)?;

    match response.status() {
        StatusCode::OK | StatusCode::CREATED => {}
        StatusCode::UNAUTHORIZED => return Err(Error::AuthFailed),
        StatusCode::PAYMENT_REQUIRED => return Err(Error::MfaRequired),
        StatusCode::FORBIDDEN => return Err(Error::Forbidden),
        StatusCode::TOO_MANY_REQUESTS => {
            return Err(Error::Throttled(probe::retry_after(response.headers())));
        }
        StatusCode::BAD_REQUEST => {
            let code = oauth_error(response)
                .await
                .unwrap_or_else(|| "unknown".into());
            return Err(Error::Rejected(code));
        }
        _ => return Err(Error::InvalidResponse),
    }
    let body = read_json::<Response>(response)
        .await
        .ok_or(Error::InvalidResponse)?;
    let client_id = body.client_id.trim();
    // Without a secret the client would be public – and with an https redirect in v1
    // would not have been created at all.
    let client_secret = body.client_secret.unwrap_or_default();
    if !valid_field(client_id) || !valid_field(&client_secret) {
        return Err(Error::InvalidResponse);
    }
    if body.client_secret_expires_at.is_some_and(|at| at > 0) {
        // Stalwart issues secrets without expiry; if one expires, sign-in
        // and refresh fail afterwards with `invalid_client`.
        tracing::warn!(
            server = %registration.base_url,
            "mail server issued a client secret with an expiry date"
        );
    }
    Ok(ClientCredentials {
        client_id: client_id.to_owned(),
        client_secret,
    })
}
