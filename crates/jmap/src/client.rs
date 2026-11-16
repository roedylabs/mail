//! Connection to a JMAP server: session via `/.well-known/jmap`
//! (RFC 8620, 2.2) and requests to the `apiUrl`.

use std::fmt;

use reqwest::{
    RequestBuilder, StatusCode,
    header::{self, HeaderMap, HeaderValue},
};
use serde::{Deserialize, de::DeserializeOwned};
use url::Url;

use crate::{CORE, Error, Request, Response, Session, error::kind_of};

const MAX_REDIRECTS: usize = 3;
/// No response the backend reads from a mail server needs more.
const MAX_BODY: usize = 256 * 1024;
const JSON: HeaderValue = HeaderValue::from_static("application/json");

/// Sign-in to the server. `Debug` hides password and token.
#[derive(Clone, PartialEq, Eq)]
pub enum Auth {
    /// User and password (with Stalwart preferably an app password, which
    /// needs no second factor).
    Basic { username: String, password: String },
    /// Access token (API key or OAuth).
    Bearer(String),
}

impl fmt::Debug for Auth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Basic { username, .. } => f
                .debug_struct("Basic")
                .field("username", username)
                .field("password", &"***")
                .finish(),
            Self::Bearer(_) => f.write_str("Bearer(***)"),
        }
    }
}

impl Auth {
    /// reqwest marks the header as sensitive (not in `Debug`).
    fn apply(&self, request: RequestBuilder) -> RequestBuilder {
        match self {
            Self::Basic { username, password } => request.basic_auth(username, Some(password)),
            Self::Bearer(token) => request.bearer_auth(token),
        }
    }
}

/// Signed-in client with the account's session.
pub struct Client {
    http: reqwest::Client,
    auth: Auth,
    session: Session,
    /// The session as the server returned it.
    session_json: serde_json::Value,
    api_url: Url,
}

impl fmt::Debug for Client {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Client")
            .field("auth", &self.auth)
            .field("api_url", &self.api_url.as_str())
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
struct Problem {
    #[serde(rename = "type")]
    kind: String,
}

impl Client {
    /// Fetches the session from `{base_url}/.well-known/jmap`. The client
    /// follows redirects only on the same origin (three at most), and the
    /// `apiUrl` must be there too – otherwise the credentials would go to
    /// another address.
    pub async fn connect(
        http: &reqwest::Client,
        base_url: &Url,
        auth: Auth,
    ) -> Result<Self, Error> {
        let mut url = base_url
            .join("/.well-known/jmap")
            .map_err(|_| Error::InvalidResponse)?;
        for _ in 0..=MAX_REDIRECTS {
            let response = auth
                .apply(http.get(url.clone()))
                .header(header::ACCEPT, JSON)
                .send()
                .await
                .map_err(|_| Error::Unreachable)?;
            let status = response.status();
            if status.is_redirection() {
                url = redirect_target(&url, response.headers())?;
                continue;
            }
            check(status)?;
            let session_json: serde_json::Value = read_json(response).await?;
            let session =
                Session::deserialize(&session_json).map_err(|_| Error::InvalidResponse)?;
            // Relative to the URL where the session was; after the redirects `url`
            // still has the origin of `base_url`.
            let api_url = same_origin(&url, &session.api_url).ok_or(Error::ForeignOrigin)?;
            if !session.has(CORE) {
                return Err(Error::Unsupported(CORE));
            }
            return Ok(Self {
                http: http.clone(),
                auth,
                session,
                session_json,
                api_url,
            });
        }
        Err(Error::InvalidResponse)
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    /// The session as JSON, complete as the server sent it.
    pub fn into_session_json(self) -> serde_json::Value {
        self.session_json
    }

    /// Sends the request to the `apiUrl`. If the server rejects the whole
    /// request (RFC 8620, 3.6.1), this becomes [`Error::Request`].
    pub async fn call(&self, request: &Request) -> Result<Response, Error> {
        let body = serde_json::to_vec(request).map_err(|_| Error::InvalidResponse)?;
        let response = self
            .auth
            .apply(self.http.post(self.api_url.clone()))
            .header(header::ACCEPT, JSON)
            .header(header::CONTENT_TYPE, JSON)
            .body(body)
            .send()
            .await
            .map_err(|_| Error::Unreachable)?;
        let status = response.status();
        let plain = matches!(
            status,
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::TOO_MANY_REQUESTS
        );
        if status.is_client_error() && !plain {
            return Err(match read_json::<Problem>(response).await {
                Ok(problem) => Error::Request(kind_of(&problem.kind)),
                Err(_) => Error::Status(status.as_u16()),
            });
        }
        check(status)?;
        read_json(response).await
    }
}

fn check(status: StatusCode) -> Result<(), Error> {
    match status {
        status if status.is_success() => Ok(()),
        StatusCode::UNAUTHORIZED => Err(Error::AuthFailed),
        StatusCode::FORBIDDEN => Err(Error::Forbidden),
        StatusCode::TOO_MANY_REQUESTS => Err(Error::Throttled),
        status => Err(Error::Status(status.as_u16())),
    }
}

/// Target of a redirect: invalid without a readable `Location`, on another
/// origin [`Error::ForeignOrigin`].
fn redirect_target(current: &Url, headers: &HeaderMap) -> Result<Url, Error> {
    let location = headers
        .get(header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(Error::InvalidResponse)?;
    let target = current.join(location).map_err(|_| Error::InvalidResponse)?;
    if target.origin() == current.origin() {
        Ok(target)
    } else {
        Err(Error::ForeignOrigin)
    }
}

/// Reads at most 256 KiB and parses it as JSON; an abort is
/// [`Error::Unreachable`], anything else [`Error::InvalidResponse`]. Also used
/// for other requests of the backend to mail servers (diagnostics, DCR).
pub async fn read_json<T: DeserializeOwned>(mut response: reqwest::Response) -> Result<T, Error> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::Unreachable)? {
        if body.len() + chunk.len() > MAX_BODY {
            return Err(Error::InvalidResponse);
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| Error::InvalidResponse)
}

/// `other` (absolute or relative to `base`) if it has the same origin.
pub fn same_origin(base: &Url, other: &str) -> Option<Url> {
    base.join(other)
        .ok()
        .filter(|url| url.origin() == base.origin())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_hides_secrets() {
        let basic = Auth::Basic {
            username: "noreply@example.com".into(),
            password: "top-secret".into(),
        };
        let shown = format!("{basic:?}");
        assert!(shown.contains("noreply@example.com"));
        assert!(!shown.contains("top-secret"));
        assert_eq!(
            format!("{:?}", Auth::Bearer("tok-123".into())),
            "Bearer(***)"
        );
    }

    #[test]
    fn same_origin_only() {
        let base = Url::parse("https://mail.example.com").unwrap();
        assert_eq!(
            same_origin(&base, "/jmap/").map(String::from),
            Some("https://mail.example.com/jmap/".into())
        );
        assert!(same_origin(&base, "https://mail.example.com:8443/jmap/").is_none());
        assert!(same_origin(&base, "http://mail.example.com/jmap/").is_none());
        assert!(same_origin(&base, "//other.example.com/jmap/").is_none());
    }

    #[test]
    fn redirects() {
        let current = Url::parse("https://mail.example.com/.well-known/jmap").unwrap();
        let headers = |location: Option<&str>| {
            let mut headers = HeaderMap::new();
            if let Some(location) = location {
                headers.insert(header::LOCATION, HeaderValue::from_str(location).unwrap());
            }
            headers
        };
        assert_eq!(
            redirect_target(&current, &headers(Some("/jmap/session"))).map(String::from),
            Ok("https://mail.example.com/jmap/session".into())
        );
        assert_eq!(
            redirect_target(&current, &headers(Some("https://other.example.com/jmap"))),
            Err(Error::ForeignOrigin)
        );
        // Without a target it is no redirect to another origin.
        assert_eq!(
            redirect_target(&current, &headers(None)),
            Err(Error::InvalidResponse)
        );
        assert_eq!(
            redirect_target(&current, &headers(Some("http://[::1"))),
            Err(Error::InvalidResponse)
        );
    }

    #[test]
    fn statuses() {
        assert_eq!(check(StatusCode::OK), Ok(()));
        assert_eq!(check(StatusCode::UNAUTHORIZED), Err(Error::AuthFailed));
        assert_eq!(check(StatusCode::FORBIDDEN), Err(Error::Forbidden));
        assert_eq!(check(StatusCode::TOO_MANY_REQUESTS), Err(Error::Throttled));
        assert_eq!(check(StatusCode::BAD_GATEWAY), Err(Error::Status(502)));
    }
}
