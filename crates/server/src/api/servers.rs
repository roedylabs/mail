//! Mail server registry (Administration › Mail servers).
//!
//! - `GET servers`: for every signed-in user – servers without the secret
//!   and the policy, for signing in to mail accounts.
//! - `GET/POST admin/servers`, `GET/PATCH/DELETE admin/servers/:id`,
//!   `GET/PUT admin/servers/policy`: maintenance by administrators; the list
//!   also names the redirect URI and the system mail's server, each server
//!   the number of linked mail accounts (`accounts`, accounts of all users
//!   with its origin).
//! - `POST admin/servers/:id/test`: diagnostics ([`broker::probe`]).
//! - `POST admin/servers/register-client`: OAuth client via DCR
//!   ([`broker::dcr`]); before saving, the dialog enters the
//!   result as the client ID. The backend keeps the confidential client's
//!   secret as a pending registration until a server with this client ID is
//!   saved.
//!
//! Every change reloads the CSP and ends up in the audit log.

use std::{net::Ipv4Addr, time::Duration};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use url::{Host, Url};

use super::{ApiError, FieldErrors, JsonBody, nullable};
use crate::{
    api::error::retry_secs,
    app::AppState,
    auth::{AdminUser, AuthUser, CurrentUser},
    broker::{
        crypto::SecretKey,
        dcr,
        probe::{self, Reasons, Status},
    },
    client_ip::ClientIp,
    db::{
        self,
        repo::{
            audit_log::{self, Category, Entry},
            mail_accounts,
            servers::{
                self, Fields, PENDING_SECRET_PURPOSE, PendingRegistration, SECRET_PURPOSE,
                SecretChange, Server,
            },
        },
    },
    mailer::system_mail,
    rate_limit::{Key, Policy},
};

/// Path of the redirect URI in the app (SPA route).
pub const CALLBACK_PATH: &str = "/oauth/callback";

pub(super) const MAX_LABEL: usize = 100;
const MAX_DOMAINS: usize = 100;
const MAX_DOMAIN: usize = 253;
const MAX_CLIENT_FIELD: usize = 1024;

/// Failed registrations: Stalwart blocks addresses after failed sign-ins
/// (Fail2Ban) – here that would be the backend's, and with it later the
/// token refresh of all users.
const REGISTER_LIMIT: Policy = Policy::lockout(
    "servers.register",
    5,
    Duration::from_secs(15 * 60),
    Duration::from_secs(15 * 60),
);

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/servers", get(list))
        .route("/admin/servers", get(admin_list).post(create))
        .route("/admin/servers/policy", get(policy).put(set_policy))
        .route("/admin/servers/register-client", post(register_client))
        .route(
            "/admin/servers/{id}",
            get(admin_get).patch(update).delete(remove),
        )
        .route("/admin/servers/{id}/test", post(test))
}

/// Server as every signed-in user sees it.
#[derive(Serialize)]
struct PublicServer {
    id: String,
    label: String,
    url: String,
    host: String,
    domains: Vec<String>,
    client_id: Option<String>,
    /// Confidential client (secret in the registry): the backend exchanges
    /// the code, the browser sends it to `POST mail-accounts` or `reauth`.
    backend_exchange: bool,
    reach: Status,
    cors: Status,
    oauth: Status,
}

/// Server for the administration; the secret only as "present".
#[derive(Serialize)]
struct AdminServer {
    id: String,
    label: String,
    url: String,
    host: String,
    domains: Vec<String>,
    client_id: Option<String>,
    has_secret: bool,
    reach: Status,
    cors: Status,
    oauth: Status,
    tested_at: Option<String>,
    /// Number of linked mail accounts.
    accounts: i64,
}

/// Host with port as the list shows it (`mail.example.com:8443`).
pub(super) fn host_of(base_url: &str) -> String {
    Url::parse(base_url)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?.to_owned();
            Some(match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host,
            })
        })
        .unwrap_or_default()
}

impl From<Server> for PublicServer {
    fn from(s: Server) -> Self {
        Self {
            host: host_of(&s.base_url),
            id: s.id,
            label: s.label,
            url: s.base_url,
            domains: s.domains,
            backend_exchange: s.has_secret && s.client_id.is_some(),
            client_id: s.client_id,
            reach: s.reach,
            cors: s.cors,
            oauth: s.oauth,
        }
    }
}

impl AdminServer {
    fn new(s: Server, accounts: i64) -> Self {
        Self {
            host: host_of(&s.base_url),
            id: s.id,
            label: s.label,
            url: s.base_url,
            domains: s.domains,
            client_id: s.client_id,
            has_secret: s.has_secret,
            reach: s.reach,
            cors: s.cors,
            oauth: s.oauth,
            tested_at: s.tested_at,
            accounts,
        }
    }

    /// With the number of accounts now linked to the server.
    fn load(conn: &rusqlite::Connection, s: Server) -> anyhow::Result<Self> {
        let accounts = mail_accounts::count_for(conn, &s.base_url)?;
        Ok(Self::new(s, accounts))
    }
}

async fn list(State(state): State<AppState>, _: CurrentUser) -> Result<Json<Value>, ApiError> {
    let (list, allow) = db::call(&state.db, |conn| {
        Ok((servers::list(conn)?, servers::allow_custom_servers(conn)?))
    })
    .await?;
    let list: Vec<PublicServer> = list.into_iter().map(Into::into).collect();
    Ok(Json(
        json!({ "servers": list, "allow_custom_servers": allow }),
    ))
}

async fn admin_list(State(state): State<AppState>, _: AdminUser) -> Result<Json<Value>, ApiError> {
    let (list, system_mail_server) = db::call(&state.db, |conn| {
        let list = servers::list(conn)?;
        let accounts = mail_accounts::count_by_base_url(conn)?;
        // Server of the system mail (warning on removal); only if it
        // still exists. An unreadable sending account only costs the hint,
        // not the list.
        let system = system_mail::load(conn)
            .unwrap_or_else(|error| {
                tracing::warn!("system mail not readable: {error:#}");
                None
            })
            .map(|mail| mail.server_id)
            .filter(|id| list.iter().any(|s| &s.id == id));
        let list: Vec<AdminServer> = list
            .into_iter()
            .map(|s| {
                let n = accounts.get(&s.base_url).copied().unwrap_or(0);
                AdminServer::new(s, n)
            })
            .collect();
        Ok((list, system))
    })
    .await?;
    // For copying into the manually created client.
    let redirect_uri = redirect_uri(&state.public_url());
    Ok(Json(json!({
        "servers": list,
        "redirect_uri": redirect_uri,
        "system_mail_server": system_mail_server,
    })))
}

async fn admin_get(
    State(state): State<AppState>,
    _: AdminUser,
    Path(id): Path<String>,
) -> Result<Json<AdminServer>, ApiError> {
    db::call(&state.db, move |conn| {
        servers::get(conn, &id)?
            .map(|server| AdminServer::load(conn, server))
            .transpose()
    })
    .await?
    .map(Json)
    .ok_or(ApiError::NotFound)
}

/// `<origin of the app>/oauth/callback`
pub(super) fn redirect_uri(public_url: &Url) -> String {
    format!(
        "{}{CALLBACK_PATH}",
        public_url.origin().ascii_serialization()
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateBody {
    label: String,
    url: String,
    #[serde(default)]
    domains: Vec<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
}

/// Partial change; missing fields stay. `client_id: null` or empty removes
/// client and secret, a new client ID without a new secret also removes the
/// secret – unless it comes from a registration via DCR, then its secret
/// applies; an empty or missing `client_secret` keeps the stored one, `null`
/// removes it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateBody {
    label: Option<String>,
    url: Option<String>,
    domains: Option<Vec<String>>,
    #[serde(default, deserialize_with = "nullable")]
    client_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    client_secret: Option<Option<String>>,
}

/// Validated input of a server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Input {
    pub label: String,
    /// Origin, e.g. `https://mail.example.com`.
    pub base_url: String,
    pub domains: Vec<String>,
    pub client_id: Option<String>,
}

/// Base URL of a mail server: `https://` (for development also `http://` on
/// `localhost` or `127.0.0.1`), host as DNS name or IPv4 address, without
/// credentials, path, query and fragment. The result is the origin without a
/// trailing `/`. The CSP's `connect-src` cannot express IPv6 addresses.
pub fn normalize_url(raw: &str) -> Result<Url, &'static str> {
    parse_origin(raw, true)
}

/// Address of a custom server ("Other server …"): like
/// [`normalize_url`], but only `https://` – without the exception for
/// development, which only administrators get. [`crate::broker::outbound`]
/// checks whether the address is public.
pub fn normalize_custom_url(raw: &str) -> Result<Url, &'static str> {
    parse_origin(raw, false)
}

fn parse_origin(raw: &str, dev_loopback: bool) -> Result<Url, &'static str> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("required");
    }
    let url = Url::parse(raw.trim_end_matches('/')).map_err(|_| "invalid")?;
    let loopback = match url.host() {
        // Only what the CSP's host source can express: labels of `a–z`,
        // `0–9`, `-`, no empty ones (so no trailing dot either).
        Some(Host::Domain(domain)) => {
            if !domain.split('.').all(is_dns_label) {
                return Err("invalid");
            }
            domain == "localhost"
        }
        // Exactly the addresses the page names, not all of 127/8.
        Some(Host::Ipv4(ip)) => ip == Ipv4Addr::LOCALHOST,
        Some(Host::Ipv6(_)) | None => return Err("invalid"),
    };
    let scheme_ok = url.scheme() == "https" || (dev_loopback && url.scheme() == "http" && loopback);
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

/// Domains: lower case, without a leading `@`, without
/// duplicates, format `name.tld`. Errors carry the first invalid domain.
pub fn normalize_domains(raw: &[String]) -> Result<Vec<String>, (&'static str, String)> {
    // Limit up front: the check runs on the database thread.
    if raw.len() > MAX_DOMAINS {
        return Err(("too_many", String::new()));
    }
    let mut domains: Vec<String> = Vec::new();
    for domain in raw {
        let domain = domain.trim().trim_start_matches('@').to_ascii_lowercase();
        if domain.is_empty() || domains.contains(&domain) {
            continue;
        }
        let labels_ok = domain.split('.').count() >= 2 && domain.split('.').all(is_dns_label);
        if !labels_ok || domain.len() > MAX_DOMAIN {
            return Err(("invalid", domain));
        }
        domains.push(domain);
    }
    Ok(domains)
}

fn is_dns_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 63
        && !label.starts_with('-')
        && !label.ends_with('-')
        && label
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub(super) fn clean_optional(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

pub(super) fn check_client_field(errors: &mut FieldErrors, field: &str, value: Option<&str>) {
    if let Some(value) = value
        && (value.len() > MAX_CLIENT_FIELD || value.chars().any(char::is_control))
    {
        errors.code(field, "invalid");
    }
}

/// Checks fields and conflicts with the other servers (`others` without the
/// edited one). Rules as in the server dialog, but duplicates per origin
/// instead of per host.
pub fn validate(
    label: &str,
    url: &str,
    domains: &[String],
    client_id: Option<String>,
    others: &[Server],
) -> Result<Input, FieldErrors> {
    let mut errors = FieldErrors::default();
    let label = label.trim();
    if label.is_empty() {
        errors.code("label", "required");
    } else if label.chars().count() > MAX_LABEL {
        errors.code("label", "too_long");
    }
    let base_url = match normalize_url(url) {
        Ok(url) => {
            let origin = url.origin().ascii_serialization();
            if let Some(other) = others.iter().find(|s| s.base_url == origin) {
                errors.add("url", json!({ "code": "taken", "server": other.label }));
            }
            origin
        }
        Err(code) => {
            errors.code("url", code);
            String::new()
        }
    };
    let domains = match normalize_domains(domains) {
        Ok(domains) => {
            let taken = domains.iter().find_map(|domain| {
                others
                    .iter()
                    .find(|s| s.domains.contains(domain))
                    .map(|s| (domain, s))
            });
            if let Some((domain, other)) = taken {
                errors.add(
                    "domains",
                    json!({ "code": "taken", "domain": domain, "server": other.label }),
                );
            }
            domains
        }
        Err((code, domain)) => {
            errors.add("domains", json!({ "code": code, "domain": domain }));
            Vec::new()
        }
    };
    let client_id = clean_optional(client_id);
    check_client_field(&mut errors, "client_id", client_id.as_deref());
    if errors.is_empty() {
        Ok(Input {
            label: label.to_owned(),
            base_url,
            domains,
            client_id,
        })
    } else {
        Err(errors)
    }
}

/// Entry by an administrator (also for `api::instance`).
pub(super) fn audit_entry(
    category: Category,
    action: &'static str,
    user: &AuthUser,
    ip: ClientIp,
) -> Entry {
    Entry::new(category, action).actor(user).ip(ip.0)
}

async fn create(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
    JsonBody(body): JsonBody<CreateBody>,
) -> Result<(StatusCode, Json<AdminServer>), ApiError> {
    let id = db::new_id()?;
    let secret = clean_optional(body.client_secret);
    let sealed = match &secret {
        Some(secret) => Some(state.secrets.seal(SECRET_PURPOSE, &id, secret.as_bytes())?),
        None => None,
    };
    let csp = state.csp.clone();
    let keys = state.secrets.clone();
    let public_url = state.public_url.clone();
    let server = db::call(&state.db, move |conn| {
        // On the database thread: after a restore this is already its address.
        let expected_redirect = redirect_uri(&public_url.get());
        let tx = conn.transaction()?;
        let others = servers::list(&tx)?;
        let input = match validate(
            &body.label,
            &body.url,
            &body.domains,
            body.client_id,
            &others,
        ) {
            Ok(input) => input,
            Err(errors) => return Ok(Err(errors)),
        };
        let mut errors = FieldErrors::default();
        check_client_field(&mut errors, "client_secret", secret.as_deref());
        if secret.is_some() && input.client_id.is_none() {
            errors.code("client_secret", "needs_client_id");
        }
        check_redirect(&tx, &mut errors, "client_id", &input, &expected_redirect)?;
        if !errors.is_empty() {
            return Ok(Err(errors));
        }
        // An entered secret takes precedence.
        let registered = adopt_registration(&tx, &keys, &input, &id)?;
        let sealed = sealed.or(registered);
        servers::insert(&tx, &id, &fields(&input), sealed.as_deref())?;
        audit_log::insert(
            &tx,
            &audit_entry(Category::System, "servers.create", &user, ip)
                .target(&id)
                .details(json!({ "label": input.label, "url": input.base_url })),
        )?;
        csp.commit(tx)?;
        let server = servers::get(conn, &id)?.ok_or_else(|| anyhow::anyhow!("server missing"))?;
        Ok(Ok(AdminServer::load(conn, server)?))
    })
    .await?
    .map_err(FieldErrors::into_error)?;
    Ok((StatusCode::CREATED, Json(server)))
}

/// A client registered via DCR only works for its redirect URI: if the public
/// address changed after the registration, every sign-in would fail. Then
/// `redirect_mismatch` with the client's redirect URI on `field`.
pub(super) fn check_redirect(
    conn: &rusqlite::Connection,
    errors: &mut FieldErrors,
    field: &str,
    input: &Input,
    redirect_uri: &str,
) -> anyhow::Result<()> {
    let Some(client_id) = &input.client_id else {
        return Ok(());
    };
    if let Some(registration) =
        servers::find_registration(conn, &input.base_url, client_id, unix_now())?
        && registration.redirect_uri != redirect_uri
    {
        errors.add(
            field,
            json!({ "code": "redirect_mismatch", "redirect_uri": registration.redirect_uri }),
        );
    }
    Ok(())
}

/// Adopts the pending registration of the client of `input`: its
/// secret, re-encrypted for the server `server_id`. The registration is
/// removed in the process, even when an entered secret takes precedence; if
/// its secret cannot be opened, it counts as absent.
pub(super) fn adopt_registration(
    conn: &rusqlite::Connection,
    keys: &SecretKey,
    input: &Input,
    server_id: &str,
) -> anyhow::Result<Option<Vec<u8>>> {
    let Some(client_id) = &input.client_id else {
        return Ok(None);
    };
    let Some(registration) =
        servers::take_registration(conn, &input.base_url, client_id, unix_now())?
    else {
        return Ok(None);
    };
    match keys.open(
        PENDING_SECRET_PURPOSE,
        client_id,
        &registration.sealed_secret,
    ) {
        Ok(secret) => Ok(Some(keys.seal(SECRET_PURPOSE, server_id, &secret)?)),
        Err(error) => {
            tracing::warn!(
                url = %input.base_url,
                client_id,
                "registration secret not readable, discarded: {error:#}"
            );
            Ok(None)
        }
    }
}

/// Now in Unix seconds (pending registrations).
pub(super) fn unix_now() -> i64 {
    jiff::Timestamp::now().as_second()
}

pub(super) fn fields(input: &Input) -> Fields<'_> {
    Fields {
        label: &input.label,
        base_url: &input.base_url,
        domains: &input.domains,
        client_id: input.client_id.as_deref(),
    }
}

async fn update(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<UpdateBody>,
) -> Result<Json<AdminServer>, ApiError> {
    // A new secret is encrypted up front (the ID is fixed).
    let new_secret = match &body.client_secret {
        Some(Some(secret)) if !secret.trim().is_empty() => Some(secret.trim().to_owned()),
        _ => None,
    };
    let sealed = match &new_secret {
        Some(secret) => Some(state.secrets.seal(SECRET_PURPOSE, &id, secret.as_bytes())?),
        None => None,
    };
    let csp = state.csp.clone();
    let keys = state.secrets.clone();
    let public_url = state.public_url.clone();
    let result = db::call(&state.db, move |conn| {
        // On the database thread: after a restore this is already its address.
        let expected_redirect = redirect_uri(&public_url.get());
        let tx = conn.transaction()?;
        let all = servers::list(&tx)?;
        let Some(current) = all.iter().find(|s| s.id == id).cloned() else {
            return Ok(None);
        };
        let others: Vec<Server> = all.into_iter().filter(|s| s.id != id).collect();
        let client_id = match body.client_id {
            None => current.client_id.clone(),
            Some(value) => value,
        };
        let input = match validate(
            body.label.as_deref().unwrap_or(&current.label),
            body.url.as_deref().unwrap_or(&current.base_url),
            body.domains.as_deref().unwrap_or(&current.domains),
            client_id,
            &others,
        ) {
            Ok(input) => input,
            Err(errors) => return Ok(Some(Err(errors))),
        };
        let mut errors = FieldErrors::default();
        check_client_field(&mut errors, "client_secret", new_secret.as_deref());
        check_redirect(&tx, &mut errors, "client_id", &input, &expected_redirect)?;
        if !errors.is_empty() {
            return Ok(Some(Err(errors)));
        }
        // A secret belongs to its client: without a client ID there is none,
        // a new client ID does not keep the old one – unless it comes from a
        // registration via DCR, then its secret applies. Nor does
        // a new address: secrets never go to an address they were not entered
        // for.
        let moved = input.base_url != current.base_url;
        let same_client = input.client_id == current.client_id && !moved;
        let registered = adopt_registration(&tx, &keys, &input, &id)?;
        let secret = match (&input.client_id, sealed, &body.client_secret) {
            (None, Some(_), _) => {
                errors.code("client_secret", "needs_client_id");
                SecretChange::Clear
            }
            (None, None, _) => SecretChange::Clear,
            (Some(_), Some(sealed), _) => SecretChange::Set(sealed),
            (Some(_), None, Some(None)) => SecretChange::Clear,
            (Some(_), None, _) => match registered {
                Some(sealed) => SecretChange::Set(sealed),
                None if same_client => SecretChange::Keep,
                None => SecretChange::Clear,
            },
        };
        if !errors.is_empty() {
            return Ok(Some(Err(errors)));
        }
        // The diagnostics check address and client ID; if either changes,
        // they no longer apply.
        let reset = moved || input.client_id != current.client_id;
        servers::update(&tx, &id, &fields(&input), &secret, reset)?;
        if moved && let Some(field) = crate::mailer::system_mail::forget_secret_of(&tx, &id)? {
            // Like a change of the email settings, so the audit log shows why
            // the system mail is no longer set up.
            audit_log::insert(
                &tx,
                &audit_entry(Category::Settings, "system_mail.update", &user, ip)
                    .details(json!({ "fields": [field] })),
            )?;
        }
        audit_log::insert(
            &tx,
            &audit_entry(Category::System, "servers.update", &user, ip)
                .target(&id)
                .details(json!({ "label": input.label, "url": input.base_url })),
        )?;
        csp.commit(tx)?;
        servers::get(conn, &id)?
            .map(|server| AdminServer::load(conn, server).map(Ok))
            .transpose()
    })
    .await?;
    match result {
        None => Err(ApiError::NotFound),
        Some(Err(errors)) => Err(errors.into_error()),
        Some(Ok(server)) => Ok(Json(server)),
    }
}

async fn remove(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let csp = state.csp.clone();
    let removed = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        let Some(server) = servers::get(&tx, &id)? else {
            return Ok(false);
        };
        servers::delete(&tx, &id)?;
        audit_log::insert(
            &tx,
            &audit_entry(Category::System, "servers.delete", &user, ip)
                .target(&id)
                .details(json!({ "label": server.label, "url": server.base_url })),
        )?;
        csp.commit(tx)?;
        Ok(true)
    })
    .await?;
    if removed {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyBody {
    allow_custom_servers: bool,
}

async fn policy(State(state): State<AppState>, _: AdminUser) -> Result<Json<PolicyBody>, ApiError> {
    let allow = db::call(&state.db, |conn| Ok(servers::allow_custom_servers(conn)?)).await?;
    Ok(Json(PolicyBody {
        allow_custom_servers: allow,
    }))
}

async fn set_policy(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
    JsonBody(body): JsonBody<PolicyBody>,
) -> Result<Json<PolicyBody>, ApiError> {
    let allow = body.allow_custom_servers;
    let csp = state.csp.clone();
    db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        if servers::set_allow_custom_servers(&tx, allow)? {
            // Recorded under "Settings" in the audit log.
            audit_log::insert(
                &tx,
                &audit_entry(Category::Settings, "servers.policy", &user, ip)
                    .details(json!({ "allow_custom_servers": allow })),
            )?;
        }
        csp.commit(tx)?;
        Ok(())
    })
    .await?;
    Ok(Json(PolicyBody {
        allow_custom_servers: allow,
    }))
}

#[derive(Serialize)]
struct TestReply {
    server: AdminServer,
    reasons: Reasons,
    /// Seconds, when the mail server throttled (`throttled`).
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after: Option<u64>,
}

async fn test(
    State(state): State<AppState>,
    _: AdminUser,
    Path(id): Path<String>,
) -> Result<Json<TestReply>, ApiError> {
    let lookup = id.clone();
    let server = db::call(&state.db, move |conn| servers::get(conn, &lookup))
        .await?
        .ok_or(ApiError::NotFound)?;
    let (report, recorded) = probe::test_registered(&state, &server, false).await?;
    let server = db::call(&state.db, move |conn| {
        servers::get(conn, &id)?
            .map(|server| AdminServer::load(conn, server))
            .transpose()
    })
    .await?
    .ok_or(ApiError::NotFound)?;
    // The reasons only match the state that was stored.
    let (reasons, retry_after) = if recorded {
        (report.reasons, report.retry_after.map(retry_secs))
    } else {
        (Reasons::default(), None)
    };
    Ok(Json(TestReply {
        server,
        reasons,
        retry_after,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegisterBody {
    url: String,
    username: String,
    password: String,
}

/// Checks the fields of a registration; returns the base URL if it is valid
/// (the other errors are then in `errors`).
pub(super) fn check_registration(
    errors: &mut FieldErrors,
    url: &str,
    username: &str,
    password: &str,
) -> Option<Url> {
    let base_url = normalize_url(url)
        .inspect_err(|code| errors.code("url", code))
        .ok();
    if username.trim().is_empty() {
        errors.code("username", "required");
    }
    if password.is_empty() {
        errors.code("password", "required");
    }
    base_url
}

/// Result of a registration via DCR.
pub(super) struct Registered {
    /// Origin of the server.
    pub url: String,
    pub client_id: String,
    pub redirect_uri: String,
}

impl Registered {
    /// Reply to the dialog: the backend keeps the secret until a server with
    /// the client ID is saved; `has_secret` says that there is one.
    pub fn reply(&self) -> Value {
        json!({
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "has_secret": true,
        })
    }
}

/// Registers the OAuth client via DCR (administration and setup) and
/// remembers its secret as a pending registration: at most five
/// rejected sign-ins in 15 minutes (Fail2Ban of the mail server), errors as
/// `registration_failed` with `reason` – never 401/403, otherwise the web app
/// would consider its own session invalid.
pub(super) async fn register(
    state: &AppState,
    base_url: &Url,
    username: &str,
    password: &str,
    public_url: &Url,
) -> Result<Registered, ApiError> {
    let origin = public_url.origin().ascii_serialization();
    let redirect_uri = redirect_uri(public_url);

    // If the request is aborted, the reservation returns the attempt.
    let attempt = state.limiter.reserve(&REGISTER_LIMIT, Key::Global)?;
    let result = dcr::register(
        &state.http,
        &dcr::Registration {
            base_url,
            redirect_uri: &redirect_uri,
            client_uri: &origin,
            username: username.trim(),
            password,
        },
    )
    .await;
    // Only rejected sign-ins count (Fail2Ban of the mail server) – with a
    // second factor also those without a code, in case Stalwart counts them.
    if matches!(
        result,
        Err(dcr::Error::AuthFailed | dcr::Error::MfaRequired)
    ) {
        attempt.count();
    } else {
        drop(attempt);
    }
    let url = base_url.origin().ascii_serialization();
    let client = match result {
        Ok(client) => client,
        Err(error) => {
            tracing::info!(url = %url, reason = error.reason(), detail = ?error, "OAuth client registration failed");
            let status = match error {
                dcr::Error::AuthFailed | dcr::Error::MfaRequired | dcr::Error::Forbidden => {
                    StatusCode::UNPROCESSABLE_ENTITY
                }
                _ => StatusCode::BAD_GATEWAY,
            };
            let mut rejection =
                ApiError::rejected(status, "registration_failed").with("reason", error.reason());
            match error {
                dcr::Error::Rejected(code) => rejection = rejection.with("detail", code),
                dcr::Error::Throttled(retry_after) => {
                    rejection = rejection.with("retry_after", retry_secs(retry_after));
                }
                _ => {}
            }
            return Err(rejection);
        }
    };
    let remembered = async {
        let registration = PendingRegistration {
            base_url: url.clone(),
            client_id: client.client_id.clone(),
            redirect_uri: redirect_uri.clone(),
            sealed_secret: state.secrets.seal(
                PENDING_SECRET_PURPOSE,
                &client.client_id,
                client.client_secret.as_bytes(),
            )?,
            registered_at: unix_now(),
        };
        db::call(&state.db, move |conn| {
            servers::remember_registration(conn, registration, unix_now())
        })
        .await
    };
    if let Err(error) = remembered.await {
        // The client now exists in Stalwart, but without the secret it is
        // useless; the admin can delete it there.
        tracing::error!(
            url = %url,
            client_id = %client.client_id,
            "registered OAuth client not stored: {error:#}"
        );
        return Err(error.into());
    }
    Ok(Registered {
        url,
        client_id: client.client_id,
        redirect_uri,
    })
}

async fn register_client(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
    JsonBody(body): JsonBody<RegisterBody>,
) -> Result<Json<Value>, ApiError> {
    let mut errors = FieldErrors::default();
    let base_url = check_registration(&mut errors, &body.url, &body.username, &body.password);
    let base_url = match base_url {
        Some(url) if errors.is_empty() => url,
        _ => return Err(errors.into_error()),
    };
    let registered = register(
        &state,
        &base_url,
        &body.username,
        &body.password,
        &state.public_url(),
    )
    .await?;
    let entry = audit_entry(Category::System, "servers.register_client", &user, ip)
        .details(json!({ "url": registered.url, "client_id": registered.client_id }));
    db::call(&state.db, move |conn| Ok(audit_log::insert(conn, &entry)?)).await?;
    Ok(Json(registered.reply()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(label: &str, url: &str, domains: &[&str]) -> Server {
        Server {
            id: label.into(),
            label: label.into(),
            base_url: url.into(),
            domains: domains.iter().map(|d| (*d).to_owned()).collect(),
            client_id: None,
            has_secret: false,
            reach: Status::Unk,
            cors: Status::Unk,
            oauth: Status::Unk,
            tested_at: None,
        }
    }

    #[test]
    fn normalizes_urls() {
        for (raw, expected) in [
            ("https://mail.s1.test", "https://mail.s1.test/"),
            ("  https://Mail.S1.test/  ", "https://mail.s1.test/"),
            ("https://mail.s1.test///", "https://mail.s1.test/"),
            ("https://mail.s1.test:443", "https://mail.s1.test/"),
            ("https://mail.s1.test:8443", "https://mail.s1.test:8443/"),
            ("https://café.example", "https://xn--caf-dma.example/"),
            ("https://192.0.2.10", "https://192.0.2.10/"),
            ("http://localhost:8080", "http://localhost:8080/"),
            ("http://127.0.0.1:8080/", "http://127.0.0.1:8080/"),
        ] {
            assert_eq!(
                normalize_url(raw).map(String::from),
                Ok(expected.into()),
                "{raw}"
            );
        }
        assert_eq!(normalize_url(" "), Err("required"));
        for raw in [
            "mail.s1.test",
            "http://mail.s1.test",
            "ftp://mail.s1.test",
            "https://mail.s1.test/jmap",
            "https://mail.s1.test/?a=1",
            "https://mail.s1.test/#x",
            "https://admin:pw@mail.s1.test",
            "https://[2001:db8::1]",
            "https://a;b.test",
            "https://mail.s1.test.",
            "https://-mail.s1.test",
            "http://127.0.0.2:8080",
            "http://[::1]:8080",
            "https://mail-.s1.test",
            "https://",
        ] {
            assert_eq!(normalize_url(raw), Err("invalid"), "{raw}");
        }
    }

    #[test]
    fn normalizes_domains() {
        let raw = ["@S1.test", " example.org ", "s1.test", ""].map(String::from);
        assert_eq!(
            normalize_domains(&raw),
            Ok(vec!["s1.test".into(), "example.org".into()])
        );
        for bad in [
            "localhost",
            "a..test",
            "x_y.test",
            "café.test",
            ".test",
            "s1.test.",
            "-a.test",
        ] {
            assert_eq!(
                normalize_domains(&[bad.to_owned()]),
                Err(("invalid", bad.to_lowercase())),
                "{bad}"
            );
        }
    }

    #[test]
    fn limits_domains_before_checking_them() {
        let many: Vec<String> = (0..=MAX_DOMAINS).map(|i| format!("d{i}.test")).collect();
        assert_eq!(normalize_domains(&many), Err(("too_many", String::new())));
        assert_eq!(
            normalize_domains(&many[..MAX_DOMAINS]).unwrap().len(),
            MAX_DOMAINS
        );
    }

    #[test]
    fn validates_fields_and_conflicts() {
        let others = [server("VPS 1", "https://mail.s1.test", &["s1.test"])];
        let input = validate(
            " VPS 2 ",
            "https://mail.s2.test/",
            &["s2.test".into()],
            Some("  ".into()),
            &others,
        )
        .unwrap();
        assert_eq!(
            input,
            Input {
                label: "VPS 2".into(),
                base_url: "https://mail.s2.test".into(),
                domains: vec!["s2.test".into()],
                client_id: None,
            }
        );

        let Err(errors) = validate(
            "",
            "https://MAIL.s1.test",
            &["s1.test".into()],
            Some("a\u{7}b".into()),
            &others,
        ) else {
            panic!("expected errors");
        };
        assert_eq!(
            errors.into_value(),
            json!({
                "label": { "code": "required" },
                "url": { "code": "taken", "server": "VPS 1" },
                "domains": { "code": "taken", "domain": "s1.test", "server": "VPS 1" },
                "client_id": { "code": "invalid" },
            })
        );

        let long = "x".repeat(MAX_LABEL + 1);
        let Err(errors) = validate(&long, "https://", &["a b".into()], None, &[]) else {
            panic!("expected errors");
        };
        assert_eq!(
            errors.into_value(),
            json!({
                "label": { "code": "too_long" },
                "url": { "code": "invalid" },
                "domains": { "code": "invalid", "domain": "a b" },
            })
        );
    }

    #[test]
    fn redirect_uri_uses_origin() {
        let url = Url::parse("https://app.example.com/path/").unwrap();
        assert_eq!(redirect_uri(&url), "https://app.example.com/oauth/callback");
    }
}
