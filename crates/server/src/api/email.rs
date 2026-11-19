//! Changing the own email address (Account › Profile and the "Confirm email
//! address" page).
//!
//! - Request via `PATCH auth/me` with the new address, password and, with
//!   multi-factor active, a code ([`request`], from `api::me`).
//! - `POST auth/me/email/resend`: new link, the previous one becomes invalid;
//!   if sending fails, everything stays as it was (`previous_link_valid`).
//! - `DELETE auth/me/email`: "discard change".
//! - `POST auth/email/check` and `POST auth/email/confirm` (public, also
//!   without a session, token in the body): state of the link before the
//!   click, or confirmation via button – link scanners that open the page
//!   thus change nothing.
//!
//! A new link is valid only once both mails are sent: reserve it, send
//! `security_email` to the previous address and `email_confirm` to the new
//! one, then release it. If one fails, the reserved link is dropped
//! (`mail_failed`). Requesting, resending and discarding run one after
//! another per user ([`KeyedLocks`]).

use std::{net::IpAddr, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{delete, post},
};
use jiff::Timestamp;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    ApiError, JsonBody, auth,
    me::{Guard, ProfileChange, Reauth, apply_profile, username_taken},
    password::LINK_IP,
};
use crate::{
    app::AppState,
    auth::{
        AuthUser, CurrentUser,
        session::{Origin, Token},
    },
    client_ip::ClientIp,
    db::{
        self,
        repo::{
            self,
            audit_log::{self, Category, Entry},
            email_changes::{self, Link, Open, State as LinkState},
            sessions, users,
        },
    },
    events::{self, Account, Outbox, Security},
    locks::KeyedLock,
    mailer::{
        MailError,
        delivery::Delivery,
        mail_failed,
        templates::{EmailConfirm, Place, SecurityEmail},
    },
    rate_limit::{Key, Policy},
    settings,
};

/// Sending links per user (request and resend, two mails each): five at
/// once, then one every twelve minutes.
const EMAIL_SEND: Policy = Policy::rate("auth.email.send", 5, Duration::from_secs(60 * 60));

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/me/email", delete(discard))
        .route("/auth/me/email/resend", post(resend))
        .route("/auth/email/check", post(check))
        .route("/auth/email/confirm", post(confirm))
}

/// The address already belongs to another account.
pub fn email_taken() -> ApiError {
    ApiError::rejected(StatusCode::UNPROCESSABLE_ENTITY, "email_taken")
}

/// The reserved link was discarded while sending, or the address changed in
/// the meantime (race, rare): reload `auth/me`.
fn discarded() -> ApiError {
    ApiError::rejected(StatusCode::CONFLICT, "email_change_discarded")
}

/// Open change in `auth/me` and the responses.
pub fn open_json(open: &Open) -> Value {
    json!({ "email": open.new_email, "expires_at": open.expires_at })
}

/// Sending account and public address; without them `mail_failed`.
async fn delivery(state: &AppState) -> Result<Delivery, ApiError> {
    Delivery::prepare(state).await?.map_err(|why| {
        tracing::warn!(?why, "email change: no system mail");
        mail_failed()
    })
}

/// What a new link depends on: the check of password and code (request) or a
/// still valid session and the open change with this ID (resend).
#[derive(Debug, Clone)]
enum Holder {
    Reauth(Guard),
    Session(String),
}

/// Why a link was not sent.
enum Failed {
    /// One of the two mails failed.
    Mail(MailError),
    Api(ApiError),
}

impl From<ApiError> for Failed {
    fn from(error: ApiError) -> Self {
        Self::Api(error)
    }
}

impl From<anyhow::Error> for Failed {
    fn from(error: anyhow::Error) -> Self {
        Self::Api(error.into())
    }
}

impl From<MailError> for Failed {
    fn from(error: MailError) -> Self {
        Self::Mail(error)
    }
}

/// A new link to `new_email`.
struct Request {
    user: AuthUser,
    new_email: String,
    origin: Origin,
    holder: Holder,
    /// Request (with event) instead of resend.
    first: bool,
    /// Display name and username from the same `PATCH auth/me`: they apply
    /// only with the link, so that nothing is stored on failure.
    profile: Option<ProfileChange>,
}

impl Request {
    /// Whether the check still holds: session and password as at the check
    /// (or the session exists), the account is active, and the address that
    /// `security_email` goes to is still the current one – otherwise the new
    /// address would get a link the current one knows nothing about.
    fn holds(&self, conn: &Connection) -> rusqlite::Result<Result<(), ApiError>> {
        let user = &self.user;
        if let Holder::Reauth(guard) = &self.holder
            && let Err(stale) = guard.check(conn, user)?
        {
            return Ok(Err(stale.into()));
        }
        if !sessions::is_valid(conn, &user.id, &user.session_id)? {
            return Ok(Err(ApiError::Unauthorized));
        }
        // Resending does not revive a change that was discarded or replaced
        // since it was read – changing the password and "sign out all others"
        // from the same session do not take the per-user lock.
        if let Holder::Session(open_id) = &self.holder
            && email_changes::open(conn, &user.id)?.is_none_or(|open| open.id != *open_id)
        {
            return Ok(Err(discarded()));
        }
        Ok(match users::credentials_by_id(conn, &user.id)? {
            Some(now) if !now.active => Err(ApiError::Unauthorized),
            Some(now) if now.user.email == user.email => Ok(()),
            _ => Err(discarded()),
        })
    }
}

/// Result of a sent link.
struct Sent {
    open: Open,
    /// With the profile changes from [`Request::profile`].
    user: AuthUser,
}

/// Sends the link in a separate task that runs to completion even when the
/// client drops the connection: otherwise the mails might be out but the
/// link never released. The user's lock goes along.
async fn send_link(
    state: &AppState,
    delivery: Delivery,
    req: Request,
    lock: KeyedLock,
) -> Result<Sent, Failed> {
    let worker = state.clone();
    tokio::spawn(async move {
        let _lock = lock;
        deliver_link(&worker, &delivery, req).await
    })
    .await
    .map_err(|error| Failed::Api(anyhow::anyhow!("sending aborted: {error}").into()))?
}

/// Reserves a link, sends `security_email` to the previous address first,
/// then `email_confirm` to the new one, and releases it afterwards. So a
/// delivered link is never valid without a notice to the previous address.
async fn deliver_link(state: &AppState, delivery: &Delivery, req: Request) -> Result<Sent, Failed> {
    let token = Token::generate()?;
    let hash = token.hash();
    let req = Arc::new(req);
    let reserving = req.clone();
    let reserved = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        if let Err(stale) = reserving.holds(&tx)? {
            return Ok(Err(stale));
        }
        let user_id = &reserving.user.id;
        let id = email_changes::reserve(&tx, user_id, &reserving.new_email, &hash)?;
        // Both mails go to the same person: times in their time zone.
        let format = settings::format_of(&tx, user_id)?;
        tx.commit()?;
        Ok(Ok((id, format)))
    })
    .await?;
    let (id, format) = reserved?;

    let (user, origin) = (&req.user, &req.origin);
    let device = origin.device().label(format.lang());
    let at = Timestamp::now();
    let sent: Result<(), Failed> = async {
        delivery
            .send(state, &format, |ctx| {
                SecurityEmail {
                    to: &user.email,
                    name: &user.display_name,
                    new_email: &req.new_email,
                    device: &device,
                    place: Place {
                        place: origin.place.as_deref(),
                        ip: origin.ip,
                    },
                    at,
                }
                .render(ctx)
            })
            .await??;
        delivery
            .send(state, &format, |ctx| {
                EmailConfirm {
                    to: &req.new_email,
                    name: &user.display_name,
                    token: token.as_str(),
                }
                .render(ctx)
            })
            .await??;
        Ok(())
    }
    .await;
    if let Err(failed) = sent {
        let id = id.clone();
        db::call(&state.db, move |conn| Ok(email_changes::cancel(conn, &id)?)).await?;
        return Err(failed);
    }

    let released = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        let rejected = |tx: rusqlite::Transaction<'_>, error: ApiError| {
            email_changes::cancel(&tx, &id)?;
            tx.commit()?;
            Ok(Err(error))
        };
        if let Err(stale) = req.holds(&tx)? {
            return rejected(tx, stale);
        }
        let mut user = req.user.clone();
        if let Some(change) = &req.profile {
            match apply_profile(&tx, &user, change, req.origin.ip)? {
                Some(changed) => user = changed,
                None => return rejected(tx, username_taken()),
            }
        }
        if !email_changes::release(&tx, &id)? {
            // Discarded in the meantime (e.g. "sign out all others" or a
            // password change in the same session): the link is not valid.
            return Ok(Err(discarded()));
        }
        let mut outbox = Outbox::default();
        if req.first {
            let event = Security::EmailChangeRequested {
                new_email: &req.new_email,
                at: (&req.origin).into(),
            };
            events::security(&tx, &mut outbox, (&user).into(), event)?;
        }
        let action = if req.first {
            "auth.email_change_request"
        } else {
            "auth.email_change_resend"
        };
        audit_log::insert(
            &tx,
            &Entry::new(Category::Login, action)
                .actor(&user)
                .target(&user.id)
                .client(&req.origin.client())
                .details(json!({ "email": req.new_email })),
        )?;
        let open = email_changes::open(&tx, &user.id)?
            .ok_or_else(|| anyhow::anyhow!("released link missing"))?;
        tx.commit()?;
        Ok(Ok((Sent { open, user }, outbox)))
    })
    .await?;
    let (sent, outbox) = released?;
    // No mail from the catalog; the two mails are already out.
    outbox.send(state);
    Ok(sent)
}

/// Check of password and code for [`request`].
pub(super) struct Credentials<'a> {
    pub password: &'a str,
    pub code: Option<String>,
}

/// Requests `new_email` (`PATCH auth/me` with password) and applies
/// `profile` along with it: without system mail `mail_failed` right away,
/// without checking password and code (no used-up code, no attempt against
/// the limit). Then password, code and the full "taken" check; a checked
/// code is used up even on `mail_failed` (it is valid only once). Returns
/// the open change and the user with the new profile.
pub(super) async fn request(
    state: &AppState,
    user: &AuthUser,
    new_email: &str,
    credentials: Credentials<'_>,
    profile: Option<ProfileChange>,
    origin: Origin,
) -> Result<(Open, AuthUser), ApiError> {
    let delivery = delivery(state).await?;
    let attempt = state
        .limiter
        .reserve(&EMAIL_SEND, Key::User(user.id.clone()))?;
    let reauth = Reauth::password(state, user, credentials.password).await?;
    let guard = match credentials.code {
        Some(code) => reauth.totp(state, user, code).await?,
        None => reauth.guard(),
    };
    let lock = state.email_locks.lock(&user.id).await;
    // Only after the check, because it also knows locked accounts and open
    // invitations – and counted, otherwise they could be queried with the
    // own password without limit.
    attempt.count();
    if is_taken(state, &user.id, new_email).await? {
        return Err(email_taken());
    }
    let req = Request {
        user: user.clone(),
        new_email: new_email.to_owned(),
        origin,
        holder: Holder::Reauth(guard),
        first: true,
        profile,
    };
    match send_link(state, delivery, req, lock).await {
        Ok(sent) => Ok((sent.open, sent.user)),
        Err(Failed::Mail(error)) => Err(error.into()),
        Err(Failed::Api(error)) => Err(error),
    }
}

async fn is_taken(state: &AppState, user_id: &str, email: &str) -> Result<bool, ApiError> {
    let (id, email) = (user_id.to_owned(), email.to_owned());
    Ok(db::call(&state.db, move |conn| {
        Ok(email_changes::taken(conn, &email, &id)?)
    })
    .await?)
}

/// Whether the previous link still confirms after a failed resend – the
/// same check as `check`.
async fn previous_link_valid(state: &AppState, id: String) -> Result<bool, ApiError> {
    let link = db::call(&state.db, move |conn| {
        Ok(email_changes::lookup_id(conn, &id)?)
    })
    .await?;
    Ok(link.is_some_and(|link| link.state == LinkState::Valid))
}

/// "Resend link": new link with a fresh 24 hours, both mails again
/// (`security_email` names the validity). If sending fails, the previous
/// link stays valid if it still is.
async fn resend(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    ip: ClientIp,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let origin = auth::origin(&state, &headers, ip);
    let lock = state.email_locks.lock(&user.id).await;
    let id = user.id.clone();
    let open = db::call(&state.db, move |conn| Ok(email_changes::open(conn, &id)?))
        .await?
        .ok_or(ApiError::NotFound)?;
    let failed = |valid: bool| mail_failed().with("previous_link_valid", valid);
    let Ok(delivery) = delivery(&state).await else {
        return Err(failed(previous_link_valid(&state, open.id).await?));
    };
    let attempt = state
        .limiter
        .reserve(&EMAIL_SEND, Key::User(user.id.clone()))?;
    if is_taken(&state, &user.id, &open.new_email).await? {
        return Err(email_taken());
    }
    attempt.count();
    let req = Request {
        user,
        new_email: open.new_email,
        origin,
        holder: Holder::Session(open.id.clone()),
        first: false,
        profile: None,
    };
    match send_link(&state, delivery, req, lock).await {
        Ok(sent) => Ok(Json(open_json(&sent.open))),
        Err(Failed::Mail(_)) => Err(failed(previous_link_valid(&state, open.id).await?)),
        Err(Failed::Api(error)) => Err(error),
    }
}

/// "Discard change": all links not yet used become invalid; without an open
/// change 404.
async fn discard(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    ip: ClientIp,
) -> Result<StatusCode, ApiError> {
    let _lock = state.email_locks.lock(&user.id).await;
    let discarded = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        if !sessions::is_valid(&tx, &user.id, &user.session_id)? {
            return Ok(Err(ApiError::Unauthorized));
        }
        if email_changes::open(&tx, &user.id)?.is_none() {
            return Ok(Err(ApiError::NotFound));
        }
        email_changes::discard(&tx, &user.id)?;
        audit_log::insert(
            &tx,
            &Entry::new(Category::Login, "auth.email_change_discard")
                .actor(&user)
                .target(&user.id)
                .ip(ip.0),
        )?;
        tx.commit()?;
        Ok(Ok(()))
    })
    .await?;
    discarded?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenBody {
    token: String,
}

/// Applies the address of a valid link in the transaction of
/// [`find_link`]. Links to the previous address (e.g. "reset password") are
/// no longer valid afterwards.
fn confirm_link(conn: &Connection, link: &Link, ip: IpAddr) -> anyhow::Result<bool> {
    let Some(owner) = users::credentials_by_id(conn, &link.user_id)?.map(|c| c.user) else {
        return Ok(false);
    };
    if !email_changes::confirm(conn, &link.id)? {
        return Ok(false);
    }
    users::set_email(conn, &owner.id, &link.new_email)?;
    repo::discard_links(conn, &owner.id)?;
    audit_log::insert(
        conn,
        &Entry::new(Category::Login, "auth.email_change_confirm")
            .actor_profile(&owner)
            .target(&owner.id)
            .ip(ip)
            .details(json!({ "email": link.new_email })),
    )?;
    let event = Account::EmailConfirmed {
        email: &link.new_email,
    };
    events::account(conn, &owner.id, event)?;
    Ok(true)
}

/// Reads the link for `token` with the limit [`LINK_IP`] (only unknown
/// tokens count) and confirms it with `confirm` if it is valid. Returns the
/// link and whether it was confirmed now.
async fn find_link(
    state: &AppState,
    ip: ClientIp,
    token: &str,
    confirm: bool,
) -> Result<Option<(Link, bool)>, ApiError> {
    let attempt = state.limiter.reserve(&LINK_IP, Key::Ip(ip.network()))?;
    let Some(token) = Token::parse(token.trim()) else {
        attempt.count();
        return Ok(None);
    };
    let hash = token.hash();
    let found = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        let Some(link) = email_changes::lookup(&tx, &hash)? else {
            return Ok(None);
        };
        if !confirm || link.state != LinkState::Valid {
            return Ok(Some((link, false)));
        }
        let confirmed = confirm_link(&tx, &link, ip.0)?;
        tx.commit()?;
        Ok(Some((link, confirmed)))
    })
    .await?;
    match found {
        Some(_) => drop(attempt),
        None => attempt.count(),
    }
    Ok(found)
}

/// Response of `check` and `confirm`: state, address (only for a valid or
/// already confirmed link) and whether the session belongs to the owner –
/// otherwise the page shows the guest variant.
fn link_json(found: Option<&(Link, bool)>, viewer: Option<&CurrentUser>) -> Value {
    let Some((link, confirmed_now)) = found else {
        return json!({ "state": "invalid", "own_session": false });
    };
    let own_session = viewer.is_some_and(|CurrentUser(user)| user.id == link.user_id);
    let state = match link.state {
        _ if *confirmed_now => "confirmed",
        LinkState::Valid => "valid",
        LinkState::Confirmed => "already_confirmed",
        LinkState::Invalid => "invalid",
    };
    let mut body = json!({ "state": state, "own_session": own_session });
    if state != "invalid" {
        body["email"] = json!(link.new_email);
    }
    body
}

/// State of the link before the page shows the button; changes nothing.
async fn check(
    State(state): State<AppState>,
    ip: ClientIp,
    viewer: Option<CurrentUser>,
    JsonBody(body): JsonBody<TokenBody>,
) -> Result<Json<Value>, ApiError> {
    let found = find_link(&state, ip, &body.token, false).await?;
    Ok(Json(link_json(found.as_ref(), viewer.as_ref())))
}

/// "Confirm email address": applies the new address if the link is valid
/// (the same check as `check`). From now on it applies to sign-in and system
/// mails; the previous one no longer does.
async fn confirm(
    State(state): State<AppState>,
    ip: ClientIp,
    viewer: Option<CurrentUser>,
    JsonBody(body): JsonBody<TokenBody>,
) -> Result<Json<Value>, ApiError> {
    let found = find_link(&state, ip, &body.token, true).await?;
    if let Some((link, true)) = &found {
        tracing::info!(user = %link.user_id, "email address confirmed");
    }
    Ok(Json(link_json(found.as_ref(), viewer.as_ref())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        auth::session::{self, Client},
        db::repo::users::{
            Profile, Role,
            tests::{add, conn},
        },
    };

    /// User with a session and a sent open change to `new@example.com`; plus
    /// the "resend" request for it.
    fn resend_request() -> (Connection, String, Request) {
        let conn = conn();
        let id = add(&conn, "max", "max@example.com", Role::User);
        let started = session::start(&conn, &id, &Client::default(), true).unwrap();
        let change = email_changes::reserve(&conn, &id, "new@example.com", &[7; 32]).unwrap();
        assert!(email_changes::release(&conn, &change).unwrap());
        let profile = Profile {
            id: id.clone(),
            username: "max".into(),
            email: "max@example.com".into(),
            display_name: "Max".into(),
            role: Role::User,
        };
        let req = Request {
            user: AuthUser::new(profile, started.id),
            new_email: "new@example.com".into(),
            origin: Origin {
                user_agent: None,
                ip: "89.12.34.56".parse().unwrap(),
                place: None,
                device_hash: [0; 32],
                app: false,
                lang: None,
            },
            holder: Holder::Session(change),
            first: false,
            profile: None,
        };
        (conn, id, req)
    }

    fn code(result: Result<(), ApiError>) -> &'static str {
        match result {
            Ok(()) => "ok",
            Err(ApiError::Unauthorized) => "unauthorized",
            Err(ApiError::Rejected { code, .. }) => code,
            Err(other) => panic!("{other:?}"),
        }
    }

    #[test]
    fn link_only_holds_for_the_address_that_got_the_notice() {
        let (conn, id, req) = resend_request();
        assert_eq!(code(req.holds(&conn).unwrap()), "ok");
        // Another address confirmed in the meantime: the new one would get a
        // link the current one knows nothing about.
        users::set_email(&conn, &id, "between@example.com").unwrap();
        assert_eq!(code(req.holds(&conn).unwrap()), "email_change_discarded");
        users::set_email(&conn, &id, "max@example.com").unwrap();
        // Locked, even though the session still exists.
        conn.execute("UPDATE users SET status = 'locked' WHERE id = ?1", [&id])
            .unwrap();
        assert_eq!(code(req.holds(&conn).unwrap()), "unauthorized");
    }

    /// If another path discards the change after `resend` has read it, no
    /// new link is created.
    #[test]
    fn resend_does_not_revive_a_discarded_change() {
        let (conn, id, req) = resend_request();
        assert_eq!(code(req.holds(&conn).unwrap()), "ok");
        email_changes::discard(&conn, &id).unwrap();
        assert_eq!(code(req.holds(&conn).unwrap()), "email_change_discarded");
    }
}
