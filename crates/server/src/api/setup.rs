//! Initial setup. As long as no administrator exists, the
//! setup token from the container log authorizes the steps; afterwards all
//! endpoints answer with 409 `setup_done`.
//!
//! - `POST setup/token` (`{token}`, step 1): checks the token and names a
//!   fixed public address (`ROEDY_PUBLIC_URL`).
//! - With the token in the header `X-Setup-Token`: `POST setup/servers/test`
//!   (diagnosis without saving), `POST setup/servers/register-client` (DCR),
//!   `POST setup/system-mail/test` (sign-in of the sending account) and
//!   `POST setup/complete`, which creates administrator, server, system mail
//!   and public address in one transaction, deletes the token and signs the
//!   administrator in.
//!
//! Every token check counts towards the lockout (five failed attempts, then
//! 30 s, per client IP) – in steps 2–6 too, otherwise it could be guessed
//! there without limit.

use std::{
    net::{Ipv4Addr, Ipv6Addr},
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{FromRequestParts, State},
    http::{HeaderMap, HeaderValue, StatusCode, header, request::Parts},
    response::{IntoResponse, Response},
    routing::post,
};
use roedy_jmap as jmap;
use serde::Deserialize;
use serde_json::{Value, json};
use url::{Host, Url};

use super::{
    ApiError, FieldErrors, JsonBody, auth, error::retry_secs, me, servers,
    system_mail as system_mail_api,
};
use crate::{
    app::AppState,
    auth::{AuthUser, session},
    broker::probe,
    client_ip::ClientIp,
    db::{
        self,
        repo::{
            app_settings,
            audit_log::{self, Category, Entry},
            known_devices,
            servers::{self as server_repo, SECRET_PURPOSE},
            users::{self, NewUser, Role},
        },
    },
    events::{self, News},
    mailer::{
        Account,
        system_mail::{self, SystemMail},
    },
    rate_limit::{Key, Policy},
    setup_token,
};

/// Header with the setup token for steps 2–6.
pub const TOKEN_HEADER: &str = "x-setup-token";

/// Five failed attempts, then a 30 s lockout. The page counts the attempts
/// without a time window; here they are forgotten after ten
/// minutes.
const TOKEN_LIMIT: Policy = Policy::lockout(
    "setup.token",
    5,
    Duration::from_secs(10 * 60),
    Duration::from_secs(30),
);

/// Login name of the sending account (at most 254 characters, like an address).
const MAX_USER: usize = 254;
/// JMAP IDs have at most 255 characters (RFC 8620, 1.2).
const MAX_IDENTITY: usize = 255;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/setup/token", post(token))
        .route("/setup/servers/test", post(test_server))
        .route("/setup/servers/register-client", post(register_client))
        .route("/setup/system-mail/test", post(test_system_mail))
        .route("/setup/complete", post(complete))
}

fn setup_done() -> ApiError {
    ApiError::rejected(StatusCode::CONFLICT, "setup_done")
}

/// Checks the token with a lockout after failed attempts. After the setup
/// 409 `setup_done` (also without a token); without a token 400; wrong 422
/// `invalid_token` with `remaining` (attempts until the lockout, "3 attempts
/// left"), at the fifth 429 `rate_limited` as during the lockout.
async fn check_token(state: &AppState, ip: ClientIp, input: Option<&str>) -> Result<(), ApiError> {
    let token = db::call(&state.db, |conn| setup_token::current(conn))
        .await?
        .ok_or_else(setup_done)?;
    let Some(input) = input else {
        return Err(ApiError::BadRequest("header X-Setup-Token missing".into()));
    };
    let key = Key::Ip(ip.network());
    // Reserve up front, so that even many concurrent attempts get no more
    // than five comparisons.
    let attempt = state.limiter.reserve(&TOKEN_LIMIT, key.clone())?;
    if setup_token::matches(&token, input) {
        // A correct token does not count.
        drop(attempt);
        return Ok(());
    }
    attempt.count();
    tracing::info!(ip = %ip.0, "setup token rejected");
    let remaining = state.limiter.remaining(&TOKEN_LIMIT, &key)?;
    Err(
        ApiError::rejected(StatusCode::UNPROCESSABLE_ENTITY, "invalid_token")
            .with("remaining", remaining),
    )
}

/// Valid setup token from the header `X-Setup-Token` (steps 2–6). Comes
/// before the body, so that nothing else is checked without a token.
pub struct SetupToken;

impl FromRequestParts<AppState> for SetupToken {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let ip = ClientIp::from_request_parts(parts, state).await?;
        // A value that is not text cannot be the token and counts as a
        // failed attempt.
        let token = parts
            .headers
            .get(TOKEN_HEADER)
            .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned());
        check_token(state, ip, token.as_deref())
            .await
            .map(|()| Self)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenBody {
    token: String,
}

async fn token(
    State(state): State<AppState>,
    ip: ClientIp,
    JsonBody(body): JsonBody<TokenBody>,
) -> Result<Json<Value>, ApiError> {
    check_token(&state, ip, Some(&body.token)).await?;
    // If it is fixed (`ROEDY_PUBLIC_URL`), step 4 shows it locked.
    let public_url = state
        .configured_url
        .as_ref()
        .map(|url| url.origin().ascii_serialization());
    Ok(Json(json!({ "public_url": public_url })))
}

/// Public address of the app from the setup: `https://`, `http://` only on
/// `localhost`, `127.0.0.1` or `[::1]` (development; the session cookie is
/// `Secure`), with host, without credentials, path, query and fragment – the
/// app lives at the root, links and redirect URI depend on the origin. The
/// result is the origin.
pub fn normalize_public_url(raw: &str) -> Result<Url, &'static str> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("required");
    }
    let url = Url::parse(raw.trim_end_matches('/')).map_err(|_| "invalid")?;
    let loopback = match url.host() {
        Some(Host::Domain(domain)) => domain == "localhost",
        Some(Host::Ipv4(ip)) => ip == Ipv4Addr::LOCALHOST,
        Some(Host::Ipv6(ip)) => ip == Ipv6Addr::LOCALHOST,
        None => return Err("invalid"),
    };
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    let bare = url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none();
    if !scheme_ok || !bare {
        return Err("invalid");
    }
    Url::parse(&url.origin().ascii_serialization()).map_err(|_| "invalid")
}

/// Public address for the steps and completion: `ROEDY_PUBLIC_URL` (then the
/// input does not count) or the checked input.
fn public_url(
    configured: Option<&Url>,
    input: Option<&str>,
    errors: &mut FieldErrors,
) -> Option<Url> {
    if let Some(url) = configured {
        return Some(url.clone());
    }
    normalize_public_url(input.unwrap_or_default())
        .inspect_err(|code| errors.code("public_url", code))
        .ok()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TestBody {
    url: String,
    client_id: Option<String>,
    public_url: Option<String>,
    /// A client secret is entered (confidential client); the test does not
    /// need the secret itself. A client registered via DCR always has one.
    #[serde(default)]
    has_secret: bool,
}

/// "Test connection" in step 4: the same diagnosis as for registry servers,
/// without saving anything.
async fn test_server(
    State(state): State<AppState>,
    _: SetupToken,
    JsonBody(body): JsonBody<TestBody>,
) -> Result<Json<Value>, ApiError> {
    let mut errors = FieldErrors::default();
    let base_url = servers::normalize_url(&body.url)
        .inspect_err(|code| errors.code("url", code))
        .ok();
    let client_id = servers::clean_optional(body.client_id);
    servers::check_client_field(&mut errors, "client_id", client_id.as_deref());
    let public_url = public_url(
        state.configured_url.as_ref(),
        body.public_url.as_deref(),
        &mut errors,
    );
    let (Some(base_url), Some(public_url)) = (base_url, public_url) else {
        return Err(errors.into_error());
    };
    if !errors.is_empty() {
        return Err(errors.into_error());
    }
    let url = base_url.origin().ascii_serialization();
    let registered = match client_id.clone() {
        Some(client_id) if !body.has_secret => {
            let url = url.clone();
            db::call(&state.db, move |conn| {
                server_repo::find_registration(conn, &url, &client_id, servers::unix_now())
            })
            .await?
            .is_some()
        }
        _ => false,
    };
    let origin = public_url.origin().ascii_serialization();
    let report = probe::probe(
        &state.http,
        &probe::Target {
            base_url: &base_url,
            client_id: client_id.as_deref(),
            has_secret: body.has_secret || registered,
            origin: Some(&origin),
        },
    )
    .await;
    tracing::info!(
        url = %url,
        reach = report.reach.as_str(),
        cors = report.cors.as_str(),
        oauth = report.oauth.as_str(),
        reasons = ?report.reasons,
        "mail server tested during setup"
    );
    let mut reply = json!({
        "url": url,
        "host": servers::host_of(&url),
        "reach": report.reach,
        "cors": report.cors,
        "oauth": report.oauth,
        "reasons": report.reasons,
    });
    if let Some(retry_after) = report.retry_after {
        reply["retry_after"] = json!(retry_secs(retry_after));
    }
    Ok(Json(reply))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegisterBody {
    url: String,
    username: String,
    password: String,
    public_url: Option<String>,
}

/// "Register client automatically" in step 4 – as in the administration,
/// with the public address from the step. No audit log entry: there is
/// nobody yet it could be attributed to, and the server is only created with
/// `setup/complete`. Until then the client waits as a pending registration
/// with secret and redirect URI.
async fn register_client(
    State(state): State<AppState>,
    _: SetupToken,
    JsonBody(body): JsonBody<RegisterBody>,
) -> Result<Json<Value>, ApiError> {
    let mut errors = FieldErrors::default();
    let base_url =
        servers::check_registration(&mut errors, &body.url, &body.username, &body.password);
    let public_url = public_url(
        state.configured_url.as_ref(),
        body.public_url.as_deref(),
        &mut errors,
    );
    let (Some(base_url), Some(public_url)) = (base_url, public_url) else {
        return Err(errors.into_error());
    };
    if !errors.is_empty() {
        return Err(errors.into_error());
    }
    let registered = servers::register(
        &state,
        &base_url,
        &body.username,
        &body.password,
        &public_url,
    )
    .await?;
    Ok(Json(registered.reply()))
}

/// Fields of the sending account (step 5 and `setup/complete`).
struct MailInput {
    user: String,
    app_password: String,
    identity: Option<String>,
}

/// User of the sending account (also Administration › Email): without
/// whitespace and control characters, at most [`MAX_USER`] bytes.
pub(super) fn is_bad_user(user: &str) -> bool {
    user.len() > MAX_USER || user.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Identity of the sending account: at most [`MAX_IDENTITY`] bytes without
/// control characters.
pub(super) fn is_bad_identity(id: &str) -> bool {
    id.len() > MAX_IDENTITY || id.chars().any(char::is_control)
}

/// The user is a login name (with Stalwart the name or address of the
/// account), so only without whitespace and control characters; the page
/// checks the field as an address.
fn check_mail(
    errors: &mut FieldErrors,
    user: &str,
    app_password: &str,
    identity: Option<String>,
) -> MailInput {
    let user = user.trim();
    if user.is_empty() {
        errors.code("user", "required");
    } else if is_bad_user(user) {
        errors.code("user", "invalid");
    }
    if app_password.is_empty() {
        errors.code("app_password", "required");
    } else {
        servers::check_client_field(errors, "app_password", Some(app_password));
    }
    let identity = servers::clean_optional(identity);
    if identity.as_deref().is_some_and(is_bad_identity) {
        errors.code("identity", "invalid");
    }
    MailInput {
        user: user.to_owned(),
        app_password: app_password.to_owned(),
        identity,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MailTestBody {
    /// Base URL of the server from step 4 (it has not been created yet).
    url: String,
    user: String,
    app_password: String,
    identity: Option<String>,
}

/// "Check and continue" in step 5: signs in as before sending (identity,
/// "Drafts"), without sending, and names the identities. Errors as
/// `mail_failed` with `reason`: `auth_failed` and `forbidden` as 422,
/// `auth_locked` (too many rejected sign-ins at this server) as 429 with
/// `retry_after`, otherwise 502.
async fn test_system_mail(
    State(state): State<AppState>,
    _: SetupToken,
    JsonBody(body): JsonBody<MailTestBody>,
) -> Result<Json<Value>, ApiError> {
    let mut errors = FieldErrors::default();
    let base_url = servers::normalize_url(&body.url)
        .inspect_err(|code| errors.code("url", code))
        .ok();
    let input = check_mail(&mut errors, &body.user, &body.app_password, body.identity);
    let base_url = match base_url {
        Some(url) if errors.is_empty() => url,
        _ => return Err(errors.into_error()),
    };
    let account = Account {
        base_url,
        auth: jmap::Auth::Basic {
            username: input.user,
            password: input.app_password,
        },
        identity_id: input.identity,
        sender_name: None,
        reply_to: None,
        keep_sent: true,
    };
    match state.mailer.test(&account).await {
        Ok(identities) => {
            let identities: Vec<Value> = identities
                .into_iter()
                .map(|i| json!({ "id": i.id, "name": i.name, "email": i.email }))
                .collect();
            Ok(Json(json!({ "identities": identities })))
        }
        Err(error) => Err(system_mail_api::rejection(&error)),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CompleteBody {
    name: String,
    email: String,
    password: String,
    server: ServerBody,
    /// Missing or ignored when `ROEDY_PUBLIC_URL` is set.
    public_url: Option<String>,
    /// Missing with "Set up later".
    system_mail: Option<SystemMailBody>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ServerBody {
    /// Empty means the host.
    #[serde(default)]
    label: String,
    url: String,
    #[serde(default)]
    domains: Vec<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SystemMailBody {
    user: String,
    app_password: String,
    identity: Option<String>,
}

/// Checked setup data.
struct Plan {
    name: String,
    email: String,
    password: String,
    server: servers::Input,
    client_secret: Option<String>,
    /// The effective public address.
    public_url: Url,
    /// Whether to store it (not with `ROEDY_PUBLIC_URL`).
    store_public_url: bool,
    system_mail: Option<MailInput>,
}

/// Checks all fields like the steps of the page; errors with the names of
/// the body (`server.url`, `system_mail.user` …). [`complete`] checks
/// conflicts with existing servers in the transaction.
fn validate(body: CompleteBody, configured: Option<&Url>) -> Result<Plan, FieldErrors> {
    let mut errors = FieldErrors::default();
    let name = body.name.trim();
    me::check_display_name(&mut errors, "name", name);
    let email = body.email.trim();
    me::check_email(&mut errors, "email", email);
    me::check_new_password(&mut errors, "password", &body.password);

    let server = body.server;
    // Empty means the host – truncated, so that a long
    // hostname does not fail on a field nobody filled in.
    let label = match server.label.trim() {
        "" => servers::normalize_url(&server.url)
            .map(|url| {
                servers::host_of(url.as_str())
                    .chars()
                    .take(servers::MAX_LABEL)
                    .collect()
            })
            .unwrap_or_else(|_| "Mailserver".into()),
        label => label.to_owned(),
    };
    // Without a client nobody can sign in; step 4 requires it (registered
    // automatically or by hand).
    let client_id = servers::clean_optional(server.client_id);
    let mut server_errors = FieldErrors::default();
    if client_id.is_none() {
        server_errors.code("client_id", "required");
    }
    let input = match servers::validate(&label, &server.url, &server.domains, client_id, &[]) {
        Ok(input) => Some(input),
        Err(field_errors) => {
            server_errors.merge(field_errors);
            None
        }
    };
    let client_secret = servers::clean_optional(server.client_secret);
    servers::check_client_field(
        &mut server_errors,
        "client_secret",
        client_secret.as_deref(),
    );
    errors.nest("server", server_errors);

    let public_url = public_url(configured, body.public_url.as_deref(), &mut errors);
    let system_mail = body.system_mail.map(|mail| {
        let mut mail_errors = FieldErrors::default();
        let input = check_mail(
            &mut mail_errors,
            &mail.user,
            &mail.app_password,
            mail.identity,
        );
        errors.nest("system_mail", mail_errors);
        input
    });

    match (input, public_url) {
        (Some(server), Some(public_url)) if errors.is_empty() => Ok(Plan {
            name: name.to_owned(),
            email: email.to_owned(),
            password: body.password,
            server,
            client_secret,
            public_url,
            store_public_url: configured.is_none(),
            system_mail,
        }),
        _ => Err(errors),
    }
}

/// Result of the transaction in [`complete`].
enum Outcome {
    Done(AuthUser, HeaderValue),
    /// An administrator exists by now.
    SetupDone,
    Invalid(FieldErrors),
}

/// "Complete setup": creates everything in one transaction, deletes the
/// token and signs the administrator in (201 with the session cookie).
async fn complete(
    State(state): State<AppState>,
    _: SetupToken,
    ip: ClientIp,
    headers: HeaderMap,
    JsonBody(body): JsonBody<CompleteBody>,
) -> Result<Response, ApiError> {
    let plan = validate(body, state.configured_url.as_ref()).map_err(FieldErrors::into_error)?;

    // Before the transaction: hashing and encryption need no database.
    let password_hash = state.hasher.hash(&plan.password).await?;
    let server_id = db::new_id()?;
    let sealed_secret = match &plan.client_secret {
        Some(secret) => Some(
            state
                .secrets
                .seal(SECRET_PURPOSE, &server_id, secret.as_bytes())?,
        ),
        None => None,
    };
    let mail = match &plan.system_mail {
        Some(mail) => Some(SystemMail::new(
            &state.secrets,
            &server_id,
            &mail.user,
            &mail.app_password,
            mail.identity.clone(),
        )?),
        None => None,
    };
    let origin = auth::origin(&state, &headers, ip);

    let csp = state.csp.clone();
    let keys = state.secrets.clone();
    let outcome = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        // Two concurrent completions: the second finds the administrator.
        if users::admin_exists(&tx)? {
            return Ok(Outcome::SetupDone);
        }
        // Conflicts with existing servers in the same transaction as the
        // creation (like `admin/servers`).
        let others = server_repo::list(&tx)?;
        let server = &plan.server;
        if let Err(conflicts) = servers::validate(
            &server.label,
            &server.base_url,
            &server.domains,
            server.client_id.clone(),
            &others,
        ) {
            let mut errors = FieldErrors::default();
            errors.nest("server", conflicts);
            return Ok(Outcome::Invalid(errors));
        }
        let mut errors = FieldErrors::default();
        let redirect_uri = servers::redirect_uri(&plan.public_url);
        servers::check_redirect(
            &tx,
            &mut errors,
            "server.client_id",
            server,
            Some(&redirect_uri),
        )?;
        if !errors.is_empty() {
            return Ok(Outcome::Invalid(errors));
        }
        // An entered secret takes precedence.
        let registered = servers::adopt_registration(&tx, &keys, server, &server_id)?;
        server_repo::insert(
            &tx,
            &server_id,
            &servers::fields(server),
            sealed_secret
                .as_ref()
                .or(registered.as_ref())
                .map(Vec::as_slice),
        )?;
        if plan.store_public_url {
            app_settings::set(&tx, app_settings::PUBLIC_URL, &plan.public_url)?;
        }
        if let Some(mail) = &mail {
            system_mail::save(&tx, mail)?;
        }
        let username = users::unique_username(&tx, &plan.email)?;
        let user_id = users::insert(
            &tx,
            &NewUser {
                username: &username,
                email: &plan.email,
                display_name: &plan.name,
                role: Role::Admin,
                password_hash: &password_hash,
            },
        )?;
        let client = origin.client();
        let started = session::start(&tx, &user_id, &client, true)?;
        // The account's first device: known, without a notice.
        known_devices::remember(&tx, &user_id, &origin.device_hash)?;
        setup_token::delete(&tx)?;
        let admin = AuthUser {
            id: user_id,
            username,
            email: plan.email.clone(),
            display_name: plan.name.clone(),
            role: Role::Admin,
            session_id: started.id.clone(),
        };
        // Shown as "completed the initial setup", then the sign-in.
        audit_log::insert(
            &tx,
            &Entry::new(Category::System, "setup.complete")
                .actor(&admin)
                .ip(ip.0)
                .target(&server_id)
                .details(json!({
                    "server": server.label,
                    "url": server.base_url,
                    "system_mail": mail.is_some(),
                })),
        )?;
        audit_log::insert(
            &tx,
            &Entry::new(Category::Login, "auth.login")
                .actor(&admin)
                .client(&client)
                .target(&started.id)
                .details(json!({ "method": "setup" })),
        )?;
        events::news(&tx, &admin.id, News::Welcome)?;
        csp.commit(tx)?;
        Ok(Outcome::Done(admin, started.cookie))
    })
    .await?;
    let (admin, cookie) = match outcome {
        Outcome::Done(admin, cookie) => (admin, cookie),
        Outcome::SetupDone => return Err(setup_done()),
        Outcome::Invalid(errors) => return Err(errors.into_error()),
    };
    tracing::info!(user = %admin.id, "setup completed");
    let body = Json(json!({ "user": auth::user_json(&admin) }));
    Ok((StatusCode::CREATED, [(header::SET_COOKIE, cookie)], body).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(value: Value) -> CompleteBody {
        serde_json::from_value(value).unwrap()
    }

    fn valid() -> Value {
        json!({
            "name": " Max Smith ",
            "email": " max@example.com ",
            "password": "Summer2026!",
            "server": {
                "url": "https://Mail.Example.com/",
                "domains": ["@Example.com"],
                "client_id": "stateless-1",
            },
            "public_url": "https://app.example.com",
            "system_mail": { "user": "noreply", "app_password": "kT9v" },
        })
    }

    fn errors_of(value: Value) -> Value {
        match validate(body(value), None) {
            Ok(_) => panic!("expected errors"),
            Err(errors) => errors.into_value(),
        }
    }

    #[test]
    fn validates_and_defaults_label_to_host() {
        let plan = validate(body(valid()), None).unwrap();
        assert_eq!(plan.name, "Max Smith");
        assert_eq!(plan.email, "max@example.com");
        assert_eq!(plan.server.label, "mail.example.com");
        assert_eq!(plan.server.base_url, "https://mail.example.com");
        assert_eq!(plan.server.domains, ["example.com"]);
        assert_eq!(plan.public_url.as_str(), "https://app.example.com/");
        assert!(plan.store_public_url);
        // Login name instead of address: Stalwart accepts both.
        assert_eq!(plan.system_mail.unwrap().user, "noreply");

        // Fixed address: the input does not count and is not stored.
        let mut without = valid();
        without.as_object_mut().unwrap().remove("public_url");
        without.as_object_mut().unwrap().remove("system_mail");
        let configured = Url::parse("https://app.example.com").unwrap();
        let plan = validate(body(without), Some(&configured)).unwrap();
        assert_eq!(plan.public_url, configured);
        assert!(!plan.store_public_url);
        assert!(plan.system_mail.is_none());

        // A long hostname is truncated as the label, not rejected.
        let host = format!("{}.{}.example.com", "a".repeat(60), "b".repeat(60));
        let mut long_host = valid();
        long_host["server"]["url"] = json!(format!("https://{host}"));
        let plan = validate(body(long_host), None).unwrap();
        assert_eq!(plan.server.label, host[..servers::MAX_LABEL]);
    }

    #[test]
    fn reports_every_field_with_its_path() {
        assert_eq!(
            errors_of(json!({
                "name": " ",
                "email": "max@example",
                "password": "short",
                "server": { "label": "", "url": "http://stalwart:8080", "domains": ["x_y.test"] },
                "public_url": "",
                "system_mail": { "user": "no reply", "app_password": "" },
            })),
            json!({
                "name": { "code": "required" },
                "email": { "code": "invalid" },
                "password": { "code": "policy", "rules": ["len", "case", "num"] },
                "server.client_id": { "code": "required" },
                "server.url": { "code": "invalid" },
                "server.domains": { "code": "invalid", "domain": "x_y.test" },
                "public_url": { "code": "required" },
                "system_mail.user": { "code": "invalid" },
                "system_mail.app_password": { "code": "required" },
            })
        );

        let mut no_client = valid();
        no_client["server"]
            .as_object_mut()
            .unwrap()
            .remove("client_id");
        no_client["server"]["client_secret"] = json!("secret");
        assert_eq!(
            errors_of(no_client),
            json!({ "server.client_id": { "code": "required" } })
        );

        let mut long = valid();
        long["password"] = json!(format!("Aa1{}", "x".repeat(auth::MAX_PASSWORD)));
        long["name"] = json!("M".repeat(me::MAX_NAME + 1));
        long["system_mail"]["app_password"] = json!("a\u{7}b");
        assert_eq!(
            errors_of(long),
            json!({
                "name": { "code": "too_long" },
                "password": { "code": "too_long" },
                "system_mail.app_password": { "code": "invalid" },
            })
        );
    }

    #[test]
    fn public_url_is_an_origin_with_https_or_loopback() {
        for (raw, expected) in [
            ("https://app.example.com/", "https://app.example.com/"),
            (
                "https://App.Example.com:8443",
                "https://app.example.com:8443/",
            ),
            ("https://[2001:db8::10]", "https://[2001:db8::10]/"),
            ("http://localhost:5173", "http://localhost:5173/"),
            ("http://127.0.0.1:8080", "http://127.0.0.1:8080/"),
            ("http://[::1]:8080", "http://[::1]:8080/"),
        ] {
            assert_eq!(
                normalize_public_url(raw).map(String::from),
                Ok(expected.into()),
                "{raw}"
            );
        }
        assert_eq!(normalize_public_url(" "), Err("required"));
        for raw in [
            "app.example.com",
            "http://app.example.com",
            "https://app.example.com/mail",
            "https://app.example.com/?a=1",
            "https://max:pw@app.example.com",
            "http://127.0.0.2:8080",
            "ftp://app.example.com",
        ] {
            assert_eq!(normalize_public_url(raw), Err("invalid"), "{raw}");
        }
    }

    #[test]
    fn rejects_unknown_fields() {
        let mut extra = valid();
        extra["role"] = json!("admin");
        assert!(serde_json::from_value::<CompleteBody>(extra).is_err());
    }
}
