//! Sending system mails via JMAP (`crates/jmap`, `mailer`) against the test
//! server.

mod fake_stalwart;

use std::time::Duration;

use axum::{http::StatusCode, response::IntoResponse as _};
use fake_stalwart::{MAIL_PASSWORD, MAIL_TOKEN, MAIL_USER, Options, Server, unreachable_url};
use http_body_util::BodyExt as _;
use jiff::Timestamp;
use roedy_jmap as jmap;
use roedy_mail_server::{
    api::ApiError,
    broker,
    db::repo::users::Role,
    mailer::{
        Account, Mail, MailError, Mailer,
        format::Format,
        templates::{Brand, Context, Invite, Theme},
    },
};
use serde_json::{Value, json};
use url::Url;

fn account(server: &Server) -> Account {
    Account {
        base_url: Url::parse(&server.url).unwrap(),
        auth: jmap::Auth::Basic {
            username: MAIL_USER.into(),
            password: MAIL_PASSWORD.into(),
        },
        identity_id: Some("i1".into()),
        sender_name: None,
        reply_to: None,
        keep_sent: true,
    }
}

fn invite() -> Mail {
    let brand = Brand::default();
    let format = Format::default();
    let public_url = Url::parse("https://app.example.com").unwrap();
    let ctx = Context {
        brand: &brand,
        theme: Theme::Light,
        format: &format,
        public_url: &public_url,
        now: Timestamp::now(),
        inline_logo: false,
    };
    Invite {
        to: "jonas.schulz@example.com",
        name: Some("Jonas"),
        inviter: Some("Max Mustermann"),
        role: Role::User,
        token: "k7Qe2xR9",
        expires_at: "2026-10-30T14:57:00Z".parse().unwrap(),
    }
    .render(&ctx)
    .unwrap()
}

/// The invitation as a mail without a link token: only such mails are filed
/// in "Sent" by the mailer.
fn notice() -> Mail {
    Mail {
        template: "security_login",
        ..invite()
    }
}

fn mailer() -> Mailer {
    Mailer::new(broker::http_client().unwrap())
}

async fn send(mailer: &Mailer, account: &Account) -> Result<(), MailError> {
    mailer.send(account, &notice()).await
}

#[tokio::test]
async fn sends_and_files_in_sent() {
    let server = Server::start(Options::default()).await;
    let mail = notice();
    mailer().send(&account(&server), &mail).await.unwrap();

    let state = server.mail();
    assert_eq!(state.failed_logins, 0);
    // Identity and mailboxes, then draft and submission.
    assert_eq!(state.requests(), 2);
    let [submitted] = state.submitted.as_slice() else {
        panic!("one mail expected: {:?}", state.submitted);
    };
    assert_eq!(
        submitted["from"],
        json!([{ "name": "Example Ltd", "email": MAIL_USER }])
    );
    assert_eq!(
        submitted["to"],
        json!([{ "name": null, "email": "jonas.schulz@example.com" }])
    );
    assert_eq!(submitted["subject"], "Invitation to Roedy Mail");
    assert_eq!(submitted["bodyValues"]["text"]["value"], mail.text.as_str());
    assert_eq!(submitted["bodyValues"]["html"]["value"], mail.html.as_str());
    assert_eq!(submitted["header:Auto-Submitted:asText"], "auto-generated");
    assert!(submitted.get("replyTo").is_none());
    let sent_at = submitted["sentAt"].as_str().unwrap();
    assert!(sent_at.parse::<Timestamp>().is_ok() && sent_at.ends_with('Z'));

    // After sending the mail is in "Sent", without `$draft`.
    let emails: Vec<_> = state.emails.values().collect();
    let [stored] = emails.as_slice() else {
        panic!("one mail in the account expected");
    };
    assert_eq!(stored["mailboxIds"], json!({ "sent": true }));
    assert_eq!(stored["keywords"], json!({ "$seen": true }));
}

/// Invitation, reset and confirmation never stay in "Sent": whoever reads
/// the mailbox of the sending account would otherwise get the link of the
/// previous recipient.
#[tokio::test]
async fn mails_with_a_token_keep_no_copy() {
    let server = Server::start(Options::default()).await;
    let mailer = mailer();
    for template in ["invite", "reset", "email_confirm"] {
        let mail = Mail {
            template,
            ..invite()
        };
        mailer.send(&account(&server), &mail).await.unwrap();
    }
    let state = server.mail();
    assert_eq!(state.submitted.len(), 3);
    assert!(state.emails.is_empty(), "{:?}", state.emails);
}

#[tokio::test]
async fn sender_name_reply_to_and_no_copy() {
    let server = Server::start(Options::default()).await;
    let account = Account {
        identity_id: Some("i2".into()),
        // Whitespace from the settings does not go to the server.
        sender_name: Some(" Roedy Mail ".into()),
        reply_to: Some(" support@example.com ".into()),
        keep_sent: false,
        ..account(&server)
    };
    send(&mailer(), &account).await.unwrap();
    let state = server.mail();
    let [submitted] = state.submitted.as_slice() else {
        panic!("one mail expected");
    };
    assert_eq!(
        submitted["from"],
        json!([{ "name": "Roedy Mail", "email": "support@example.com" }])
    );
    assert_eq!(
        submitted["replyTo"],
        json!([{ "name": null, "email": "support@example.com" }])
    );
    // Without a copy in "Sent" the draft is deleted after sending.
    assert!(state.emails.is_empty());
}

#[tokio::test]
async fn token_and_first_identity() {
    let server = Server::start(Options::default()).await;
    let account = Account {
        auth: jmap::Auth::Bearer(MAIL_TOKEN.into()),
        identity_id: None,
        ..account(&server)
    };
    send(&mailer(), &account).await.unwrap();
    assert_eq!(server.mail().submitted[0]["from"][0]["email"], MAIL_USER);
}

#[tokio::test]
async fn lists_identities() {
    let server = Server::start(Options::default()).await;
    let client = jmap::Client::connect(
        &broker::http_client().unwrap(),
        &Url::parse(&server.url).unwrap(),
        jmap::Auth::Bearer(MAIL_TOKEN.into()),
    )
    .await
    .unwrap();
    assert_eq!(client.session().username, MAIL_USER);
    let identities: Vec<_> = client
        .identities()
        .await
        .unwrap()
        .into_iter()
        .map(|i| (i.id, i.name, i.email))
        .collect();
    assert_eq!(
        identities,
        [
            ("i1".into(), "Example Ltd".into(), MAIL_USER.into()),
            (
                "i2".into(),
                "Example Support".into(),
                "support@example.com".into()
            ),
        ]
    );
}

#[tokio::test]
async fn wrong_password_is_mail_failed_and_locks_after_five() {
    let server = Server::start(Options::default()).await;
    let account = Account {
        auth: jmap::Auth::Basic {
            username: MAIL_USER.into(),
            password: "incorrect".into(),
        },
        ..account(&server)
    };
    let mailer = mailer();
    for _ in 0..5 {
        let error = send(&mailer, &account).await.unwrap_err();
        assert_eq!(error, MailError::Jmap(jmap::Error::AuthFailed));
    }
    assert_eq!(server.mail().failed_logins, 5);
    // After that the backend no longer asks the server (Fail2Ban).
    let locked = send(&mailer, &account).await;
    assert!(
        matches!(locked, Err(MailError::Locked(left)) if left > Duration::from_secs(14 * 60)),
        "{locked:?}"
    );
    assert_eq!(server.mail().failed_logins, 5);

    // The lock only applies to this server (Stalwart counts per server):
    // another one is still asked.
    let other = Server::start(Options::default()).await;
    let elsewhere = Account {
        base_url: Url::parse(&other.url).unwrap(),
        ..account.clone()
    };
    assert_eq!(
        send(&mailer, &elsewhere).await,
        Err(MailError::Jmap(jmap::Error::AuthFailed))
    );
    assert_eq!(other.mail().failed_logins, 1);

    let response = ApiError::from(MailError::Locked(Duration::from_secs(60))).into_response();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({ "error": "mail_failed" })
    );
}

#[tokio::test]
async fn other_errors_do_not_lock() {
    let account = Account {
        base_url: Url::parse(&unreachable_url()).unwrap(),
        ..account(&Server::start(Options::default()).await)
    };
    let mailer = mailer();
    for _ in 0..6 {
        assert_eq!(
            send(&mailer, &account).await,
            Err(MailError::Jmap(jmap::Error::Unreachable))
        );
    }
}

#[tokio::test]
async fn rejected_submission_removes_the_draft() {
    let server = Server::start(Options {
        submission_error: Some("forbiddenToSend"),
        ..Options::default()
    })
    .await;
    let error = send(&mailer(), &account(&server)).await.unwrap_err();
    assert_eq!(
        error,
        MailError::Jmap(jmap::Error::NotCreated {
            kind: "forbiddenToSend".into(),
            description: Some("Rejected.".into()),
        })
    );
    assert_eq!(error.reason(), "not_created");
    let state = server.mail();
    assert!(state.submitted.is_empty());
    assert!(state.emails.is_empty(), "draft was left behind");
}

#[tokio::test]
async fn unknown_identity() {
    let server = Server::start(Options::default()).await;
    let account = Account {
        identity_id: Some("i9".into()),
        ..account(&server)
    };
    assert_eq!(
        send(&mailer(), &account).await,
        Err(MailError::Jmap(jmap::Error::NoIdentity))
    );
}

#[tokio::test]
async fn copy_needs_a_sent_mailbox() {
    let server = Server::start(Options {
        without_sent: true,
        ..Options::default()
    })
    .await;
    let mailer = mailer();
    assert_eq!(
        send(&mailer, &account(&server)).await,
        Err(MailError::Jmap(jmap::Error::NoMailbox("sent")))
    );
    let account = Account {
        keep_sent: false,
        ..account(&server)
    };
    send(&mailer, &account).await.unwrap();
    assert_eq!(server.mail().submitted.len(), 1);
}

#[tokio::test]
async fn credentials_stay_on_the_origin() {
    for options in [
        Options {
            foreign_redirect: true,
            ..Options::default()
        },
        Options {
            foreign_api_url: true,
            ..Options::default()
        },
    ] {
        let server = Server::start(options).await;
        assert_eq!(
            send(&mailer(), &account(&server)).await,
            Err(MailError::Jmap(jmap::Error::ForeignOrigin))
        );
        assert_eq!(server.mail().requests(), 0);
    }
}

#[tokio::test]
async fn reuses_the_session_for_the_next_mails() {
    let server = Server::start(Options::default()).await;
    let mailer = mailer();
    send(&mailer, &account(&server)).await.unwrap();
    assert_eq!(server.mail().requests(), 2);
    // Same session, same identity: only the submission remains.
    send(&mailer, &account(&server)).await.unwrap();
    assert_eq!(server.mail().requests(), 3);
    // Other settings: new session.
    let other = Account {
        identity_id: Some("i2".into()),
        ..account(&server)
    };
    send(&mailer, &other).await.unwrap();
    assert_eq!(server.mail().requests(), 5);
    assert_eq!(
        server.mail().submitted[2]["from"][0]["email"],
        "support@example.com"
    );
}

#[tokio::test]
async fn many_mails_at_once_do_not_lock() {
    let server = Server::start(Options::default()).await;
    let mailer = mailer();
    let account = account(&server);
    let results = tokio::join!(
        send(&mailer, &account),
        send(&mailer, &account),
        send(&mailer, &account),
        send(&mailer, &account),
        send(&mailer, &account),
        send(&mailer, &account),
    );
    let results = [
        results.0, results.1, results.2, results.3, results.4, results.5,
    ];
    assert!(results.iter().all(Result::is_ok), "{results:?}");
    let state = server.mail();
    assert_eq!(state.submitted.len(), 6);
    // One after the other, from the second mail on with the stored session.
    assert_eq!(state.requests(), 2 + 5);
}

#[tokio::test]
async fn a_success_forgets_earlier_failures() {
    let server = Server::start(Options::default()).await;
    let wrong = Account {
        auth: jmap::Auth::Basic {
            username: MAIL_USER.into(),
            password: "incorrect".into(),
        },
        ..account(&server)
    };
    let mailer = mailer();
    for _ in 0..4 {
        send(&mailer, &wrong).await.unwrap_err();
    }
    send(&mailer, &account(&server)).await.unwrap();
    for _ in 0..4 {
        assert_eq!(
            send(&mailer, &wrong).await,
            Err(MailError::Jmap(jmap::Error::AuthFailed))
        );
    }
    assert_eq!(server.mail().failed_logins, 8);
}

#[tokio::test]
async fn unclear_submission_keeps_the_mail() {
    let server = Server::start(Options {
        unreadable_submission: true,
        ..Options::default()
    })
    .await;
    assert_eq!(
        send(&mailer(), &account(&server)).await,
        Err(MailError::Jmap(jmap::Error::InvalidResponse))
    );
    // Possibly already sent: the copy in "Sent" stays.
    let state = server.mail();
    assert_eq!(state.submitted.len(), 1);
    let emails: Vec<_> = state.emails.values().collect();
    assert_eq!(emails.len(), 1);
    assert_eq!(emails[0]["mailboxIds"], json!({ "sent": true }));
}

#[tokio::test]
async fn relative_api_url() {
    let server = Server::start(Options {
        relative_api_url: true,
        ..Options::default()
    })
    .await;
    // `api/` next to `/jmap/session`, so `/jmap/api/`.
    send(&mailer(), &account(&server)).await.unwrap();
    assert_eq!(server.mail().submitted.len(), 1);
}
