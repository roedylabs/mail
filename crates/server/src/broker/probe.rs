//! Diagnosis of a mail server ("Test connection"): three checks, one per row
//! in the web app's diagnosis.
//!
//! 1. **JMAP session** (`reach`): `GET {url}/.well-known/jmap` (redirects
//!    only to the same origin) returns a session with JMAP Core and Mail.
//!    Stalwart answers it even without sign-in; if a server requires one,
//!    it counts as reachable, CORS then stays `unk`. The session's `apiUrl`
//!    must lie on the same origin, otherwise the app's CSP would not allow
//!    the requests.
//! 2. **CORS** (`cors`): preflight to the `apiUrl` with the app's origin,
//!    `Authorization` and `Content-Type` (JSON is not a "simple" type);
//!    `Access-Control-Allow-Origin` must be `*` or the origin,
//!    `Access-Control-Allow-Headers` must name both – `*` only suffices for
//!    `Content-Type`, not for `Authorization` (Fetch standard).
//! 3. **OAuth** (`oauth`): the metadata (RFC 8414) is that of Stalwart
//!    v1 – with `revocation_endpoint` and `protected_resources`, which v0.16
//!    does not know (`unsupported_version`, even without a client ID) –, a
//!    client ID is configured, and the metadata names `issuer` (the server's
//!    origin – the browser compares it with `iss` of the redirect back,
//!    RFC 9207), authorization, token and revocation endpoints on the same
//!    origin, `authorization_code`/`refresh_token`, PKCE with S256 and the
//!    client authentication: without a secret (`none`) or with a secret
//!    (`client_secret_basic` or `client_secret_post`; the backend then exchanges
//!    the code). Missing lists apply with the defaults of
//!    RFC 8414 (no refresh tokens, no PKCE, only `client_secret_basic`).
//!    Whether Stalwart accepts the client ID only shows at the first
//!    sign-in. `protected_resources` only counts if present: Stalwart names
//!    `https://…` there even with an issuer `http://…`.
//!
//! If the server is not reachable, CORS and OAuth stay `unk`. If it throttles
//! the backend's requests (`429`, Stalwart's anonymous limit: 100
//! requests per minute and IP), the affected check and every
//! further one stays `unk` (`throttled`), and the report names the wait time from
//! `Retry-After`.

use std::{collections::HashMap, time::Duration};

use reqwest::{
    Client, Method, StatusCode,
    header::{self, HeaderMap},
};
use serde::{Deserialize, Serialize};
use url::Url;

use super::{read_json, same_origin};
use crate::{
    app::AppState,
    db::{
        self,
        repo::servers::{self, Server},
    },
};

const CORE: &str = "urn:ietf:params:jmap:core";
const MAIL: &str = "urn:ietf:params:jmap:mail";
const MAX_REDIRECTS: usize = 3;
/// Longer wait times from `Retry-After` count as this.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(3600);

/// State of a check as the web app shows it (`ok`, `err`, `unk`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
    Err,
    /// Not checked.
    #[default]
    Unk,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Err => "err",
            Self::Unk => "unk",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "ok" => Some(Self::Ok),
            "err" => Some(Self::Err),
            "unk" => Some(Self::Unk),
            _ => None,
        }
    }
}

/// Result of the diagnosis; for `err` and `unk`, `reasons` names the cause as a
/// stable key (log, API response).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Report {
    pub reach: Status,
    pub cors: Status,
    pub oauth: Status,
    pub reasons: Reasons,
    /// Wait time if the mail server throttled (`throttled`).
    #[serde(skip)]
    pub retry_after: Option<Duration>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Reasons {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reach: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cors: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth: Option<&'static str>,
}

/// What is checked.
pub struct Target<'a> {
    /// Base URL from the registry (origin only).
    pub base_url: &'a Url,
    pub client_id: Option<&'a str>,
    /// A client secret is configured (confidential client).
    pub has_secret: bool,
    /// Origin of the app, e.g. `https://app.example.com`.
    pub origin: &'a str,
}

/// Checks a server of the registry like "Test connection" and stores the
/// result (administration and job `server_probe`); `true` if it was
/// stored – if the server was changed meanwhile, it does
/// not count. With `keep_if_throttled` (job) a throttled test does not replace the
/// last result: the next run then checks again an hour later
/// instead of showing "Not checked yet" for a day.
pub async fn test_registered(
    state: &AppState,
    server: &Server,
    keep_if_throttled: bool,
) -> anyhow::Result<(Report, bool)> {
    let base_url = Url::parse(&server.base_url)
        .map_err(|e| anyhow::anyhow!("servers.base_url of {} invalid: {e}", server.id))?;
    let origin = state.public_url().origin().ascii_serialization();
    let report = probe(
        &state.http,
        &Target {
            base_url: &base_url,
            client_id: server.client_id.as_deref(),
            has_secret: server.has_secret,
            origin: &origin,
        },
    )
    .await;
    tracing::info!(
        server = %server.id,
        url = %server.base_url,
        reach = report.reach.as_str(),
        cors = report.cors.as_str(),
        oauth = report.oauth.as_str(),
        reasons = ?report.reasons,
        "Mail server tested"
    );
    if keep_if_throttled && report.retry_after.is_some() {
        return Ok((report, false));
    }
    let (id, url, client_id, saved) = (
        server.id.clone(),
        server.base_url.clone(),
        server.client_id.clone(),
        report.clone(),
    );
    let recorded = db::call(&state.db, move |conn| {
        Ok(servers::record_test(
            conn,
            &id,
            &url,
            client_id.as_deref(),
            &saved,
        )?)
    })
    .await?;
    Ok((report, recorded))
}

pub async fn probe(http: &Client, target: &Target<'_>) -> Report {
    let mut report = Report::default();
    let preflight_url = match session(http, target).await {
        Session::Found { api_url, cors } => {
            report.reach = Status::Ok;
            Some((api_url, cors))
        }
        // Without a session there is no `apiUrl` for the preflight. `/.well-known/*`
        // is no substitute: Stalwart always answers `OPTIONS` there
        // with open CORS.
        Session::AuthRequired => {
            report.reach = Status::Ok;
            report.reasons.reach = Some("auth_required");
            None
        }
        Session::Failed(reason) => {
            report.reach = Status::Err;
            report.reasons.reach = Some(reason);
            report.reasons.cors = Some("not_reachable");
            report.reasons.oauth = Some("not_reachable");
            return report;
        }
        // It would throttle further requests the same way.
        Session::Throttled(retry_after) => {
            report.reasons = Reasons {
                reach: Some(THROTTLED),
                cors: Some(THROTTLED),
                oauth: Some(THROTTLED),
            };
            report.retry_after = Some(retry_after);
            return report;
        }
    };

    (report.cors, report.reasons.cors) = match preflight_url {
        Some((url, session_cors)) => match cors(http, &url, target.origin, session_cors).await {
            Ok(()) => (Status::Ok, None),
            Err(Failure::Err(reason)) => (Status::Err, Some(reason)),
            Err(Failure::Throttled(retry_after)) => {
                report.reasons.cors = Some(THROTTLED);
                report.reasons.oauth = Some(THROTTLED);
                report.retry_after = Some(retry_after);
                return report;
            }
        },
        None => (Status::Unk, Some("no_api_url")),
    };

    (report.oauth, report.reasons.oauth) = match oauth(http, target).await {
        Ok(()) => (Status::Ok, None),
        Err(Failure::Err(reason)) => (Status::Err, Some(reason)),
        Err(Failure::Throttled(retry_after)) => {
            report.retry_after = Some(retry_after);
            (Status::Unk, Some(THROTTLED))
        }
    };
    report
}

/// Reason when the mail server throttled with `429`.
const THROTTLED: &str = "throttled";

/// Why a check is not `ok`.
enum Failure {
    Err(&'static str),
    /// `429`: not checked, wait time from `Retry-After`.
    Throttled(Duration),
}

impl From<&'static str> for Failure {
    fn from(reason: &'static str) -> Self {
        Self::Err(reason)
    }
}

/// Wait time of a `429` response from `Retry-After` (seconds, RFC 9110
/// section 10.2.3); without a readable value one minute – that is the
/// window of Stalwart's anonymous limit.
pub(super) fn retry_after(headers: &HeaderMap) -> Duration {
    headers
        .get(header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map_or(Duration::from_secs(60), |secs| {
            Duration::from_secs(secs).clamp(Duration::from_secs(1), MAX_RETRY_AFTER)
        })
}

enum Session {
    /// Session with Core and Mail; `cors`: whether the response allowed the app
    /// origin.
    Found {
        api_url: Url,
        cors: bool,
    },
    /// 401: the server requires sign-in for the session.
    AuthRequired,
    Failed(&'static str),
    Throttled(Duration),
}

#[derive(Deserialize)]
struct SessionResource {
    capabilities: HashMap<String, serde_json::Value>,
    #[serde(rename = "apiUrl")]
    api_url: String,
}

async fn session(http: &Client, target: &Target<'_>) -> Session {
    let Ok(mut url) = target.base_url.join("/.well-known/jmap") else {
        return Session::Failed("invalid_url");
    };
    for _ in 0..=MAX_REDIRECTS {
        let request = http
            .get(url.clone())
            .header(header::ACCEPT, "application/json")
            .header(header::ORIGIN, target.origin);
        let Ok(response) = request.send().await else {
            return Session::Failed("unreachable");
        };
        let status = response.status();
        if status.is_redirection() {
            let next = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|location| same_origin(&url, location));
            match next {
                Some(next) => {
                    url = next;
                    continue;
                }
                None => return Session::Failed("redirect_other_origin"),
            }
        }
        if status == StatusCode::UNAUTHORIZED {
            return Session::AuthRequired;
        }
        if status == StatusCode::TOO_MANY_REQUESTS {
            return Session::Throttled(retry_after(response.headers()));
        }
        if !status.is_success() {
            return Session::Failed("no_session");
        }
        let cors = allows_origin(response.headers(), target.origin);
        let Some(session) = read_json::<SessionResource>(response).await else {
            return Session::Failed("no_session");
        };
        if !session.capabilities.contains_key(CORE) || !session.capabilities.contains_key(MAIL) {
            return Session::Failed("no_mail");
        }
        // Relative to the session's address (after the redirects, which stayed
        // on the base URL's origin).
        return match same_origin(&url, &session.api_url) {
            Some(api_url) => Session::Found { api_url, cors },
            None => Session::Failed("api_url_mismatch"),
        };
    }
    Session::Failed("too_many_redirects")
}

async fn cors(http: &Client, url: &Url, origin: &str, session_cors: bool) -> Result<(), Failure> {
    let response = http
        .request(Method::OPTIONS, url.clone())
        .header(header::ORIGIN, origin)
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
        .header(
            header::ACCESS_CONTROL_REQUEST_HEADERS,
            "authorization, content-type",
        )
        .send()
        .await
        .map_err(|_| "preflight_failed")?;
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        return Err(Failure::Throttled(retry_after(response.headers())));
    }
    if !response.status().is_success() {
        return Err("preflight_status".into());
    }
    let headers = response.headers();
    if !allows_origin(headers, origin) || !session_cors {
        return Err("origin_not_allowed".into());
    }
    let allowed: Vec<String> = headers
        .get_all(header::ACCESS_CONTROL_ALLOW_HEADERS)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|name| name.trim().to_ascii_lowercase())
        .collect();
    // `*` applies to all headers except `Authorization` (the app sends no
    // cookies, so no "credentials" in the CORS sense).
    if !allowed.iter().any(|name| name == "authorization") {
        return Err("authorization_not_allowed".into());
    }
    if !allowed
        .iter()
        .any(|name| name == "content-type" || name == "*")
    {
        return Err("content_type_not_allowed".into());
    }
    Ok(())
}

fn allows_origin(headers: &HeaderMap, origin: &str) -> bool {
    headers
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            let value = value.trim();
            value == "*" || value.eq_ignore_ascii_case(origin)
        })
}

/// OAuth metadata (RFC 8414), as far as the backend needs it.
#[derive(Clone, Deserialize)]
pub(super) struct Metadata {
    pub issuer: Option<String>,
    pub authorization_endpoint: Option<String>,
    pub token_endpoint: String,
    pub registration_endpoint: Option<String>,
    /// RFC 7009; only Stalwart v1 names it.
    pub revocation_endpoint: Option<String>,
    /// RFC 9728, section 4; only Stalwart v1 names it.
    pub protected_resources: Option<serde_json::Value>,
    pub grant_types_supported: Option<Vec<String>>,
    pub code_challenge_methods_supported: Option<Vec<String>>,
    pub token_endpoint_auth_methods_supported: Option<Vec<String>>,
    /// Client authentication at the revocation endpoint (RFC 8414, section 2).
    pub revocation_endpoint_auth_methods_supported: Option<Vec<String>>,
}

impl Metadata {
    /// Metadata of Stalwart v1: v0.16 names neither
    /// `revocation_endpoint` nor `protected_resources`.
    pub fn is_v1(&self) -> bool {
        self.revocation_endpoint.is_some() && self.protected_resources.is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum MetadataError {
    Unreachable,
    /// No (readable) metadata at the address.
    Missing,
    /// `429` with the wait time from `Retry-After`.
    Throttled(Duration),
}

/// Reads `/.well-known/oauth-authorization-server`.
pub(super) async fn metadata(http: &Client, base_url: &Url) -> Result<Metadata, MetadataError> {
    let url = base_url
        .join("/.well-known/oauth-authorization-server")
        .map_err(|_| MetadataError::Missing)?;
    let response = http
        .get(url)
        .header(header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| MetadataError::Unreachable)?;
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        return Err(MetadataError::Throttled(retry_after(response.headers())));
    }
    if !response.status().is_success() {
        return Err(MetadataError::Missing);
    }
    read_json(response).await.ok_or(MetadataError::Missing)
}

async fn oauth(http: &Client, target: &Target<'_>) -> Result<(), Failure> {
    // An old version reports the diagnosis even without a client ID: then
    // no client helps.
    let metadata = match metadata(http, target.base_url).await {
        Ok(metadata) if !metadata.is_v1() => return Err("unsupported_version".into()),
        Err(MetadataError::Throttled(retry_after)) => {
            return Err(Failure::Throttled(retry_after));
        }
        _ if target.client_id.is_none() => return Err("no_client_id".into()),
        Ok(metadata) => metadata,
        Err(MetadataError::Unreachable) => return Err("metadata_unreachable".into()),
        Err(MetadataError::Missing) => return Err("no_metadata".into()),
    };
    check_metadata(target.base_url, &metadata, target.has_secret).map_err(Failure::Err)
}

/// What the app needs from the authorization server. If a list is missing,
/// the default from RFC 8414, section 2, applies.
fn check_metadata(
    base_url: &Url,
    metadata: &Metadata,
    has_secret: bool,
) -> Result<(), &'static str> {
    if !is_issuer(base_url, metadata.issuer.as_deref()) {
        return Err("issuer_mismatch");
    }
    let on_origin = |endpoint: &str| same_origin(base_url, endpoint).is_some();
    if !metadata
        .authorization_endpoint
        .as_deref()
        .is_some_and(on_origin)
    {
        return Err("authorization_endpoint_mismatch");
    }
    if !on_origin(&metadata.token_endpoint) {
        return Err("token_endpoint_mismatch");
    }
    // On revocation the refresh token and secret go there.
    if !metadata
        .revocation_endpoint
        .as_deref()
        .is_some_and(on_origin)
    {
        return Err("revocation_endpoint_mismatch");
    }
    let supports = |list: &Option<Vec<String>>, default: &[&str], value: &str| match list {
        Some(list) => list.iter().any(|item| item == value),
        None => default.contains(&value),
    };
    let grants = &metadata.grant_types_supported;
    let default_grants = ["authorization_code", "implicit"];
    if !supports(grants, &default_grants, "authorization_code")
        || !supports(grants, &default_grants, "refresh_token")
    {
        return Err("grant_types");
    }
    if !supports(&metadata.code_challenge_methods_supported, &[], "S256") {
        return Err("pkce");
    }
    // Without a secret the browser exchanges the code (public client), with a
    // secret the backend.
    let auth_methods = &metadata.token_endpoint_auth_methods_supported;
    let default_methods = ["client_secret_basic"];
    if has_secret {
        if !["client_secret_basic", "client_secret_post"]
            .into_iter()
            .any(|method| supports(auth_methods, &default_methods, method))
        {
            return Err("no_confidential_client");
        }
    } else if !supports(auth_methods, &default_methods, "none") {
        return Err("no_public_client");
    }
    Ok(())
}

/// `issuer` is the server's origin (RFC 8414, 2: `https`, without query
/// and fragment; for Stalwart the base URL), at most with a trailing `/`.
fn is_issuer(base_url: &Url, issuer: Option<&str>) -> bool {
    let Some(url) = issuer.and_then(|issuer| Url::parse(issuer).ok()) else {
        return false;
    };
    url.origin() == base_url.origin()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(items: &[&str]) -> Option<Vec<String>> {
        Some(items.iter().map(|item| (*item).to_owned()).collect())
    }

    #[test]
    fn metadata_needs_refresh_pkce_and_public_clients() {
        let base = Url::parse("https://mail.example.com").unwrap();
        let full = Metadata {
            issuer: Some("https://mail.example.com".into()),
            authorization_endpoint: Some("https://mail.example.com/login".into()),
            token_endpoint: "https://mail.example.com/auth/token".into(),
            registration_endpoint: None,
            revocation_endpoint: Some("https://mail.example.com/auth/revoke".into()),
            protected_resources: Some(serde_json::json!(["https://mail.example.com"])),
            grant_types_supported: list(&["authorization_code", "refresh_token"]),
            code_challenge_methods_supported: list(&["S256"]),
            token_endpoint_auth_methods_supported: list(&["none", "client_secret_basic"]),
            revocation_endpoint_auth_methods_supported: None,
        };
        assert_eq!(check_metadata(&base, &full, false), Ok(()));
        assert_eq!(check_metadata(&base, &full, true), Ok(()));

        let with = |change: fn(&mut Metadata)| {
            let mut metadata = full.clone();
            change(&mut metadata);
            check_metadata(&base, &metadata, false)
        };
        assert_eq!(
            with(|m| m.issuer = Some("https://mail.example.com/".into())),
            Ok(())
        );
        for issuer in [
            None,
            Some("https://other.example"),
            Some("http://mail.example.com"),
            Some("https://mail.example.com/realms/a"),
            Some("https://mail.example.com?x=1"),
            Some("mail.example.com"),
        ] {
            let mut metadata = full.clone();
            metadata.issuer = issuer.map(str::to_owned);
            assert_eq!(
                check_metadata(&base, &metadata, false),
                Err("issuer_mismatch"),
                "{issuer:?}"
            );
        }
        assert_eq!(
            with(|m| m.authorization_endpoint = None),
            Err("authorization_endpoint_mismatch")
        );
        assert_eq!(
            with(|m| m.authorization_endpoint = Some("https://sso.example.com/login".into())),
            Err("authorization_endpoint_mismatch")
        );
        assert_eq!(
            with(|m| m.authorization_endpoint = Some("http://mail.example.com/login".into())),
            Err("authorization_endpoint_mismatch")
        );
        assert_eq!(
            with(|m| m.token_endpoint = "https://other.example/auth/token".into()),
            Err("token_endpoint_mismatch")
        );
        assert_eq!(with(|m| m.token_endpoint = "/auth/token".into()), Ok(()));
        assert_eq!(
            with(|m| m.revocation_endpoint = Some("https://other.example/auth/revoke".into())),
            Err("revocation_endpoint_mismatch")
        );
        assert_eq!(
            with(|m| m.revocation_endpoint = None),
            Err("revocation_endpoint_mismatch")
        );
        assert_eq!(with(|m| m.grant_types_supported = None), Err("grant_types"));
        assert_eq!(
            with(|m| m.grant_types_supported = list(&["authorization_code"])),
            Err("grant_types")
        );
        assert_eq!(
            with(|m| m.code_challenge_methods_supported = None),
            Err("pkce")
        );
        assert_eq!(
            with(|m| m.code_challenge_methods_supported = list(&["plain"])),
            Err("pkce")
        );
        assert_eq!(
            with(|m| m.token_endpoint_auth_methods_supported = None),
            Err("no_public_client")
        );
        assert_eq!(
            with(|m| m.token_endpoint_auth_methods_supported = list(&["client_secret_post"])),
            Err("no_public_client")
        );

        // With a secret: client authentication at the token endpoint.
        let confidential = |methods: Option<Vec<String>>| {
            let mut metadata = full.clone();
            metadata.token_endpoint_auth_methods_supported = methods;
            check_metadata(&base, &metadata, true)
        };
        assert_eq!(confidential(None), Ok(()));
        assert_eq!(confidential(list(&["client_secret_post"])), Ok(()));
        assert_eq!(
            confidential(list(&["none", "private_key_jwt"])),
            Err("no_confidential_client")
        );

        // Stalwart v1 recognises the diagnosis by revocation and protected
        // resources (v0.16 names neither); locally v1.0.2 names
        // `https://…` there even with an issuer `http://…`.
        assert!(full.is_v1());
        let mut old = full.clone();
        old.revocation_endpoint = None;
        assert!(!old.is_v1());
        let mut old = full.clone();
        old.protected_resources = None;
        assert!(!old.is_v1());
    }

    #[test]
    fn reads_retry_after_in_seconds() {
        let wait = |value: Option<&str>| {
            let mut headers = HeaderMap::new();
            if let Some(value) = value {
                headers.insert(header::RETRY_AFTER, value.parse().unwrap());
            }
            retry_after(&headers).as_secs()
        };
        assert_eq!(wait(Some("17")), 17);
        assert_eq!(wait(Some(" 5 ")), 5);
        assert_eq!(wait(Some("0")), 1);
        assert_eq!(wait(Some("86400")), 3600);
        // Date or no value: one minute, Stalwart's window.
        assert_eq!(wait(Some("Wed, 21 Oct 2026 07:28:00 GMT")), 60);
        assert_eq!(wait(None), 60);
    }
}
