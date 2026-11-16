//! "Forgot password" and "Reset password" (steps of the sign-in page).
//!
//! - `POST auth/password/forgot` (`{email}`): always answers the same (202),
//!   whether the account exists or not. Lookup and mail run in the
//!   background, so the response time does not give anything away either.
//!   Only active accounts get a link (template `reset`, 60 minutes, single
//!   use); a new one replaces the previous one.
//! - `POST auth/password/reset/:token` (`{password}`): new password
//!   according to the policy. Ends all sessions, discards open links from
//!   mails and triggers "Password changed" (event and mail
//!   `security_password`). It does not sign in – afterwards sign in with the
//!   new password and, with multi-factor, a code; a sign-in lockout after
//!   wrong passwords is lifted.

use std::time::Duration;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::post,
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    ApiError, FieldErrors, JsonBody,
    auth::{self, LOGIN_ACCOUNT, LOGIN_SUCCESS},
    me::{REAUTH_SUCCESS, check_email, check_new_password},
};
use crate::{
    app::AppState,
    auth::session::Token,
    client_ip::ClientIp,
    db::{
        self,
        repo::{
            self,
            audit_log::{self, Category, Entry},
            password_resets::{self, Lookup},
            sessions, users,
        },
    },
    events::{self, Outbox, Security},
    mailer::{delivery::Delivery, templates::Reset},
    rate_limit::{Key, Policy},
    settings,
};

/// "Forgot password" requests per client IP: ten at once, then one every
/// six minutes.
const FORGOT_IP: Policy = Policy::rate("auth.forgot.ip", 10, Duration::from_secs(60 * 60));
/// Mails per entered address: five at once, then one every twelve minutes.
/// Beyond that, silently no mail goes out – a separate response would reveal
/// that the account exists.
const FORGOT_ACCOUNT: Policy = Policy::rate("auth.forgot.account", 5, Duration::from_secs(60 * 60));
/// Unknown tokens from mail links per client IP (password reset, email
/// confirmation): ten in 15 minutes, then a 15-minute lockout. A 256-bit
/// token cannot be guessed anyway; the limit keeps load and audit log small.
pub const LINK_IP: Policy = Policy::lockout(
    "auth.link.ip",
    10,
    Duration::from_secs(15 * 60),
    Duration::from_secs(15 * 60),
);

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/password/forgot", post(forgot))
        .route("/auth/password/reset/{token}", post(reset))
}

fn invalid_token() -> ApiError {
    ApiError::rejected(StatusCode::UNPROCESSABLE_ENTITY, "invalid_token")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ForgotBody {
    email: String,
}

/// "Send link": always 202, without revealing whether the account exists.
async fn forgot(
    State(state): State<AppState>,
    ip: ClientIp,
    JsonBody(body): JsonBody<ForgotBody>,
) -> Result<StatusCode, ApiError> {
    let email = body.email.trim().to_owned();
    let mut errors = FieldErrors::default();
    check_email(&mut errors, "email", &email);
    if !errors.is_empty() {
        return Err(errors.into_error());
    }
    state.limiter.acquire(&FORGOT_IP, Key::Ip(ip.network()))?;
    let worker = state.clone();
    state.background.spawn(async move {
        if let Err(error) = send_reset(&worker, email, ip).await {
            tracing::warn!("password reset link not sent: {error:#}");
        }
    });
    Ok(StatusCode::ACCEPTED)
}

/// Creates a link for an active account and sends it; without account,
/// system mail or public URL nothing goes out (log).
async fn send_reset(state: &AppState, email: String, ip: ClientIp) -> anyhow::Result<()> {
    // Lowercased like `COLLATE NOCASE` (ASCII only), which the lookup
    // compares with: other spellings of the same address share the counter,
    // foreign characters like `K` (Kelvin) do not use it up.
    let key = Key::User(format!("forgot:{}", email.to_ascii_lowercase()));
    if state.limiter.acquire(&FORGOT_ACCOUNT, key).is_err() {
        tracing::info!(ip = %ip.0, "forgot password: limit per address reached, no mail");
        return Ok(());
    }
    let delivery = match Delivery::prepare(state).await? {
        Ok(delivery) => delivery,
        Err(why) => {
            tracing::warn!(?why, "forgot password: no system mail, no link");
            return Ok(());
        }
    };
    let token = Token::generate()?;
    let hash = token.hash();
    let found = db::call(&state.db, move |conn| {
        let Some(user) = users::find_active_by_email(conn, &email)? else {
            return Ok(None);
        };
        let tx = conn.transaction()?;
        let format = settings::format_of(&tx, &user.id)?;
        password_resets::insert(&tx, &user.id, &hash)?;
        audit_log::insert(
            &tx,
            &Entry::new(Category::Login, "auth.password_forgot")
                .actor_profile(&user)
                .target(&user.id)
                .ip(ip.0),
        )?;
        tx.commit()?;
        Ok(Some((user, format)))
    })
    .await?;
    let Some((user, format)) = found else {
        tracing::info!(ip = %ip.0, "forgot password: no active account, no mail");
        return Ok(());
    };
    // If sending fails, nobody knows the link; it simply expires.
    let _ = delivery
        .send(state, &format, |ctx| {
            Reset {
                to: &user.email,
                name: &user.display_name,
                token: token.as_str(),
            }
            .render(ctx)
        })
        .await?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResetBody {
    password: String,
}

/// "Set password" with the link from the mail. An unknown, expired or
/// already used link is 422 `invalid_token` (only unknown ones count towards
/// the limit per IP); the policy checks the password only with a valid link.
async fn reset(
    State(state): State<AppState>,
    ip: ClientIp,
    headers: HeaderMap,
    Path(token): Path<String>,
    JsonBody(body): JsonBody<ResetBody>,
) -> Result<Json<Value>, ApiError> {
    let attempt = state.limiter.reserve(&LINK_IP, Key::Ip(ip.network()))?;
    let Some(token) = Token::parse(&token) else {
        attempt.count();
        return Err(invalid_token());
    };
    let hash = token.hash();
    match db::call(&state.db, move |conn| {
        Ok(password_resets::lookup(conn, &hash)?)
    })
    .await?
    {
        Lookup::Unknown => {
            attempt.count();
            return Err(invalid_token());
        }
        Lookup::Spent => return Err(invalid_token()),
        Lookup::Valid { .. } => drop(attempt),
    }
    let mut errors = FieldErrors::default();
    check_new_password(&mut errors, "password", &body.password);
    if !errors.is_empty() {
        return Err(errors.into_error());
    }

    let new_hash = state.hasher.hash(&body.password).await?;
    let device = auth::device(&headers);
    let done = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        // Used up only now: two concurrent requests set a password only once,
        // an account locked in the meantime none at all.
        let Some(user_id) = password_resets::redeem(&tx, &hash)? else {
            return Ok(None);
        };
        let Some(user) = users::credentials_by_id(&tx, &user_id)?.map(|c| c.user) else {
            return Ok(None);
        };
        users::set_password(&tx, &user.id, &new_hash)?;
        let ended = sessions::delete_for_user(&tx, &user.id, None)?;
        repo::discard_links(&tx, &user.id)?;
        let mut outbox = Outbox::default();
        let event = Security::PasswordChanged {
            device,
            sessions_ended: ended,
            reset: true,
        };
        events::security(&tx, &mut outbox, (&user).into(), event)?;
        audit_log::insert(
            &tx,
            &Entry::new(Category::Login, "auth.password_reset")
                .actor_profile(&user)
                .target(&user.id)
                .ip(ip.0)
                .details(json!({ "sessions_ended": ended })),
        )?;
        tx.commit()?;
        Ok(Some((user, ended, outbox)))
    })
    .await?;
    let (user, ended, outbox) = done.ok_or_else(invalid_token)?;
    // Often the reason for the reset: with the new password, sign-in should
    // work right away, with address as well as username. The
    // limits for successes end too, for sign-in as in the session: if someone
    // used them up with the old password, it no longer fits now, and their
    // sessions are ended. The lockout for wrong codes stays – the link
    // from the mail does not replace the second factor.
    for login in [&user.email, &user.username] {
        let key = auth::login_key(login);
        state.limiter.reset(&LOGIN_ACCOUNT, &key);
        state.limiter.reset(&LOGIN_SUCCESS, &key);
    }
    state
        .limiter
        .reset(&REAUTH_SUCCESS, &Key::User(user.id.clone()));
    outbox.send(&state);
    Ok(Json(json!({ "status": "ok", "sessions_ended": ended })))
}
