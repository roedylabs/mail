//! Users' mail accounts (Account › Email accounts).
//!
//! - `GET mail-accounts`: the own accounts without tokens, with `state` and
//!   `blocked` (custom server while the policy is off).
//! - `POST mail-accounts`: connects an account with the tokens from the
//!   browser – access and refresh token after signing in at the mail server
//!   (`oauth`) or an access token (`token`). The JMAP session of the tokens
//!   tells which account it is ([`broker::account`]); if it is already
//!   connected, 409 `dup` with that account. Server from the registry
//!   (`server_id`) or custom server (`url`, only with
//!   `allow_custom_servers`, only public addresses). The first account
//!   becomes the default account (`defaultAccount`).
//!   For confidential clients (secret in the registry) the browser sends
//!   code and PKCE verifier, and the backend exchanges them; only such
//!   accounts are refreshed with the secret (`backend_exchange`). A grant
//!   from the exchange that is not kept (`dup`, failed check) is revoked.
//! - `POST mail-accounts/:id/reauth`: "sign in again" with the same checks,
//!   under the user's lock like creating; the session must name the same
//!   account. Afterwards the token broker revokes the previous grant – or the
//!   new one from a code exchange if it is not kept (`other_account`, account
//!   removed meanwhile).
//! - `PATCH mail-accounts/:id`: color (`color`, index into `MA_COLORS` of `@roedy/tokens`).
//! - `POST mail-accounts/:id/check`: "check connection" – session and
//!   storage (`Quota/get`) with an access token from the broker, stored in
//!   `quota_used`, `quota_total` and `last_check_at`.
//! - `GET mail-accounts/:id/token`: access token for the browser via the
//!   token broker ([`token`]).
//! - `DELETE mail-accounts/:id`: removes an own account; if it was the
//!   default account, the next one applies. Its links to tags go away via
//!   the foreign key. Afterwards the token broker revokes the grant at the
//!   mail server ([`token::revoke`]).
//!
//! Deleting the own app account (`DELETE auth/me`) revokes the grants of all
//! accounts via [`grants`] and [`revoke_grants`].

use std::{
    collections::BTreeSet,
    net::IpAddr,
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::{HeaderMap, StatusCode},
    routing::{delete, get, post},
};
use roedy_jmap::Storage;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use url::{Host, Url};

use super::{
    ApiError, FieldErrors, JsonBody,
    servers::{
        check_client_field, clean_optional, host_of, normalize_custom_url, normalize_url,
        redirect_uri,
    },
};
use crate::{
    app::AppState,
    auth::{CurrentUser, email, session::AuthUser},
    broker::{
        account, oauth,
        outbound::{self, Blocked},
        token,
    },
    db::{
        self,
        repo::{
            mail_accounts::{
                self, ACCESS_PURPOSE, AuthKind, COLORS, MailAccount, NewAccount, Reauth,
                SECRET_PURPOSE,
            },
            servers::{self, Server},
            sessions,
        },
    },
    locks::KeyedLock,
    rate_limit::{Key, Policy},
    settings::{self, DefaultAccount},
};

/// Every attempt queries the mail server.
const ADD_LIMIT: Policy = Policy::rate("mail_accounts.add", 10, Duration::from_secs(10 * 60));
/// Rejected tokens per user.
pub(crate) const REJECTED_LIMIT: Policy = Policy::lockout(
    "mail_accounts.rejected",
    5,
    Duration::from_secs(15 * 60),
    Duration::from_secs(15 * 60),
);
/// Rejected tokens per user over one hour: at most half as many as lock the
/// mail server for everyone ([`REJECTED_SERVER_LIMIT`]) – otherwise a single
/// user with wrong tokens would lock "add account" and "sign in again" for
/// all users of the server.
pub(crate) const REJECTED_HOUR_LIMIT: Policy = Policy::lockout(
    "mail_accounts.rejected_hour",
    10,
    Duration::from_secs(60 * 60),
    Duration::from_secs(60 * 60),
);
/// Rejected tokens per mail server: Stalwart blocks addresses after failed
/// sign-ins (Fail2Ban) – here the backend's, and with it the token refresh of
/// all accounts on that server. Per server, so that a server that always
/// rejects (e.g. a custom one) does not lock the others.
pub(crate) const REJECTED_SERVER_LIMIT: Policy = Policy::lockout(
    "mail_accounts.rejected_server",
    20,
    Duration::from_secs(60 * 60),
    Duration::from_secs(60 * 60),
);

/// Access tokens per user: the app fetches one per account at startup and
/// then before expiry, in every tab.
const TOKEN_LIMIT: Policy = Policy::rate("mail_accounts.token", 60, Duration::from_secs(60));
/// Refreshing on demand (`refresh=true`) queries the mail server every time.
const FORCE_REFRESH_LIMIT: Policy = Policy::rate(
    "mail_accounts.token_refresh",
    10,
    Duration::from_secs(10 * 60),
);

/// "Check connection" queries the mail server three to eight times (session
/// with redirect, `Quota/get`; after a 401 metadata and token endpoint, then
/// once more from the start).
const CHECK_LIMIT: Policy = Policy::rate("mail_accounts.check", 10, Duration::from_secs(60));

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/mail-accounts", get(list).post(create))
        .route("/mail-accounts/{id}", delete(remove).patch(update))
        .route("/mail-accounts/{id}/token", get(token))
        .route("/mail-accounts/{id}/reauth", post(reauth))
        .route("/mail-accounts/{id}/check", post(check))
}

/// An account as its user sees it; never tokens or session.
#[derive(Serialize)]
struct AccountView {
    id: String,
    email: String,
    /// Username of the JMAP session (shown in the account's connection
    /// details).
    username: String,
    /// Origin of the mail server.
    url: String,
    host: String,
    /// Registry server with this origin; `null` = custom server.
    server_id: Option<String>,
    auth_kind: &'static str,
    /// Index into `MA_COLORS`.
    color: i64,
    /// `ok` or `needs_reauth` ("sign-in required").
    state: String,
    /// Without a registry server and not usable as a custom server: the
    /// app's CSP blocks it (`raBlocked`) until the policy is on again or the
    /// server is added to the registry.
    blocked: bool,
    quota_used: Option<i64>,
    quota_total: Option<i64>,
    last_check_at: Option<String>,
    created_at: String,
}

/// Whether an account without a registry server is usable as a custom
/// server: policy on and an address that would pass as a custom server
/// (`https://`, no internal IP address) – e.g. not `http://localhost` of a
/// removed development server. Internal DNS names are only detected by the
/// connection (`AppState::user_http`).
fn usable_as_custom(base_url: &str, allow_custom: bool) -> bool {
    allow_custom
        && normalize_custom_url(base_url).is_ok_and(|url| match url.host() {
            Some(Host::Ipv4(ip)) => outbound::is_public(IpAddr::V4(ip)),
            _ => true,
        })
}

/// An account without a registry server that is not usable as a custom
/// server: no tokens, no signing in again (`raBlocked`).
pub(crate) fn blocked(base_url: &str, registered: bool, allow_custom: bool) -> bool {
    !registered && !usable_as_custom(base_url, allow_custom)
}

fn view(account: MailAccount, server_id: Option<String>, allow_custom: bool) -> AccountView {
    AccountView {
        host: host_of(&account.base_url),
        blocked: blocked(&account.base_url, server_id.is_some(), allow_custom),
        server_id,
        id: account.id,
        email: account.email,
        username: account.username,
        url: account.base_url,
        auth_kind: account.auth_kind.as_str(),
        color: account.color,
        state: account.state,
        quota_used: account.quota_used,
        quota_total: account.quota_total,
        last_check_at: account.last_check_at,
        created_at: account.created_at,
    }
}

/// [`view`] with the registry server and the policy as of now.
fn current_view(conn: &Connection, account: MailAccount) -> anyhow::Result<AccountView> {
    let server_id = servers::find_by_base_url(conn, &account.base_url)?.map(|server| server.id);
    let allow = servers::allow_custom_servers(conn)?;
    Ok(view(account, server_id, allow))
}

async fn list(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<Value>, ApiError> {
    let accounts = db::call(&state.db, move |conn| {
        let registry = servers::ids_by_base_url(conn)?;
        let allow = servers::allow_custom_servers(conn)?;
        Ok(mail_accounts::list(conn, &user.id)?
            .into_iter()
            .map(|account| {
                let server_id = registry.get(&account.base_url).cloned();
                view(account, server_id, allow)
            })
            .collect::<Vec<_>>())
    })
    .await?;
    Ok(Json(json!({ "accounts": accounts })))
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum AuthKindBody {
    Oauth,
    Token,
}

impl From<AuthKindBody> for AuthKind {
    fn from(kind: AuthKindBody) -> Self {
        match kind {
            AuthKindBody::Oauth => Self::Oauth,
            AuthKindBody::Token => Self::Token,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateBody {
    /// Entered address (`login_hint`); the session tells which one applies.
    email: String,
    /// Registry server …
    server_id: Option<String>,
    /// … or custom server ("Anderer Server …"); not both.
    url: Option<String>,
    auth_kind: AuthKindBody,
    /// `oauth`: response of the token endpoint.
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u32>,
    /// `oauth`: client the browser signed in with; if missing, the registry
    /// client applies.
    client_id: Option<String>,
    /// `oauth` with a confidential client (`backend_exchange` in `GET
    /// servers`): code and PKCE verifier instead of the tokens; the backend
    /// exchanges them.
    code: Option<String>,
    code_verifier: Option<String>,
    /// `token`: access token.
    token: Option<String>,
    /// App user the browser started the sign-in for; if it is not the
    /// signed-in user (another sign-in in the same browser meanwhile), 409
    /// `session_changed` before anything is exchanged or stored.
    user_id: Option<String>,
}

/// "Sign in again": the same fields as when creating, without account and
/// server – those are fixed.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReauthBody {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u32>,
    client_id: Option<String>,
    code: Option<String>,
    code_verifier: Option<String>,
    token: Option<String>,
    /// App user the browser started the sign-in for; if it is not the
    /// signed-in user (another sign-in in the same browser meanwhile), 409
    /// `session_changed` before anything is exchanged or stored.
    user_id: Option<String>,
}

/// Tokens or code from the body.
struct Supplied {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u32>,
    code: Option<String>,
    code_verifier: Option<String>,
    token: Option<String>,
}

/// Where the account belongs.
enum Target {
    Registry(Server),
    /// Custom server; public addresses only.
    Custom(Url),
}

impl Target {
    fn origin(&self) -> anyhow::Result<Url> {
        match self {
            Self::Registry(server) => Ok(Url::parse(&server.base_url)?),
            Self::Custom(url) => Ok(url.clone()),
        }
    }
}

/// What the browser sends. The secret that is stored is the refresh token or
/// the access token.
enum Credentials {
    Oauth {
        access: String,
        refresh: String,
        expires_in: Option<u32>,
    },
    /// Confidential client: the backend exchanges the code.
    Code {
        code: String,
        verifier: String,
    },
    Token(String),
}

/// A token: required, otherwise as [`oauth::token_problem`].
fn token_field(errors: &mut FieldErrors, field: &str, value: Option<String>) -> Option<String> {
    let value = value.map(|v| v.trim().to_owned()).unwrap_or_default();
    match oauth::token_problem(&value) {
        None => Some(value),
        Some(code) => {
            errors.code(field, code);
            None
        }
    }
}

/// PKCE verifier (RFC 7636, section 4.1): 43 to 128 characters from
/// `A–Z`, `a–z`, `0–9` and `-._~`.
fn verifier_field(errors: &mut FieldErrors, value: Option<String>) -> Option<String> {
    let value = value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    let code = match &value {
        None => "required",
        Some(v)
            if (43..=128).contains(&v.len())
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b)) =>
        {
            return value;
        }
        Some(_) => "invalid",
    };
    errors.code("code_verifier", code);
    None
}

fn credentials(
    errors: &mut FieldErrors,
    kind: AuthKind,
    supplied: Supplied,
) -> Option<Credentials> {
    match kind {
        AuthKind::Oauth if supplied.code.is_some() => {
            if supplied.access_token.is_some() || supplied.refresh_token.is_some() {
                errors.code("code", "conflict");
                return None;
            }
            let code = token_field(errors, "code", supplied.code);
            let verifier = verifier_field(errors, supplied.code_verifier);
            Some(Credentials::Code {
                code: code?,
                verifier: verifier?,
            })
        }
        AuthKind::Oauth => {
            let access = token_field(errors, "access_token", supplied.access_token);
            let refresh = token_field(errors, "refresh_token", supplied.refresh_token);
            Some(Credentials::Oauth {
                access: access?,
                refresh: refresh?,
                expires_in: supplied.expires_in,
            })
        }
        AuthKind::Token => token_field(errors, "token", supplied.token).map(Credentials::Token),
    }
}

/// The client the tokens are issued for: the one the browser names,
/// otherwise the registry's. Without a registry client there is no sign-in
/// at the mail server and no refresh; the backend exchanges the code only
/// for confidential clients (secret in the registry).
fn oauth_client(
    errors: &mut FieldErrors,
    target: &Target,
    given: Option<String>,
    credentials: Option<&Credentials>,
) -> Option<String> {
    let server = match target {
        Target::Registry(server) if server.client_id.is_some() => server,
        _ => {
            errors.code("auth_kind", "no_client");
            return None;
        }
    };
    if matches!(credentials, Some(Credentials::Code { .. })) && !server.has_secret {
        errors.code("code", "not_allowed");
    }
    given.or_else(|| server.client_id.clone())
}

/// Server from the registry or a custom address. A custom address with the
/// origin of a registry server counts as that server.
fn target(
    conn: &Connection,
    body: &CreateBody,
    errors: &mut FieldErrors,
) -> anyhow::Result<Option<Target>> {
    let raw = match (&body.server_id, &body.url) {
        (Some(_), Some(_)) => {
            errors.code("url", "conflict");
            return Ok(None);
        }
        (Some(id), None) => {
            let found = servers::get(conn, id)?;
            if found.is_none() {
                errors.code("server_id", "not_found");
            }
            return Ok(found.map(Target::Registry));
        }
        (None, Some(raw)) => raw,
        (None, None) => {
            errors.code("server_id", "required");
            return Ok(None);
        }
    };
    if let Ok(url) = normalize_url(raw) {
        let origin = url.origin().ascii_serialization();
        if let Some(server) = servers::find_by_base_url(conn, &origin)? {
            return Ok(Some(Target::Registry(server)));
        }
    }
    let url = match normalize_custom_url(raw) {
        Ok(url) => url,
        Err(code) => {
            errors.code("url", code);
            return Ok(None);
        }
    };
    if !servers::allow_custom_servers(conn)? {
        errors.code("url", "not_allowed");
        return Ok(None);
    }
    Ok(Some(Target::Custom(url)))
}

/// Does the server still hold as [`target`] found it before the check at
/// the mail server? Returns the registry server's ID; in between the
/// administrator may have removed it, changed its address or its client, or
/// switched the policy off.
fn recheck(
    conn: &Connection,
    target: &Target,
    oauth: bool,
) -> anyhow::Result<Result<Option<String>, FieldErrors>> {
    let mut errors = FieldErrors::default();
    let server_id = match target {
        Target::Registry(server) => match servers::get(conn, &server.id)? {
            Some(now) if now.base_url == server.base_url => {
                if oauth && now.client_id.is_none() {
                    errors.code("auth_kind", "no_client");
                }
                Some(now.id)
            }
            _ => {
                errors.code("server_id", "not_found");
                None
            }
        },
        Target::Custom(url) => {
            let origin = url.origin().ascii_serialization();
            let found = servers::find_by_base_url(conn, &origin)?.map(|server| server.id);
            if found.is_none() && !servers::allow_custom_servers(conn)? {
                errors.code("url", "not_allowed");
            }
            found
        }
    };
    Ok(if errors.is_empty() {
        Ok(server_id)
    } else {
        Err(errors)
    })
}

fn check_failed(status: StatusCode, reason: &'static str) -> ApiError {
    ApiError::rejected(status, "check_failed").with("reason", reason)
}

/// The mail server did not exchange the code: 422 if it rejects what the
/// backend sent (code, verifier or client), otherwise 502.
fn exchange_failed(error: &oauth::Error) -> ApiError {
    let status = match error {
        oauth::Error::InvalidGrant | oauth::Error::InvalidClient | oauth::Error::Rejected(_) => {
            StatusCode::UNPROCESSABLE_ENTITY
        }
        _ => StatusCode::BAD_GATEWAY,
    };
    let rejection = ApiError::rejected(status, "exchange_failed").with("reason", error.reason());
    match error {
        oauth::Error::Rejected(code) => rejection.with("detail", code.clone()),
        _ => rejection,
    }
}

/// Exchanges the code of a confidential client; the secret
/// belongs only to the registry client ([`token::client_secret`]).
async fn exchange(
    state: &AppState,
    server: &Server,
    base_url: &Url,
    client_id: &str,
    code: &str,
    verifier: &str,
) -> Result<Result<oauth::Tokens, oauth::Error>, ApiError> {
    let redirect_uri = redirect_uri(&state.public_url);
    let secret = token::client_secret(state, server, client_id).await?;
    Ok(oauth::request(
        &state.http,
        base_url,
        oauth::Client {
            id: client_id,
            secret: secret.as_deref(),
        },
        oauth::Grant::Code {
            code,
            verifier,
            redirect_uri: &redirect_uri,
        },
    )
    .await)
}

/// Verified sign-in: the tokens (after the code exchange) and the account
/// according to the session.
struct Verified {
    origin: String,
    secret: String,
    /// `oauth`: access token and its lifetime from receipt.
    access: Option<(String, Option<u32>)>,
    received: Instant,
    account: account::Account,
    /// The backend exchanged the code (confidential client): only such a
    /// grant is refreshed with the client secret, and nobody but the backend
    /// holds its refresh token.
    exchanged: bool,
}

impl Verified {
    /// The grant if the backend obtained it by exchanging a code; when it is
    /// not kept, the caller revokes it ([`token::revoke_discarded`]). Tokens
    /// from the browser stay the browser's: it may send the same ones again,
    /// for example after a lost response, and would then revoke the grant of
    /// the account that has them already.
    fn exchanged(&self, target: &Target, client_id: Option<&str>) -> Option<token::Discarded> {
        self.exchanged
            .then(|| discarded(target, client_id, &self.secret))
            .flatten()
    }
}

/// A grant from the code exchange (only at registry servers) for
/// [`token::revoke_discarded`].
fn discarded(
    target: &Target,
    client_id: Option<&str>,
    refresh_token: &str,
) -> Option<token::Discarded> {
    match (target, client_id) {
        (Target::Registry(server), Some(client_id)) => Some(token::Discarded {
            server: server.clone(),
            client_id: client_id.to_owned(),
            refresh_token: refresh_token.to_owned(),
        }),
        _ => None,
    }
}

/// Queries the mail server: exchange the code (confidential clients), then
/// the session of the tokens ([`account::check`]). Rejected codes and tokens
/// count against the limits (the mail server's Fail2Ban).
async fn verify(
    state: &AppState,
    user_id: &str,
    target: &Target,
    client_id: Option<&str>,
    credentials: Credentials,
    hint: &str,
    received: Instant,
) -> Result<Verified, ApiError> {
    let base_url = target.origin()?;
    let http = match target {
        Target::Registry(_) => &state.http,
        Target::Custom(url) => {
            match outbound::check_public(url).await {
                Ok(()) => {}
                Err(Blocked::Private) => {
                    let mut errors = FieldErrors::default();
                    errors.code("url", "private");
                    return Err(errors.into_error());
                }
                Err(Blocked::Unresolvable) => {
                    return Err(check_failed(StatusCode::BAD_GATEWAY, "unreachable"));
                }
            }
            &state.user_http
        }
    };
    let origin = base_url.origin().ascii_serialization();

    // If the request is aborted, the reservations return the attempt.
    let rejected = state
        .limiter
        .reserve(&REJECTED_LIMIT, Key::User(user_id.to_owned()))?;
    let rejected_hour = state
        .limiter
        .reserve(&REJECTED_HOUR_LIMIT, Key::User(user_id.to_owned()))?;
    let rejected_server = state
        .limiter
        .reserve(&REJECTED_SERVER_LIMIT, Key::Server(origin.clone()))?;
    let (secret, access, received, exchanged) = match credentials {
        Credentials::Oauth {
            access,
            refresh,
            expires_in,
        } => (refresh, Some((access, expires_in)), received, false),
        Credentials::Token(token) => (token, None, received, false),
        Credentials::Code { code, verifier } => {
            let (Target::Registry(server), Some(client_id)) = (target, client_id) else {
                return Err(anyhow::anyhow!("code exchange without a registry client").into());
            };
            let tokens = match exchange(state, server, &base_url, client_id, &code, &verifier)
                .await?
            {
                Ok(tokens) => tokens,
                Err(error) => {
                    if error.is_rejected() {
                        rejected.count();
                        rejected_hour.count();
                        rejected_server.count();
                    }
                    tracing::info!(user = %user_id, url = %origin, reason = error.reason(), "code not exchanged");
                    return Err(exchange_failed(&error));
                }
            };
            let Some(refresh) = tokens.refresh_token else {
                tracing::info!(user = %user_id, url = %origin, "code exchange without refresh token");
                return Err(
                    ApiError::rejected(StatusCode::BAD_GATEWAY, "exchange_failed")
                        .with("reason", "no_refresh_token"),
                );
            };
            (
                refresh,
                Some((tokens.access_token, tokens.expires_in)),
                Instant::now(),
                true,
            )
        }
    };

    let bearer = access
        .as_ref()
        .map_or(secret.as_str(), |(access, _)| access);
    let result = account::check(http, &base_url, bearer, hint).await;
    if result.as_ref().is_err_and(account::CheckError::is_rejected) {
        rejected.count();
        rejected_hour.count();
        rejected_server.count();
    } else {
        drop((rejected, rejected_hour, rejected_server));
    }
    let account = match result {
        Ok(account) => account,
        Err(error) => {
            tracing::info!(user = %user_id, url = %origin, reason = error.reason(), "mail account sign-in not verified");
            // The grant just exchanged is of no use without the account.
            if let Some(discarded) = exchanged
                .then(|| discarded(target, client_id, &secret))
                .flatten()
            {
                token::revoke_discarded(state, user_id, discarded);
            }
            let status = if error.is_rejected() {
                StatusCode::UNPROCESSABLE_ENTITY
            } else {
                StatusCode::BAD_GATEWAY
            };
            return Err(check_failed(status, error.reason()));
        }
    };
    Ok(Verified {
        origin,
        secret,
        access,
        received,
        account,
        exchanged,
    })
}

/// Encrypted tokens of a verified account (the ID is the AAD).
struct Sealed {
    secret_enc: Vec<u8>,
    access_token_enc: Option<Vec<u8>>,
    /// Lifetime of the access token from now.
    expires_in: Option<u32>,
    session_json: String,
}

fn seal(state: &AppState, id: &str, verified: &Verified) -> anyhow::Result<Sealed> {
    let secret_enc = state
        .secrets
        .seal(SECRET_PURPOSE, id, verified.secret.as_bytes())?;
    let (access_token_enc, expires_in) = match &verified.access {
        Some((access, expires_in)) => {
            // The time since receipt has already passed (rounded up).
            let elapsed =
                u32::try_from(verified.received.elapsed().as_secs() + 1).unwrap_or(u32::MAX);
            (
                Some(state.secrets.seal(ACCESS_PURPOSE, id, access.as_bytes())?),
                expires_in.map(|secs| secs.saturating_sub(elapsed)),
            )
        }
        None => (None, None),
    };
    Ok(Sealed {
        secret_enc,
        access_token_enc,
        expires_in,
        session_json: serde_json::to_string(&verified.account.session)?,
    })
}

/// Sign-in from the body, when creating as well as when signing in again.
struct Login {
    kind: AuthKind,
    credentials: Option<Credentials>,
    /// Client the browser names.
    client_id: Option<String>,
    /// `expires_in` counts from the token endpoint's response; the backend
    /// gets no closer to it than the arrival of the request.
    received: Instant,
}

impl Login {
    fn parse(
        errors: &mut FieldErrors,
        kind: AuthKind,
        supplied: Supplied,
        client_id: Option<String>,
        received: Instant,
    ) -> Self {
        let credentials = credentials(errors, kind, supplied);
        let client_id = clean_optional(client_id);
        check_client_field(errors, "client_id", client_id.as_deref());
        Self {
            kind,
            credentials,
            client_id,
            received,
        }
    }

    /// Queries the mail server ([`verify`]) if all inputs are valid –
    /// `errors` carries those of the other fields; plus the client of the
    /// tokens ([`oauth_client`]).
    async fn check(
        self,
        state: &AppState,
        user_id: &str,
        target: &Target,
        hint: &str,
        mut errors: FieldErrors,
    ) -> Result<(Verified, Option<String>), ApiError> {
        let client_id = if self.kind == AuthKind::Oauth {
            oauth_client(
                &mut errors,
                target,
                self.client_id,
                self.credentials.as_ref(),
            )
        } else {
            None
        };
        let credentials = match self.credentials {
            Some(credentials) if errors.is_empty() => credentials,
            _ => return Err(errors.into_error()),
        };
        state
            .limiter
            .acquire(&ADD_LIMIT, Key::User(user_id.to_owned()))?;
        let verified = verify(
            state,
            user_id,
            target,
            client_id.as_deref(),
            credentials,
            hint,
            self.received,
        )
        .await?;
        Ok((verified, client_id))
    }
}

/// 409 `session_changed` if the browser started the sign-in for another app
/// user than the one signed in now (`user_id` in the body).
fn same_user(expected: Option<&str>, user_id: &str) -> Result<(), ApiError> {
    match expected {
        Some(expected) if expected != user_id => {
            Err(ApiError::rejected(StatusCode::CONFLICT, "session_changed"))
        }
        _ => Ok(()),
    }
}

async fn create(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    JsonBody(mut body): JsonBody<CreateBody>,
) -> Result<(StatusCode, Json<AccountView>), ApiError> {
    let received = Instant::now();
    same_user(body.user_id.as_deref(), &user.id)?;
    let mut errors = FieldErrors::default();
    let hint = body.email.trim().to_lowercase();
    if hint.is_empty() {
        errors.code("email", "required");
    } else if !email::is_valid(&hint) {
        errors.code("email", "invalid");
    }
    let kind = AuthKind::from(body.auth_kind);
    let login = Login::parse(
        &mut errors,
        kind,
        Supplied {
            access_token: body.access_token.take(),
            refresh_token: body.refresh_token.take(),
            expires_in: body.expires_in,
            code: body.code.take(),
            code_verifier: body.code_verifier.take(),
            token: body.token.take(),
        },
        body.client_id.take(),
        received,
    );
    let target = db::call(&state.db, move |conn| {
        let mut errors = FieldErrors::default();
        Ok(target(conn, &body, &mut errors)?.ok_or(errors))
    })
    .await?;
    let target = target.map_err(|other| {
        errors.merge(other);
        std::mem::take(&mut errors).into_error()
    })?;
    let _owner = lock_owner(&state, &user).await?;
    let (verified, client_id) = login
        .check(&state, &user.id, &target, &hint, errors)
        .await?;
    let oauth = kind == AuthKind::Oauth;

    // The ID is fixed before encrypting (it is the AAD).
    let id = db::new_id()?;
    let sealed = seal(&state, &id, &verified)?;
    let exchanged = verified.exchanged(&target, client_id.as_deref());
    let backend_exchange = verified.exchanged;
    let Verified {
        origin, account, ..
    } = verified;
    let user_id = user.id.clone();
    let saved = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        let server_id = match recheck(&tx, &target, oauth)? {
            Ok(server_id) => server_id,
            Err(errors) => return Ok(Err(NotSaved::Invalid(errors.into_error()))),
        };
        if let Some(existing) = mail_accounts::find(&tx, &user_id, &origin, &account.account_id)? {
            // The page shows the address of the signed-in account and
            // "open account".
            return Ok(Err(NotSaved::Discarded(
                ApiError::rejected(StatusCode::CONFLICT, "dup").with(
                    "account",
                    json!({ "id": existing.id, "email": existing.email }),
                ),
            )));
        }
        let before = mail_accounts::list(&tx, &user_id)?;
        mail_accounts::insert(
            &tx,
            &NewAccount {
                id: &id,
                user_id: &user_id,
                base_url: &origin,
                email: &account.email,
                account_id: &account.account_id,
                username: &account.username,
                auth_kind: kind,
                client_id: client_id.as_deref(),
                backend_exchange,
                secret_enc: &sealed.secret_enc,
                access_token_enc: sealed.access_token_enc.as_deref(),
                expires_in: sealed.expires_in,
                session_json: &sealed.session_json,
                color: mail_accounts::free_color(&before),
            },
        )?;
        adopt_default(&tx, &user_id, &before, &id)?;
        let account = mail_accounts::get(&tx, &user_id, &id)?
            .ok_or_else(|| anyhow::anyhow!("mail account missing"))?;
        tx.commit()?;
        // Just checked: registry server, or custom server with the policy on.
        Ok(Ok(view(account, server_id, true)))
    })
    .await?;
    let view = saved.map_err(|not_saved| not_saved.into_error(&state, &user.id, exchanged))?;
    tracing::info!(user = %user.id, account = %view.id, url = %view.url, kind = view.auth_kind, "mail account connected");
    Ok((StatusCode::CREATED, Json(view)))
}

/// Why a verified sign-in was not saved.
enum NotSaved {
    /// The registry or the policy changed meanwhile ([`recheck`]).
    Invalid(ApiError),
    /// The sign-in is of no use: the account is connected already (`dup`)
    /// or was removed while signing in again.
    Discarded(ApiError),
}

impl NotSaved {
    /// The response; a grant from the code exchange that is discarded is
    /// revoked first ([`token::revoke_discarded`]).
    fn into_error(
        self,
        state: &AppState,
        user_id: &str,
        exchanged: Option<token::Discarded>,
    ) -> ApiError {
        match self {
            Self::Invalid(error) => error,
            Self::Discarded(error) => {
                if let Some(exchanged) = exchanged {
                    token::revoke_discarded(state, user_id, exchanged);
                }
                error
            }
        }
    }
}

/// Takes the user's lock ([`owner_key`]) for creating an account or signing
/// in again, held until after saving: removing the user waits that long and
/// then revokes this grant too; if the removal was faster, the session is no
/// longer valid and no grant is created that nobody would revoke. Whoever
/// holds it takes no account lock, so the order of [`lock_owners`] (users,
/// then accounts) holds.
async fn lock_owner(state: &AppState, user: &AuthUser) -> Result<KeyedLock, ApiError> {
    let lock = state.token_locks.lock(&owner_key(&user.id)).await;
    let (owner, session_id) = (user.id.clone(), user.session_id.clone());
    if !db::call(&state.db, move |conn| {
        Ok(sessions::is_valid(conn, &owner, &session_id)?)
    })
    .await?
    {
        return Err(ApiError::Unauthorized);
    }
    Ok(lock)
}

/// "Sign in again": new tokens for an existing account,
/// checked as when creating. The session must name the same account – server
/// (via the account's origin), account ID and username – otherwise the entry
/// including color, default account and tags would silently read someone
/// else's mailbox.
async fn reauth(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<ReauthBody>,
) -> Result<Json<AccountView>, ApiError> {
    let received = Instant::now();
    same_user(body.user_id.as_deref(), &user.id)?;
    let (user_id, row) = (user.id.clone(), id.clone());
    let found = db::call(&state.db, move |conn| {
        let Some(account) = mail_accounts::get(conn, &user_id, &row)? else {
            return Ok(None);
        };
        let server = servers::find_by_base_url(conn, &account.base_url)?;
        let allow = servers::allow_custom_servers(conn)?;
        Ok(Some((account, server, allow)))
    })
    .await?;
    let (stored, server, allow) = found.ok_or(ApiError::NotFound)?;
    let target = match server {
        Some(server) => Target::Registry(server),
        None if blocked(&stored.base_url, false, allow) => {
            return Err(ApiError::rejected(StatusCode::CONFLICT, "blocked"));
        }
        None => Target::Custom(Url::parse(&stored.base_url).map_err(anyhow::Error::from)?),
    };

    let mut errors = FieldErrors::default();
    let login = Login::parse(
        &mut errors,
        stored.auth_kind,
        Supplied {
            access_token: body.access_token,
            refresh_token: body.refresh_token,
            expires_in: body.expires_in,
            code: body.code,
            code_verifier: body.code_verifier,
            token: body.token,
        },
        body.client_id,
        received,
    );
    let _owner = lock_owner(&state, &user).await?;
    let (verified, client_id) = login
        .check(&state, &user.id, &target, &stored.email, errors)
        .await?;
    let oauth = stored.auth_kind == AuthKind::Oauth;
    let exchanged = verified.exchanged(&target, client_id.as_deref());
    if verified.account.account_id != stored.account_id
        || verified.account.username != stored.username
    {
        tracing::info!(user = %user.id, account = %id, "sign-in again with a different account rejected");
        // The page reports "you signed in as ‹address›".
        let error = ApiError::rejected(StatusCode::CONFLICT, "other_account")
            .with("account", json!({ "email": verified.account.email }));
        return Err(NotSaved::Discarded(error).into_error(&state, &user.id, exchanged));
    }

    let sealed = seal(&state, &id, &verified)?;
    // Without the account's lock: a refresh may run at the same time and
    // follows the new tokens afterwards. The refresh token stored at the time
    // of replacing is revoked; with it Stalwart revokes the grant across all
    // generations, including one the refresh still receives.
    let (user_id, row) = (user.id.clone(), id.clone());
    let backend_exchange = verified.exchanged;
    let saved = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        let server_id = match recheck(&tx, &target, oauth)? {
            Ok(server_id) => server_id,
            Err(errors) => return Ok(Err(NotSaved::Invalid(errors.into_error()))),
        };
        let previous = mail_accounts::credentials(&tx, &row, Some(&user_id))?
            .map(|creds| grant(&tx, creds))
            .transpose()?
            .flatten();
        let replaced = mail_accounts::reauth(
            &tx,
            &user_id,
            &row,
            &Reauth {
                client_id: client_id.as_deref(),
                backend_exchange,
                secret_enc: &sealed.secret_enc,
                access_token_enc: sealed.access_token_enc.as_deref(),
                expires_in: sealed.expires_in,
                session_json: &sealed.session_json,
            },
        )?;
        // Removed in the meantime.
        let Some(account) = replaced
            .then(|| mail_accounts::get(&tx, &user_id, &row))
            .transpose()?
            .flatten()
        else {
            return Ok(Err(NotSaved::Discarded(ApiError::NotFound)));
        };
        tx.commit()?;
        Ok(Ok((view(account, server_id, true), previous)))
    })
    .await?;
    let (view, previous) =
        saved.map_err(|not_saved| not_saved.into_error(&state, &user.id, exchanged))?;
    tracing::info!(user = %user.id, account = %view.id, "mail account signed in again");
    // Otherwise the previous grant stays valid until it expires – unless the
    // browser sent the same refresh token again.
    if let Some(previous) = previous
        && !same_secret(&state, &previous.creds, &verified.secret)
    {
        revoke_grants(&state, vec![previous]);
    }
    Ok(Json(view))
}

/// Whether the stored refresh token or access token is `secret`.
fn same_secret(state: &AppState, creds: &mail_accounts::Credentials, secret: &str) -> bool {
    state
        .secrets
        .open(SECRET_PURPOSE, &creds.account.id, &creds.secret_enc)
        .is_ok_and(|stored| stored == secret.as_bytes())
}

/// `refresh=true`: the mail server rejected the access token; refresh it
/// although it is still valid.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenQuery {
    #[serde(default)]
    refresh: bool,
}

/// Access token for the browser; API responses
/// carry `Cache-Control: no-store`. Only with `X-Requested-With`: the fetch
/// counts towards the user's limits and refreshes at the mail server when
/// needed – an image in a mail must trigger neither.
async fn token(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<TokenQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    super::require_requested_with(&headers)?;
    let Query(query) = query.map_err(|rejection| ApiError::BadRequest(rejection.body_text()))?;
    state
        .limiter
        .acquire(&TOKEN_LIMIT, Key::User(user.id.clone()))?;
    if query.refresh {
        state
            .limiter
            .acquire(&FORCE_REFRESH_LIMIT, Key::User(user.id.clone()))?;
    }
    let access = token::access(&state, &user.id, &id, query.refresh)
        .await
        .map_err(token_error)?;
    Ok(Json(json!({
        "accessToken": access.access_token,
        "expiresAt": access.expires_at,
        "session": access.session,
    })))
}

/// Token broker errors for `GET …/token` and `POST …/check`.
fn token_error(error: token::Error) -> ApiError {
    match error {
        token::Error::NotFound => ApiError::NotFound,
        token::Error::Blocked => ApiError::rejected(StatusCode::CONFLICT, "blocked"),
        token::Error::NeedsReauth => ApiError::rejected(StatusCode::CONFLICT, "needs_reauth"),
        token::Error::Refresh(error) => {
            ApiError::rejected(StatusCode::BAD_GATEWAY, "refresh_failed")
                .with("reason", error.reason())
        }
        token::Error::Limited(limited) => limited.into(),
        token::Error::Internal(error) => error.into(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateBody {
    color: Option<i64>,
}

/// Color of the account; without the field everything stays as it is.
async fn update(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<UpdateBody>,
) -> Result<Json<AccountView>, ApiError> {
    if body
        .color
        .is_some_and(|color| !(0..COLORS).contains(&color))
    {
        let mut errors = FieldErrors::default();
        errors.code("color", "invalid");
        return Err(errors.into_error());
    }
    let updated = db::call(&state.db, move |conn| {
        let account = match body.color {
            Some(color) => mail_accounts::set_color(conn, &user.id, &id, color)?,
            None => mail_accounts::get(conn, &user.id, &id)?,
        };
        account
            .map(|account| current_view(conn, account))
            .transpose()
    })
    .await?;
    updated.map(Json).ok_or(ApiError::NotFound)
}

/// "Check connection": access token from the broker, with it
/// session and `Quota/get`; if the mail server rejects an access token from
/// the sign-in, once more with a refreshed one (like the browser). Broker
/// errors as for `GET …/token`, mail server errors 502 `check_failed` with
/// `reason` – the account stays as it is.
async fn check(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<AccountView>, ApiError> {
    state
        .limiter
        .acquire(&CHECK_LIMIT, Key::User(user.id.clone()))?;
    let (user_id, row) = (user.id.clone(), id.clone());
    let found = db::call(&state.db, move |conn| {
        let Some(account) = mail_accounts::get(conn, &user_id, &row)? else {
            return Ok(None);
        };
        let registered = servers::find_by_base_url(conn, &account.base_url)?.is_some();
        Ok(Some((account, registered)))
    })
    .await?;
    let (account, registered) = found.ok_or(ApiError::NotFound)?;
    let base_url = Url::parse(&account.base_url).map_err(anyhow::Error::from)?;
    let http = state.mail_http(registered);
    let mut force = false;
    let checked = loop {
        let access = token::access(&state, &user.id, &id, force)
            .await
            .map_err(token_error)?;
        let result = account::storage(http, &base_url, access.access_token).await;
        // Force a refresh like `GET …/token?refresh=true`, with the same
        // limit; once it is reached, the rejection stands.
        let retry = !force
            && account.auth_kind == AuthKind::Oauth
            && result == Err(roedy_jmap::Error::AuthFailed)
            && state
                .limiter
                .acquire(&FORCE_REFRESH_LIMIT, Key::User(user.id.clone()))
                .is_ok();
        if !retry {
            break result;
        }
        force = true;
    };
    let storage = checked.map_err(|error| {
        tracing::info!(user = %user.id, account = %id, reason = error.reason(), "connection check failed");
        check_failed(StatusCode::BAD_GATEWAY, error.reason())
    })?;
    let quota = storage.map(|Storage { used, total }| (used, total));
    let user_id = user.id.clone();
    let saved = db::call(&state.db, move |conn| {
        mail_accounts::store_check(conn, &user_id, &id, quota)?
            .map(|account| current_view(conn, account))
            .transpose()
    })
    .await?;
    saved.map(Json).ok_or(ApiError::NotFound)
}

/// The new account becomes the default account if
/// neither "all accounts" nor an existing account is selected.
fn adopt_default(
    conn: &Connection,
    user_id: &str,
    before: &[MailAccount],
    added: &str,
) -> anyhow::Result<()> {
    let stored = settings::load(conn, user_id)?;
    let keep = stored
        .settings
        .default_account
        .as_ref()
        .is_some_and(|current| match current.account_id() {
            None => true,
            Some(id) => before.iter().any(|account| account.id == id),
        });
    if keep {
        return Ok(());
    }
    let mut next = stored.settings.clone();
    next.default_account = Some(DefaultAccount::account(added));
    save_settings(conn, user_id, stored.version, &next)
}

/// If the removed account was the default account, the
/// first remaining one applies, without accounts none.
fn release_default(
    conn: &Connection,
    user_id: &str,
    removed: &str,
    remaining: &[MailAccount],
) -> anyhow::Result<()> {
    let stored = settings::load(conn, user_id)?;
    let current = stored.settings.default_account.as_ref();
    if current.and_then(DefaultAccount::account_id) != Some(removed) {
        return Ok(());
    }
    let mut next = stored.settings.clone();
    next.default_account = remaining
        .first()
        .map(|account| DefaultAccount::account(&account.id));
    save_settings(conn, user_id, stored.version, &next)
}

/// Read in the same transaction, so the version still holds.
fn save_settings(
    conn: &Connection,
    user_id: &str,
    version: i64,
    next: &settings::Settings,
) -> anyhow::Result<()> {
    settings::save(conn, user_id, version, next)?
        .map(drop)
        .ok_or_else(|| anyhow::anyhow!("settings version has changed"))
}

async fn remove(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    // First the own account, then its lock (foreign IDs lock nothing): no
    // refresh runs while the account disappears, and the last stored refresh
    // token is revoked.
    let (user_id, account) = (user.id.clone(), id.clone());
    let own = db::call(&state.db, move |conn| {
        Ok(mail_accounts::exists(conn, &user_id, &account)?)
    })
    .await?;
    if !own {
        return Err(ApiError::NotFound);
    }
    let _lock = state.token_locks.lock(&id).await;
    let user_id = user.id.clone();
    let account = id.clone();
    let removed = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        let Some(creds) = mail_accounts::credentials(&tx, &account, Some(&user_id))? else {
            return Ok(None);
        };
        if !mail_accounts::delete(&tx, &user_id, &account)? {
            return Ok(None);
        }
        let grant = grant(&tx, creds)?;
        let remaining = mail_accounts::list(&tx, &user_id)?;
        release_default(&tx, &user_id, &account, &remaining)?;
        tx.commit()?;
        Ok(Some(grant))
    })
    .await?;
    let Some(grant) = removed else {
        return Err(ApiError::NotFound);
    };
    tracing::info!(user = %user.id, account = %id, "mail account removed");
    revoke_grants(&state, grant.into_iter().collect());
    Ok(StatusCode::NO_CONTENT)
}

/// A grant the token broker revokes: account with tokens and the registry
/// server with its origin.
pub(super) struct Grant {
    creds: mail_accounts::Credentials,
    server: Option<Server>,
}

/// The grant of an account, read in the transaction that removes it or
/// replaces its tokens; `None` for blocked accounts – the backend does not
/// query their servers.
fn grant(conn: &Connection, creds: mail_accounts::Credentials) -> anyhow::Result<Option<Grant>> {
    let server = servers::find_by_base_url(conn, &creds.account.base_url)?;
    let allow = servers::allow_custom_servers(conn)?;
    Ok((!blocked(&creds.account.base_url, server.is_some(), allow))
        .then_some(Grant { creds, server }))
}

/// The grants of all accounts of a user, in the transaction that deletes
/// them (`DELETE auth/me`, removal by an administrator). The caller takes
/// the locks beforehand ([`lock_owners`]).
pub(super) fn grants(conn: &Connection, user_id: &str) -> anyhow::Result<Vec<Grant>> {
    let mut grants = Vec::new();
    for account in mail_accounts::list(conn, user_id)? {
        if let Some(creds) = mail_accounts::credentials(conn, &account.id, Some(user_id))?
            && let Some(grant) = grant(conn, creds)?
        {
            grants.push(grant);
        }
    }
    Ok(grants)
}

/// Key of a user's lock in `token_locks` (IDs are ULIDs, without `:`):
/// `create` and `reauth` hold it from the code exchange until saving
/// ([`lock_owner`]), [`lock_owners`] takes it before the accounts' locks.
fn owner_key(user_id: &str) -> String {
    format!("user:{user_id}")
}

/// Locks for removing the users `user_ids` (`DELETE auth/me`, removal by an
/// administrator): first the users – a running
/// creation saves before, a new one waits –, then their accounts – no
/// refresh runs while they disappear, and the last stored refresh token is
/// revoked. Both in ascending order so that two removals never block each
/// other; whoever holds an account's lock never waits for a user's.
pub(super) async fn lock_owners(
    state: &AppState,
    user_ids: impl IntoIterator<Item = String>,
) -> anyhow::Result<Vec<KeyedLock>> {
    let user_ids: BTreeSet<String> = user_ids.into_iter().collect();
    let mut locks = Vec::new();
    for id in &user_ids {
        locks.push(state.token_locks.lock(&owner_key(id)).await);
    }
    let accounts = db::call(&state.db, move |conn| {
        let mut accounts = BTreeSet::new();
        for id in &user_ids {
            accounts.extend(mail_accounts::list(conn, id)?.into_iter().map(|a| a.id));
        }
        Ok(accounts)
    })
    .await?;
    for id in &accounts {
        locks.push(state.token_locks.lock(id).await);
    }
    Ok(locks)
}

/// Revokes the grants after the commit, each in its own task
/// ([`token::revoke`]).
pub(super) fn revoke_grants(state: &AppState, grants: Vec<Grant>) {
    for Grant { creds, server } in grants {
        token::revoke(state, creds, server);
    }
}
