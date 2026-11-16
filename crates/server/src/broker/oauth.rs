//! Requests to the mail server's token endpoint (RFC 6749): refresh
//! (section 6) for the token broker and code exchange (section 4.1.3) for
//! confidential clients whose secret only the backend knows, plus revoking a
//! grant (RFC 7009) when removing a
//! mail account. The OAuth metadata names the endpoints;
//! credentials only go to the same origin as the server.

use base64::Engine as _;
use reqwest::{Client as Http, StatusCode, header};
use serde::Deserialize;
use url::{Url, form_urlencoded};

use super::{oauth_error, probe, read_json, same_origin};

/// Longest token the app accepts (like `POST mail-accounts`).
pub const MAX_TOKEN: usize = 8192;

/// The client the backend acts as.
#[derive(Clone, Copy)]
pub struct Client<'a> {
    pub id: &'a str,
    /// Secret of a confidential client; without one the client counts as
    /// public and only sends its ID.
    pub secret: Option<&'a str>,
}

/// What the client exchanges.
#[derive(Clone, Copy)]
pub enum Grant<'a> {
    Code {
        code: &'a str,
        verifier: &'a str,
        redirect_uri: &'a str,
    },
    Refresh(&'a str),
}

/// Response of the token endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tokens {
    pub access_token: String,
    /// Missing on refresh when the server keeps the previous one valid
    /// (RFC 6749, Abschnitt 6).
    pub refresh_token: Option<String>,
    /// Seconds from the response.
    pub expires_in: Option<u32>,
}

/// Why the exchange failed; [`Error::reason`] is the key for log
/// and API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Server, metadata or token endpoint not reachable.
    Unreachable,
    /// No metadata or no token endpoint on the server's origin.
    Unsupported,
    /// `invalid_grant`: code or refresh token expired, redeemed,
    /// revoked or issued for another client. Stalwart v1
    /// revokes the whole grant when a replaced refresh token
    /// comes back.
    InvalidGrant,
    /// `invalid_client`: client unknown or secret wrong.
    InvalidClient,
    /// 429: the mail server throttles requests from this address.
    Throttled,
    /// 400 or 401 with another error code, e.g.
    /// `unauthorized_client`.
    Rejected(String),
    /// Unexpected HTTP status, e.g. 5xx or 401 without an OAuth error (more
    /// likely from a proxy in front of the server).
    Status(u16),
    /// Response unreadable or without a usable token.
    InvalidResponse,
}

impl Error {
    pub fn reason(&self) -> &'static str {
        match self {
            Self::Unreachable => "unreachable",
            Self::Unsupported => "unsupported",
            Self::InvalidGrant => "invalid_grant",
            Self::InvalidClient => "invalid_client",
            Self::Throttled => "throttled",
            Self::Rejected(_) => "rejected",
            Self::Status(_) => "http_status",
            Self::InvalidResponse => "invalid_response",
        }
    }

    /// The server rejected what the backend sent; the same
    /// attempt fails again (Fail2Ban). This includes
    /// `unauthorized_client`: that is how Stalwart v1 names a client that may not
    /// use the grant type.
    pub fn is_rejected(&self) -> bool {
        match self {
            Self::InvalidGrant | Self::InvalidClient => true,
            Self::Rejected(code) => code == "unauthorized_client",
            _ => false,
        }
    }
}

#[derive(Deserialize)]
struct Response {
    access_token: String,
    token_type: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

/// Exchanges `grant` at the token endpoint of `base_url`.
pub async fn request(
    http: &Http,
    base_url: &Url,
    client: Client<'_>,
    grant: Grant<'_>,
) -> Result<Tokens, Error> {
    let metadata = metadata(http, base_url).await?;
    let endpoint = same_origin(base_url, &metadata.token_endpoint).ok_or(Error::Unsupported)?;
    let fields = match grant {
        Grant::Code {
            code,
            verifier,
            redirect_uri,
        } => vec![
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
        ],
        Grant::Refresh(token) => vec![("grant_type", "refresh_token"), ("refresh_token", token)],
    };
    let methods = metadata.token_endpoint_auth_methods_supported.as_deref();
    let response = post(http, endpoint, methods, client, &fields).await?;
    if response.status() != StatusCode::OK {
        return Err(failure(response).await);
    }
    let body = read_json::<Response>(response)
        .await
        .ok_or(Error::InvalidResponse)?;
    if body
        .token_type
        .as_deref()
        .is_some_and(|kind| !kind.eq_ignore_ascii_case("bearer"))
    {
        return Err(Error::InvalidResponse);
    }
    let access_token = valid_token(body.access_token).ok_or(Error::InvalidResponse)?;
    let refresh_token = match body.refresh_token {
        Some(token) => Some(valid_token(token).ok_or(Error::InvalidResponse)?),
        None => None,
    };
    Ok(Tokens {
        access_token,
        refresh_token,
        expires_in: body
            .expires_in
            .map(|secs| u32::try_from(secs).unwrap_or(u32::MAX)),
    })
}

/// Revokes the grant behind `refresh_token` at the metadata's
/// `revocation_endpoint` (RFC 7009, section 2.1); Stalwart v1 deletes the whole grant
/// including access tokens. The server also answers an unknown token
/// with 200, Stalwart answers a wrong secret only if the grant belongs to the
/// client. How the client authenticates is given by the methods of the
/// revocation endpoint.
pub async fn revoke(
    http: &Http,
    base_url: &Url,
    client: Client<'_>,
    refresh_token: &str,
) -> Result<(), Error> {
    let metadata = metadata(http, base_url).await?;
    let endpoint = metadata
        .revocation_endpoint
        .as_deref()
        .and_then(|endpoint| same_origin(base_url, endpoint))
        .ok_or(Error::Unsupported)?;
    let fields = [
        ("token", refresh_token),
        ("token_type_hint", "refresh_token"),
    ];
    let methods = metadata
        .revocation_endpoint_auth_methods_supported
        .as_deref();
    let response = post(http, endpoint, methods, client, &fields).await?;
    if response.status() != StatusCode::OK {
        return Err(failure(response).await);
    }
    Ok(())
}

async fn metadata(http: &Http, base_url: &Url) -> Result<probe::Metadata, Error> {
    probe::metadata(http, base_url)
        .await
        .map_err(|error| match error {
            probe::MetadataError::Unreachable => Error::Unreachable,
            probe::MetadataError::Missing => Error::Unsupported,
            probe::MetadataError::Throttled(_) => Error::Throttled,
        })
}

/// Sends `fields` as a form with the client's authentication: the secret
/// via Basic where the endpoint accepts it ([`use_basic`] with its
/// `methods` from the metadata), otherwise ID and, if any, secret in the body.
async fn post(
    http: &Http,
    endpoint: Url,
    methods: Option<&[String]>,
    client: Client<'_>,
    fields: &[(&str, &str)],
) -> Result<reqwest::Response, Error> {
    let use_basic = use_basic(methods, client);
    // The serializer is not `Send` and ends before the first `await`.
    let body = {
        let mut form = form_urlencoded::Serializer::new(String::new());
        form.extend_pairs(fields);
        if !use_basic {
            form.append_pair("client_id", client.id);
            if let Some(secret) = client.secret {
                form.append_pair("client_secret", secret);
            }
        }
        form.finish()
    };
    let mut builder = http
        .post(endpoint)
        .header(header::ACCEPT, "application/json")
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(body);
    if let (true, Some(secret)) = (use_basic, client.secret) {
        builder = builder.header(header::AUTHORIZATION, basic(client.id, secret));
    }
    builder.send().await.map_err(|_| Error::Unreachable)
}

/// Why the server did not answer a request with 200.
async fn failure(response: reqwest::Response) -> Error {
    match response.status() {
        StatusCode::TOO_MANY_REQUESTS => Error::Throttled,
        status @ (StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED) => {
            match oauth_error(response).await.as_deref() {
                Some("invalid_grant") => Error::InvalidGrant,
                Some("invalid_client") => Error::InvalidClient,
                Some(code) => Error::Rejected(code.to_owned()),
                // Would lock the account although the mail server rejected nothing.
                None if status == StatusCode::UNAUTHORIZED => Error::Status(status.as_u16()),
                None => Error::Rejected("unknown".into()),
            }
        }
        status => Error::Status(status.as_u16()),
    }
}

/// Does the client send its secret via Basic? RFC 6749, section 2.3.1: Basic
/// is mandatory for every server and applies when the metadata names no
/// `methods` list for the endpoint (RFC 8414); if it does not name Basic,
/// the secret goes in the body. Stalwart v1 reverses Basic's form encoding.
fn use_basic(methods: Option<&[String]>, client: Client<'_>) -> bool {
    client.secret.is_some()
        && methods.is_none_or(|methods| methods.iter().any(|m| m == "client_secret_basic"))
}

fn encode(value: &str) -> String {
    form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// `client_secret_basic`: ID and secret first encoded as
/// `application/x-www-form-urlencoded` (RFC 6749, section 2.3.1).
fn basic(id: &str, secret: &str) -> String {
    let pair = format!("{}:{}", encode(id), encode(secret));
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(pair)
    )
}

/// Why a token the app stores and passes on is unfit (code
/// for the API); `None` if it is fit: not empty, visible ASCII
/// (RFC 6750 and API keys), at most [`MAX_TOKEN`] bytes.
pub fn token_problem(token: &str) -> Option<&'static str> {
    if token.is_empty() {
        Some("required")
    } else if token.len() > MAX_TOKEN {
        Some("too_long")
    } else if !token.bytes().all(|b| b.is_ascii_graphic()) {
        Some("invalid")
    } else {
        None
    }
}

fn valid_token(token: String) -> Option<String> {
    token_problem(&token).is_none().then_some(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_auth_encodes_id_and_secret_first() {
        // "a b:c" / "ä&=" → `a+b%3Ac:%C3%A4%26%3D`
        let header = basic("a b:c", "ä&=");
        let encoded = header.strip_prefix("Basic ").unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        assert_eq!(decoded, b"a+b%3Ac:%C3%A4%26%3D");
    }

    #[test]
    fn secrets_go_per_basic_unless_the_server_lists_only_other_methods() {
        let methods = |list: &[&str]| list.iter().map(|m| (*m).to_owned()).collect::<Vec<_>>();
        let client = |secret| Client {
            id: "client-1",
            secret,
        };
        // Also secrets the encoding changes (Stalwart v1 decodes).
        let both = methods(&["client_secret_post", "client_secret_basic"]);
        assert!(use_basic(Some(&both), client(Some("secret"))));
        assert!(use_basic(Some(&both), client(Some("sec+ret/="))));
        assert!(!use_basic(Some(&both), client(None)));
        // Without a list, Basic applies.
        assert!(use_basic(None, client(Some("sec+ret/="))));
        let post_only = methods(&["client_secret_post"]);
        assert!(!use_basic(Some(&post_only), client(Some("secret"))));
    }

    #[test]
    fn unauthorized_clients_are_rejected_other_codes_not() {
        assert!(Error::InvalidGrant.is_rejected());
        assert!(Error::InvalidClient.is_rejected());
        assert!(Error::Rejected("unauthorized_client".into()).is_rejected());
        assert!(!Error::Rejected("invalid_scope".into()).is_rejected());
        assert!(!Error::Status(401).is_rejected());
        assert!(!Error::Throttled.is_rejected());
    }

    #[test]
    fn tokens_must_be_visible_ascii() {
        assert_eq!(
            valid_token("abc.DEF-1_~+/=".into()).as_deref(),
            Some("abc.DEF-1_~+/=")
        );
        assert_eq!(valid_token(String::new()), None);
        assert_eq!(valid_token("a b".into()), None);
        assert_eq!(valid_token("ä".into()), None);
        assert_eq!(valid_token("x".repeat(MAX_TOKEN + 1)), None);
    }
}
