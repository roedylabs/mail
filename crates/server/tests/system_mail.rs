//! Administration › Email via the API (`system-mail`): account without
//! secrets, changes with checks and audit log, status from checks and sending,
//! testing the draft with a test email, preview of the mail templates – against the mocked Stalwart
//! (`fake_stalwart`).

mod fake_stalwart;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    Router,
    body::Body,
    extract::connect_info::MockConnectInfo,
    http::{Method, Request, StatusCode, header},
};
use fake_stalwart::{MAIL_PASSWORD, MAIL_TOKEN, MAIL_USER, Options, Server};
use http_body_util::BodyExt as _;
use roedy_mail_server::{
    api,
    app::{AppState, router},
    auth::{
        password::{Hasher, Params},
        session,
    },
    broker::crypto::SecretKey,
    config::Config,
    db::{
        self, Db,
        repo::{
            servers as server_repo,
            users::{self, NewUser, Role},
        },
    },
    i18n,
    mailer::{
        preview::TEMPLATES,
        system_mail::{self, SystemMail},
    },
    settings::Language,
    web::static_files::WebAssets,
};
use serde_json::{Value, json};
use tower::ServiceExt as _;
use url::Url;

const PASSWORD: &str = "Summer2026!";
const PATH: &str = "/admin/system-mail";
const TEST: &str = "/admin/system-mail/test";
const PREVIEW: &str = "/admin/system-mail/preview";

struct Env {
    _tmp: tempfile::TempDir,
    state: AppState,
    server: Server,
    admin: String,
}

struct Reply {
    status: StatusCode,
    body: String,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", self.body))
    }
}

/// Server `s1` in the registry, a signed-in administrator; with `mail` also
/// the sending account from the setup (app password, identity `i1`).
async fn env(mail: bool) -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let conn = db::open(tmp.path()).unwrap();
    let config = Config {
        public_url: Some(Url::parse("https://app.example.com").unwrap()),
        ..Config::default()
    };
    let mut state = AppState::new(
        Db::from(conn),
        Arc::new(WebAssets::None),
        &config,
        SecretKey::random().unwrap(),
    )
    .unwrap();
    state.hasher = Arc::new(Hasher::with_params(Params::new(64, 1, 1, None).unwrap()));
    let server = Server::start(Options::default()).await;
    let url = server.url.clone();
    db::call(&state.db, move |conn| {
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
        Ok(())
    })
    .await
    .unwrap();
    let mut env = Env {
        _tmp: tmp,
        state,
        server,
        admin: String::new(),
    };
    env.add_user("anna", "anna@example.com", Role::Admin).await;
    env.admin = env.session("anna").await;
    // Only after sign-in: its security notice would otherwise go via the
    // sending account and set the status along the way.
    if mail {
        let secrets = env.state.secrets.clone();
        db::call(&env.state.db, move |conn| {
            let mail =
                SystemMail::new(&secrets, "s1", MAIL_USER, MAIL_PASSWORD, Some("i1".into()))?;
            system_mail::save(conn, &mail)
        })
        .await
        .unwrap();
    }
    env
}

impl Env {
    async fn add_user(&self, username: &str, email: &str, role: Role) {
        let hash = self.state.hasher.hash(PASSWORD).await.unwrap();
        let (username, email) = (username.to_owned(), email.to_owned());
        db::call(&self.state.db, move |conn| {
            users::insert(
                conn,
                &NewUser {
                    username: &username,
                    email: &email,
                    display_name: "Anna Becker",
                    role,
                    password_hash: &hash,
                },
            )
        })
        .await
        .unwrap();
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        session: Option<&str>,
    ) -> Reply {
        let mut builder = Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"))
            .header(api::CSRF_HEADER, "fetch")
            .header(header::USER_AGENT, "Mozilla/5.0 Firefox/140.0");
        if let Some(session) = session {
            builder = builder.header(header::COOKIE, format!("{}={session}", session::COOKIE));
        }
        let request = match body {
            Some(body) => builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string())),
            None => builder.body(Body::empty()),
        }
        .unwrap();
        let app: Router = router(self.state.clone())
            .layer(MockConnectInfo(SocketAddr::from(([89, 12, 34, 56], 4711))));
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        Reply {
            status,
            body: String::from_utf8(bytes.to_vec()).unwrap(),
        }
    }

    async fn session(&self, login: &str) -> String {
        let request = Request::builder()
            .method(Method::POST)
            .uri("/api/v1/auth/login")
            .header(api::CSRF_HEADER, "fetch")
            .header(header::USER_AGENT, "Mozilla/5.0 Firefox/140.0")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "login": login, "password": PASSWORD }).to_string(),
            ))
            .unwrap();
        let app: Router = router(self.state.clone())
            .layer(MockConnectInfo(SocketAddr::from(([89, 12, 34, 56], 4711))));
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        // The "new sign-in" notice is sent by a background task that loads the
        // sending account only when it runs. In tests Tokio runs on one thread:
        // the task only gets its turn when the test really waits, under load
        // sometimes only at the JMAP request of the first PUT – then the notice
        // would go via the account just stored (without the wait the binary
        // fails on one core, `taskset -c 0`, in about every fifth run).
        self.state.background.finish(Duration::from_secs(5)).await;
        let prefix = format!("{}=", session::COOKIE);
        response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .find_map(|c| {
                let value = c
                    .to_str()
                    .unwrap()
                    .strip_prefix(&prefix)?
                    .split(';')
                    .next()?;
                (!value.is_empty()).then(|| value.to_owned())
            })
            .unwrap()
    }

    async fn get(&self) -> Value {
        let reply = self
            .request(Method::GET, PATH, None, Some(&self.admin))
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        assert!(!reply.body.contains(MAIL_PASSWORD), "{}", reply.body);
        assert!(!reply.body.contains("_enc"), "{}", reply.body);
        reply.json()
    }

    async fn put(&self, body: Value) -> Reply {
        self.request(Method::PUT, PATH, Some(body), Some(&self.admin))
            .await
    }

    async fn test(&self, body: Value) -> Reply {
        self.request(Method::POST, TEST, Some(body), Some(&self.admin))
            .await
    }

    async fn stored_json(&self) -> String {
        db::call(&self.state.db, |conn| {
            Ok(conn.query_row(
                "SELECT json FROM app_settings WHERE key = 'system_mail'",
                [],
                |row| row.get::<_, String>(0),
            )?)
        })
        .await
        .unwrap()
    }

    async fn logged(&self) -> Vec<Value> {
        db::call(&self.state.db, |conn| {
            let mut statement = conn.prepare(
                "SELECT category, details FROM audit_log WHERE action = 'system_mail.update' \
                 ORDER BY id",
            )?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<(String, String)>, _>>()?;
            Ok(rows)
        })
        .await
        .unwrap()
        .into_iter()
        .map(|(category, details)| {
            assert_eq!(category, "settings");
            assert!(!details.contains(MAIL_PASSWORD) && !details.contains(MAIL_TOKEN));
            serde_json::from_str(&details).unwrap()
        })
        .collect()
    }

    async fn configured(&self) -> bool {
        let reply = self
            .request(Method::GET, "/auth/me", None, Some(&self.admin))
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.json()["system_mail_configured"].as_bool().unwrap()
    }
}

fn fields(reply: &Reply) -> Value {
    assert_eq!(
        reply.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        reply.body
    );
    let body = reply.json();
    assert_eq!(body["error"], "invalid", "{body}");
    body["fields"].clone()
}

/// Sent test emails; the sign-in also sends security notices.
async fn test_mails(server: &Server, n: usize) -> Vec<Value> {
    let found = || -> Vec<Value> {
        server
            .mail()
            .submitted
            .into_iter()
            .filter(|mail| mail["subject"] == "Test email from Roedy Mail")
            .collect()
    };
    for _ in 0..300 {
        if found().len() >= n {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let mails = found();
    assert_eq!(mails.len(), n, "{mails:#?}");
    mails
}

#[tokio::test]
async fn only_for_admins() {
    let env = env(true).await;
    env.add_user("max", "max@example.com", Role::User).await;
    let user = env.session("max").await;
    for (method, path) in [
        (Method::GET, PATH),
        (Method::PUT, PATH),
        (Method::POST, TEST),
        (Method::GET, "/admin/system-mail/preview?template=invite"),
    ] {
        let body = (method != Method::GET).then(|| json!({}));
        let reply = env.request(method.clone(), path, body.clone(), None).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{method} {path}");
        let reply = env.request(method.clone(), path, body, Some(&user)).await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN, "{method} {path}");
    }
}

/// Setup skipped: `PUT` creates the account and checks it right away.
#[tokio::test]
async fn put_creates_the_account_and_checks_it() {
    let env = env(false).await;
    let view = env.get().await;
    assert_eq!(
        view,
        json!({
            "server_id": null, "auth": "password", "user": "", "has_secret": false,
            "identity_id": null, "sender_name": null, "reply_to": null, "keep_sent": true,
            "status": "none", "reason": null, "checked_at": null, "identities": [],
        })
    );
    assert!(!env.configured().await);

    let errors = fields(&env.put(json!({})).await);
    assert_eq!(
        errors,
        json!({
            "server_id": { "code": "required" },
            "app_password": { "code": "required" },
            "user": { "code": "required" },
        })
    );
    let errors = fields(
        &env.put(json!({ "server_id": "s9", "user": MAIL_USER }))
            .await,
    );
    assert_eq!(errors["server_id"]["code"], "invalid");
    assert_eq!(env.logged().await, Vec::<Value>::new());

    let reply = env
        .put(json!({
            "server_id": "s1", "user": MAIL_USER, "app_password": MAIL_PASSWORD,
            "sender_name": " Example Ltd ", "reply_to": "support@example.com",
        }))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let view = reply.json();
    assert_eq!(view["server_id"], "s1");
    assert_eq!(view["has_secret"], true);
    assert_eq!(view["sender_name"], "Example Ltd");
    assert_eq!(view["status"], "ok", "{view}");
    assert!(view["checked_at"].as_str().unwrap().ends_with('Z'));
    let ids: Vec<&str> = view["identities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 2, "{view}");
    assert!(!reply.body.contains(MAIL_PASSWORD));
    assert_eq!(env.get().await, view);
    assert!(env.configured().await);
    assert!(!env.stored_json().await.contains(MAIL_PASSWORD));
    assert_eq!(
        env.logged().await,
        vec![json!({ "fields": ["server_id", "user", "app_password", "sender_name", "reply_to"] })]
    );

    // Without a change: no entry, no new check.
    let requests = env.server.mail().requests();
    let reply = env
        .put(json!({ "app_password": MAIL_PASSWORD, "sender_name": "Example Ltd" }))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.json(), view);
    assert_eq!(env.logged().await.len(), 1);
    let mail = env.server.mail();
    assert_eq!(mail.requests(), requests, "{:#?}", mail.calls);

    // Changing sender and sending does not check again.
    let reply = env.put(json!({ "keep_sent": false, "reply_to": "" })).await;
    let changed = reply.json();
    assert_eq!(changed["reply_to"], Value::Null);
    assert_eq!(changed["keep_sent"], false);
    assert_eq!(changed["checked_at"], view["checked_at"]);
    let mail = env.server.mail();
    assert_eq!(mail.requests(), requests, "{:#?}", mail.calls);
    assert_eq!(
        env.logged().await[1],
        json!({ "fields": ["reply_to", "keep_sent"] })
    );

    // The mailer checks another identity too: check again.
    let reply = env.put(json!({ "identity_id": "i2" })).await;
    let changed = reply.json();
    assert_eq!(
        (changed["identity_id"].as_str(), changed["status"].as_str()),
        (Some("i2"), Some("ok"))
    );
    let mail = env.server.mail();
    assert!(mail.requests() > requests, "{:#?}", mail.calls);
    let errors = env.put(json!({ "identity_id": "i9" })).await.json();
    assert_eq!(
        (errors["status"].as_str(), errors["reason"].as_str()),
        (Some("err"), Some("no_identity")),
        "{errors}"
    );
    // A draft with a missing identity does not change the status of i9 to
    // "ok", nor does one with i1.
    let reply = env.test(json!({ "identity_id": "i1" })).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(env.get().await["status"], "err");
}

/// A draft does not change the stored status; a stored wrong password does.
#[tokio::test]
async fn status_from_tests_of_the_saved_account_only() {
    let env = env(true).await;
    let view = env.get().await;
    assert_eq!(
        (view["status"].as_str(), view["user"].as_str()),
        (Some("unchecked"), Some(MAIL_USER))
    );
    assert_eq!(view["identity_id"], "i1");
    assert!(env.configured().await);

    let reply = env.test(json!({})).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.json()["sent"], false);
    assert_eq!(reply.json()["identities"].as_array().unwrap().len(), 2);
    let view = env.get().await;
    assert_eq!(view["status"], "ok");

    let reply = env.test(json!({ "app_password": "incorrect" })).await;
    assert_eq!(
        reply.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        reply.body
    );
    assert_eq!(reply.json()["error"], "mail_failed");
    assert_eq!(reply.json()["reason"], "auth_failed");
    assert_eq!(env.get().await, view);
    assert!(!env.stored_json().await.contains("incorrect"));

    let reply = env.put(json!({ "app_password": "incorrect" })).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let failed = reply.json();
    assert_eq!(
        (failed["status"].as_str(), failed["reason"].as_str()),
        (Some("err"), Some("auth_failed"))
    );
    // The identities of the last successful check do not apply to the new
    // connection.
    assert_eq!(failed["identities"], json!([]));
    assert!(env.configured().await, "an error is not \"not set up\"");

    // The right password again.
    let reply = env.put(json!({ "app_password": MAIL_PASSWORD })).await;
    assert_eq!(reply.json()["status"], "ok", "{}", reply.body);
    assert_eq!(
        env.logged()
            .await
            .iter()
            .map(|d| d["fields"].clone())
            .collect::<Vec<_>>(),
        vec![json!(["app_password"]), json!(["app_password"])]
    );
}

/// The stored secret only goes to the server it was entered for: another
/// server or a new URL needs it again.
#[tokio::test]
async fn secret_stays_with_its_server() {
    let env = env(true).await;
    let other = Server::start(Options::default()).await;
    let url = other.url.clone();
    db::call(&env.state.db, move |conn| {
        server_repo::insert(
            conn,
            "s2",
            &server_repo::Fields {
                label: "Other",
                base_url: &url,
                domains: &[],
                client_id: Some("c"),
            },
            None,
        )?;
        Ok(())
    })
    .await
    .unwrap();

    let required = json!({ "app_password": { "code": "required" } });
    assert_eq!(
        fields(&env.test(json!({ "server_id": "s2" })).await),
        required
    );
    assert_eq!(
        fields(&env.put(json!({ "server_id": "s2" })).await),
        required
    );
    assert!(other.token_requests().is_empty());
    let reply = env
        .put(json!({ "server_id": "s2", "app_password": MAIL_PASSWORD }))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert!(env.configured().await);

    // New URL of the server: the secret does not stay.
    let reply = env
        .request(
            Method::PATCH,
            "/admin/servers/s2",
            Some(json!({ "url": fake_stalwart::unreachable_url() })),
            Some(&env.admin),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(env.get().await["has_secret"], false);
    assert!(!env.configured().await);
    // The audit log shows why.
    assert_eq!(
        env.logged().await.last(),
        Some(&json!({ "fields": ["app_password"] }))
    );
    // Only changing the label keeps it.
    let reply = env.put(json!({ "app_password": MAIL_PASSWORD })).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let reply = env
        .request(
            Method::PATCH,
            "/admin/servers/s2",
            Some(json!({ "label": "New" })),
            Some(&env.admin),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(env.get().await["has_secret"], true);
}

#[tokio::test]
async fn token_instead_of_password() {
    let env = env(true).await;
    let errors = fields(&env.put(json!({ "auth": "token" })).await);
    assert_eq!(errors, json!({ "token": { "code": "required" } }));
    let errors = fields(&env.put(json!({ "auth": "sso" })).await);
    assert_eq!(errors, json!({ "auth": { "code": "invalid" } }));
    let reply = env.put(json!({ "pass": "x" })).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{}", reply.body);

    let reply = env
        .put(json!({ "auth": "token", "token": MAIL_TOKEN }))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let view = reply.json();
    assert_eq!(view["auth"], "token");
    assert_eq!(view["has_secret"], true);
    assert_eq!(view["status"], "ok", "{view}");
    let stored = env.stored_json().await;
    assert!(
        !stored.contains(MAIL_TOKEN) && !stored.contains("app_password_enc"),
        "{stored}"
    );
    assert_eq!(
        env.logged().await,
        vec![json!({ "fields": ["auth", "token"] })]
    );

    // Going back to the password needs one again.
    let errors = fields(&env.put(json!({ "auth": "password" })).await);
    assert_eq!(errors, json!({ "app_password": { "code": "required" } }));
    // The draft with password can be tested without saving.
    let reply = env
        .test(json!({ "auth": "password", "app_password": MAIL_PASSWORD }))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(env.get().await["auth"], "token");
}

#[tokio::test]
async fn test_mail_goes_out_and_is_limited() {
    let env = env(true).await;
    let reply = env
        .request(
            Method::PUT,
            PATH,
            Some(json!({ "to": "max@example.com" })),
            Some(&env.admin),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{}", reply.body);
    let errors = fields(&env.test(json!({ "to": "max@" })).await);
    assert_eq!(errors, json!({ "to": { "code": "invalid" } }));

    let reply = env
        .test(json!({ "to": "max@example.net", "sender_name": "Trial" }))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.json()["sent"], true);
    let mail = test_mails(&env.server, 1).await.remove(0);
    assert_eq!(mail["subject"], "Test email from Roedy Mail", "{mail}");
    assert_eq!(mail["to"][0]["email"], "max@example.net", "{mail}");
    assert_eq!(mail["from"][0]["name"], "Trial", "{mail}");
    assert_eq!(env.get().await["status"], "ok");

    // Rejected by the session: nothing is sent.
    env.server.reject_mail_to(Some("eva@example.com"));
    let reply = env.test(json!({ "to": "eva@example.com" })).await;
    assert_eq!(reply.status, StatusCode::BAD_GATEWAY, "{}", reply.body);
    assert_eq!(reply.json()["reason"], "not_created");
    assert_eq!(
        env.get().await["status"],
        "ok",
        "a rejected recipient is no connection error"
    );

    // Ten test emails in ten minutes; the check without `to` does not count.
    for _ in 2..10 {
        let reply = env.test(json!({ "to": "max@example.net" })).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    }
    let reply = env.test(json!({ "to": "max@example.net" })).await;
    assert_eq!(
        reply.status,
        StatusCode::TOO_MANY_REQUESTS,
        "{}",
        reply.body
    );
    assert_eq!(reply.json()["error"], "rate_limited");
    assert_eq!(env.test(json!({})).await.status, StatusCode::OK);
}

/// If sending a system mail fails on the connection, the page shows
/// "No connection"; without a server the account counts as not set up.
#[tokio::test]
async fn sends_keep_the_status_current() {
    let env = env(true).await;
    assert_eq!(env.test(json!({})).await.status, StatusCode::OK);
    assert_eq!(env.get().await["status"], "ok");

    env.server.stop().await;
    let reply = env
        .request(
            Method::POST,
            "/invites",
            Some(json!({ "emails": ["tim@example.com"], "role": "user" })),
            Some(&env.admin),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let view = env.get().await;
    assert_eq!(
        (view["status"].as_str(), view["reason"].as_str()),
        (Some("err"), Some("unreachable")),
        "{view}"
    );
    assert_eq!(view["identities"].as_array().unwrap().len(), 2, "stay");

    db::call(&env.state.db, |conn| Ok(server_repo::delete(conn, "s1")?))
        .await
        .unwrap();
    let view = env.get().await;
    assert_eq!(
        (view["status"].as_str(), view["server_id"].clone()),
        (Some("none"), Value::Null)
    );
    assert_eq!(view["user"], MAIL_USER, "the other fields stay");
    assert!(!env.configured().await);
    let errors = fields(&env.put(json!({ "keep_sent": false })).await);
    assert_eq!(errors, json!({ "server_id": { "code": "invalid" } }));
}

impl Env {
    async fn preview(&self, query: &str) -> Reply {
        self.request(
            Method::GET,
            &format!("{PREVIEW}?{query}"),
            None,
            Some(&self.admin),
        )
        .await
    }
}

/// Every template and variant of the templates tab, as HTML light and dark
/// and as text; sender from the last check, logo as data URL.
#[tokio::test]
async fn preview_of_every_template_and_variant() {
    let env = env(true).await;
    for (template, variants) in TEMPLATES {
        let variants: Vec<String> = if variants.is_empty() {
            vec![String::new()]
        } else {
            variants.iter().map(|v| format!("&variant={v}")).collect()
        };
        for variant in variants {
            for format in ["html&theme=light", "html&theme=dark", "text"] {
                let query = format!("template={template}{variant}&format={format}");
                let reply = env.preview(&query).await;
                assert_eq!(reply.status, StatusCode::OK, "{query}: {}", reply.body);
                let body = reply.json();
                assert!(!body["subject"].as_str().unwrap().is_empty(), "{query}");
                assert!(body["to"].as_str().unwrap().contains('@'), "{query}");
                let content = body["body"].as_str().unwrap();
                assert_eq!(
                    content.starts_with("<!DOCTYPE html>"),
                    format != "text",
                    "{query}"
                );
            }
        }
    }

    // Unchecked account: no identity yet, so no sender.
    let reply = env
        .preview("template=system&variant=update&theme=dark")
        .await;
    let body = reply.json();
    assert_eq!(body["from"], Value::Null);
    assert_eq!(body["to"], "anna@example.com");
    assert_eq!(body["subject"], "Update to version 0.2.0 installed");
    let html = body["body"].as_str().unwrap();
    assert!(html.contains("Hi Anna,"), "{html}");
    assert!(
        html.contains(r#"<img src="data:image/png;base64,"#),
        "{html}"
    );
    assert!(!html.contains("/branding/mail-logo.png"), "{html}");
    assert!(
        html.contains("#221d19") && !html.contains("#ffffff"),
        "{html}"
    );
    assert!(html.contains("https://app.example.com/admin/updates"));

    // After the check: identity `i1` of the account, sender name as when
    // sending.
    let reply = env.test(json!({})).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let body = env.preview("template=invite&format=text").await.json();
    assert_eq!(body["from"], format!("Example Ltd <{MAIL_USER}>"));
    assert_eq!(body["to"], "jonas.schulz@example.com");
    let text = body["body"].as_str().unwrap();
    assert!(
        text.starts_with("Hi Jonas,\n\nAnna Becker has invited you to Roedy Mail."),
        "{text}"
    );
    let reply = env.put(json!({ "sender_name": "Roedy Post" })).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let body = env.preview("template=reset").await.json();
    assert_eq!(body["from"], format!("Roedy Post <{MAIL_USER}>"));
}

#[tokio::test]
async fn preview_rejects_unknown_templates_and_parameters() {
    let env = env(false).await;
    for query in [
        "",
        "template=system_test",
        "template=security_login",
        "template=invite&variant=login",
        "template=security&variant=backup",
        "template=security&variant=",
        "template=invite&format=pdf",
        "template=invite&theme=gray",
        "template=invite&lang=fr",
        "template=invite&lang=EN",
        "template=invite&to=a@b.example",
    ] {
        let reply = env.preview(query).await;
        assert_eq!(
            reply.status,
            StatusCode::BAD_REQUEST,
            "{query}: {}",
            reply.body
        );
        assert_eq!(reply.json()["error"], "bad_request", "{query}");
    }
    // Without a sending account there is no sender, the preview still works.
    let reply = env.preview("template=digest&variant=over_50").await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.json()["from"], Value::Null);
}

/// Language: without `lang` the administrator's, with `lang` the requested one.
#[tokio::test]
async fn preview_in_the_language_of_the_admin_or_the_request() {
    let env = env(false).await;
    let subject = |body: Value| body["subject"].as_str().unwrap().to_owned();
    // The administrator has the default language, English.
    assert_eq!(
        subject(env.preview("template=invite").await.json()),
        "Invitation to Roedy Mail"
    );
    let german = env.preview("template=invite&lang=de").await.json();
    assert!(
        german["body"]
            .as_str()
            .unwrap()
            .contains("<html lang=\"de\">")
    );
    let german_subject = subject(german);
    assert_eq!(
        german_subject,
        i18n::tf(
            Language::German,
            "mail.invite.subject",
            &[("app", &"Roedy Mail")]
        )
    );

    // Switched to German: without `lang` German, `lang=en` still English.
    let body = json!({ "version": 0, "settings": { "lang": "de" } });
    let reply = env
        .request(Method::PUT, "/settings", Some(body), Some(&env.admin))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(
        subject(env.preview("template=invite").await.json()),
        german_subject
    );
    let english = env.preview("template=invite&lang=en").await.json();
    assert_eq!(subject(english.clone()), "Invitation to Roedy Mail");
    assert!(
        english["body"]
            .as_str()
            .unwrap()
            .contains("<html lang=\"en\">")
    );
    let digest = env
        .preview("template=digest&variant=summary&format=text&lang=en")
        .await
        .json();
    assert_eq!(subject(digest.clone()), "Your Roedy Mail digest");
    assert!(
        digest["body"]
            .as_str()
            .unwrap()
            .contains("* Invitation accepted (5 hours ago)"),
        "{digest}"
    );
}

/// Times in the administrator's time zone and formats (settings).
#[tokio::test]
async fn preview_uses_the_format_of_the_admin() {
    let env = env(false).await;
    let body = json!({
        "version": 0,
        "settings": { "tz": "America/New_York", "timeFmt": "12h", "dateFmt": "us" },
    });
    let reply = env
        .request(Method::PUT, "/settings", Some(body), Some(&env.admin))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let text = env
        .preview("template=system&variant=backup&format=text")
        .await
        .json()["body"]
        .as_str()
        .unwrap()
        .to_owned();
    let line = text
        .lines()
        .find_map(|line| line.strip_prefix("Time: "))
        .unwrap();
    // e.g. "11/05/2026, 3:57 AM"
    let (date, time) = line.split_once(", ").unwrap();
    assert_eq!(date.matches('/').count(), 2, "{line}");
    assert!(time.ends_with(" AM") || time.ends_with(" PM"), "{line}");
}
