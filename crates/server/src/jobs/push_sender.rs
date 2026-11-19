//! Web Push: the job sends what
//! `events` queued with `channel = 'push'` in `notification_deliveries`
//! to all signed-in browsers of the recipient. It runs every minute and
//! also as soon as an event wakes it (`push::wake`), so usually
//! right after the event.
//!
//! Security goes out immediately, even during quiet hours; quiet hours hold
//! everything else back until they end ([`Schedule::open`]).
//! Channels, role and status apply at sending time, as for email.
//! Title, text and target come from `events::texts::render` in the
//! recipient's language, `tag` is the entry in the bell.
//!
//! Subscriptions the push service no longer knows (404, 410) are removed
//! by the job, as are those with an expired `expirationTime`. If no
//! browser accepted the message and an error was temporary (429,
//! 5xx, network), a new attempt follows after [`RETRY`], at most
//! [`MAX_ATTEMPTS`]; if one accepted it, it counts as delivered.

use std::time::Duration;

use jiff::{SignedDuration, Timestamp};

use super::Job;
use crate::{
    app::AppState,
    db::{
        self,
        repo::{
            notification_deliveries::{self as deliveries, Channel, Owner, Pending},
            push_subscriptions,
            users::Role,
        },
    },
    events::{self, Channels, Topic, schedule::Schedule, texts},
    push::{self, Data, Message, Outcome, START_PATH, Sender, TTL, Urgency},
    settings::{self, Language},
};

/// Attempts per message.
pub const MAX_ATTEMPTS: u32 = 3;
/// Delay after a temporary error.
pub const RETRY: SignedDuration = SignedDuration::from_mins(5);

pub fn job() -> Job<AppState> {
    Job {
        name: "push_sender",
        first: Duration::from_secs(60),
        every: Duration::from_secs(60),
        run: |state| Box::pin(run(state)),
        wake: Some(&push::WAKE),
    }
}

async fn run(state: AppState) -> anyhow::Result<()> {
    run_at(&state, Timestamp::now()).await
}

/// One run with `now` as the point in time (tests call it with their own).
pub async fn run_at(state: &AppState, now: Timestamp) -> anyhow::Result<()> {
    let at = now.to_string();
    let owners = db::call(&state.db, move |conn| {
        let expired = push_subscriptions::delete_expired(conn, &at)?;
        if expired > 0 {
            tracing::debug!(expired, "expired push subscriptions removed");
        }
        Ok(deliveries::owners(conn, Channel::Push, &at)?)
    })
    .await?;
    if owners.is_empty() {
        return Ok(());
    }
    let run = Run {
        state,
        now,
        sender: Sender::of(state).await?,
        app: state.brand().app,
    };
    for owner in owners {
        let id = owner.profile.id.clone();
        if let Err(error) = run.owner(owner).await {
            tracing::warn!(user = %id, "push messages not sent: {error:#}");
        }
    }
    Ok(())
}

/// Whether an entry is still delivered at sending time.
fn wanted(pending: &Pending, channels: &Channels, admin: bool, active: bool) -> bool {
    let Some(topic) = Topic::parse(&pending.topic) else {
        return false;
    };
    active
        && channels.wants(topic, events::Channel::Push)
        && (admin || !matches!(topic, Topic::Team | Topic::System))
}

fn is_security(pending: &Pending) -> bool {
    pending.topic == Topic::Security.as_str()
}

/// What may go out at `now`: security always, everything else only outside
/// quiet hours.
fn due(schedule: &Schedule, pending: Vec<Pending>, now: Timestamp) -> Vec<Pending> {
    let open = schedule.open(now);
    pending
        .into_iter()
        .filter(|p| open || is_security(p))
        .collect()
}

struct Run<'a> {
    state: &'a AppState,
    now: Timestamp,
    sender: Sender,
    app: String,
}

impl Run<'_> {
    async fn owner(&self, owner: Owner) -> anyhow::Result<()> {
        let (user, at) = (owner.profile.id.clone(), self.now.to_string());
        let (admin, active) = (owner.profile.role == Role::Admin, owner.active);
        let (stored, mut subscriptions, pending) = db::call(&self.state.db, move |conn| {
            let stored = settings::load(conn, &user)?;
            let channels = Channels::from(&stored.settings);
            let subscriptions = push_subscriptions::of_user(conn, &user)?;
            // Without a browser there is nobody to deliver them to later.
            let (keep, gone): (Vec<_>, Vec<_>) =
                deliveries::pending(conn, Channel::Push, &user, &at)?
                    .into_iter()
                    .partition(|p| {
                        !subscriptions.is_empty() && wanted(p, &channels, admin, active)
                    });
            deliveries::delete(conn, &ids(&gone))?;
            Ok((stored, subscriptions, keep))
        })
        .await?;
        for one in due(&Schedule::of(&stored.settings), pending, self.now) {
            if subscriptions.is_empty() {
                self.settle(true, one).await?;
                continue;
            }
            let message = self.message(stored.lang, &one);
            let urgency = if is_security(&one) {
                Urgency::High
            } else {
                Urgency::Normal
            };
            let outcomes = self
                .sender
                .send_all(&subscriptions, &message, urgency, TTL)
                .await;
            let delivered = outcomes.contains(&Outcome::Delivered);
            let retry = outcomes.contains(&Outcome::Retry);
            let mut gone = Vec::new();
            let mut outcome = outcomes.iter();
            subscriptions.retain(|s| {
                let alive = outcome.next() != Some(&Outcome::Gone);
                if !alive {
                    gone.push(s.id.clone());
                }
                alive
            });
            if !gone.is_empty() {
                db::call(&self.state.db, move |conn| {
                    push_subscriptions::delete_gone(conn, &gone)
                })
                .await?;
            }
            self.settle(delivered || !retry, one).await?;
        }
        Ok(())
    }

    /// Title, text and target in the recipient's language.
    fn message(&self, lang: Language, pending: &Pending) -> Message {
        let cx = texts::Context {
            lang,
            app: &self.app,
        };
        let shown = texts::render(&pending.topic, &pending.kind, &pending.params, &cx);
        Message {
            title: shown.title,
            body: shown.text,
            icon: self.sender.icon.clone(),
            tag: pending
                .notification_id
                .clone()
                .unwrap_or_else(|| pending.id.clone()),
            data: Data {
                url: shown
                    .target
                    .map_or_else(|| START_PATH.to_owned(), |target| target.path()),
            },
        }
    }

    /// Remove when done, otherwise retry later.
    async fn settle(&self, done: bool, pending: Pending) -> anyhow::Result<()> {
        let ids = vec![pending.id];
        if done {
            db::call(&self.state.db, move |conn| deliveries::delete(conn, &ids)).await?;
            return Ok(());
        }
        let retry = self.now.checked_add(RETRY).unwrap_or(self.now).to_string();
        let given_up = db::call(&self.state.db, move |conn| {
            deliveries::failed(conn, &ids, &retry, MAX_ATTEMPTS)
        })
        .await?;
        if given_up > 0 {
            tracing::warn!("push message dropped after {MAX_ATTEMPTS} attempts");
        }
        Ok(())
    }
}

fn ids(pending: &[Pending]) -> Vec<String> {
    pending.iter().map(|p| p.id.clone()).collect()
}

#[cfg(test)]
mod tests {
    use jiff::{civil, tz::TimeZone};
    use serde_json::json;

    use super::*;
    use crate::{
        events::schedule::Quiet,
        settings::{Digest, Settings},
    };

    fn pending(id: &str, topic: &str) -> Pending {
        Pending {
            id: id.into(),
            topic: topic.into(),
            kind: format!("{topic}.x"),
            params: json!({}),
            notification_id: None,
            created_at: "2026-11-04T10:00:00Z".into(),
            attempts: 0,
        }
    }

    #[test]
    fn wanted_follows_push_channels_role_and_status() {
        let mut settings = Settings::default();
        let channels = Channels::from(&settings);
        // Default: push globally off.
        assert!(!wanted(&pending("1", "security"), &channels, true, true));
        settings.n_ch.push = true;
        settings.n_mx.team.push = true;
        let channels = Channels::from(&settings);
        assert!(wanted(&pending("1", "security"), &channels, false, true));
        assert!(!wanted(&pending("2", "account"), &channels, false, true));
        assert!(wanted(&pending("3", "team"), &channels, true, true));
        assert!(!wanted(&pending("3", "team"), &channels, false, true));
        assert!(!wanted(&pending("1", "security"), &channels, false, false));
        assert!(!wanted(&pending("4", "calendar"), &channels, true, true));
    }

    #[test]
    fn quiet_hours_hold_back_all_but_security() {
        let quiet = Quiet::new(civil::time(22, 0, 0, 0), civil::time(7, 0, 0, 0));
        let schedule = Schedule::new(
            Digest::Instant,
            quiet,
            TimeZone::get("Europe/Berlin").unwrap(),
        );
        let night: Timestamp = "2026-11-04T23:30:00Z".parse().unwrap();
        let morning: Timestamp = "2026-11-05T06:00:00Z".parse().unwrap();
        let list = || vec![pending("1", "account"), pending("2", "security")];
        let ids = |list: Vec<Pending>| list.into_iter().map(|p| p.id).collect::<Vec<_>>();
        assert_eq!(ids(due(&schedule, list(), night)), ["2"]);
        assert_eq!(ids(due(&schedule, list(), morning)), ["1", "2"]);
    }
}
