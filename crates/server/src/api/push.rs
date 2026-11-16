//! Web Push.
//!
//! - `GET push/vapid-public-key`: `{"key": …}` for
//!   `pushManager.subscribe({ applicationServerKey })`.
//! - `GET push/subscriptions`: the person's subscribed browsers with the
//!   device name from the session and `current` for this session.
//! - `POST push/subscriptions`: subscribes the browser (`PushSubscription`
//!   like `toJSON()`: `endpoint`, `expirationTime`, `keys.p256dh`,
//!   `keys.auth`); 201 new, 200 for a known endpoint. The subscription
//!   belongs to this session and ends with it.
//! - `DELETE push/subscriptions/:id`: "Turning off deletes the subscription".
//! - `POST push/test`: test message to the browsers of this session (see
//!   [`test_text`]), without quiet hours and channels; `{"sent": n}`.
//!   Without a subscription 409 `no_subscription`; if no push service
//!   accepts, 502 `push_failed`.
//!
//! The app switches the channel (`nCh.push`) via `settings`; whether a topic
//! comes via push is decided by `nCh` and `nMx` when sending.

use std::time::Duration;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get, post},
};
use base64::{
    Engine as _, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use jiff::Timestamp;
use serde::Deserialize;
use serde_json::{Value, json};
use url::{Host, Url};

use super::{ApiError, FieldErrors, JsonBody};
use crate::{
    app::AppState,
    auth::{CurrentUser, device::Device},
    broker::outbound,
    db::{
        self,
        repo::push_subscriptions::{self, New, Subscription},
    },
    i18n,
    push::{Data, Message, Outcome, START_PATH, Sender, Urgency, ece},
    rate_limit::{Key, Policy},
    settings::{self, Language},
};

/// Longest endpoint (those of the big push services are under 1 KiB).
const MAX_ENDPOINT: usize = 2048;
/// Test messages per person: otherwise push services might throttle the
/// VAPID key of the whole instance.
const TEST_LIMIT: Policy = Policy::rate("push.test.user", 10, Duration::from_secs(10 * 60));
/// Text of the test message in the person's language.
pub fn test_text(lang: Language) -> &'static str {
    i18n::t(lang, "push.test_text")
}
/// How long the push service keeps the test message.
const TEST_TTL: Duration = Duration::from_secs(5 * 60);
/// `tag` of the test message: a new one replaces the previous one.
const TEST_TAG: &str = "push-test";

/// Base64url like `PushSubscription.toJSON()`, with or without padding.
const BASE64URL: GeneralPurpose = GeneralPurpose::new(
    &alphabet::URL_SAFE,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/push/vapid-public-key", get(vapid_public_key))
        .route("/push/subscriptions", get(list).post(subscribe))
        .route("/push/subscriptions/{id}", delete(unsubscribe))
        .route("/push/test", post(test))
}

async fn vapid_public_key(
    State(state): State<AppState>,
    CurrentUser(_): CurrentUser,
) -> Result<Json<Value>, ApiError> {
    let vapid = state.vapid().await?;
    Ok(Json(json!({ "key": vapid.public_key() })))
}

fn subscription_json(s: &Subscription, session_id: &str, lang: Language) -> Value {
    json!({
        "id": s.id,
        "endpoint": s.endpoint,
        "device": Device::parse(s.user_agent.as_deref()).label(lang),
        "created_at": s.created_at,
        "expires_at": s.expires_at,
        "current": s.session_id == session_id,
    })
}

async fn list(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<Value>, ApiError> {
    let user_id = user.id.clone();
    let (listed, lang) = db::call(&state.db, move |conn| {
        Ok((
            push_subscriptions::of_user(conn, &user_id)?,
            settings::lang_of(conn, &user_id)?,
        ))
    })
    .await?;
    let items: Vec<Value> = listed
        .iter()
        .map(|s| subscription_json(s, &user.session_id, lang))
        .collect();
    Ok(Json(json!({ "subscriptions": items })))
}

#[derive(Debug, Deserialize)]
struct SubscribeBody {
    endpoint: String,
    /// Milliseconds since 1970 or `null`.
    #[serde(default, rename = "expirationTime")]
    expiration_time: Option<f64>,
    keys: SubscribeKeys,
}

#[derive(Debug, Deserialize)]
struct SubscribeKeys {
    p256dh: String,
    auth: String,
}

/// Checked details of a subscription.
struct Checked {
    endpoint: String,
    p256dh: Vec<u8>,
    auth: Vec<u8>,
    expires_at: Option<String>,
}

/// Endpoint only over HTTPS (RFC 8030 › 8) and never to an IP address in a
/// non-public network: the resolver of `AppState::user_http` checks names on
/// every connection; IP addresses in the URL do not ask it.
fn check_endpoint(endpoint: &str) -> Result<String, &'static str> {
    if endpoint.len() > MAX_ENDPOINT {
        return Err("invalid");
    }
    let url = Url::parse(endpoint).map_err(|_| "invalid")?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("invalid");
    }
    match url.host() {
        Some(Host::Ipv4(ip)) if !outbound::is_public(ip.into()) => Err("private"),
        Some(Host::Ipv6(ip)) if !outbound::is_public(ip.into()) => Err("private"),
        // Verbatim, as the browser reports it: the app compares it with
        // `pushManager.getSubscription()`.
        Some(_) => Ok(endpoint.to_owned()),
        None => Err("invalid"),
    }
}

fn check(body: &SubscribeBody) -> Result<Checked, ApiError> {
    let mut errors = FieldErrors::default();
    let endpoint = check_endpoint(&body.endpoint)
        .map_err(|code| errors.code("endpoint", code))
        .ok();
    let p256dh = BASE64URL
        .decode(&body.keys.p256dh)
        .ok()
        .filter(|key| ece::valid_public_key(key));
    if p256dh.is_none() {
        errors.code("keys.p256dh", "invalid");
    }
    let auth = BASE64URL
        .decode(&body.keys.auth)
        .ok()
        .filter(|auth| auth.len() == ece::AUTH_LEN);
    if auth.is_none() {
        errors.code("keys.auth", "invalid");
    }
    let expires_at = match body.expiration_time {
        None => None,
        Some(ms) => {
            #[allow(clippy::cast_possible_truncation)]
            let at = (ms.is_finite() && ms.abs() < 1e15)
                .then(|| Timestamp::from_millisecond(ms as i64).ok())
                .flatten();
            match at {
                None => errors.code("expirationTime", "invalid"),
                // Already expired: the job would remove it right away.
                Some(at) if at <= Timestamp::now() => errors.code("expirationTime", "expired"),
                Some(_) => {}
            }
            at.map(|at| at.to_string())
        }
    };
    match (endpoint, p256dh, auth) {
        (Some(endpoint), Some(p256dh), Some(auth)) if errors.is_empty() => Ok(Checked {
            endpoint,
            p256dh,
            auth,
            expires_at,
        }),
        _ => Err(errors.into_error()),
    }
}

async fn subscribe(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    JsonBody(body): JsonBody<SubscribeBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let checked = check(&body)?;
    let (user_id, session_id) = (user.id.clone(), user.session_id.clone());
    let (created, saved, lang) = db::call(&state.db, move |conn| {
        let (id, created) = push_subscriptions::upsert(
            conn,
            &user_id,
            &session_id,
            &New {
                endpoint: &checked.endpoint,
                p256dh: &checked.p256dh,
                auth: &checked.auth,
                expires_at: checked.expires_at.as_deref(),
            },
        )?;
        let saved = push_subscriptions::get(conn, &user_id, &id)?
            .ok_or_else(|| anyhow::anyhow!("subscription vanished after saving"))?;
        Ok((created, saved, settings::lang_of(conn, &user_id)?))
    })
    .await?;
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((
        status,
        Json(subscription_json(&saved, &user.session_id, lang)),
    ))
}

/// Unsubscribes a browser; a foreign or unknown one does not exist (404).
async fn unsubscribe(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let deleted = db::call(&state.db, move |conn| {
        Ok(push_subscriptions::delete(conn, &user.id, &id)?)
    })
    .await?;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

/// Test message to the browsers of this session (`pu.test`): title = name of
/// the app, a click opens the app.
async fn test(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<Value>, ApiError> {
    let (user_id, session_id) = (user.id.clone(), user.session_id.clone());
    let (subscriptions, lang) = db::call(&state.db, move |conn| {
        Ok((
            push_subscriptions::of_session(conn, &user_id, &session_id)?,
            settings::lang_of(conn, &user_id)?,
        ))
    })
    .await?;
    if subscriptions.is_empty() {
        return Err(no_subscription());
    }
    state
        .limiter
        .acquire(&TEST_LIMIT, Key::User(user.id.clone()))?;
    let sender = Sender::of(&state).await?;
    let message = Message {
        title: state.brand().app,
        body: test_text(lang).to_owned(),
        icon: sender.icon.clone(),
        tag: TEST_TAG.to_owned(),
        data: Data {
            url: START_PATH.to_owned(),
        },
    };
    let outcomes = sender
        .send_all(&subscriptions, &message, Urgency::High, TEST_TTL)
        .await;
    let sent = outcomes
        .iter()
        .filter(|o| **o == Outcome::Delivered)
        .count();
    let gone: Vec<String> = subscriptions
        .iter()
        .zip(&outcomes)
        .filter(|(_, outcome)| **outcome == Outcome::Gone)
        .map(|(s, _)| s.id.clone())
        .collect();
    let all_gone = gone.len() == subscriptions.len();
    if !gone.is_empty() {
        db::call(&state.db, move |conn| {
            push_subscriptions::delete_gone(conn, &gone)
        })
        .await?;
    }
    match sent {
        0 if all_gone => Err(no_subscription()),
        0 => Err(ApiError::rejected(StatusCode::BAD_GATEWAY, "push_failed")),
        sent => Ok(Json(json!({ "sent": sent }))),
    }
}

fn no_subscription() -> ApiError {
    ApiError::rejected(StatusCode::CONFLICT, "no_subscription")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_only_over_https_and_not_into_private_networks() {
        assert_eq!(
            check_endpoint("https://fcm.googleapis.com/fcm/send/abc:def").unwrap(),
            "https://fcm.googleapis.com/fcm/send/abc:def"
        );
        assert_eq!(check_endpoint("http://push.example.com/x"), Err("invalid"));
        assert_eq!(check_endpoint("https://127.0.0.1/x"), Err("private"));
        assert_eq!(check_endpoint("https://[::1]/x"), Err("private"));
        assert_eq!(check_endpoint("https://10.1.2.3/x"), Err("private"));
        assert_eq!(
            check_endpoint("https://a:b@push.example.com/x"),
            Err("invalid")
        );
        assert_eq!(check_endpoint("no link"), Err("invalid"));
        let long = format!("https://push.example.com/{}", "a".repeat(MAX_ENDPOINT));
        assert_eq!(check_endpoint(&long), Err("invalid"));
    }
}
