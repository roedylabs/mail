//! Mock of the Stalwart endpoints used by diagnostics, DCR and sending
//! system mails (behaviour as in Stalwart v1), on `127.0.0.1` with
//! a random port. Without sign-in the session only returns the capabilities;
//! with [`MAIL_USER`]/[`MAIL_PASSWORD`] or [`MAIL_TOKEN`] an account with two
//! identities, with [`OTHER_TOKEN`] and [`NAMED_TOKEN`] further accounts
//! (mail accounts). The token endpoint exchanges codes and refresh
//! tokens for access tokens, which the session accepts too, and rotates
//! refresh tokens strictly like v1 ([`Grant`]); the revocation endpoint
//! deletes grants (token broker).

#![allow(dead_code, reason = "not every test file uses everything")]

use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use axum::{
    Form, Json, Router,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{self, get, post},
};
use serde_json::{Value, json};
use tokio::{net::TcpListener, sync::oneshot};

pub const ADMIN: &str = "admin";
pub const ADMIN_PASSWORD: &str = "secret";
pub const CLIENT_ID: &str = "stateless-client-1";
/// Sending account with app password or token (tests only).
pub const MAIL_USER: &str = "noreply@example.com";
pub const MAIL_PASSWORD: &str = "app-password-1";
pub const MAIL_TOKEN: &str = "token-1";
/// Another account: `a2`, `eva@example.com`.
pub const OTHER_TOKEN: &str = "token-2";
/// Account `a3` with the username `erika` (no address) and the identities
/// `info@example.com` and `erika@example.com`.
pub const NAMED_TOKEN: &str = "token-3";

/// Refresh tokens the token endpoint knows from the start: for [`MAIL_USER`]
/// and the account of [`OTHER_TOKEN`] respectively.
pub const REFRESH_TOKEN: &str = "refresh-secret-1";
pub const OTHER_REFRESH: &str = "refresh-secret-2";
/// Codes from the sign-in redirect (each redeemable once), with
/// [`VERIFIER`].
pub const CODE: &str = "code-1";
pub const OTHER_CODE: &str = "code-2";
pub const VERIFIER: &str = "verifier-0123456789-0123456789-0123456789-abcdef";
/// Secret of the confidential client ([`Options::client_secret`]); with
/// characters that Basic's form encoding changes.
pub const CLIENT_SECRET: &str = "client+secret/=";

/// An account on the server.
pub struct Account {
    pub id: &'static str,
    pub username: &'static str,
    identities: fn() -> Value,
}

const ACCOUNT: Account = Account {
    id: "a1",
    username: MAIL_USER,
    identities,
};
const OTHER: Account = Account {
    id: "a2",
    username: "eva@example.com",
    identities: || json!([{ "id": "i5", "name": "Eva", "email": "eva@example.com" }]),
};
const NAMED: Account = Account {
    id: "a3",
    username: "erika",
    identities: || {
        json!([
            { "id": "i6", "name": "All", "email": "*@example.com" },
            { "id": "i7", "name": "Info", "email": "info@example.com" },
            { "id": "i8", "name": "Erika", "email": "Erika@Example.com" },
        ])
    },
};

/// Wait time in `Retry-After` of throttled responses.
pub const RETRY_AFTER: u64 = 42;

/// What the server can do.
#[derive(Debug, Clone, Copy)]
pub struct Options {
    /// "Permissive CORS" in Stalwart.
    pub cors: bool,
    /// OAuth metadata under `/.well-known/oauth-authorization-server`.
    pub metadata: bool,
    /// Metadata like Stalwart v0.16: without `revocation_endpoint` and
    /// `protected_resources`.
    pub v016: bool,
    /// `/auth/register` answers with this status (402, 403, 429 …).
    pub register_status: Option<StatusCode>,
    /// `token_endpoint_auth_methods_supported` instead of Stalwart's list.
    pub auth_methods: Option<&'static [&'static str]>,
    /// After this many requests every further one answers with `429` and
    /// `Retry-After` (Stalwart's anonymous limit).
    pub throttle_after: Option<usize>,
    /// Session only with sign-in (401).
    pub session_needs_auth: bool,
    /// `apiUrl` on another host.
    pub foreign_api_url: bool,
    /// `Access-Control-Allow-Headers` instead of Stalwart's list.
    pub allow_headers: Option<&'static str>,
    /// Metadata without the optional lists (RFC 8414: defaults apply then).
    pub minimal_metadata: bool,
    /// `/.well-known/jmap` redirects to another origin.
    pub foreign_redirect: bool,
    /// `EmailSubmission/set` rejects with this error type.
    pub submission_error: Option<&'static str>,
    /// Account without a "Sent" mailbox.
    pub without_sent: bool,
    /// Relative `apiUrl` (`api/`, so `/jmap/api/`).
    pub relative_api_url: bool,
    /// `EmailSubmission/set` sends but does not name the submission.
    pub unreadable_submission: bool,
    /// `issuer` of the metadata on another host.
    pub foreign_issuer: bool,
    /// `downloadUrl` of the session on another host.
    pub foreign_download_url: bool,
    /// Confidential client: the token endpoint requires this secret from
    /// [`CLIENT_ID`].
    pub client_secret: Option<&'static str>,
    /// The client may redeem neither codes nor refresh tokens
    /// (`unauthorized_client`, like Stalwart v1 for a client without these
    /// grant types).
    pub unauthorized_client: bool,
    /// The refresh returns no new refresh token (RFC 6749 › 6 allows that;
    /// Stalwart v1 always rotates).
    pub keep_refresh: bool,
    /// `revocation_endpoint_auth_methods_supported` instead of v1's list.
    pub revocation_auth_methods: Option<&'static [&'static str]>,
    /// `expires_in` of the issued access tokens.
    pub expires_in: u64,
    /// How long the token endpoint takes for a response.
    pub token_delay: Duration,
    /// Account storage (`used`, `hardLimit`) for `Quota/get`; `None` like
    /// Stalwart without a limit (empty list).
    pub quota: Option<(u64, u64)>,
    /// `Quota/get` answers with `accountNotSupportedByMethod`.
    pub quota_unsupported: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            cors: true,
            metadata: true,
            v016: false,
            register_status: None,
            auth_methods: None,
            throttle_after: None,
            session_needs_auth: false,
            foreign_api_url: false,
            allow_headers: None,
            minimal_metadata: false,
            foreign_redirect: false,
            submission_error: None,
            without_sent: false,
            relative_api_url: false,
            unreadable_submission: false,
            foreign_issuer: false,
            foreign_download_url: false,
            client_secret: None,
            unauthorized_client: false,
            keep_refresh: false,
            revocation_auth_methods: None,
            expires_in: 3600,
            token_delay: Duration::ZERO,
            quota: None,
            quota_unsupported: false,
        }
    }
}

#[derive(Clone)]
struct Fake {
    base: String,
    options: Options,
    /// Requests so far (for `throttle_after`).
    requests: Arc<AtomicUsize>,
    /// Start of the server, reference for [`Call::at`].
    started: Instant,
    /// Bodies of the registrations.
    registrations: Arc<Mutex<Vec<Value>>>,
    mail: Arc<Mutex<MailState>>,
    tokens: Arc<Mutex<TokenState>>,
}

/// A request to the token or revocation endpoint.
#[derive(Debug, Clone)]
pub struct TokenRequest {
    pub form: HashMap<String, String>,
    pub authorization: Option<String>,
}

impl TokenRequest {
    fn new(headers: &HeaderMap, form: &HashMap<String, String>) -> Self {
        Self {
            form: form.clone(),
            authorization: headers
                .get(header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
        }
    }
}

/// A grant as in Stalwart v1 (`crates/common/src/auth/oauth/grant.rs`): every
/// refresh token carries a generation. A refresh with the current one issues
/// the next (`pending`); as long as that is unused, the current one issues it
/// again (response lost). If an older one comes back, the server revokes the
/// whole grant.
struct Grant {
    account: &'static Account,
    /// Client of the grant; undetermined for the predefined refresh tokens.
    client: Option<String>,
    generation: u32,
    pending: bool,
}

/// What a refresh with a generation does.
enum Rotation {
    /// Issue the next generation (again).
    Issue(u32),
    /// Replaced token reused: revoke the grant.
    Replay,
    Invalid,
}

impl Grant {
    fn rotation(&self, presented: u32) -> Rotation {
        // The current generation or, after a rotation, the issued one.
        let issued = self.pending && presented == self.generation + 1;
        if presented == self.generation || issued {
            Rotation::Issue(presented + 1)
        } else if presented < self.generation {
            Rotation::Replay
        } else {
            Rotation::Invalid
        }
    }
}

/// State of the token endpoint.
#[derive(Default)]
struct TokenState {
    grants: HashMap<u32, Grant>,
    /// Refresh tokens with grant and generation.
    refresh: HashMap<String, (u32, u32)>,
    codes: HashMap<String, &'static Account>,
    /// Issued access tokens; they are valid as long as their grant exists.
    access: HashMap<String, (&'static Account, u32)>,
    requests: Vec<TokenRequest>,
    revocations: Vec<TokenRequest>,
    /// Answers with this status instead of exchanging.
    failure: Option<StatusCode>,
    /// Exchanges, but answers with 504 (response lost on the way).
    lose: bool,
    next: u32,
}

impl TokenState {
    fn new() -> Self {
        let mut state = Self {
            codes: HashMap::from([(CODE.to_owned(), &ACCOUNT), (OTHER_CODE.to_owned(), &OTHER)]),
            ..Self::default()
        };
        for (token, account) in [(REFRESH_TOKEN, &ACCOUNT), (OTHER_REFRESH, &OTHER)] {
            let grant = state.grant(account, None);
            state.refresh.insert(token.to_owned(), (grant, 0));
        }
        state
    }

    fn issue(&mut self, kind: &str) -> String {
        self.next += 1;
        format!("{kind}-{}", self.next)
    }

    fn grant(&mut self, account: &'static Account, client: Option<String>) -> u32 {
        self.next += 1;
        let grant = Grant {
            account,
            client,
            generation: 0,
            pending: false,
        };
        self.grants.insert(self.next, grant);
        self.next
    }

    /// Grant and generation of a refresh token whose grant exists.
    fn refresh_of(&self, token: &str) -> Option<(u32, u32)> {
        self.refresh
            .get(token)
            .copied()
            .filter(|(grant, _)| self.grants.contains_key(grant))
    }

    /// A new access token for the grant.
    fn access_for(&mut self, grant: u32) -> String {
        let account = self.grants[&grant].account;
        let access = self.issue("access");
        self.access.insert(access.clone(), (account, grant));
        access
    }
}

/// What happened in the account.
#[derive(Debug, Default, Clone)]
pub struct MailState {
    /// Mails in the account by ID.
    pub emails: BTreeMap<String, Value>,
    /// Sent mails (state at sending).
    pub submitted: Vec<Value>,
    /// Abgewiesene Anmeldungen.
    pub failed_logins: usize,
    /// Signed-in requests to the `apiUrl` in order.
    pub calls: Vec<Call>,
    /// `EmailSubmission/set` rejects mails to this address
    /// ([`Server::reject_mail_to`]).
    reject_to: Option<String>,
    /// Mails rejected that way (state at the attempt).
    pub rejected: Vec<Value>,
    next_id: u32,
}

impl MailState {
    /// Number of signed-in requests to the `apiUrl`.
    pub fn requests(&self) -> usize {
        self.calls.len()
    }
}

/// A signed-in request to the `apiUrl`: time since the server start and the
/// methods in it, so that an unexpected request shows its origin in a test's
/// message.
#[derive(Debug, Clone)]
pub struct Call {
    pub at: Duration,
    pub methods: Vec<String>,
}

pub struct Server {
    pub url: String,
    registrations: Arc<Mutex<Vec<Value>>>,
    mail: Arc<Mutex<MailState>>,
    tokens: Arc<Mutex<TokenState>>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
}

impl Server {
    pub async fn start(options: Options) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let registrations = Arc::new(Mutex::new(Vec::new()));
        let mail = Arc::new(Mutex::new(MailState::default()));
        let tokens = Arc::new(Mutex::new(TokenState::new()));
        let fake = Fake {
            base: url.clone(),
            options,
            requests: Arc::new(AtomicUsize::new(0)),
            started: Instant::now(),
            registrations: registrations.clone(),
            mail: mail.clone(),
            tokens: tokens.clone(),
        };
        let app = Router::new()
            .route("/.well-known/jmap", get(well_known))
            .route("/jmap/session", get(session))
            .route("/jmap/", routing::options(preflight).post(api))
            .route("/jmap/api/", post(api))
            .route("/.well-known/oauth-authorization-server", get(metadata))
            .route("/auth/register", post(register))
            .route("/auth/token", post(token))
            .route("/auth/revoke", post(revoke))
            .layer(middleware::from_fn_with_state(fake.clone(), cors))
            .layer(middleware::from_fn_with_state(fake.clone(), throttle))
            .with_state(fake);
        let (stop, stopped) = oneshot::channel();
        tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    stopped.await.ok();
                })
                .await
                .unwrap();
        });
        Self {
            url,
            registrations,
            mail,
            tokens,
            stop: Mutex::new(Some(stop)),
        }
    }

    /// Stops the server; afterwards it is no longer reachable.
    pub async fn stop(&self) {
        if let Some(stop) = self.stop.lock().unwrap().take() {
            stop.send(()).ok();
        }
        // Until the port is closed.
        while tokio::net::TcpStream::connect(self.url.trim_start_matches("http://"))
            .await
            .is_ok()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Requests to the token endpoint so far.
    pub fn token_requests(&self) -> Vec<TokenRequest> {
        self.tokens.lock().unwrap().requests.clone()
    }

    /// From now on the token endpoint answers with `status` (`None`: normal
    /// again).
    pub fn fail_tokens(&self, status: Option<StatusCode>) {
        self.tokens.lock().unwrap().failure = status;
    }

    /// Issued access tokens are no longer valid, the grants still are (the
    /// server rejects the access token, a refresh helps).
    pub fn forget_access_tokens(&self) {
        self.tokens.lock().unwrap().access.clear();
    }

    /// Revokes all grants including access tokens – like a new password or the
    /// migration to Stalwart v1, which takes over no tokens.
    pub fn revoke_refresh_tokens(&self) {
        self.tokens.lock().unwrap().grants.clear();
    }

    /// From now on the token endpoint exchanges, but the response gets lost
    /// (504 as from a proxy); `false`: normal again.
    pub fn lose_token_responses(&self, lose: bool) {
        self.tokens.lock().unwrap().lose = lose;
    }

    /// Whether the server would accept the refresh token: its grant exists and
    /// it is not replaced (without redeeming it).
    pub fn refresh_valid(&self, token: &str) -> bool {
        let tokens = self.tokens.lock().unwrap();
        tokens.refresh_of(token).is_some_and(|(grant, generation)| {
            matches!(
                tokens.grants[&grant].rotation(generation),
                Rotation::Issue(_)
            )
        })
    }

    /// Whether the grant behind the refresh token still exists.
    pub fn grant_exists(&self, token: &str) -> bool {
        self.tokens.lock().unwrap().refresh_of(token).is_some()
    }

    /// Requests to the revocation endpoint so far.
    pub fn revocations(&self) -> Vec<TokenRequest> {
        self.tokens.lock().unwrap().revocations.clone()
    }

    /// A new code for the account of [`MAIL_TOKEN`].
    pub fn new_code(&self) -> String {
        let mut tokens = self.tokens.lock().unwrap();
        let code = tokens.issue("code");
        tokens.codes.insert(code.clone(), &ACCOUNT);
        code
    }

    /// Bodies of all registrations so far.
    pub fn registrations(&self) -> Vec<Value> {
        self.registrations.lock().unwrap().clone()
    }

    /// State of the account.
    pub fn mail(&self) -> MailState {
        self.mail.lock().unwrap().clone()
    }

    /// From now on rejects mails to `to` (`None`: send all again).
    pub fn reject_mail_to(&self, to: Option<&str>) {
        self.mail.lock().unwrap().reject_to = to.map(str::to_owned);
    }
}

enum Login {
    Anonymous,
    Valid(&'static Account),
    Invalid,
}

fn login(fake: &Fake, headers: &HeaderMap) -> Login {
    use base64::Engine as _;
    let Some(value) = headers.get(header::AUTHORIZATION) else {
        return Login::Anonymous;
    };
    let basic = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{MAIL_USER}:{MAIL_PASSWORD}"))
    );
    let bearer = |token: &str| value == format!("Bearer {token}").as_str();
    let issued = value
        .to_str()
        .ok()
        .and_then(|value| value.strip_prefix("Bearer "))
        .and_then(|token| {
            let tokens = fake.tokens.lock().unwrap();
            tokens
                .access
                .get(token)
                .filter(|(_, grant)| tokens.grants.contains_key(grant))
                .map(|(account, _)| *account)
        });
    if let Some(account) = issued {
        Login::Valid(account)
    } else if value == basic.as_str() || bearer(MAIL_TOKEN) {
        Login::Valid(&ACCOUNT)
    } else if bearer(OTHER_TOKEN) {
        Login::Valid(&OTHER)
    } else if bearer(NAMED_TOKEN) {
        Login::Valid(&NAMED)
    } else {
        fake.mail.lock().unwrap().failed_logins += 1;
        Login::Invalid
    }
}

/// Address where nobody answers: without root nobody can bind port 1, not
/// even a test running in parallel (a released random port could be
/// assigned again right away).
pub fn unreachable_url() -> String {
    "http://127.0.0.1:1".into()
}

/// Response with `429` like Stalwart's rate limit.
fn throttled() -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        [(header::RETRY_AFTER, RETRY_AFTER.to_string())],
    )
        .into_response()
}

async fn throttle(State(fake): State<Fake>, request: Request, next: Next) -> Response {
    let count = fake.requests.fetch_add(1, Ordering::SeqCst);
    if fake
        .options
        .throttle_after
        .is_some_and(|limit| count >= limit)
    {
        return throttled();
    }
    next.run(request).await
}

/// Like Stalwart: with "Permissive CORS" all responses carry the same
/// headers.
async fn cors(State(fake): State<Fake>, request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    if fake.options.cors {
        let headers = response.headers_mut();
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("*"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static(
                fake.options
                    .allow_headers
                    .unwrap_or("Authorization, Content-Type, Accept, X-Requested-With"),
            ),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("POST, GET, PATCH, PUT, DELETE, HEAD, OPTIONS"),
        );
    }
    response
}

async fn well_known(State(fake): State<Fake>) -> Response {
    let location = if fake.options.foreign_redirect {
        // Another origin (host), but reachable.
        fake.base.replace("127.0.0.1", "localhost") + "/jmap/session"
    } else {
        "/jmap/session".into()
    };
    (
        StatusCode::TEMPORARY_REDIRECT,
        [(header::LOCATION, location)],
    )
        .into_response()
}

async fn session(State(fake): State<Fake>, headers: HeaderMap) -> Response {
    let login = login(&fake, &headers);
    if matches!(login, Login::Invalid)
        || (fake.options.session_needs_auth && matches!(login, Login::Anonymous))
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let api_base = if fake.options.foreign_api_url {
        "https://other.example.com".to_owned()
    } else {
        fake.base.clone()
    };
    let (accounts, primary, username) = match login {
        Login::Valid(account) => (
            json!({ account.id: { "name": account.username, "isPersonal": true } }),
            json!({
                "urn:ietf:params:jmap:mail": account.id,
                "urn:ietf:params:jmap:submission": account.id,
                "urn:ietf:params:jmap:quota": account.id,
            }),
            account.username,
        ),
        _ => (json!({}), json!({}), ""),
    };
    let download_base = if fake.options.foreign_download_url {
        "https://cdn.example.com"
    } else {
        &api_base
    };
    Json(json!({
        "capabilities": {
            "urn:ietf:params:jmap:core": { "maxSizeUpload": 50_000_000 },
            "urn:ietf:params:jmap:mail": {},
            "urn:ietf:params:jmap:submission": {},
            "urn:ietf:params:jmap:quota": {},
        },
        "accounts": accounts,
        "primaryAccounts": primary,
        "username": username,
        "apiUrl": if fake.options.relative_api_url {
            "api/".to_owned()
        } else {
            format!("{api_base}/jmap/")
        },
        "downloadUrl": format!("{download_base}/jmap/download/{{accountId}}/{{blobId}}/{{name}}?accept={{type}}"),
        "uploadUrl": format!("{api_base}/jmap/upload/{{accountId}}/"),
        "eventSourceUrl": format!("{api_base}/jmap/eventsource/?types={{types}}&closeafter={{closeafter}}&ping={{ping}}"),
        "state": "0",
    }))
    .into_response()
}

async fn preflight() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn metadata(State(fake): State<Fake>) -> Response {
    if !fake.options.metadata {
        return StatusCode::NOT_FOUND.into_response();
    }
    let base = &fake.base;
    let issuer = if fake.options.foreign_issuer {
        "https://other.example.com"
    } else {
        base
    };
    let mut metadata = if fake.options.minimal_metadata {
        json!({
            "issuer": issuer,
            "authorization_endpoint": format!("{base}/login"),
            "token_endpoint": format!("{base}/auth/token"),
            "registration_endpoint": format!("{base}/auth/register"),
            "response_types_supported": ["code"],
        })
    } else {
        json!({
            "issuer": issuer,
            "authorization_endpoint": format!("{base}/login"),
            "token_endpoint": format!("{base}/auth/token"),
            "device_authorization_endpoint": format!("{base}/auth/device"),
            "registration_endpoint": format!("{base}/auth/register"),
            "introspection_endpoint": format!("{base}/auth/introspect"),
            "end_session_endpoint": format!("{base}/auth/logout"),
            "grant_types_supported": ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
            "response_types_supported": ["code"],
            "scopes_supported": [
                "openid",
                "offline_access",
                "urn:ietf:params:oauth:scope:mail",
                "urn:ietf:params:oauth:scope:contacts",
                "urn:ietf:params:oauth:scope:calendars",
                "urn:ietf:params:oauth:scope:files",
            ],
            "token_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
            "revocation_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
            "code_challenge_methods_supported": ["S256"],
            "authorization_response_iss_parameter_supported": true,
            "client_id_metadata_document_supported": true,
        })
    };
    if let Some(methods) = fake.options.auth_methods {
        metadata["token_endpoint_auth_methods_supported"] = json!(methods);
    }
    if let Some(methods) = fake.options.revocation_auth_methods {
        metadata["revocation_endpoint_auth_methods_supported"] = json!(methods);
    }
    if !fake.options.v016 {
        // Like v1.0.2 locally: `https://` even with an `http://` issuer.
        metadata["revocation_endpoint"] = json!(format!("{base}/auth/revoke"));
        metadata["protected_resources"] = json!([base.replace("http://", "https://")]);
    }
    Json(metadata).into_response()
}

async fn register(
    State(fake): State<Fake>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    use base64::Engine as _;
    let expected = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{ADMIN}:{ADMIN_PASSWORD}"))
    );
    let authorized = headers
        .get(header::AUTHORIZATION)
        .is_some_and(|value| value == expected.as_str());
    if let Some(status) = fake.options.register_status {
        return if status == StatusCode::TOO_MANY_REQUESTS {
            throttled()
        } else {
            status.into_response()
        };
    }
    // Like v1: confidential clients only authenticated (public ones would also
    // work anonymously, but only with a loopback redirect).
    if !authorized {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    fake.registrations.lock().unwrap().push(body.clone());
    let rejected =
        |error: &str| (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response();
    let method = body["token_endpoint_auth_method"]
        .as_str()
        .unwrap_or("client_secret_basic")
        .to_owned();
    let method = method.as_str();
    if !["none", "client_secret_basic", "client_secret_post"].contains(&method) {
        return rejected("invalid_client_metadata");
    }
    let loopback = |uri: &str| uri.starts_with("http://127.0.0.1");
    let redirect_ok = body["redirect_uris"].as_array().is_some_and(|uris| {
        !uris.is_empty()
            && uris.iter().all(|uri| {
                uri.as_str().is_some_and(|uri| {
                    loopback(uri) || (method != "none" && uri.starts_with("https://"))
                })
            })
    });
    if !redirect_ok {
        return rejected("invalid_redirect_uri");
    }
    let mut reply = body;
    reply["client_id"] = json!(CLIENT_ID);
    reply["client_id_issued_at"] = json!(1_790_000_000);
    if method != "none" {
        reply["client_secret"] = json!(fake.options.client_secret.unwrap_or(CLIENT_SECRET));
        reply["client_secret_expires_at"] = json!(0);
    }
    (StatusCode::CREATED, Json(reply)).into_response()
}

fn oauth_error(status: StatusCode, error: &str) -> Response {
    (status, Json(json!({ "error": error }))).into_response()
}

/// Client of the request as in Stalwart v1 (`ClientCredentials::parse`): ID
/// and secret from the body, otherwise via Basic, decoded there per RFC 6749,
/// section 2.3.1; `None` if body and Basic both name a secret or different
/// IDs.
fn client_of(
    headers: &HeaderMap,
    form: &HashMap<String, String>,
) -> Option<(String, Option<String>)> {
    use base64::Engine as _;
    let decode = |value: &str| {
        percent_encoding::percent_decode_str(&value.replace('+', " "))
            .decode_utf8_lossy()
            .into_owned()
    };
    let basic = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Basic "))
        .and_then(|encoded| {
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .ok()
        })
        .and_then(|decoded| String::from_utf8(decoded).ok())
        .and_then(|pair| {
            pair.split_once(':')
                .map(|(id, secret)| (decode(id), decode(secret)))
        });
    let (id, secret) = (form.get("client_id"), form.get("client_secret"));
    match basic {
        None => Some((id.cloned().unwrap_or_default(), secret.cloned())),
        Some(_) if secret.is_some() => None,
        Some((basic_id, _)) if id.is_some_and(|id| *id != basic_id) => None,
        Some((basic_id, basic_secret)) => Some((basic_id, Some(basic_secret))),
    }
}

/// Like Stalwart: a client with a secret must name it; others name none.
/// `invalid_client` comes with 401.
fn client_rejected(fake: &Fake, client_id: &str, secret: Option<&str>) -> Option<Response> {
    (client_id == CLIENT_ID
        && fake.options.client_secret.is_some()
        && secret != fake.options.client_secret)
        .then(|| oauth_error(StatusCode::UNAUTHORIZED, "invalid_client"))
}

/// Token endpoint (RFC 6749, sections 4.1.3 and 6) in the order of Stalwart
/// v1's checks: first code or refresh token, then the secret.
async fn token(
    State(fake): State<Fake>,
    headers: HeaderMap,
    Form(form): Form<HashMap<String, String>>,
) -> Response {
    fake.tokens
        .lock()
        .unwrap()
        .requests
        .push(TokenRequest::new(&headers, &form));
    if !fake.options.token_delay.is_zero() {
        tokio::time::sleep(fake.options.token_delay).await;
    }
    let mut tokens = fake.tokens.lock().unwrap();
    if let Some(status) = tokens.failure {
        return status.into_response();
    }
    let Some((client_id, secret)) = client_of(&headers, &form) else {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let field = |name: &str| form.get(name).map(String::as_str).unwrap_or_default();
    let (grant, generation) = match field("grant_type") {
        "authorization_code" => {
            // Codes belong to `CLIENT_ID`; unknown or redeemed ones are
            // `invalid_grant`.
            let Some(account) = tokens.codes.remove(field("code")) else {
                return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant");
            };
            if client_id != CLIENT_ID {
                return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant");
            }
            if let Some(rejected) = client_rejected(&fake, &client_id, secret.as_deref()) {
                return rejected;
            }
            if fake.options.unauthorized_client {
                return oauth_error(StatusCode::BAD_REQUEST, "unauthorized_client");
            }
            if field("code_verifier") != VERIFIER || field("redirect_uri").is_empty() {
                return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant");
            }
            (tokens.grant(account, Some(client_id)), 0)
        }
        "refresh_token" => {
            let Some((grant, presented)) = tokens.refresh_of(field("refresh_token")) else {
                return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant");
            };
            let stored = &tokens.grants[&grant];
            if stored
                .client
                .as_ref()
                .is_some_and(|client| *client != client_id)
            {
                return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant");
            }
            if let Some(rejected) = client_rejected(&fake, &client_id, secret.as_deref()) {
                return rejected;
            }
            if fake.options.unauthorized_client {
                return oauth_error(StatusCode::BAD_REQUEST, "unauthorized_client");
            }
            if fake.options.keep_refresh {
                let access = tokens.access_for(grant);
                return Json(json!({
                    "access_token": access,
                    "token_type": "bearer",
                    "expires_in": fake.options.expires_in,
                }))
                .into_response();
            }
            match stored.rotation(presented) {
                Rotation::Issue(next) => {
                    let stored = tokens.grants.get_mut(&grant).unwrap();
                    stored.generation = next - 1;
                    stored.pending = true;
                    (grant, next)
                }
                Rotation::Replay => {
                    tokens.grants.remove(&grant);
                    return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant");
                }
                Rotation::Invalid => return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant"),
            }
        }
        _ => return oauth_error(StatusCode::BAD_REQUEST, "unsupported_grant_type"),
    };
    let access = tokens.access_for(grant);
    let refresh = tokens.issue("refresh");
    tokens.refresh.insert(refresh.clone(), (grant, generation));
    if tokens.lose {
        return StatusCode::GATEWAY_TIMEOUT.into_response();
    }
    Json(json!({
        "access_token": access,
        "token_type": "bearer",
        "expires_in": fake.options.expires_in,
        "refresh_token": refresh,
        "scope": "offline_access urn:ietf:params:oauth:scope:mail urn:ietf:params:oauth:scope:contacts",
    }))
    .into_response()
}

/// Revocation endpoint (RFC 7009) as in Stalwart v1: a token whose grant
/// belongs to the client deletes the whole grant if the secret matches; the
/// server answers everything else with 200.
async fn revoke(
    State(fake): State<Fake>,
    headers: HeaderMap,
    Form(form): Form<HashMap<String, String>>,
) -> Response {
    let mut tokens = fake.tokens.lock().unwrap();
    tokens.revocations.push(TokenRequest::new(&headers, &form));
    let token = form.get("token").filter(|token| !token.is_empty());
    let (Some(token), Some((client_id, secret))) = (token, client_of(&headers, &form)) else {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if client_id.is_empty() {
        return oauth_error(StatusCode::UNAUTHORIZED, "invalid_client");
    }
    let grant = tokens
        .refresh_of(token)
        .map(|(grant, _)| grant)
        .or_else(|| tokens.access.get(token.as_str()).map(|(_, grant)| *grant))
        .filter(|grant| {
            tokens.grants.get(grant).is_some_and(|stored| {
                stored
                    .client
                    .as_ref()
                    .is_none_or(|client| *client == client_id)
            })
        });
    if let Some(grant) = grant {
        if let Some(rejected) = client_rejected(&fake, &client_id, secret.as_deref()) {
            return rejected;
        }
        tokens.grants.remove(&grant);
    }
    StatusCode::OK.into_response()
}

/// Two identities of the test account.
fn identities() -> Value {
    json!([
        { "id": "i1", "name": "Example Ltd", "email": MAIL_USER, "mayDelete": false },
        { "id": "i2", "name": "Example Support", "email": "support@example.com", "mayDelete": true },
    ])
}

/// `POST /jmap/`: method calls one after another, creation IDs (`#m`) apply
/// in the whole request (RFC 8620, 5.3).
async fn api(State(fake): State<Fake>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let Login::Valid(account) = login(&fake, &headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let calls = body["methodCalls"].as_array().cloned().unwrap_or_default();
    let mut state = fake.mail.lock().unwrap();
    state.calls.push(Call {
        at: fake.started.elapsed(),
        methods: calls
            .iter()
            .map(|call| call[0].as_str().unwrap_or_default().to_owned())
            .collect(),
    });
    let mut created = HashMap::new();
    let mut responses = Vec::new();
    for call in calls {
        let (name, args, id) = (call[0].as_str().unwrap_or_default(), &call[1], &call[2]);
        if args["accountId"] != account.id {
            responses.push(json!(["error", { "type": "accountNotFound" }, id]));
            continue;
        }
        match name {
            "Identity/get" => responses.push(json!([
                name,
                { "accountId": account.id, "state": "1", "list": (account.identities)(), "notFound": [] },
                id,
            ])),
            "Mailbox/get" => {
                let mut list = vec![
                    json!({ "id": "inbox", "role": "inbox" }),
                    json!({ "id": "drafts", "role": "drafts" }),
                    json!({ "id": "archiv", "role": null }),
                ];
                if !fake.options.without_sent {
                    list.push(json!({ "id": "sent", "role": "sent" }));
                }
                responses.push(json!([
                    name,
                    { "accountId": account.id, "state": "1", "list": list, "notFound": [] },
                    id,
                ]));
            }
            "Email/set" => {
                let result = email_set(&mut state, args, &mut created);
                responses.push(json!([name, result, id]));
            }
            "EmailSubmission/set" => {
                for response in submission_set(&fake.options, &mut state, args, &created) {
                    responses.push(json!([response.0, response.1, id]));
                }
            }
            "Quota/get" if fake.options.quota_unsupported => {
                responses.push(json!(["error", { "type": "accountNotSupportedByMethod" }, id]));
            }
            // Like Stalwart v1.0.2 (RFC 9425).
            "Quota/get" => {
                let list = fake.options.quota.map(|(used, hard_limit)| {
                    json!({
                        "id": "q", "resourceType": "octets", "used": used, "warnLimit": null,
                        "softLimit": null, "hardLimit": hard_limit, "scope": "account",
                        "name": account.username, "types": ["Email", "SieveScript"],
                    })
                });
                responses.push(json!([
                    name,
                    { "accountId": account.id, "state": "n", "list": list.into_iter().collect::<Vec<_>>(), "notFound": [] },
                    id,
                ]));
            }
            _ => responses.push(json!(["error", { "type": "unknownMethod" }, id])),
        }
    }
    Json(json!({ "methodResponses": responses, "sessionState": "1" })).into_response()
}

fn email_set(
    state: &mut MailState,
    args: &Value,
    created_ids: &mut HashMap<String, String>,
) -> Value {
    let mut created = serde_json::Map::new();
    let mut not_created = serde_json::Map::new();
    for (key, email) in args["create"].as_object().cloned().unwrap_or_default() {
        let valid = email["mailboxIds"]
            .as_object()
            .is_some_and(|m| !m.is_empty())
            && email["bodyValues"].is_object();
        if !valid {
            not_created.insert(key, json!({ "type": "invalidProperties" }));
            continue;
        }
        state.next_id += 1;
        let id = format!("e{}", state.next_id);
        state.emails.insert(id.clone(), email);
        created.insert(key.clone(), json!({ "id": id, "blobId": format!("b{id}"), "threadId": format!("t{id}"), "size": 1000 }));
        created_ids.insert(key, id);
    }
    let mut updated = serde_json::Map::new();
    for (id, patch) in args["update"].as_object().cloned().unwrap_or_default() {
        if let Some(email) = state.emails.get_mut(&id) {
            apply_patch(email, &patch);
            updated.insert(id, Value::Null);
        }
    }
    let mut destroyed = Vec::new();
    for id in args["destroy"].as_array().cloned().unwrap_or_default() {
        if let Some(id) = id.as_str()
            && state.emails.remove(id).is_some()
        {
            destroyed.push(json!(id));
        }
    }
    json!({
        "accountId": ACCOUNT.id,
        "newState": "2",
        "created": created,
        "notCreated": not_created,
        "updated": updated,
        "destroyed": destroyed,
    })
}

/// Patch per RFC 8620, 5.3 (`mailboxIds/<id>`, `keywords/<k>`).
fn apply_patch(email: &mut Value, patch: &Value) {
    for (path, value) in patch.as_object().cloned().unwrap_or_default() {
        let (property, key) = path.split_once('/').unwrap();
        let map = email[property].as_object_mut().unwrap();
        if value.is_null() {
            map.remove(key);
        } else {
            map.insert(key.to_owned(), value);
        }
    }
}

/// Like Stalwart: the identity must exist, `From` must match it; after
/// sending the implicit `Email/set` (RFC 8621, 7.5) with the same ID.
fn submission_set(
    options: &Options,
    state: &mut MailState,
    args: &Value,
    created_emails: &HashMap<String, String>,
) -> Vec<(&'static str, Value)> {
    let mut created = serde_json::Map::new();
    let mut not_created = serde_json::Map::new();
    let mut sent = HashMap::new();
    for (key, submission) in args["create"].as_object().cloned().unwrap_or_default() {
        let email_id = submission["emailId"].as_str().unwrap_or_default();
        let email_id = match email_id.strip_prefix('#') {
            Some(reference) => created_emails.get(reference).cloned(),
            None => Some(email_id.to_owned()),
        };
        let identity = identities()
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["id"] == submission["identityId"])
            .cloned();
        let (Some(email_id), Some(identity)) = (email_id, identity) else {
            not_created.insert(key, json!({ "type": "invalidProperties" }));
            continue;
        };
        let Some(email) = state.emails.get(&email_id).cloned() else {
            not_created.insert(
                key,
                json!({ "type": "invalidProperties", "description": "Email not found." }),
            );
            continue;
        };
        if email["from"][0]["email"] != identity["email"] {
            not_created.insert(key, json!({ "type": "forbiddenFrom" }));
            continue;
        }
        if let Some(kind) = options.submission_error {
            not_created.insert(key, json!({ "type": kind, "description": "Rejected." }));
            continue;
        }
        if state.reject_to.is_some()
            && email["to"][0]["email"].as_str() == state.reject_to.as_deref()
        {
            not_created.insert(
                key,
                json!({ "type": "forbiddenToSend", "description": "Rejected." }),
            );
            state.rejected.push(email);
            continue;
        }
        state.submitted.push(email);
        if !options.unreadable_submission {
            created.insert(
                key.clone(),
                json!({ "id": format!("s{email_id}"), "undoStatus": "final" }),
            );
        }
        sent.insert(format!("#{key}"), email_id);
    }
    let mut responses = vec![(
        "EmailSubmission/set",
        json!({ "accountId": ACCOUNT.id, "newState": "2", "created": created, "notCreated": not_created }),
    )];
    let mut update = serde_json::Map::new();
    for (reference, patch) in args["onSuccessUpdateEmail"]
        .as_object()
        .cloned()
        .unwrap_or_default()
    {
        if let Some(id) = sent.get(&reference) {
            update.insert(id.clone(), patch);
        }
    }
    let destroy: Vec<Value> = args["onSuccessDestroyEmail"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|reference| sent.get(reference.as_str()?))
        .map(|id| json!(id))
        .collect();
    if !update.is_empty() || !destroy.is_empty() {
        let args = json!({ "accountId": ACCOUNT.id, "update": update, "destroy": destroy });
        responses.push(("Email/set", email_set(state, &args, &mut HashMap::new())));
    }
    responses
}
