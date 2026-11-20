//! Web push for notifications: the backend sends to the
//! browsers' push services (RFC 8030), encrypted per RFC 8291 ([`ece`]) and
//! identified with VAPID per RFC 8292 ([`vapid`]). The cryptography comes from
//! `ring`, which rustls brings along anyway; the crate `web-push` would bring
//! OpenSSL.
//!
//! What is sent, `events` queues in `notification_deliveries`
//! (`channel = 'push'`) and wakes the job `push_sender` with [`wake`], which
//! delivers it – security right away, everything else outside quiet hours.

pub mod ece;
pub mod vapid;

use std::{sync::Arc, time::Duration};

use anyhow::Context as _;
use jiff::Timestamp;
use reqwest::{StatusCode, header};
use serde::Serialize;
use tokio::{sync::Notify, task::JoinSet};
use url::Url;

pub use vapid::Vapid;

use crate::{
    app::AppState, db::repo::push_subscriptions::Subscription, mailer::templates::PUSH_ICON_PATH,
};

/// Wakes the job `push_sender` (see [`wake`]).
pub static WAKE: Notify = Notify::const_new();

/// Wakes the job `push_sender`, so that a queued message does not wait for the
/// next run. Callers are in the middle of their transaction; the job reads
/// through the same connection ([`crate::db::call`]) and therefore only sees
/// the queued entry after the commit.
pub fn wake() {
    WAKE.notify_one();
}

/// Content of a push message as the service worker shows it: title and text from
/// the event catalog, app icon, `tag` = ID (replaces an earlier message of
/// the same entry), a click opens `data.url`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Message {
    pub title: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub tag: String,
    pub data: Data,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Data {
    /// Path in the web app (`nPath`).
    pub url: String,
}

/// Target without an entry (`nPath` without a target).
pub const START_PATH: &str = "/start";

impl Message {
    /// JSON of the message; if it is too long for one record, the text is
    /// shortened (with "…").
    pub fn to_bytes(&self) -> anyhow::Result<Vec<u8>> {
        let bytes = serde_json::to_vec(self)?;
        if bytes.len() <= ece::MAX_PLAINTEXT {
            return Ok(bytes);
        }
        // Longest prefix of the text that fits with "…" (escapes in the JSON
        // make the length per character uneven).
        let starts: Vec<usize> = self.body.char_indices().map(|(i, _)| i).collect();
        anyhow::ensure!(!starts.is_empty(), "push message too large");
        let mut message = self.clone();
        let mut fits = |chars: usize| -> anyhow::Result<Option<Vec<u8>>> {
            message.body = format!("{}…", &self.body[..starts[chars]]);
            let bytes = serde_json::to_vec(&message)?;
            Ok((bytes.len() <= ece::MAX_PLAINTEXT).then_some(bytes))
        };
        let mut best = fits(0)?.context("push message too large")?;
        let (mut lo, mut hi) = (0, starts.len());
        while lo + 1 < hi {
            let mid = lo + (hi - lo) / 2;
            match fits(mid)? {
                Some(bytes) => (best, lo) = (bytes, mid),
                None => hi = mid,
            }
        }
        Ok(best)
    }
}

/// Urgency (RFC 8030 › 5.3): high for security and test, otherwise normal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Urgency {
    Normal,
    High,
}

impl Urgency {
    fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::High => "high",
        }
    }
}

/// How long the push service keeps a message for a device without a
/// connection (`TTL`).
pub const TTL: Duration = Duration::from_secs(24 * 3600);

/// Outcome of a message to a push service.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Delivered,
    /// Subscription expired or unsubscribed (404, 410): remove.
    Gone,
    /// Retry later (429, 5xx, network).
    Retry,
    /// Rejected (such as 400, 403, 413); another attempt changes nothing.
    Rejected,
}

impl Outcome {
    fn of(status: StatusCode) -> Self {
        match status {
            s if s.is_success() => Self::Delivered,
            StatusCode::NOT_FOUND | StatusCode::GONE => Self::Gone,
            StatusCode::TOO_MANY_REQUESTS => Self::Retry,
            s if s.is_server_error() => Self::Retry,
            _ => Self::Rejected,
        }
    }
}

/// Sender: HTTP client with SSRF guard (the endpoints come from the browser),
/// VAPID key, contact for `sub` and icon of the messages. Cheap
/// to clone.
#[derive(Clone)]
pub struct Sender {
    http: reqwest::Client,
    vapid: Arc<Vapid>,
    /// Public address of the instance as contact (`sub`).
    subject: Arc<str>,
    /// `/branding/push-icon.png?v=…`, if the logo has been rendered.
    pub icon: Option<String>,
}

impl Sender {
    /// From the app state; creates the VAPID key the first time.
    pub async fn of(state: &AppState) -> anyhow::Result<Self> {
        Ok(Self {
            http: state.user_http.clone(),
            vapid: state.vapid().await?,
            subject: state.public_url.origin().ascii_serialization().into(),
            // With a version like the mail logo, so that the push service or
            // the device does not show the old one after a change.
            icon: state
                .brand()
                .push_icon()
                .map(|png| format!("{PUSH_ICON_PATH}?v={}", png.version)),
        })
    }

    /// Sends `message` to all `to` at once (a hanging push service does not hold
    /// up the others); the outcomes are in the same order.
    pub async fn send_all(
        &self,
        to: &[Subscription],
        message: &Message,
        urgency: Urgency,
        ttl: Duration,
    ) -> Vec<Outcome> {
        let plain: Arc<[u8]> = match message.to_bytes() {
            Ok(plain) => plain.into(),
            Err(error) => {
                tracing::warn!("push message not prepared: {error:#}");
                return vec![Outcome::Rejected; to.len()];
            }
        };
        let mut tasks = JoinSet::new();
        for (i, subscription) in to.iter().enumerate() {
            let (sender, plain) = (self.clone(), plain.clone());
            let (endpoint, p256dh, auth) = (
                subscription.endpoint.clone(),
                subscription.p256dh.clone(),
                subscription.auth.clone(),
            );
            tasks.spawn(async move {
                let outcome = sender
                    .send(&endpoint, &p256dh, &auth, &plain, urgency, ttl)
                    .await;
                (i, outcome)
            });
        }
        // An aborted attempt counts as temporary.
        let mut outcomes = vec![Outcome::Retry; to.len()];
        while let Some(done) = tasks.join_next().await {
            if let Ok((i, outcome)) = done {
                outcomes[i] = outcome;
            }
        }
        outcomes
    }

    /// One message to one browser. The log only names the host of the push
    /// service: the endpoint itself is the device's address.
    async fn send(
        &self,
        endpoint: &str,
        p256dh: &[u8],
        auth: &[u8],
        plain: &[u8],
        urgency: Urgency,
        ttl: Duration,
    ) -> Outcome {
        let Ok(url) = Url::parse(endpoint) else {
            return Outcome::Gone;
        };
        let host = url.host_str().unwrap_or_default().to_owned();
        let prepared = ece::encrypt(p256dh, auth, plain).and_then(|body| {
            let token = self
                .vapid
                .authorization(&url, &self.subject, Timestamp::now())?;
            Ok((body, token))
        });
        let (body, token) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                tracing::warn!(host, "push message not prepared: {error:#}");
                return Outcome::Rejected;
            }
        };
        let response = self
            .http
            .post(url)
            .header("TTL", ttl.as_secs().to_string())
            .header("Urgency", urgency.as_str())
            .header(header::CONTENT_ENCODING, "aes128gcm")
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(header::AUTHORIZATION, token)
            .body(body)
            .send()
            .await;
        match response {
            Ok(response) => {
                let outcome = Outcome::of(response.status());
                if matches!(outcome, Outcome::Retry | Outcome::Rejected) {
                    tracing::warn!(
                        host,
                        status = response.status().as_u16(),
                        "push service did not accept the message"
                    );
                }
                outcome
            }
            Err(error) => {
                // Without URL: the endpoint is a secret identifier of the device
                // (RFC 8030 › 8); only the host goes into the log.
                let error = error.without_url();
                tracing::warn!(host, "push service not reached: {error}");
                Outcome::Retry
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(body: String) -> Message {
        Message {
            title: "New sign-in".into(),
            body,
            icon: Some("/branding/push-icon.png".into()),
            tag: "01J".into(),
            data: Data {
                url: "/account/security".into(),
            },
        }
    }

    #[test]
    fn json_like_npush() {
        let bytes = message("Firefox on Linux".into()).to_bytes().unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "title": "New sign-in",
                "body": "Firefox on Linux",
                "icon": "/branding/push-icon.png",
                "tag": "01J",
                "data": { "url": "/account/security" },
            })
        );
        let mut without = message(String::new());
        without.icon = None;
        assert!(
            !String::from_utf8(without.to_bytes().unwrap())
                .unwrap()
                .contains("icon")
        );
    }

    #[test]
    fn long_texts_are_cut_to_fit() {
        for body in ["ä".repeat(3000), "\"".repeat(3000), "a".repeat(5000)] {
            let bytes = message(body).to_bytes().unwrap();
            assert!(bytes.len() <= ece::MAX_PLAINTEXT, "{}", bytes.len());
            assert!(bytes.len() > ece::MAX_PLAINTEXT - 16, "{}", bytes.len());
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert!(value["body"].as_str().unwrap().ends_with('…'));
        }
    }

    #[test]
    fn too_long_title_is_an_error() {
        let mut long = message(String::new());
        long.title = "x".repeat(5000);
        assert!(long.to_bytes().is_err());
        long.body = "Text".into();
        assert!(long.to_bytes().is_err());
    }

    /// If the push service is unreachable, the log names the host but not the
    /// endpoint (`reqwest::Error` would otherwise append the URL).
    #[tokio::test]
    async fn log_names_the_host_but_not_the_endpoint() {
        use std::{io, sync::Mutex};

        #[derive(Clone, Default)]
        struct Buffer(Arc<Mutex<Vec<u8>>>);
        impl io::Write for Buffer {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let rng = ring::rand::SystemRandom::new();
        let browser =
            ring::agreement::EphemeralPrivateKey::generate(&ring::agreement::ECDH_P256, &rng)
                .unwrap();
        let p256dh = browser.compute_public_key().unwrap().as_ref().to_vec();
        let sender = Sender {
            http: crate::broker::http_client().unwrap(),
            vapid: Arc::new(Vapid::generate().unwrap().0),
            subject: "https://app.example.com".into(),
            icon: None,
        };
        let buffer = Buffer::default();
        let writer = buffer.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);
        // Port 1 is closed: the connection fails at once.
        let outcome = sender
            .send(
                "https://127.0.0.1:1/wpush/secret-path",
                &p256dh,
                &[7; 16],
                b"{}",
                Urgency::Normal,
                Duration::from_secs(60),
            )
            .await;
        assert_eq!(outcome, Outcome::Retry);
        let logs = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
        assert!(logs.contains("push service not reached"), "{logs}");
        assert!(logs.contains("127.0.0.1"), "{logs}");
        assert!(!logs.contains("secret-path"), "{logs}");
    }

    #[test]
    fn outcome_of_status() {
        assert_eq!(Outcome::of(StatusCode::CREATED), Outcome::Delivered);
        assert_eq!(Outcome::of(StatusCode::GONE), Outcome::Gone);
        assert_eq!(Outcome::of(StatusCode::NOT_FOUND), Outcome::Gone);
        assert_eq!(Outcome::of(StatusCode::TOO_MANY_REQUESTS), Outcome::Retry);
        assert_eq!(Outcome::of(StatusCode::BAD_GATEWAY), Outcome::Retry);
        assert_eq!(Outcome::of(StatusCode::FORBIDDEN), Outcome::Rejected);
        assert_eq!(
            Outcome::of(StatusCode::PAYLOAD_TOO_LARGE),
            Outcome::Rejected
        );
    }
}
