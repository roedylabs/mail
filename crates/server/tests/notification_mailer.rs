//! Notifications by email via the job `notification_mailer` against the
//! test server: "instant" also without the app, digest at 07:00
//! local time, quiet hours, retry after a send failure, and without system
//! mail.

mod fake_stalwart;

use std::sync::Arc;

use fake_stalwart::{MAIL_PASSWORD, MAIL_USER, Options, Server};
use jiff::{SignedDuration, Timestamp, civil, tz::TimeZone};
use roedy_mail_server::{
    app::AppState,
    broker::crypto::SecretKey,
    config::Config,
    db::{
        self, Db,
        repo::{
            notification_deliveries::{self, Channel, Pending},
            notifications, servers as server_repo,
            users::{self, NewUser, Role},
        },
    },
    events::{self, Account, News, schedule::Schedule},
    jobs::notification_mailer::{self, MAX_ATTEMPTS, MAX_NOTICES, RETRY},
    mailer::system_mail::{self, SystemMail},
    settings::{self, Digest, Settings},
    web::static_files::WebAssets,
};
use serde_json::Value;
use url::Url;

struct Env {
    _tmp: tempfile::TempDir,
    state: AppState,
}

async fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let conn = db::open(tmp.path()).unwrap();
    let config = Config::default();
    let state = AppState::new(
        Db::from(conn),
        Arc::new(WebAssets::None),
        &config,
        Url::parse("https://app.example.com").unwrap(),
        SecretKey::random().unwrap(),
    )
    .unwrap();
    Env { _tmp: tmp, state }
}

/// With a sending account on the test server.
async fn env_with_mail() -> (Env, Server) {
    let env = env().await;
    let server = Server::start(Options::default()).await;
    let (secrets, url) = (env.state.secrets.clone(), server.url.clone());
    env.sql(move |conn| {
        server_repo::insert(
            conn,
            "s1",
            &server_repo::Fields {
                label: "Test",
                base_url: &url,
                domains: &[],
                client_id: Some("c"),
            },
            None,
        )?;
        let mail = SystemMail::new(&secrets, "s1", MAIL_USER, MAIL_PASSWORD, Some("i1".into()))?;
        system_mail::save(conn, &mail)?;
        Ok(())
    })
    .await;
    (env, server)
}

impl Env {
    async fn sql<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut rusqlite::Connection) -> anyhow::Result<T> + Send + 'static,
    ) -> T {
        db::call(&self.state.db, f).await.unwrap()
    }

    /// Creates "Max Mustermann" with the settings from `adjust`.
    async fn max(&self, adjust: impl FnOnce(&mut Settings)) -> String {
        let mut wanted = Settings::default();
        adjust(&mut wanted);
        self.sql(move |conn| {
            let id = users::insert(
                conn,
                &NewUser {
                    username: "max",
                    email: "max@example.com",
                    display_name: "Max Mustermann",
                    role: Role::User,
                    password_hash: "unused",
                },
            )?;
            settings::save(conn, &id, 0, &wanted)?;
            Ok(id)
        })
        .await
    }

    async fn pending(&self, user: &str) -> Vec<Pending> {
        let user = user.to_owned();
        self.sql(move |conn| {
            notification_deliveries::pending(conn, Channel::Mail, &user, "2999-01-01T00:00:00Z")
        })
        .await
    }

    async fn run(&self, now: Timestamp) {
        notification_mailer::run_at(&self.state, now).await.unwrap();
    }
}

fn text(mail: &Value) -> &str {
    mail["bodyValues"]["text"]["value"].as_str().unwrap()
}

fn created(pending: &Pending) -> Timestamp {
    pending.created_at.parse().unwrap()
}

fn berlin() -> TimeZone {
    TimeZone::get("Europe/Berlin").unwrap()
}

/// `time` on the day after `at` in Berlin.
fn next_day(at: Timestamp, time: civil::Time) -> Timestamp {
    at.to_zoned(berlin())
        .date()
        .tomorrow()
        .unwrap()
        .to_datetime(time)
        .to_zoned(berlin())
        .unwrap()
        .timestamp()
}

#[tokio::test]
async fn instant_mail_also_without_the_app() {
    let (env, server) = env_with_mail().await;
    let max = env
        .max(|s| {
            s.n_digest = Digest::Instant;
            s.n_mx.account.app = false;
        })
        .await;
    let id = max.clone();
    env.sql(move |conn| {
        let event = Account::Profile {
            name: true,
            username: false,
        };
        assert!(events::account(conn, &id, event)?, "reported by email");
        assert!(notifications::list(conn, &id)?.is_empty(), "not in the app");
        Ok(())
    })
    .await;
    assert_eq!(env.pending(&max).await.len(), 1);

    env.run(Timestamp::now()).await;
    let submitted = server.mail().submitted;
    assert_eq!(submitted.len(), 1, "{submitted:#?}");
    let mail = &submitted[0];
    assert_eq!(mail["subject"], "Profile changed");
    assert_eq!(mail["to"][0]["email"], "max@example.com");
    let body = text(mail);
    assert!(
        body.starts_with("Hi Max,\n\nProfile changed\nDisplay name changed.\nToday, "),
        "{body}"
    );
    assert!(
        body.contains("\n\nView:\nhttps://app.example.com/account/profile\n\n"),
        "{body}"
    );
    assert!(env.pending(&max).await.is_empty(), "delivered");

    env.run(Timestamp::now()).await;
    assert_eq!(server.mail().submitted.len(), 1, "only once");
}

#[tokio::test]
async fn daily_digest_at_seven_in_local_time() {
    let (env, server) = env_with_mail().await;
    let max = env.max(|s| s.n_mx.news.mail = true).await;
    let id = max.clone();
    env.sql(move |conn| {
        let event = Account::Profile {
            name: false,
            username: true,
        };
        events::account(conn, &id, event)?;
        events::news(conn, &id, News::Welcome)?;
        Ok(())
    })
    .await;
    let pending = env.pending(&max).await;
    assert_eq!(pending.len(), 2);
    let due = Schedule::of(&Settings::default()).due(created(&pending[0]));
    assert_eq!(
        due.to_zoned(berlin()).time(),
        civil::time(7, 0, 0, 0),
        "07:00 in Berlin"
    );

    env.run(due - SignedDuration::from_secs(1)).await;
    assert!(server.mail().submitted.is_empty(), "not due yet");
    env.run(due).await;
    let submitted = server.mail().submitted;
    assert_eq!(submitted.len(), 1, "{submitted:#?}");
    assert_eq!(submitted[0]["subject"], "Your Roedy Mail digest");
    let body = text(&submitted[0]);
    assert!(
        body.starts_with(
            "Hi Max,\n\nYou have 2 new notifications since your last digest.\n\n* Welcome ("
        ),
        "newest first: {body}"
    );
    assert!(
        body.contains(
            ")\n  Username changed.\n\nView all notifications:\nhttps://app.example.com\n\n"
        ),
        "{body}"
    );
    assert!(env.pending(&max).await.is_empty());
}

#[tokio::test]
async fn digest_shows_the_newest_and_counts_all() {
    let (env, server) = env_with_mail().await;
    let max = env.max(|_| {}).await;
    let id = max.clone();
    env.sql(move |conn| {
        for i in 0..=MAX_NOTICES {
            let event = Account::Profile {
                name: i % 2 == 0,
                username: true,
            };
            events::account(conn, &id, event)?;
        }
        Ok(())
    })
    .await;
    let pending = env.pending(&max).await;
    let due = Schedule::of(&Settings::default()).due(created(&pending[0]));
    env.run(due).await;
    let submitted = server.mail().submitted;
    assert_eq!(submitted.len(), 1, "{submitted:#?}");
    let body = text(&submitted[0]);
    let total = MAX_NOTICES + 1;
    assert!(
        body.contains(&format!("You have {total} new notifications since")),
        "{body}"
    );
    assert_eq!(body.matches("\n* Profile changed (").count(), MAX_NOTICES);
    // Newest first: 50 to 1 are shown, the oldest (0, even: both names) is
    // missing and appears as the remainder below; the last one shown (1)
    // only changed the username.
    assert_eq!(body.matches("Display name and username").count(), 25);
    assert!(
        body.contains(
            ")\n  Username changed.\n\n… and 1 more notification\n\nView all notifications:"
        ),
        "{body}"
    );
    assert!(env.pending(&max).await.is_empty(), "all delivered");
}

#[tokio::test]
async fn quiet_hours_hold_instant_mails_until_their_end() {
    let (env, server) = env_with_mail().await;
    let max = env
        .max(|s| {
            s.n_digest = Digest::Instant;
            s.n_quiet = true;
        })
        .await;
    let id = max.clone();
    env.sql(move |conn| {
        let event = Account::Profile {
            name: true,
            username: true,
        };
        events::account(conn, &id, event)?;
        events::account(conn, &id, event)?;
        Ok(())
    })
    .await;
    let created = created(&env.pending(&max).await[0]);

    // Quiet hours from 22:00 to 07:00 (default).
    env.run(next_day(created, civil::time(0, 30, 0, 0))).await;
    assert!(server.mail().submitted.is_empty(), "in the quiet hours");
    env.run(next_day(created, civil::time(7, 0, 0, 0))).await;
    let submitted = server.mail().submitted;
    assert_eq!(
        submitted.len(),
        2,
        "individually at their end: {submitted:#?}"
    );
    assert!(
        submitted
            .iter()
            .all(|mail| mail["subject"] == "Profile changed")
    );
}

#[tokio::test]
async fn failed_mail_is_tried_again_later() {
    let (env, server) = env_with_mail().await;
    let max = env.max(|s| s.n_digest = Digest::Instant).await;
    let id = max.clone();
    env.sql(move |conn| {
        events::news(conn, &id, News::Welcome)?;
        let event = Account::Profile {
            name: true,
            username: false,
        };
        events::account(conn, &id, event)?;
        Ok(())
    })
    .await;
    let now = Timestamp::now();
    server.reject_mail_to(Some("max@example.com"));
    env.run(now).await;
    assert_eq!(
        server.mail().rejected.len(),
        1,
        "news by default without email"
    );
    assert_eq!(env.pending(&max).await[0].attempts, 1);

    env.run(now + SignedDuration::from_mins(10)).await;
    assert_eq!(server.mail().rejected.len(), 1, "waits");
    env.run(now + RETRY).await;
    assert_eq!(server.mail().rejected.len(), 2);

    server.reject_mail_to(None);
    env.run(now + RETRY * 2).await;
    assert_eq!(server.mail().submitted.len(), 1);
    assert!(env.pending(&max).await.is_empty());

    // After the last attempt the entry is dropped.
    let id = max.clone();
    env.sql(move |conn| {
        let event = Account::Profile {
            name: true,
            username: false,
        };
        events::account(conn, &id, event)?;
        Ok(())
    })
    .await;
    server.reject_mail_to(Some("max@example.com"));
    let mut at = Timestamp::now();
    for _ in 0..MAX_ATTEMPTS {
        env.run(at).await;
        at += RETRY;
    }
    assert!(env.pending(&max).await.is_empty(), "discarded");
    assert_eq!(server.mail().rejected.len(), 2 + 3);
}

#[tokio::test]
async fn without_system_mail_due_entries_are_dropped() {
    let env = env().await;
    let max = env.max(|_| {}).await;
    let id = max.clone();
    env.sql(move |conn| {
        let event = Account::Profile {
            name: true,
            username: false,
        };
        events::account(conn, &id, event)?;
        Ok(())
    })
    .await;
    let created = created(&env.pending(&max).await[0]);
    env.run(created).await;
    assert_eq!(env.pending(&max).await.len(), 1, "not due yet");
    env.run(next_day(created, civil::time(7, 0, 0, 0))).await;
    assert!(
        env.pending(&max).await.is_empty(),
        "dropped like security notices"
    );
}
