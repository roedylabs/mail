//! Notifications by email:
//! Every minute the job looks for recipients with queued entries
//! (`notification_deliveries`, from `events::notify`) and sends according to
//! their plan ([`Schedule`]): "Instant" one mail per entry, otherwise the
//! digest daily or on Mondays at 07:00 in their time zone, never during
//! quiet hours. "Instant" mails held back arrive at the end of those,
//! one by one, oldest first, as "Each notification as a separate email"
//! promises.
//!
//! Channels, role and status apply at sending time: whoever has since
//! turned off email for the topic, is locked, or may no longer see team and
//! system no longer gets the entries. Title, text and
//! target come from `events::texts::render` in the recipient's language.
//! Without system mail or a public address, due entries are
//! dropped (log) like security notices; after a sending error the
//! next attempt follows after [`RETRY`], after [`MAX_ATTEMPTS`] the entry
//! is dropped. A waiting entry does not hold up newer ones; "Instant" mails
//! may then arrive in a different order.

use std::time::Duration;

use jiff::{SignedDuration, Timestamp};

use super::Job;
use crate::{
    app::AppState,
    db::{
        self,
        repo::{
            notification_deliveries::{self as deliveries, Channel, Owner, Pending},
            users::Role,
        },
    },
    events::{self, Channels, Topic, schedule::Schedule, texts},
    mailer::{
        Mail,
        delivery::{Delivery, Unavailable},
        format::Format,
        templates::{Context, Digest, DigestInstant, Notice},
    },
    settings::{self, Digest as Rhythm},
};

/// Maximum number of entries in a digest; the sentence above names all of
/// them, the rest is listed below.
pub const MAX_NOTICES: usize = 50;
/// Attempts per entry.
pub const MAX_ATTEMPTS: u32 = 3;
/// Delay after a sending error.
pub const RETRY: SignedDuration = SignedDuration::from_mins(30);

pub fn job() -> Job<AppState> {
    Job {
        name: "notification_mailer",
        first: Duration::from_secs(60),
        every: Duration::from_secs(60),
        run: |state| Box::pin(run(state)),
        wake: None,
    }
}

async fn run(state: AppState) -> anyhow::Result<()> {
    run_at(&state, Timestamp::now()).await
}

/// One run with `now` as the point in time (tests call it with their own).
pub async fn run_at(state: &AppState, now: Timestamp) -> anyhow::Result<()> {
    let at = now.to_string();
    let owners = db::call(&state.db, move |conn| {
        Ok(deliveries::owners(conn, Channel::Mail, &at)?)
    })
    .await?;
    let mut run = Run {
        state,
        now,
        app: state.brand().app,
        delivery: None,
        dropped: 0,
    };
    for owner in owners {
        let id = owner.profile.id.clone();
        if let Err(error) = run.owner(owner).await {
            tracing::warn!(user = %id, "notifications by email not sent: {error:#}");
        }
    }
    match run.delivery {
        Some(Err(Unavailable::NoSystemMail)) if run.dropped > 0 => tracing::debug!(
            dropped = run.dropped,
            "no system mail configured, notifications by email are dropped"
        ),
        Some(Err(Unavailable::NoPublicUrl)) if run.dropped > 0 => tracing::warn!(
            dropped = run.dropped,
            "no public address, notifications by email are dropped"
        ),
        _ => {}
    }
    Ok(())
}

/// What is to be sent to a recipient now.
#[derive(Debug, PartialEq)]
enum Plan {
    Wait,
    /// One mail per entry, oldest first.
    Instant(Vec<Pending>),
    /// One digest with all entries.
    Digest(Vec<Pending>),
}

/// Whether an entry is still delivered at sending time.
fn wanted(pending: &Pending, channels: &Channels, admin: bool, active: bool) -> bool {
    let Some(topic) = Topic::parse(&pending.topic) else {
        return false;
    };
    active
        && topic != Topic::Security
        && channels.wants(topic, events::Channel::Mail)
        && (admin || !matches!(topic, Topic::Team | Topic::System))
}

/// Time of the event; `None` if it cannot be read.
fn created(pending: &Pending) -> Option<Timestamp> {
    pending.created_at.parse().ok()
}

/// For the schedule an unreadable time counts as long past:
/// the entry goes out immediately instead of pushing every digest of the
/// recipient to tomorrow as "just now".
fn scheduled(pending: &Pending) -> Timestamp {
    created(pending).unwrap_or(Timestamp::UNIX_EPOCH)
}

/// Plan from the pending entries (oldest first): if the oldest is
/// due and no quiet hours apply, everything up to `now` goes out.
fn plan(schedule: &Schedule, mut pending: Vec<Pending>, now: Timestamp) -> Plan {
    pending.retain(|p| scheduled(p) <= now);
    let Some(oldest) = pending.first() else {
        return Plan::Wait;
    };
    if !schedule.ready(scheduled(oldest), now) {
        return Plan::Wait;
    }
    match schedule.digest {
        Rhythm::Instant => Plan::Instant(pending),
        Rhythm::Daily | Rhythm::Weekly => Plan::Digest(pending),
    }
}

fn ids(pending: &[Pending]) -> Vec<String> {
    pending.iter().map(|p| p.id.clone()).collect()
}

/// State of a run; the sending account is loaded by the first due
/// recipient.
struct Run<'a> {
    state: &'a AppState,
    now: Timestamp,
    app: String,
    delivery: Option<Result<Delivery, Unavailable>>,
    dropped: usize,
}

impl Run<'_> {
    async fn owner(&mut self, owner: Owner) -> anyhow::Result<()> {
        let (user, now) = (owner.profile.id.clone(), self.now);
        let (admin, active) = (owner.profile.role == Role::Admin, owner.active);
        let at = now.to_string();
        let (stored, pending) = db::call(&self.state.db, move |conn| {
            let stored = settings::load(conn, &user)?;
            let channels = Channels::from(&stored.settings);
            let (keep, gone): (Vec<_>, Vec<_>) =
                deliveries::pending(conn, Channel::Mail, &user, &at)?
                    .into_iter()
                    .partition(|p| wanted(p, &channels, admin, active));
            deliveries::delete(conn, &ids(&gone))?;
            Ok((stored, keep))
        })
        .await?;
        let plan = plan(&Schedule::of(&stored.settings), pending, now);
        let due = match &plan {
            Plan::Wait => return Ok(()),
            Plan::Instant(due) | Plan::Digest(due) => due,
        };
        if self.unavailable().await? {
            self.dropped += due.len();
            return self.done(due).await;
        }
        let format = stored.format();
        let mail = Recipient {
            owner: &owner,
            format: &format,
        };
        match plan {
            Plan::Instant(pending) => {
                for one in pending {
                    let sent = self.send_instant(&mail, &one).await;
                    self.settle(sent, &[one]).await?;
                }
            }
            Plan::Digest(pending) => {
                let sent = self.send_digest(&mail, &pending).await;
                self.settle(sent, &pending).await?;
            }
            Plan::Wait => {}
        }
        Ok(())
    }

    /// Loads the sending account and public address on first use; `true`
    /// if either is missing.
    async fn unavailable(&mut self) -> anyhow::Result<bool> {
        if self.delivery.is_none() {
            self.delivery = Some(Delivery::prepare(self.state).await?);
        }
        Ok(matches!(self.delivery, Some(Err(_))))
    }

    /// "Instant": one mail for the entry `one`, button to its target.
    async fn send_instant(&self, to: &Recipient<'_>, one: &Pending) -> bool {
        let (notice, target) = self.notice(to, one);
        let path = target.map(|target| target.path());
        let (email, name) = (&to.owner.profile.email, &to.owner.profile.display_name);
        self.deliver(to, |ctx| {
            DigestInstant {
                to: email,
                name,
                notice: &notice,
                path: path.as_deref(),
            }
            .render(ctx)
        })
        .await
    }

    /// Digest: the newest [`MAX_NOTICES`] entries, the sentence
    /// names all of them.
    async fn send_digest(&self, to: &Recipient<'_>, pending: &[Pending]) -> bool {
        let notices: Vec<Notice> = pending
            .iter()
            .rev()
            .take(MAX_NOTICES)
            .map(|p| self.notice(to, p).0)
            .collect();
        let (email, name) = (&to.owner.profile.email, &to.owner.profile.display_name);
        self.deliver(to, |ctx| {
            Digest {
                to: email,
                name,
                notices: &notices,
                total: pending.len(),
            }
            .render(ctx)
        })
        .await
    }

    /// Title, text and target of an entry in the recipient's language.
    fn notice(&self, to: &Recipient<'_>, p: &Pending) -> (Notice, Option<texts::Target>) {
        let cx = texts::Context {
            lang: to.format.lang(),
            app: &self.app,
        };
        let shown = texts::render(&p.topic, &p.kind, &p.params, &cx);
        let notice = Notice {
            title: shown.title,
            text: shown.text,
            at: created(p).unwrap_or(self.now),
        };
        (notice, shown.target)
    }

    /// Renders with `render` and sends; `false` on an error (written to the
    /// log).
    async fn deliver(
        &self,
        to: &Recipient<'_>,
        render: impl FnOnce(&Context<'_>) -> anyhow::Result<Mail>,
    ) -> bool {
        let Some(Ok(delivery)) = &self.delivery else {
            return false;
        };
        match delivery
            .send_at(self.state, to.format, self.now, render)
            .await
        {
            Ok(Ok(())) => true,
            // The mailer writes the cause to the log itself.
            Ok(Err(_)) => false,
            Err(error) => {
                tracing::warn!(
                    user = %to.owner.profile.id,
                    "notification not rendered: {error:#}"
                );
                false
            }
        }
    }

    /// After sending: remove delivered ones, otherwise retry later.
    async fn settle(&self, sent: bool, pending: &[Pending]) -> anyhow::Result<()> {
        if sent {
            return self.done(pending).await;
        }
        let ids = ids(pending);
        let retry = self.now.checked_add(RETRY).unwrap_or(self.now).to_string();
        let given_up = db::call(&self.state.db, move |conn| {
            deliveries::failed(conn, &ids, &retry, MAX_ATTEMPTS)
        })
        .await?;
        if given_up > 0 {
            tracing::warn!(
                given_up,
                "notifications by email dropped after {MAX_ATTEMPTS} attempts"
            );
        }
        Ok(())
    }

    async fn done(&self, pending: &[Pending]) -> anyhow::Result<()> {
        let ids = ids(pending);
        db::call(&self.state.db, move |conn| deliveries::delete(conn, &ids)).await?;
        Ok(())
    }
}

/// Recipient with their time zone, formats and language.
struct Recipient<'a> {
    owner: &'a Owner,
    format: &'a Format,
}

#[cfg(test)]
mod tests {
    use jiff::tz::TimeZone;
    use serde_json::json;

    use super::*;
    use crate::{events::schedule::Quiet, settings::Settings};

    fn pending(id: &str, topic: &str, created_at: &str) -> Pending {
        Pending {
            id: id.into(),
            topic: topic.into(),
            kind: format!("{topic}.x"),
            params: json!({}),
            notification_id: None,
            created_at: created_at.into(),
            attempts: 0,
        }
    }

    fn at(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    #[test]
    fn wanted_follows_channels_role_and_status() {
        let channels = Channels::from(&Settings::default());
        let account = pending("1", "account", "2026-11-04T10:00:00Z");
        let team = pending("2", "team", "2026-11-04T10:00:00Z");
        let security = pending("3", "security", "2026-11-04T10:00:00Z");
        let unknown = pending("4", "unknown", "2026-11-04T10:00:00Z");
        assert!(wanted(&account, &channels, false, true));
        assert!(!wanted(&account, &channels, false, false), "locked");
        assert!(!wanted(&security, &channels, true, true), "own mails");
        assert!(!wanted(&unknown, &channels, true, true));
        assert!(
            !wanted(&team, &channels, true, true),
            "team in NMX0 without email"
        );
        let mut settings = Settings::default();
        settings.n_mx.team.mail = true;
        let channels = Channels::from(&settings);
        assert!(wanted(&team, &channels, true, true));
        assert!(!wanted(&team, &channels, false, true), "admins only");
        settings.n_ch.mail = false;
        assert!(
            !wanted(&account, &Channels::from(&settings), false, true),
            "email off"
        );
    }

    #[test]
    fn plan_waits_for_the_digest_and_the_quiet_hours() {
        let berlin = TimeZone::get("Europe/Berlin").unwrap();
        let quiet = Quiet::new("22:00".parse().unwrap(), "07:00".parse().unwrap());
        let a = pending("a", "account", "2026-11-04T21:30:00Z"); // 22:30 local time
        let b = pending("b", "news", "2026-11-04T22:00:00Z");
        let both = || vec![a.clone(), b.clone()];

        let instant = Schedule::new(Rhythm::Instant, quiet, berlin.clone());
        assert_eq!(
            plan(&instant, both(), at("2026-11-05T05:59:00Z")),
            Plan::Wait
        );
        assert_eq!(
            plan(&instant, both(), at("2026-11-05T06:00:00Z")),
            Plan::Instant(both()),
            "one by one at the end of the quiet hours"
        );
        assert_eq!(
            plan(&instant, both(), at("2026-11-04T21:45:00Z")),
            Plan::Wait,
            "during the quiet hours, b not there yet"
        );

        let daily = Schedule::new(Rhythm::Daily, None, berlin);
        assert_eq!(plan(&daily, both(), at("2026-11-05T05:59:00Z")), Plan::Wait);
        assert_eq!(
            plan(&daily, both(), at("2026-11-05T06:00:00Z")),
            Plan::Digest(both())
        );
        assert_eq!(
            plan(&daily, Vec::new(), at("2026-11-06T06:00:00Z")),
            Plan::Wait
        );

        // An unreadable time does not push the digest to
        // tomorrow but goes out immediately.
        let broken = pending("c", "account", "broken");
        let now = at("2026-11-05T12:00:00Z");
        assert_eq!(
            plan(&daily, vec![broken.clone()], now),
            Plan::Digest(vec![broken])
        );
    }
}
