//! System mails: render templates ([`templates`]) and send them via the
//! sending account over JMAP ([`Mailer::send`]).
//!
//! The sending account is an account on a registry server with an
//! app password (Basic auth) or token; the mail goes out from its identity.
//! It is stored in `app_settings.system_mail` ([`system_mail`]; the
//! setup creates it, Administration › Email changes it).
//! If sending fails, callers report `mail_failed` ([`MailError`] →
//! [`ApiError`]); the cause is only in the log, never with credentials.

pub mod delivery;
pub mod format;
pub mod preview;
pub mod system_mail;
pub mod templates;

use std::{
    collections::HashMap,
    fmt,
    time::{Duration, Instant},
};

use axum::http::StatusCode;
use jiff::{Timestamp, Unit};
use roedy_jmap as jmap;
use tokio::sync::Mutex;
use url::Url;

use crate::api::ApiError;

/// Rejected sign-ins at the mail server: Stalwart locks addresses after
/// failed sign-ins (Fail2Ban) – here the backend's, and with it
/// diagnosis, registration and later the token refresh of all users.
/// With wrong credentials (e.g. after a new app password) the
/// backend therefore tries at most five times in 15 minutes per server (from the
/// first error) and then not at all for 15 minutes; a success resets the
/// counter.
const MAX_FAILURES: u32 = 5;
const FAILURE_WINDOW: Duration = Duration::from_secs(15 * 60);
const LOCK: Duration = Duration::from_secs(15 * 60);
/// Session, identity and mailboxes of a send stay valid this long for
/// the next ones.
const SESSION_TTL: Duration = Duration::from_secs(10 * 60);

/// Rendered mail. `Debug` does not show the content: it contains links with
/// tokens.
#[derive(Clone)]
pub struct Mail {
    /// Template name (`invite`, `reset` …) for the log.
    pub template: &'static str,
    pub to: String,
    pub subject: String,
    pub html: String,
    pub text: String,
}

/// Templates with a link that unlocks something on its own (accept an
/// invitation, set a password, confirm an address): their copy in "Sent"
/// would stay valid in the sending account's mailbox, and whoever reads it would
/// get ahead of the person.
const WITH_TOKEN: [&str; 3] = ["invite", "reset", "email_confirm"];

impl Mail {
    /// Whether the mail contains such a link; it then never stays in
    /// "Sent", even with `mail.keepSent`.
    pub fn has_token(&self) -> bool {
        WITH_TOKEN.contains(&self.template)
    }
}

impl fmt::Debug for Mail {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Mail")
            .field("template", &self.template)
            .field("to", &self.to)
            .field("subject", &self.subject)
            .finish_non_exhaustive()
    }
}

/// Sending account of the system mail. `Debug` does not show password and
/// token.
#[derive(Debug, Clone)]
pub struct Account {
    /// Base URL of the server from the registry (origin only).
    pub base_url: Url,
    pub auth: jmap::Auth,
    /// Identity of the account (`mail.identity`); without it the first applies.
    pub identity_id: Option<String>,
    /// Sender name instead of the identity's (`mail.name`).
    pub sender_name: Option<String>,
    /// Reply-to address (`mail.replyTo`).
    pub reply_to: Option<String>,
    /// Keep a copy in "Sent" (`mail.keepSent`).
    pub keep_sent: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MailError {
    /// Too many rejected sign-ins at this server; until the lock expires
    /// (remaining time) the backend does not ask it again.
    Locked(Duration),
    Jmap(jmap::Error),
}

impl MailError {
    /// Stable key for log and diagnosis.
    pub fn reason(&self) -> &'static str {
        match self {
            Self::Locked(_) => "auth_locked",
            Self::Jmap(error) => error.reason(),
        }
    }

    /// Role of the missing mailbox for `no_mailbox` (`drafts`, `sent`);
    /// the page names it in the text.
    pub fn mailbox_role(&self) -> Option<&'static str> {
        match self {
            Self::Jmap(jmap::Error::NoMailbox(role)) => Some(role),
            _ => None,
        }
    }
}

impl fmt::Display for MailError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Locked(_) => f.write_str("too many rejected sign-ins, sending locked"),
            Self::Jmap(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for MailError {}

/// 502 `mail_failed` – without the cause, which administrators see in the log; also
/// without a configured system mail.
pub fn mail_failed() -> ApiError {
    ApiError::rejected(StatusCode::BAD_GATEWAY, "mail_failed")
}

impl From<MailError> for ApiError {
    fn from(_: MailError) -> Self {
        mail_failed()
    }
}

/// Sending of system mails, one at a time: this way, even with many
/// concurrent mails, it stays at most five rejected sign-ins per
/// server, and the
/// mails after the first need only one request (session, identity
/// and mailboxes stay valid for [`SESSION_TTL`]).
pub struct Mailer {
    http: reqwest::Client,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// Per server (origin): Stalwart counts failed sign-ins per
    /// server, so a wrong account on one does not lock another.
    failures: HashMap<String, Failures>,
    session: Option<Session>,
}

/// Session of the last successful send.
struct Session {
    key: (Url, jmap::Auth, Option<String>),
    client: jmap::Client,
    outbox: jmap::Outbox,
    opened: Instant,
}

/// Rejected sign-ins in the window from the first one.
#[derive(Debug, Default)]
struct Failures {
    count: u32,
    since: Option<Instant>,
    locked_until: Option<Instant>,
}

impl Failures {
    /// Remaining time of the lock.
    fn locked(&self, now: Instant) -> Option<Duration> {
        self.locked_until
            .filter(|until| *until > now)
            .map(|until| until - now)
    }

    /// Whether the entry still has an effect (lock or errors in the window).
    fn active(&self, now: Instant) -> bool {
        self.locked(now).is_some()
            || self
                .since
                .is_some_and(|since| now.duration_since(since) < FAILURE_WINDOW)
    }

    fn failed(&mut self, now: Instant) {
        if self
            .since
            .is_none_or(|since| now.duration_since(since) >= FAILURE_WINDOW)
        {
            self.count = 0;
            self.since = Some(now);
        }
        self.count += 1;
        if self.count >= MAX_FAILURES {
            *self = Self {
                locked_until: Some(now + LOCK),
                ..Self::default()
            };
        }
    }
}

impl Mailer {
    /// `http` is the client for mail servers ([`crate::broker::http_client`]).
    pub fn new(http: reqwest::Client) -> Self {
        Self {
            http,
            state: Mutex::default(),
        }
    }

    /// Sends the mail via the sending account and writes the result to the
    /// log.
    pub async fn send(&self, account: &Account, mail: &Mail) -> Result<(), MailError> {
        let server = account.base_url.origin().ascii_serialization();
        let result = self.submit(account, mail).await;
        match &result {
            Ok(sent) if sent.filed => {
                tracing::info!(template = mail.template, %server, "system mail sent");
            }
            Ok(_) => tracing::warn!(
                template = mail.template,
                %server,
                "system mail sent but not filed as configured (draft stays)"
            ),
            Err(error) => tracing::warn!(
                template = mail.template,
                %server,
                reason = error.reason(),
                detail = %error,
                "System mail not sent"
            ),
        }
        result.map(drop)
    }

    /// Checks the sending account as before a send (sign-in, identity,
    /// "Drafts") without sending, and returns its identities without
    /// placeholders – for the system mail test of the setup and later
    /// Administration › Email. Rejected sign-ins count as for a
    /// send; afterwards the session also applies to the next mail.
    pub async fn test(&self, account: &Account) -> Result<Vec<jmap::Identity>, MailError> {
        let server = account.base_url.origin().ascii_serialization();
        let result = self
            .with_session(account, async |session| session.client.identities().await)
            .await;
        match &result {
            Ok(_) => tracing::info!(%server, "sending account checked"),
            Err(error) => tracing::info!(
                %server,
                reason = error.reason(),
                detail = %error,
                "Sending account not usable"
            ),
        }
        result.map(|identities| {
            identities
                .into_iter()
                .filter(|identity| !identity.is_wildcard())
                .collect()
        })
    }

    async fn submit(&self, account: &Account, mail: &Mail) -> Result<jmap::Sent, MailError> {
        self.with_session(account, async |session| {
            let sent_at = sent_at(Timestamp::now());
            let message = jmap::Message {
                to: &mail.to,
                from_name: non_empty(account.sender_name.as_deref()),
                reply_to: non_empty(account.reply_to.as_deref()),
                subject: &mail.subject,
                text: &mail.text,
                html: &mail.html,
                sent_at: &sent_at,
            };
            session
                .client
                .send(
                    &session.outbox,
                    &message,
                    account.keep_sent && !mail.has_token(),
                )
                .await
        })
        .await
    }

    /// Runs `work` with a session of the account, one after the other:
    /// while locked the mailer does not ask the server, rejected sign-ins
    /// count, a success resets the counter and keeps the session.
    async fn with_session<T>(
        &self,
        account: &Account,
        work: impl AsyncFnOnce(&Session) -> Result<T, jmap::Error>,
    ) -> Result<T, MailError> {
        let mut state = self.state.lock().await;
        let now = Instant::now();
        state.failures.retain(|_, failures| failures.active(now));
        let origin = account.base_url.origin().ascii_serialization();
        if let Some(left) = state.failures.get(&origin).and_then(|f| f.locked(now)) {
            return Err(MailError::Locked(left));
        }
        let key = (
            account.base_url.clone(),
            account.auth.clone(),
            account.identity_id.clone(),
        );
        let cached = state.session.take();
        let result = async {
            // Only after a success and only for the same account.
            let session = match cached {
                Some(session) if session.key == key && session.opened.elapsed() < SESSION_TTL => {
                    session
                }
                _ => self.open(account, key).await?,
            };
            let value = work(&session).await?;
            Ok((value, session))
        }
        .await;
        match result {
            Ok((value, session)) => {
                // The credentials are right (again): earlier errors no longer
                // count.
                state.failures.remove(&origin);
                state.session = Some(session);
                Ok(value)
            }
            Err(error) => {
                if error == jmap::Error::AuthFailed {
                    state
                        .failures
                        .entry(origin)
                        .or_default()
                        .failed(Instant::now());
                }
                Err(MailError::Jmap(error))
            }
        }
    }

    async fn open(
        &self,
        account: &Account,
        key: (Url, jmap::Auth, Option<String>),
    ) -> Result<Session, jmap::Error> {
        let client =
            jmap::Client::connect(&self.http, &account.base_url, account.auth.clone()).await?;
        let outbox = client.outbox(account.identity_id.as_deref()).await?;
        Ok(Session {
            key,
            client,
            outbox,
            opened: Instant::now(),
        })
    }
}

/// Configured text without whitespace at the edges; empty counts as not set.
fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// `Date` of the mail (RFC 3339 in UTC, to the second).
fn sent_at(now: Timestamp) -> String {
    now.round(Unit::Second)
        .unwrap_or(now)
        .strftime("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_header_in_utc_seconds() {
        let now: Timestamp = "2026-10-24T13:57:12.6+02:00".parse().unwrap();
        assert_eq!(sent_at(now), "2026-10-24T11:57:13Z");
    }

    #[test]
    fn settings_are_trimmed() {
        assert_eq!(
            non_empty(Some(" support@example.com ")),
            Some("support@example.com")
        );
        assert_eq!(non_empty(Some("  ")), None);
        assert_eq!(non_empty(None), None);
    }

    #[test]
    fn failures_count_from_the_first_and_expire() {
        let t0 = Instant::now();
        let mut failures = Failures::default();
        assert!(!failures.active(t0));
        for _ in 0..4 {
            failures.failed(t0);
        }
        assert_eq!(failures.locked(t0), None);
        assert!(failures.active(t0 + FAILURE_WINDOW - Duration::from_secs(1)));
        assert!(!failures.active(t0 + FAILURE_WINDOW));
        // The window starts with the first error, not the last.
        failures.failed(t0 + FAILURE_WINDOW);
        assert_eq!(failures.locked(t0 + FAILURE_WINDOW), None);
        assert_eq!(failures.count, 1);

        let mut failures = Failures::default();
        for _ in 0..5 {
            failures.failed(t0);
        }
        assert_eq!(
            failures.locked(t0 + LOCK - Duration::from_secs(1)),
            Some(Duration::from_secs(1))
        );
        assert!(failures.active(t0 + LOCK - Duration::from_secs(1)));
        assert_eq!(failures.locked(t0 + LOCK), None);
        assert!(!failures.active(t0 + LOCK));
    }

    #[test]
    fn debug_shows_no_secrets_or_links() {
        let account = Account {
            base_url: Url::parse("https://mail.example.com").unwrap(),
            auth: jmap::Auth::Basic {
                username: "noreply@example.com".into(),
                password: "kT9v-Qm2x-Lp7w".into(),
            },
            identity_id: None,
            sender_name: None,
            reply_to: None,
            keep_sent: true,
        };
        assert!(!format!("{account:?}").contains("kT9v"));
        let mail = Mail {
            template: "reset",
            to: "max@example.net".into(),
            subject: "Reset your Roedy Mail password".into(),
            html: "<a href=\"https://app.example.com/password/reset/Zm4pT1\">".into(),
            text: "https://app.example.com/password/reset/Zm4pT1".into(),
        };
        let shown = format!("{mail:?}");
        assert!(shown.contains("reset") && !shown.contains("Zm4pT1"));
        assert_eq!(MailError::Locked(LOCK).reason(), "auth_locked");
        assert_eq!(
            MailError::Jmap(jmap::Error::AuthFailed).to_string(),
            "sign-in to the mail server rejected"
        );
    }
}
