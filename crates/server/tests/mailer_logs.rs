//! Send logs contain the reason but no credentials. Separate test file
//! (separate process): `tracing` remembers process-wide which call sites
//! log; parallel tests without a subscriber would otherwise make this test
//! miss events.

mod fake_stalwart;

use std::{
    io,
    sync::{Arc, Mutex},
};

use base64::Engine as _;
use fake_stalwart::{MAIL_PASSWORD, MAIL_TOKEN, MAIL_USER, Options, Server};
use roedy_jmap as jmap;
use roedy_mail_server::{
    broker,
    mailer::{Account, Mail, Mailer},
};
use url::Url;

/// Collects the logger's output.
#[derive(Clone, Default)]
struct Logs(Arc<Mutex<Vec<u8>>>);

impl io::Write for Logs {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn logs_name_the_reason_but_no_credentials() {
    let logs = Logs::default();
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    tracing::subscriber::set_global_default(subscriber).unwrap();

    let server = Server::start(Options::default()).await;
    let account = |auth| Account {
        base_url: Url::parse(&server.url).unwrap(),
        auth,
        identity_id: None,
        sender_name: None,
        reply_to: None,
        keep_sent: true,
    };
    let basic = |password: &str| jmap::Auth::Basic {
        username: MAIL_USER.into(),
        password: password.into(),
    };
    let mail = Mail {
        template: "invite",
        to: "jonas.schulz@example.com".into(),
        subject: "Invitation to Roedy Mail".into(),
        html: "<p>Hello</p>".into(),
        text: "Hello".into(),
    };
    let mailer = Mailer::new(broker::http_client().unwrap());
    let send = |account: Account| {
        let (mailer, mail) = (&mailer, &mail);
        async move { mailer.send(&account, mail).await }
    };
    send(account(basic("top-secret"))).await.unwrap_err();
    send(account(basic(MAIL_PASSWORD))).await.unwrap();
    send(account(jmap::Auth::Bearer(MAIL_TOKEN.into())))
        .await
        .unwrap();

    let logs = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    assert!(logs.contains("System mail not sent"), "{logs}");
    assert!(logs.contains("reason=\"auth_failed\""), "{logs}");
    assert!(logs.contains("system mail sent"), "{logs}");
    let encoded = |password: &str| {
        base64::engine::general_purpose::STANDARD.encode(format!("{MAIL_USER}:{password}"))
    };
    for secret in [
        "top-secret".to_owned(),
        MAIL_PASSWORD.to_owned(),
        MAIL_TOKEN.to_owned(),
        encoded("top-secret"),
        encoded(MAIL_PASSWORD),
    ] {
        assert!(!logs.contains(&secret), "{secret} in the log:\n{logs}");
    }
}
