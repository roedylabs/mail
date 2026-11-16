//! Invitations (Administration › Users and the invitation page).
//!
//! For administrators (`invites/:id`):
//!
//! - `POST invites` (`{emails, role, name?}`): creates every invitation, even
//!   if its mail does not go out, and reports ID and `sent` per address;
//!   without a system mail the invitations are only created
//!   (`system_mail: false`). An address is taken if it belongs to a user (any
//!   status), an open invitation or an open email address change
//!   (`emails.<i>`: `taken`).
//! - `POST invites/:id/resend`: the same link; on success a new expiry
//!   (7 days) and `mail_sent_at`, otherwise 502 `mail_failed` without change.
//! - `POST invites/:id/renew` ("Extend"): the same link, new expiry
//!   (7 days), no mail; `mail_sent_at` stays. As with `resend`, the acting
//!   administrator becomes the inviter. Also for valid invitations (the page
//!   only offers it for expired ones).
//! - `GET invites/:id/link`, `PATCH invites/:id` (`{role}`),
//!   `DELETE invites/:id` (revoke).
//!
//! Public with the token from the link (`invites/:token`; unknown tokens are
//! 404 and count towards the per-IP limit like the other links from mails):
//!
//! - `GET`: address, name, role, inviter, expiry (`expired`).
//! - `POST …/totp`: secret for the "Multi-factor" step.
//! - `POST …/accept` (`{name, password, code}`): code from the app
//!   (mandatory, the user's decision), then in one transaction the account,
//!   first app, recovery codes and session; the invitation is gone
//!   afterwards. 201 with the codes and the session cookie.
//! - `POST …/request`: "Request a new invitation" for an expired invitation;
//!   notifies the administrators at most once per 24 hours
//!   (`team.invite_requested`).

use std::{collections::HashSet, time::Duration};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse as _, Response},
    routing::{get, post},
};
use jiff::Timestamp;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    ApiError, FieldErrors, JsonBody, auth,
    me::{check_display_name, check_email, check_new_password},
    password::LINK_IP,
    users::{Actor, RoleBody, admin_change, admin_holds, invite_json},
};
use crate::{
    app::AppState,
    auth::{AdminUser, AuthUser, CurrentUser, recovery, session, session::Token, totp},
    client_ip::ClientIp,
    db::{
        self,
        repo::{
            audit_log::{self, Category, Entry},
            email_changes,
            invitations::{self, Found, Invitation, NewInvitation, TOKEN_PURPOSE, TOTP_PURPOSE},
            known_devices, sessions, totp_devices,
            users::{self, NewUser, Role},
        },
    },
    events::{self, News, Team},
    mailer::{
        delivery::{Delivery, Unavailable},
        format::{Format, full_name},
        mail_failed,
        templates::Invite,
    },
    rate_limit::{Key, Policy, Reservation},
    settings,
};

/// At most this many addresses at once.
const MAX_INVITES: usize = 50;
/// Invitation mails per administrator: 50 at once, then one per 72 seconds
/// (also "Resend") – a hijacked session should not be able to write to any
/// number of addresses through the system mail.
const INVITE_MAIL: Policy = Policy::rate("invites.mail", 50, Duration::from_secs(60 * 60));
/// Wrong codes in the "Multi-factor" step per invitation: five in
/// 15 minutes, then a 15-minute lockout (like `auth.login.code`).
const INVITE_CODE: Policy = Policy::lockout(
    "invites.code",
    5,
    Duration::from_secs(15 * 60),
    Duration::from_secs(15 * 60),
);

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/invites", post(create))
        .route("/invites/{key}", get(show).patch(update).delete(revoke_one))
        .route("/invites/{key}/resend", post(resend))
        .route("/invites/{key}/renew", post(renew))
        .route("/invites/{key}/link", get(link))
        .route("/invites/{key}/totp", post(enroll))
        .route("/invites/{key}/accept", post(accept))
        .route("/invites/{key}/request", post(request))
}

fn rejected(code: &'static str) -> ApiError {
    ApiError::rejected(StatusCode::UNPROCESSABLE_ENTITY, code)
}

/// 422 `invite_expired`: the page shows "Invitation expired".
fn expired() -> ApiError {
    rejected("invite_expired")
}

/// New role of an invitation with audit entry; `false` if it already applied.
pub(super) fn change_role(
    conn: &Connection,
    actor: &Actor<'_>,
    invite: &Invitation,
    role: Role,
) -> anyhow::Result<bool> {
    if invite.role == role || !invitations::set_role(conn, &invite.id, role)? {
        return Ok(false);
    }
    let details = json!({ "email": invite.email, "role": role.as_str() });
    audit_log::insert(conn, &actor.entry("users.invite_role", &invite.id, details))?;
    Ok(true)
}

/// Revokes the invitation: the link no longer works.
pub(super) fn revoke(
    conn: &Connection,
    actor: &Actor<'_>,
    invite: &Invitation,
) -> anyhow::Result<bool> {
    if !invitations::delete(conn, &invite.id)? {
        return Ok(false);
    }
    let details = json!({ "email": invite.email });
    audit_log::insert(
        conn,
        &actor.entry("users.invite_revoke", &invite.id, details),
    )?;
    Ok(true)
}

/// The token from the row (for the mail and "Copy link").
fn open_token(state: &AppState, id: &str, sealed: &[u8]) -> Result<Token, ApiError> {
    let plain = state.secrets.open(TOKEN_PURPOSE, id, sealed)?;
    String::from_utf8(plain)
        .ok()
        .and_then(|text| Token::parse(&text))
        .ok_or_else(|| anyhow::anyhow!("invitation token {id} unreadable").into())
}

/// Format of invitation mails: the invited person has no settings yet, so
/// the defaults in the inviter's language apply.
async fn invite_format(state: &AppState, inviter: &AuthUser) -> anyhow::Result<Format> {
    let inviter_id = inviter.id.clone();
    let lang = db::call(&state.db, move |conn| settings::lang_of(conn, &inviter_id)).await?;
    Ok(Format::default().with_lang(lang))
}

/// Sends the mail of an invitation (valid until `expires_at`); `false` if it
/// did not go out (cause in the mailer's log).
async fn send_mail(
    state: &AppState,
    delivery: &Delivery,
    invite: &Invitation,
    token: &Token,
    inviter: &AuthUser,
    format: &Format,
    expires_at: &str,
) -> anyhow::Result<bool> {
    let until: Timestamp = expires_at.parse()?;
    let sent = delivery
        .send(state, format, |ctx| {
            Invite {
                to: &invite.email,
                name: invite.name.as_deref(),
                inviter: Some(&inviter.display_name),
                role: invite.role,
                token: token.as_str(),
                expires_at: until,
            }
            .render(ctx)
        })
        .await?;
    Ok(sent.is_ok())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateBody {
    emails: Vec<String>,
    role: Role,
    /// Only with a single address ("Last name, First name").
    #[serde(default)]
    name: Option<String>,
}

/// Validated form: addresses with their index in the input.
struct Form {
    emails: Vec<(usize, String)>,
    name: Option<String>,
    role: Role,
}

/// Validates the form; errors per address under `emails.<i>` (index in the
/// input). Duplicate addresses count once.
fn validate(body: CreateBody) -> Result<Form, FieldErrors> {
    let mut errors = FieldErrors::default();
    if body.emails.is_empty() {
        errors.code("emails", "required");
    } else if body.emails.len() > MAX_INVITES {
        // Skip the other checks: a long list would otherwise cost time.
        errors.code("emails", "too_many");
        return Err(errors);
    }
    let mut seen = HashSet::new();
    let mut emails: Vec<(usize, String)> = Vec::new();
    for (i, email) in body.emails.iter().enumerate() {
        let email = email.trim();
        let mut one = FieldErrors::default();
        check_email(&mut one, &format!("emails.{i}"), email);
        if !one.is_empty() {
            errors.merge(one);
        } else if seen.insert(email.to_ascii_lowercase()) {
            emails.push((i, email.to_owned()));
        }
    }
    let name = body
        .name
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty());
    if let Some(name) = &name {
        if emails.len() > 1 {
            errors.code("name", "single_only");
        } else {
            check_display_name(&mut errors, "name", name);
        }
    }
    if errors.is_empty() {
        Ok(Form {
            emails,
            name,
            role: body.role,
        })
    } else {
        Err(errors)
    }
}

/// "Send invitation", or without a system mail "Create invitation".
async fn create(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    ip: ClientIp,
    JsonBody(body): JsonBody<CreateBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let Form { emails, name, role } = validate(body).map_err(FieldErrors::into_error)?;
    let delivery = Delivery::prepare(&state).await?;
    let system_mail = !matches!(delivery, Err(Unavailable::NoSystemMail));
    let mails = if delivery.is_ok() { emails.len() } else { 0 };
    // One attempt per mail; if the request ends without invitations, they
    // are returned (`Reservation`).
    let reserved = (0..mails)
        .map(|_| {
            state
                .limiter
                .reserve(&INVITE_MAIL, Key::User(admin.id.clone()))
        })
        .collect::<Result<Vec<_>, _>>()?;

    // Tokens and encryption before the transaction.
    let mut planned = Vec::with_capacity(emails.len());
    for (i, email) in emails {
        let id = db::new_id()?;
        let token = Token::generate()?;
        let sealed = state
            .secrets
            .seal(TOKEN_PURPOSE, &id, token.as_str().as_bytes())?;
        planned.push((i, email, id, token, sealed));
    }
    let created = admin_change(&state, admin.clone(), ip, move |tx, actor| {
        let mut taken = FieldErrors::default();
        for (i, email, ..) in &planned {
            if users::email_taken(tx, email, "", false)?
                || invitations::exists_for(tx, email)?
                || email_changes::pending_for(tx, email)?
            {
                taken.code(&format!("emails.{i}"), "taken");
            }
        }
        if !taken.is_empty() {
            return Ok(Err(taken.into_error()));
        }
        let mut created = Vec::with_capacity(planned.len());
        for (_, email, id, token, sealed) in planned {
            let invite = invitations::insert(
                tx,
                &NewInvitation {
                    id: &id,
                    email: &email,
                    name: name.as_deref(),
                    role,
                    token_hash: &token.hash(),
                    token_enc: &sealed,
                    invited_by: &actor.admin.id,
                },
            )?;
            let details = json!({ "email": invite.email, "role": role.as_str() });
            audit_log::insert(tx, &actor.entry("users.invite", &invite.id, details))?;
            created.push((invite, token));
        }
        Ok(Ok(created))
    })
    .await?;
    reserved.into_iter().for_each(Reservation::count);

    // Sending in a separate task that also runs to completion when the
    // client aborts – otherwise a sent invitation would show up as "Not
    // sent" in the list.
    let format = invite_format(&state, &admin).await?;
    let worker = state.clone();
    let rows = tokio::spawn(async move {
        let mut rows = Vec::with_capacity(created.len());
        for (invite, token) in &created {
            let sent = match &delivery {
                Ok(delivery) => {
                    let until = &invite.expires_at;
                    let sent = async {
                        if !send_mail(&worker, delivery, invite, token, &admin, &format, until)
                            .await?
                        {
                            return Ok(false);
                        }
                        let (id, by, until) = (invite.id.clone(), admin.id.clone(), until.clone());
                        db::call(&worker.db, move |conn| {
                            Ok(invitations::mark_sent(conn, &id, &by, &until)?)
                        })
                        .await
                    };
                    sent.await.unwrap_or_else(|error: anyhow::Error| {
                        tracing::warn!("invitation not sent: {error:#}");
                        false
                    })
                }
                Err(why) => {
                    tracing::info!(?why, "invitation only created, no mail");
                    false
                }
            };
            rows.push(json!({ "id": invite.id, "email": invite.email, "sent": sent }));
        }
        rows
    })
    .await
    .map_err(|error| anyhow::anyhow!("sending aborted: {error}"))?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "invites": rows, "system_mail": system_mail })),
    ))
}

/// "Resend": the same link, one already passed on stays valid.
async fn resend(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    ip: ClientIp,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let delivery = Delivery::prepare(&state).await?.map_err(|why| {
        tracing::warn!(?why, "resend invitation: no system mail");
        mail_failed()
    })?;
    let (lookup, holder) = (id.clone(), admin.clone());
    let found = db::call(&state.db, move |conn| {
        if let Err(error) = admin_holds(conn, &holder)? {
            return Ok(Err(error));
        }
        let Some(invite) = invitations::get(conn, &lookup)? else {
            return Ok(Err(ApiError::NotFound));
        };
        let sealed = invitations::token_enc(conn, &lookup)?.unwrap_or_default();
        Ok(Ok((invite, sealed, invitations::next_expiry(conn)?)))
    })
    .await??;
    let (invite, sealed, until) = found;
    let token = open_token(&state, &invite.id, &sealed)?;
    state
        .limiter
        .acquire(&INVITE_MAIL, Key::User(admin.id.clone()))?;

    // Sending and recording in a separate task that also runs to completion
    // when the client aborts.
    let format = invite_format(&state, &admin).await?;
    let worker = state.clone();
    tokio::spawn(async move {
        if !send_mail(&worker, &delivery, &invite, &token, &admin, &format, &until).await? {
            return Err(mail_failed());
        }
        // The mail went out and is recorded, even if the administrator has
        // been locked or lost the role in the meantime – they then do not
        // become the inviter (`invitations::mark_sent`).
        let id = invite.id.clone();
        db::call(&worker.db, move |conn| {
            let tx = conn.transaction()?;
            // Revoked or accepted in the meantime: the link is not valid.
            if !invitations::mark_sent(&tx, &id, &admin.id, &until)? {
                return Ok(Err(ApiError::NotFound));
            }
            let actor = Actor {
                admin: &admin,
                ip: ip.0,
            };
            let details = json!({ "email": invite.email });
            audit_log::insert(&tx, &actor.entry("users.invite_resend", &id, details))?;
            let now = invitations::get(&tx, &id)?;
            tx.commit()?;
            Ok(Ok(Json(json!({ "invite": now.as_ref().map(invite_json) }))))
        })
        .await?
    })
    .await
    .map_err(|error| anyhow::anyhow!("sending aborted: {error}"))?
}

/// "Extend": valid for seven days again, without a mail; the link stays the
/// same, one already passed on works again.
async fn renew(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    ip: ClientIp,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let now = one_invite(&state, admin, ip, id, |conn, actor, invite| {
        let until = invitations::next_expiry(conn)?;
        if !invitations::renew(conn, &invite.id, &actor.admin.id, &until)? {
            return Ok(false);
        }
        let details = json!({ "email": invite.email });
        audit_log::insert(
            conn,
            &actor.entry("users.invite_renew", &invite.id, details),
        )?;
        Ok(true)
    })
    .await?;
    Ok(Json(json!({ "invite": now.as_ref().map(invite_json) })))
}

/// "Copy link": the link from the mail, even if it never went out.
async fn link(
    State(state): State<AppState>,
    _: AdminUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let lookup = id.clone();
    let sealed = db::call(&state.db, move |conn| {
        Ok(invitations::token_enc(conn, &lookup)?)
    })
    .await?
    .ok_or(ApiError::NotFound)?;
    let token = open_token(&state, &id, &sealed)?;
    let path = format!("/invite/{}", token.as_str());
    let url = match state.public_url().await? {
        Some(public) => format!("{}{path}", public.origin().ascii_serialization()),
        None => path,
    };
    Ok(Json(json!({ "url": url })))
}

/// Changes an invitation ([`admin_change`]); then returns its state (`None`
/// after revoking).
async fn one_invite(
    state: &AppState,
    admin: AuthUser,
    ip: ClientIp,
    id: String,
    apply: impl FnOnce(&Connection, &Actor<'_>, &Invitation) -> anyhow::Result<bool> + Send + 'static,
) -> Result<Option<Invitation>, ApiError> {
    admin_change(state, admin, ip, move |tx, actor| {
        let Some(invite) = invitations::get(tx, &id)? else {
            return Ok(Err(ApiError::NotFound));
        };
        apply(tx, actor, &invite)?;
        Ok(Ok(invitations::get(tx, &id)?))
    })
    .await
}

async fn update(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    ip: ClientIp,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<RoleBody>,
) -> Result<Json<Value>, ApiError> {
    let now = one_invite(&state, admin, ip, id, move |conn, actor, invite| {
        change_role(conn, actor, invite, body.role)
    })
    .await?;
    Ok(Json(json!({ "invite": now.as_ref().map(invite_json) })))
}

/// "Revoke invitation" after confirmation.
async fn revoke_one(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    ip: ClientIp,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    one_invite(&state, admin, ip, id, revoke).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Invitation for the token from the link; unknown tokens count towards the
/// per-IP limit (like the other links from mails) and are 404.
async fn find(state: &AppState, ip: ClientIp, token: &str) -> Result<([u8; 32], Found), ApiError> {
    let attempt = state.limiter.reserve(&LINK_IP, Key::Ip(ip.network()))?;
    let Some(token) = Token::parse(token) else {
        attempt.count();
        return Err(ApiError::NotFound);
    };
    let hash = token.hash();
    let found = db::call(&state.db, move |conn| {
        Ok(invitations::by_token(conn, &hash)?)
    })
    .await?;
    match found {
        Some(found) => Ok((hash, found)),
        None => {
            attempt.count();
            Err(ApiError::NotFound)
        }
    }
}

/// Invitation page: details for "Welcome" or "Invitation expired". Names in
/// display form ("Max Smith"). Like changing requests only with
/// `X-Requested-With`: unknown tokens count towards the per-IP limit, and a
/// foreign `<img>` should not be able to trigger them.
async fn show(
    State(state): State<AppState>,
    ip: ClientIp,
    headers: HeaderMap,
    Path(token): Path<String>,
) -> Result<Json<Value>, ApiError> {
    super::require_requested_with(&headers)?;
    let (_, found) = find(&state, ip, &token).await?;
    let invite = found.invitation;
    Ok(Json(json!({
        "email": invite.email,
        "name": invite.name.as_deref().map(full_name),
        "role": invite.role.as_str(),
        "inviter": invite.inviter.as_deref().map(full_name),
        "expires_at": invite.expires_at,
        "expired": invite.expired,
    })))
}

/// "Multi-factor" step: new secret for the authenticator app (an earlier one
/// of the invitation then no longer applies).
async fn enroll(
    State(state): State<AppState>,
    ip: ClientIp,
    Path(token): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (_, found) = find(&state, ip, &token).await?;
    let invite = found.invitation;
    if invite.expired {
        return Err(expired());
    }
    let secret = totp::generate_secret()?;
    let sealed = state.secrets.seal(TOTP_PURPOSE, &invite.id, &secret)?;
    let (base32, uri) = totp::enrollment(&secret, &state.brand().app, &invite.email)?;
    let id = invite.id;
    let stored = db::call(&state.db, move |conn| {
        Ok(invitations::set_totp(conn, &id, &sealed)?)
    })
    .await?;
    if !stored {
        return Err(expired());
    }
    Ok(Json(json!({ "secret": base32, "uri": uri })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AcceptBody {
    name: String,
    password: String,
    /// Code from the app of the "Multi-factor" step.
    code: String,
}

/// Result of the transaction in [`accept`].
struct Accepted {
    user: AuthUser,
    cookie: axum::http::HeaderValue,
    codes: Vec<String>,
}

/// "Activate account": name, password and code from the app; signed in
/// afterwards. In maintenance mode only invitations as administrator.
async fn accept(
    State(state): State<AppState>,
    ip: ClientIp,
    headers: HeaderMap,
    previous: Option<CurrentUser>,
    Path(token): Path<String>,
    JsonBody(body): JsonBody<AcceptBody>,
) -> Result<Response, ApiError> {
    let (hash, found) = find(&state, ip, &token).await?;
    let invite = found.invitation;
    if invite.expired {
        return Err(expired());
    }
    state.maintenance.admit(invite.role)?;
    let name = body.name.trim().to_owned();
    let code = totp::compact(&body.code);
    let mut errors = FieldErrors::default();
    check_display_name(&mut errors, "name", &name);
    check_new_password(&mut errors, "password", &body.password);
    if code.is_empty() {
        errors.code("code", "required");
    } else if !totp::is_well_formed(&code) {
        errors.code("code", "invalid");
    }
    if !errors.is_empty() {
        return Err(errors.into_error());
    }
    let Some(sealed) = found.totp_secret_enc else {
        return Err(rejected("totp_required"));
    };

    // The code before the hash: a wrong one costs no computing time.
    let attempt = state
        .limiter
        .reserve(&INVITE_CODE, Key::User(format!("invite:{}", invite.id)))?;
    let secret = state.secrets.open(TOTP_PURPOSE, &invite.id, &sealed)?;
    let Some(step) = totp::matching_step(&secret, &code, totp::now())? else {
        attempt.count();
        return Err(auth::invalid_code());
    };
    drop(attempt);
    let password_hash = state.hasher.hash(&body.password).await?;
    let device_id = db::new_id()?;
    let device_secret = state
        .secrets
        .seal(totp::SECRET_PURPOSE, &device_id, &secret)?;
    let origin = auth::origin(&state, &headers, ip);
    let previous = previous.map(|CurrentUser(user)| user);
    let maintenance = state.maintenance.clone();

    let accepted = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        // Accepted, revoked, expired or a new secret created in the meantime:
        // the check applied to a different state.
        let Some(now) = invitations::by_token(&tx, &hash)? else {
            return Ok(Err(ApiError::NotFound));
        };
        if now.invitation.expired {
            return Ok(Err(expired()));
        }
        if now.totp_secret_enc.as_deref() != Some(sealed.as_slice()) {
            return Ok(Err(auth::invalid_code()));
        }
        let invite = now.invitation;
        // With the role as of now: it may have changed since the check
        // above.
        if let Err(error) = maintenance.admit(invite.role) {
            return Ok(Err(error));
        }
        let username = users::unique_username(&tx, &invite.email)?;
        let user_id = users::insert(
            &tx,
            &NewUser {
                username: &username,
                email: &invite.email,
                display_name: &name,
                role: invite.role,
                password_hash: &password_hash,
            },
        )?;
        // No settings yet: the app name in the default language.
        let app = totp::default_name(&[], settings::Language::default());
        totp_devices::insert_confirmed(&tx, &device_id, &user_id, &app, &device_secret, step)?;
        let codes = recovery::replace(&tx, &user_id)?;
        invitations::delete(&tx, &invite.id)?;
        // Like a sign-in: an earlier session of the browser ends.
        if let Some(previous) = &previous {
            sessions::delete(&tx, &previous.id, &previous.session_id)?;
        }
        let client = origin.client();
        let started = session::start(&tx, &user_id, &client, true)?;
        // The account's first device: known, without a notice.
        known_devices::remember(&tx, &user_id, &origin.device_hash)?;
        let user = AuthUser {
            id: user_id,
            username,
            email: invite.email.clone(),
            display_name: name.clone(),
            role: invite.role,
            session_id: started.id.clone(),
        };
        audit_log::insert(
            &tx,
            &Entry::new(Category::Users, "users.invite_accept")
                .actor(&user)
                .client(&client)
                .target(&user.id)
                .details(json!({
                    "email": user.email,
                    "role": user.role.as_str(),
                    "invitation": invite.id,
                    "invited_by": invite.invited_by,
                })),
        )?;
        audit_log::insert(
            &tx,
            &Entry::new(Category::Login, "auth.login")
                .actor(&user)
                .client(&client)
                .target(&started.id)
                .details(json!({ "method": "invite" })),
        )?;
        let event = Team::InviteAccepted {
            user_id: &user.id,
            name: &user.display_name,
        };
        events::team(&tx, event, Some(&user.id))?;
        events::news(&tx, &user.id, News::Welcome)?;
        tx.commit()?;
        Ok(Ok(Accepted {
            user,
            cookie: started.cookie,
            codes,
        }))
    })
    .await??;
    tracing::info!(user = %accepted.user.id, "invitation accepted");
    let body = Json(json!({
        "user": auth::user_json(&accepted.user),
        "recovery_codes": accepted.codes,
    }));
    Ok((
        StatusCode::CREATED,
        [(header::SET_COOKIE, accepted.cookie)],
        body,
    )
        .into_response())
}

/// "Request a new invitation" on the page of an expired invitation: always
/// 202; it is reported at most once per 24 hours.
async fn request(
    State(state): State<AppState>,
    ip: ClientIp,
    Path(token): Path<String>,
) -> Result<StatusCode, ApiError> {
    let (_, found) = find(&state, ip, &token).await?;
    let invite = found.invitation;
    if !invite.expired {
        return Err(rejected("invite_valid"));
    }
    db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        if invitations::request(&tx, &invite.id)? {
            let event = Team::InviteRequested {
                invitation_id: &invite.id,
                email: &invite.email,
            };
            events::team(&tx, event, None)?;
            let mut entry = Entry::new(Category::Users, "users.invite_request")
                .ip(ip.0)
                .target(&invite.id)
                .details(json!({ "email": invite.email }));
            // Without an account: the invited address.
            entry.actor_name = Some(invite.email.clone());
            audit_log::insert(&tx, &entry)?;
        }
        tx.commit()?;
        Ok(())
    })
    .await?;
    Ok(StatusCode::ACCEPTED)
}
