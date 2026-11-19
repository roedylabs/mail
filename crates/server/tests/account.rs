//! Forgot/reset password and profile with email address change via the API:
//! links from mails, order and release
//! of the two mails, shared validity check of `check` and `confirm`,
//! discarding open links.

mod fake_stalwart;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    Router,
    body::Body,
    extract::connect_info::MockConnectInfo,
    http::{HeaderMap, Method, Request, StatusCode, header},
};
use fake_stalwart::{MAIL_PASSWORD, MAIL_USER, Options, Server};
use http_body_util::BodyExt as _;
use roedy_mail_server::{
    api,
    app::{AppState, router},
    auth::{
        challenge,
        device::Device,
        password::{Hasher, Params},
        session, totp,
    },
    broker::crypto::SecretKey,
    config::Config,
    db::{
        self, Db,
        repo::{
            known_devices, notifications, servers as server_repo, totp_devices,
            users::{self, NewUser, Role},
        },
    },
    mailer::system_mail::{self, SystemMail},
    web::static_files::WebAssets,
};
use serde_json::{Value, json};
use tower::ServiceExt as _;
use url::Url;

const PASSWORD: &str = "Summer2026!";
const NEW_PASSWORD: &str = "Winter2026!";
const FIREFOX: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
const HOME: [u8; 4] = [89, 12, 34, 56];
const AWAY: [u8; 4] = [91, 64, 1, 2];

struct Env {
    _tmp: tempfile::TempDir,
    state: AppState,
}

async fn env() -> Env {
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
        )
        .unwrap();
        let mail =
            SystemMail::new(&secrets, "s1", MAIL_USER, MAIL_PASSWORD, Some("i1".into())).unwrap();
        system_mail::save(conn, &mail).unwrap();
        Ok(())
    })
    .await;
    (env, server)
}

impl Env {
    /// User whose browser is already known in the test (otherwise the first
    /// sign-in would send a "new sign-in" notice).
    async fn add_user(&self, username: &str, email: &str) -> String {
        let hash = self.state.hasher.hash(PASSWORD).await.unwrap();
        let (username, email) = (username.to_owned(), email.to_owned());
        let device = Device::parse(Some(FIREFOX)).hash(&self.state.secrets, HOME.into());
        db::call(&self.state.db, move |conn| {
            let id = users::insert(
                conn,
                &NewUser {
                    username: &username,
                    email: &email,
                    display_name: "Max Mustermann",
                    role: Role::User,
                    password_hash: &hash,
                },
            )?;
            known_devices::remember(conn, &id, &device)?;
            Ok(id)
        })
        .await
        .unwrap()
    }

    /// Confirmed authenticator app; returns the secret.
    async fn add_device(&self, user_id: &str) -> Vec<u8> {
        let id = db::new_id().unwrap();
        let secret = totp::generate_secret().unwrap().to_vec();
        let sealed = self
            .state
            .secrets
            .seal(totp::SECRET_PURPOSE, &id, &secret)
            .unwrap();
        let user_id = user_id.to_owned();
        db::call(&self.state.db, move |conn| {
            totp_devices::insert_pending(conn, &id, &user_id, &sealed)?;
            totp_devices::confirm(conn, &id, "Phone", 0)?;
            Ok(())
        })
        .await
        .unwrap();
        secret
    }

    async fn sql<T: Send + 'static>(
        &self,
        f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T> + Send + 'static,
    ) -> T {
        db::call(&self.state.db, move |conn| Ok(f(conn)?))
            .await
            .unwrap()
    }

    async fn request(
        &self,
        ip: [u8; 4],
        method: Method,
        path: &str,
        body: Option<Value>,
        session: Option<&str>,
    ) -> Reply {
        let cookie = session.map(|session| (session::COOKIE, session));
        self.send(ip, method, path, body, cookie).await
    }

    async fn send(
        &self,
        ip: [u8; 4],
        method: Method,
        path: &str,
        body: Option<Value>,
        cookie: Option<(&str, &str)>,
    ) -> Reply {
        let mut builder = Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"))
            .header(api::CSRF_HEADER, "fetch")
            .header(header::USER_AGENT, FIREFOX);
        if let Some((name, value)) = cookie {
            builder = builder.header(header::COOKIE, format!("{name}={value}"));
        }
        let request = match body {
            Some(body) => builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string())),
            None => builder.body(Body::empty()),
        }
        .unwrap();
        let app: Router =
            router(self.state.clone()).layer(MockConnectInfo(SocketAddr::from((ip, 4711))));
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        Reply {
            status,
            headers,
            body: String::from_utf8(bytes.to_vec()).unwrap(),
        }
    }

    async fn post(&self, path: &str, body: Value, session: Option<&str>) -> Reply {
        self.request(HOME, Method::POST, path, Some(body), session)
            .await
    }

    async fn login(&self, login: &str, password: &str) -> Reply {
        self.post(
            "/auth/login",
            json!({ "login": login, "password": password }),
            None,
        )
        .await
    }

    async fn session(&self, login: &str) -> String {
        let reply = self.login(login, PASSWORD).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.cookie(session::COOKIE).unwrap()
    }

    /// Sign-in with password and the app's current code.
    async fn session_with_code(&self, login: &str, secret: &[u8]) -> String {
        let reply = self.login(login, PASSWORD).await;
        assert_eq!(reply.json()["status"], "totp_required", "{}", reply.body);
        let mfa = reply.cookie(challenge::COOKIE).unwrap();
        let body = json!({ "code": code(secret, 0) });
        let reply = self
            .send(
                HOME,
                Method::POST,
                "/auth/totp",
                Some(body),
                Some((challenge::COOKIE, &mfa)),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.cookie(session::COOKIE).unwrap()
    }

    async fn me(&self, session: &str) -> Value {
        let reply = self
            .request(HOME, Method::GET, "/auth/me", None, Some(session))
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.json()
    }

    async fn patch_me(&self, session: &str, body: Value) -> Reply {
        self.request(HOME, Method::PATCH, "/auth/me", Some(body), Some(session))
            .await
    }

    /// Second step: new address with password.
    async fn request_change(&self, session: &str, email: &str) -> Reply {
        self.patch_me(session, json!({ "email": email, "password": PASSWORD }))
            .await
    }

    async fn check(&self, token: &str, session: Option<&str>) -> Value {
        let reply = self
            .post("/auth/email/check", json!({ "token": token }), session)
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.json()
    }

    async fn confirm(&self, token: &str, session: Option<&str>) -> Value {
        let reply = self
            .post("/auth/email/confirm", json!({ "token": token }), session)
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.json()
    }

    async fn params(&self, user: &str) -> Vec<Value> {
        let user = user.to_owned();
        db::call(&self.state.db, move |conn| notifications::list(conn, &user))
            .await
            .unwrap()
            .into_iter()
            .map(|n| n.params)
            .collect()
    }

    async fn kinds(&self, user: &str) -> Vec<String> {
        let user = user.to_owned();
        db::call(&self.state.db, move |conn| notifications::list(conn, &user))
            .await
            .unwrap()
            .into_iter()
            .map(|n| n.kind)
            .collect()
    }

    async fn actions(&self) -> Vec<String> {
        self.sql(|conn| {
            conn.prepare("SELECT action FROM audit_log ORDER BY id")?
                .query_map([], |r| r.get(0))?
                .collect()
        })
        .await
    }
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: String,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", self.body))
    }

    fn error(&self) -> Value {
        self.json()["error"].clone()
    }

    fn cookie(&self, name: &str) -> Option<String> {
        self.headers
            .get_all(header::SET_COOKIE)
            .iter()
            .find_map(|c| {
                let value = c
                    .to_str()
                    .unwrap()
                    .strip_prefix(&format!("{name}="))?
                    .split(';')
                    .next()?;
                (!value.is_empty()).then(|| value.to_owned())
            })
    }
}

/// Waits until the test server has sent `n` mails and checks that no
/// further one follows.
async fn mails(server: &Server, n: usize) -> Vec<Value> {
    for _ in 0..300 {
        if server.mail().submitted.len() >= n {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    let submitted = server.mail().submitted;
    assert_eq!(submitted.len(), n, "{submitted:#?}");
    submitted
}

fn text(mail: &Value) -> &str {
    mail["bodyValues"]["text"]["value"].as_str().unwrap()
}

fn to(mail: &Value) -> &str {
    mail["to"][0]["email"].as_str().unwrap()
}

/// Token from the link `prefix` (64 hex characters) in the text variant.
fn token(mail: &Value, prefix: &str) -> String {
    let text = text(mail);
    let start = text
        .find(prefix)
        .unwrap_or_else(|| panic!("no link: {text}"))
        + prefix.len();
    text[start..start + 64].to_owned()
}

fn confirm_token(mail: &Value) -> String {
    token(mail, "https://app.example.com/confirm-email/")
}

/// The app's code for the time step `offset` relative to now (0 or 1; ±1
/// step is valid).
fn code(secret: &[u8], offset: u64) -> String {
    totp_rs::Builder::new()
        .with_secret(secret.to_vec())
        .build()
        .unwrap()
        .generate(totp::now() + offset * 30)
        .to_string()
}

/// Requests `new@example.com` and returns the link's token; `sent` counts
/// the mails so far.
async fn change_link(env: &Env, server: &Server, session: &str, sent: &mut usize) -> String {
    let reply = env.request_change(session, "new@example.com").await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    *sent += 2;
    confirm_token(&mails(server, *sent).await[*sent - 1])
}

// --- Forgot and reset password ---

#[tokio::test]
async fn forgot_answers_the_same_and_mails_only_active_accounts() {
    let (env, server) = env_with_mail().await;
    let max = env.add_user("max", "max@example.com").await;
    let eva = env.add_user("eva", "eva@example.com").await;
    env.sql(move |conn| conn.execute("UPDATE users SET status = 'locked' WHERE id = ?1", [&eva]))
        .await;

    for email in ["niemand@example.com", "eva@example.com", "MAX@example.com"] {
        let reply = env
            .post("/auth/password/forgot", json!({ "email": email }), None)
            .await;
        assert_eq!(
            reply.status,
            StatusCode::ACCEPTED,
            "{email}: {}",
            reply.body
        );
        assert_eq!(reply.body, "", "{email}");
    }
    let sent = mails(&server, 1).await;
    assert_eq!(to(&sent[0]), "max@example.com");
    assert_eq!(sent[0]["subject"], "Reset your Roedy Mail password");
    assert!(text(&sent[0]).contains("The link is valid for 60 minutes"));
    token(&sent[0], "https://app.example.com/password/reset/");
    assert!(
        env.actions()
            .await
            .contains(&"auth.password_forgot".to_owned())
    );
    assert!(env.kinds(&max).await.is_empty());

    let invalid = env
        .post("/auth/password/forgot", json!({ "email": "max" }), None)
        .await;
    assert_eq!(invalid.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(invalid.json()["fields"]["email"]["code"], "invalid");
}

/// The silent per-address limit folds only ASCII, like the lookup: requests
/// with `K` (Kelvin sign) do not use up the counter of `kai@…` and so do
/// not suppress a mail to the account.
#[tokio::test]
async fn forgot_limit_folds_like_the_lookup() {
    let (env, server) = env_with_mail().await;
    env.add_user("kai", "kai@example.com").await;
    for _ in 0..5 {
        let reply = env
            .post(
                "/auth/password/forgot",
                json!({ "email": "\u{212A}ai@example.com" }),
                None,
            )
            .await;
        assert_eq!(reply.status, StatusCode::ACCEPTED, "{}", reply.body);
    }
    // The requests run in the background; only then the real address.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let reply = env
        .post(
            "/auth/password/forgot",
            json!({ "email": "kai@example.com" }),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::ACCEPTED);
    assert_eq!(to(&mails(&server, 1).await[0]), "kai@example.com");
}

#[tokio::test]
async fn forgot_without_system_mail_answers_the_same() {
    let env = env().await;
    env.add_user("max", "max@example.com").await;
    let reply = env
        .post(
            "/auth/password/forgot",
            json!({ "email": "max@example.com" }),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::ACCEPTED);
}

#[tokio::test]
async fn reset_link_works_once_and_ends_all_sessions() {
    let (env, server) = env_with_mail().await;
    let max = env.add_user("max", "max@example.com").await;
    let first = env.session("max").await;
    let second = env.session("max").await;
    // An open email change is discarded too.
    let change = env.request_change(&first, "new@example.com").await;
    assert_eq!(change.status, StatusCode::OK, "{}", change.body);
    let change_mails = mails(&server, 2).await;
    let link = confirm_token(&change_mails[1]);

    env.post(
        "/auth/password/forgot",
        json!({ "email": "max@example.com" }),
        None,
    )
    .await;
    let sent = mails(&server, 3).await;
    let reset = token(&sent[2], "https://app.example.com/password/reset/");
    let path = format!("/auth/password/reset/{reset}");

    let weak = env.post(&path, json!({ "password": "short" }), None).await;
    assert_eq!(weak.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(weak.json()["fields"]["password"]["code"], "policy");

    let done = env
        .post(&path, json!({ "password": NEW_PASSWORD }), None)
        .await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.body);
    assert_eq!(done.json(), json!({ "status": "ok", "sessions_ended": 2 }));
    // No sign-in through the link (otherwise it would bypass the second factor).
    assert!(done.cookie(session::COOKIE).is_none());

    for session in [&first, &second] {
        let me = env
            .request(HOME, Method::GET, "/auth/me", None, Some(session))
            .await;
        assert_eq!(me.status, StatusCode::UNAUTHORIZED);
    }
    assert_eq!(env.check(&link, None).await["state"], "invalid");
    assert_eq!(
        env.login("max", PASSWORD).await.error(),
        "invalid_credentials"
    );
    assert_eq!(env.login("max", NEW_PASSWORD).await.status, StatusCode::OK);

    // Only once.
    let again = env
        .post(&path, json!({ "password": NEW_PASSWORD }), None)
        .await;
    assert_eq!(again.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(again.error(), "invalid_token");

    // "Password changed" as event, the mail in the "password reset" variant:
    // all devices are already signed out.
    let sent = mails(&server, 4).await;
    assert_eq!(sent[3]["subject"], "Your password was reset");
    let body = text(&sent[3]);
    assert!(
        body.contains("Reset password” email. All devices were signed out."),
        "{body}"
    );
    assert!(
        body.contains("Then someone has access to your mailbox."),
        "{body}"
    );
    assert!(
        env.kinds(&max)
            .await
            .contains(&"security.password".to_owned())
    );
    assert!(
        env.actions()
            .await
            .contains(&"auth.password_reset".to_owned())
    );
}

#[tokio::test]
async fn reset_link_expires_after_sixty_minutes_and_only_the_latest_counts() {
    let (env, server) = env_with_mail().await;
    env.add_user("max", "max@example.com").await;
    let forgot = json!({ "email": "max@example.com" });
    env.post("/auth/password/forgot", forgot.clone(), None)
        .await;
    let older = token(&mails(&server, 1).await[0], "/password/reset/");
    env.post("/auth/password/forgot", forgot, None).await;
    let latest = token(&mails(&server, 2).await[1], "/password/reset/");
    let body = json!({ "password": NEW_PASSWORD });

    let replaced = env
        .post(&format!("/auth/password/reset/{older}"), body.clone(), None)
        .await;
    assert_eq!(replaced.error(), "invalid_token");

    env.sql(|conn| {
        conn.execute(
            "UPDATE password_resets SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second')",
            [],
        )
    })
    .await;
    let expired = env
        .post(&format!("/auth/password/reset/{latest}"), body, None)
        .await;
    assert_eq!(expired.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(expired.error(), "invalid_token");
    assert_eq!(env.login("max", PASSWORD).await.status, StatusCode::OK);
}

#[tokio::test]
async fn unknown_link_tokens_are_limited_per_ip() {
    let env = env().await;
    let body = json!({ "password": NEW_PASSWORD });
    for i in 0..10 {
        let path = format!("/auth/password/reset/{}", "a".repeat(64));
        let reply = env.post(&path, body.clone(), None).await;
        assert_eq!(reply.error(), "invalid_token", "{i}");
    }
    // "Confirm email" counts too.
    let limited = env
        .post("/auth/email/check", json!({ "token": "nonsense" }), None)
        .await;
    assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
    // From another address it goes on.
    let other = env
        .request(
            AWAY,
            Method::POST,
            "/auth/email/check",
            Some(json!({ "token": "nonsense" })),
            None,
        )
        .await;
    assert_eq!(
        other.json(),
        json!({ "state": "invalid", "own_session": false })
    );
}

// --- Profile and email change ---

#[tokio::test]
async fn profile_saves_name_and_username_at_once() {
    let env = env().await;
    let max = env.add_user("max", "max@example.com").await;
    env.add_user("eva", "eva@example.com").await;
    let session = env.session("max").await;

    let saved = env
        .patch_me(
            &session,
            json!({ "display_name": " Max O’Brien-Müller ", "username": "maxi" }),
        )
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
    assert_eq!(saved.json()["status"], "ok");
    assert_eq!(saved.json()["user"]["display_name"], "Max O’Brien-Müller");
    let me = env.me(&session).await;
    assert_eq!(me["username"], "maxi");
    assert_eq!(me["email_change"], Value::Null);
    // "Profile changed" with the changed fields.
    assert_eq!(env.kinds(&max).await, ["account.profile"]);
    assert_eq!(
        env.params(&max).await,
        [json!({ "fields": ["name", "username"] })]
    );
    // Saved unchanged: no event.
    let same = env.patch_me(&session, json!({ "username": "maxi" })).await;
    assert_eq!(same.status, StatusCode::OK, "{}", same.body);
    assert_eq!(env.kinds(&max).await.len(), 1);

    let taken = env.patch_me(&session, json!({ "username": "eva" })).await;
    assert_eq!(taken.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(taken.json()["fields"]["username"]["code"], "taken");
    let invalid = env
        .patch_me(
            &session,
            json!({ "username": "Max", "display_name": "", "email": "max@" }),
        )
        .await;
    let fields = &invalid.json()["fields"];
    assert_eq!(fields["username"]["code"], "invalid");
    assert_eq!(fields["display_name"]["code"], "required");
    assert_eq!(fields["email"]["code"], "invalid");
    // Letters, spaces, hyphens and apostrophes only.
    let comma = env
        .patch_me(&session, json!({ "display_name": "Mustermann, Max" }))
        .await;
    assert_eq!(comma.json()["fields"]["display_name"]["code"], "invalid");
    // On an error nothing is stored.
    assert_eq!(env.me(&session).await["display_name"], "Max O’Brien-Müller");
    assert_eq!(env.kinds(&max).await.len(), 1);
}

#[tokio::test]
async fn new_address_needs_password_and_is_checked_in_two_steps() {
    let (env, server) = env_with_mail().await;
    let max = env.add_user("max", "max@example.com").await;
    env.add_user("eva", "eva@example.com").await;
    let anna = env.add_user("anna", "anna@example.com").await;
    env.sql(move |conn| conn.execute("UPDATE users SET status = 'locked' WHERE id = ?1", [&anna]))
        .await;
    let session = env.session("max").await;

    // Without password: only format and uniqueness among active users.
    let active = env
        .patch_me(&session, json!({ "email": "EVA@example.com" }))
        .await;
    assert_eq!(active.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(active.error(), "email_taken");
    let step = env
        .patch_me(
            &session,
            json!({ "display_name": "Max Mann", "email": "anna@example.com" }),
        )
        .await;
    assert_eq!(step.status, StatusCode::OK, "{}", step.body);
    assert_eq!(step.json()["status"], "reauth_required");
    // The name is stored, the address is not.
    let me = env.me(&session).await;
    assert_eq!(me["display_name"], "Max Mann");
    assert_eq!(me["email"], "max@example.com");

    // With password the full check: locked accounts too.
    let locked = env.request_change(&session, "anna@example.com").await;
    assert_eq!(locked.error(), "email_taken");
    let wrong = env
        .patch_me(
            &session,
            json!({ "email": "new@example.com", "password": "incorrect-incorrect" }),
        )
        .await;
    assert_eq!(wrong.error(), "invalid_password");
    assert!(server.mail().submitted.is_empty());
    // Only "Profile changed" from the name, nothing about the address.
    assert_eq!(env.kinds(&max).await, ["account.profile"]);
}

#[tokio::test]
async fn both_mails_go_out_before_the_link_confirms_by_button() {
    let (env, server) = env_with_mail().await;
    let max = env.add_user("max", "max@example.com").await;
    let session = env.session("max").await;

    let sent = env
        .request_change(&session, "Max.Mustermann@example.com")
        .await;
    assert_eq!(sent.status, StatusCode::OK, "{}", sent.body);
    let body = sent.json();
    assert_eq!(body["status"], "email_sent");
    assert_eq!(body["email_change"]["email"], "Max.Mustermann@example.com");
    assert_eq!(body["user"]["email"], "max@example.com");

    // First the notice to the previous address, then the link to the new one.
    let mails = mails(&server, 2).await;
    assert_eq!(to(&mails[0]), "max@example.com");
    assert_eq!(
        mails[0]["subject"],
        "Your email address for Roedy Mail is being changed"
    );
    assert!(text(&mails[0]).contains("New address: Max.Mustermann@example.com"));
    assert!(text(&mails[0]).contains("Device: Firefox on Linux"));
    assert!(text(&mails[0]).contains("IP address: 89.12.x.x"));
    assert_eq!(to(&mails[1]), "Max.Mustermann@example.com");
    assert_eq!(
        mails[1]["subject"],
        "Confirm your new email address for Roedy Mail"
    );
    let link = confirm_token(&mails[1]);

    let me = env.me(&session).await;
    assert_eq!(me["email"], "max@example.com");
    assert_eq!(me["email_change"]["email"], "Max.Mustermann@example.com");
    assert!(me["email_change"]["expires_at"].is_string());
    assert_eq!(env.kinds(&max).await, ["security.email_change"]);

    // `check` changes nothing, any number of times.
    for _ in 0..2 {
        let checked = env.check(&link, Some(&session)).await;
        assert_eq!(
            checked,
            json!({ "state": "valid", "email": "Max.Mustermann@example.com", "own_session": true })
        );
    }
    assert_eq!(env.me(&session).await["email"], "max@example.com");
    assert_eq!(env.check(&link, None).await["own_session"], false);
    // The old address is valid until the confirmation.
    assert_eq!(
        env.login("max@example.com", PASSWORD).await.status,
        StatusCode::OK
    );

    // Confirming also works without a session (guest variant).
    let confirmed = env.confirm(&link, None).await;
    assert_eq!(
        confirmed,
        json!({ "state": "confirmed", "email": "Max.Mustermann@example.com", "own_session": false })
    );
    let me = env.me(&session).await;
    assert_eq!(me["email"], "Max.Mustermann@example.com");
    assert_eq!(me["email_change"], Value::Null);
    assert_eq!(
        env.kinds(&max).await,
        ["account.email_confirmed", "security.email_change"]
    );
    assert_eq!(
        env.params(&max).await[0],
        json!({ "email": "Max.Mustermann@example.com" })
    );
    assert_eq!(
        env.confirm(&link, Some(&session)).await["state"],
        "already_confirmed"
    );
    assert_eq!(env.kinds(&max).await.len(), 2);
    assert_eq!(env.check(&link, None).await["state"], "already_confirmed");
    assert_eq!(
        env.login("max@example.com", PASSWORD).await.error(),
        "invalid_credentials"
    );
    assert_eq!(
        env.login("max.mustermann@example.com", PASSWORD)
            .await
            .status,
        StatusCode::OK
    );
    let actions = env.actions().await;
    for action in ["auth.email_change_request", "auth.email_change_confirm"] {
        assert!(
            actions.contains(&action.to_owned()),
            "{action}: {actions:?}"
        );
    }
}

#[tokio::test]
async fn failed_mail_creates_nothing_and_its_link_does_not_confirm() {
    let (env, server) = env_with_mail().await;
    let max = env.add_user("max", "max@example.com").await;
    let secret = env.add_device(&max).await;
    let session = env.session_with_code("max", &secret).await;
    // With multi-factor the second step needs a code.
    let without = env.request_change(&session, "new@example.com").await;
    assert_eq!(without.json()["fields"]["code"]["code"], "required");

    server.reject_mail_to(Some("new@example.com"));
    // The sign-in used up the current code; the next one is already valid
    // (±1 step).
    let fresh = code(&secret, 1);
    let failed = env
        .patch_me(
            &session,
            json!({ "email": "new@example.com", "password": PASSWORD, "code": fresh }),
        )
        .await;
    assert_eq!(failed.status, StatusCode::BAD_GATEWAY, "{}", failed.body);
    assert_eq!(failed.error(), "mail_failed");
    // The notice to the previous address is out, the change is not created.
    let sent = mails(&server, 1).await;
    assert_eq!(to(&sent[0]), "max@example.com");
    assert_eq!(env.me(&session).await["email_change"], Value::Null);
    assert!(env.kinds(&max).await.is_empty());
    // The link of the failed mail does not confirm.
    let rejected = server.mail().rejected;
    assert_eq!(rejected.len(), 1);
    assert_eq!(to(&rejected[0]), "new@example.com");
    let link = confirm_token(&rejected[0]);
    assert_eq!(env.check(&link, None).await["state"], "invalid");
    assert_eq!(env.confirm(&link, None).await["state"], "invalid");
    assert_eq!(env.me(&session).await["email"], "max@example.com");

    // The checked code is used up.
    server.reject_mail_to(None);
    let reused = env
        .patch_me(
            &session,
            json!({ "email": "new@example.com", "password": PASSWORD, "code": fresh }),
        )
        .await;
    assert_eq!(reused.error(), "code_used");
}

#[tokio::test]
async fn second_step_saves_name_only_with_the_link() {
    let (env, server) = env_with_mail().await;
    let max = env.add_user("max", "max@example.com").await;
    let session = env.session("max").await;
    let wrong = env
        .patch_me(
            &session,
            json!({ "display_name": "New", "email": "new@example.com", "password": "incorrect-incorrect" }),
        )
        .await;
    assert_eq!(wrong.error(), "invalid_password");
    // On an error everything stays as it was.
    assert_eq!(env.me(&session).await["display_name"], "Max Mustermann");

    let sent = env
        .patch_me(
            &session,
            json!({ "display_name": "New", "email": "new@example.com", "password": PASSWORD }),
        )
        .await;
    assert_eq!(sent.status, StatusCode::OK, "{}", sent.body);
    assert_eq!(sent.json()["user"]["display_name"], "New");
    assert_eq!(env.me(&session).await["display_name"], "New");
    assert_eq!(
        env.kinds(&max).await,
        ["security.email_change", "account.profile"]
    );
    mails(&server, 2).await;
}

#[tokio::test]
async fn confirming_a_new_address_discards_links_to_the_old_one() {
    let (env, server) = env_with_mail().await;
    env.add_user("max", "max@example.com").await;
    let session = env.session("max").await;
    // A reset link to the previous address …
    env.post(
        "/auth/password/forgot",
        json!({ "email": "max@example.com" }),
        None,
    )
    .await;
    let reset = token(&mails(&server, 1).await[0], "/password/reset/");
    env.request_change(&session, "new@example.com").await;
    let link = confirm_token(&mails(&server, 3).await[2]);
    assert_eq!(env.confirm(&link, None).await["state"], "confirmed");
    // … is no longer valid after the confirmation.
    let reply = env
        .post(
            &format!("/auth/password/reset/{reset}"),
            json!({ "password": NEW_PASSWORD }),
            None,
        )
        .await;
    assert_eq!(reply.error(), "invalid_token");
    assert_eq!(env.login("max", PASSWORD).await.status, StatusCode::OK);
}

#[tokio::test]
async fn reset_lifts_the_login_lock_of_the_account() {
    let (env, server) = env_with_mail().await;
    env.add_user("max", "max@example.com").await;
    // Username and address each count on their own; the
    // address from a second IP so that its limit does not apply.
    let login_from = |ip: [u8; 4], login: &'static str, password: &'static str| {
        env.request(
            ip,
            Method::POST,
            "/auth/login",
            Some(json!({ "login": login, "password": password })),
            None,
        )
    };
    for (ip, login) in [(HOME, "max"), ([198, 51, 100, 9], "max@example.com")] {
        for _ in 0..10 {
            let reply = login_from(ip, login, "incorrect-incorrect").await;
            assert_eq!(reply.error(), "invalid_credentials");
        }
        let reply = login_from(ip, login, PASSWORD).await;
        assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
    }
    env.post(
        "/auth/password/forgot",
        json!({ "email": "max@example.com" }),
        None,
    )
    .await;
    let reset = token(&mails(&server, 1).await[0], "/password/reset/");
    let done = env
        .post(
            &format!("/auth/password/reset/{reset}"),
            json!({ "password": NEW_PASSWORD }),
            None,
        )
        .await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.body);
    assert_eq!(env.login("max", NEW_PASSWORD).await.status, StatusCode::OK);
    let reply = login_from([198, 51, 100, 9], "max@example.com", NEW_PASSWORD).await;
    assert_eq!(reply.status, StatusCode::OK);
}

/// The reset also lifts the limit for correct passwords: whoever
/// used it up with the old password no longer gets in with it.
#[tokio::test]
async fn reset_lifts_the_success_limit_of_the_login() {
    let (env, server) = env_with_mail().await;
    env.add_user("max", "max@example.com").await;
    for _ in 0..10 {
        assert_eq!(env.login("max", PASSWORD).await.status, StatusCode::OK);
    }
    let reply = env.login("max", PASSWORD).await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
    let before = server.mail().submitted.len();
    env.post(
        "/auth/password/forgot",
        json!({ "email": "max@example.com" }),
        None,
    )
    .await;
    let sent = mails(&server, before + 1).await;
    let reset = sent
        .iter()
        .find(|mail| text(mail).contains("/password/reset/"))
        .map(|mail| token(mail, "/password/reset/"))
        .expect("reset mail");
    let done = env
        .post(
            &format!("/auth/password/reset/{reset}"),
            json!({ "password": NEW_PASSWORD }),
            None,
        )
        .await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.body);
    assert_eq!(env.login("max", NEW_PASSWORD).await.status, StatusCode::OK);
}

#[tokio::test]
async fn without_system_mail_fails_before_any_check() {
    let env = env().await;
    env.add_user("max", "max@example.com").await;
    let session = env.session("max").await;
    // A wrong password does not count either and is not checked.
    for _ in 0..6 {
        let reply = env
            .patch_me(
                &session,
                json!({ "email": "new@example.com", "password": "incorrect-incorrect" }),
            )
            .await;
        assert_eq!(reply.status, StatusCode::BAD_GATEWAY);
        assert_eq!(reply.error(), "mail_failed");
    }
    let step = env
        .patch_me(&session, json!({ "email": "new@example.com" }))
        .await;
    assert_eq!(step.json()["status"], "reauth_required");
    // The shared limit is untouched.
    let wrong = env
        .request(
            HOME,
            Method::PUT,
            "/auth/password",
            Some(
                json!({ "current_password": "incorrect-incorrect", "new_password": NEW_PASSWORD }),
            ),
            Some(&session),
        )
        .await;
    assert_eq!(wrong.error(), "invalid_password");
}

#[tokio::test]
async fn resend_replaces_the_link_and_keeps_it_when_sending_fails() {
    let (env, server) = env_with_mail().await;
    env.add_user("max", "max@example.com").await;
    let session = env.session("max").await;
    env.request_change(&session, "new@example.com").await;
    let first = confirm_token(&mails(&server, 2).await[1]);

    let resent = env
        .request(
            HOME,
            Method::POST,
            "/auth/me/email/resend",
            None,
            Some(&session),
        )
        .await;
    assert_eq!(resent.status, StatusCode::OK, "{}", resent.body);
    assert_eq!(resent.json()["email"], "new@example.com");
    // The notice to the previous address goes out again too.
    let sent = mails(&server, 4).await;
    assert_eq!(to(&sent[2]), "max@example.com");
    assert_eq!(to(&sent[3]), "new@example.com");
    let second = confirm_token(&sent[3]);
    assert_eq!(env.check(&first, None).await["state"], "invalid");
    assert_eq!(env.check(&second, None).await["state"], "valid");

    server.reject_mail_to(Some("new@example.com"));
    let failed = env
        .request(
            HOME,
            Method::POST,
            "/auth/me/email/resend",
            None,
            Some(&session),
        )
        .await;
    assert_eq!(failed.status, StatusCode::BAD_GATEWAY);
    assert_eq!(
        failed.json(),
        json!({ "error": "mail_failed", "previous_link_valid": true })
    );
    assert_eq!(env.check(&second, None).await["state"], "valid");

    // If the previous link has expired, the response says so.
    env.sql(|conn| {
        conn.execute(
            "UPDATE email_changes SET expires_at = '2000-01-01T00:00:00.000Z'",
            [],
        )
    })
    .await;
    let expired = env
        .request(
            HOME,
            Method::POST,
            "/auth/me/email/resend",
            None,
            Some(&session),
        )
        .await;
    assert_eq!(expired.json()["previous_link_valid"], false);
    // The change stays open until it is discarded or replaced.
    assert_eq!(
        env.me(&session).await["email_change"]["email"],
        "new@example.com"
    );
    server.reject_mail_to(None);
    let again = env
        .request(
            HOME,
            Method::POST,
            "/auth/me/email/resend",
            None,
            Some(&session),
        )
        .await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.body);
}

#[tokio::test]
async fn discard_and_security_steps_invalidate_open_links() {
    let (env, server) = env_with_mail().await;
    env.add_user("max", "max@example.com").await;
    let session = env.session("max").await;
    let mut sent = 0;

    // "Discard change"
    let token = change_link(&env, &server, &session, &mut sent).await;
    let discarded = env
        .request(HOME, Method::DELETE, "/auth/me/email", None, Some(&session))
        .await;
    assert_eq!(discarded.status, StatusCode::NO_CONTENT);
    assert_eq!(env.check(&token, None).await["state"], "invalid");
    assert_eq!(env.me(&session).await["email_change"], Value::Null);
    let nothing = env
        .request(HOME, Method::DELETE, "/auth/me/email", None, Some(&session))
        .await;
    assert_eq!(nothing.status, StatusCode::NOT_FOUND);
    // A stale pending link is no open change either.
    let id = env.me(&session).await["id"].as_str().unwrap().to_owned();
    env.sql(move |conn| {
        conn.execute(
            "INSERT INTO email_changes (id, user_id, token_hash, new_email, expires_at) \
             VALUES ('x', ?1, zeroblob(32), 'new@example.com', '2099-01-01T00:00:00.000Z')",
            [&id],
        )
    })
    .await;
    let reserved = env
        .request(HOME, Method::DELETE, "/auth/me/email", None, Some(&session))
        .await;
    assert_eq!(reserved.status, StatusCode::NOT_FOUND);

    // "Sign out all others"
    let token = change_link(&env, &server, &session, &mut sent).await;
    let revoked = env
        .request(
            HOME,
            Method::POST,
            "/auth/sessions/revoke-others",
            None,
            Some(&session),
        )
        .await;
    assert_eq!(revoked.status, StatusCode::OK);
    assert_eq!(env.check(&token, None).await["state"], "invalid");

    // Change password (with "Password changed" as a further mail)
    let token = change_link(&env, &server, &session, &mut sent).await;
    let changed = env
        .request(
            HOME,
            Method::PUT,
            "/auth/password",
            Some(json!({ "current_password": PASSWORD, "new_password": NEW_PASSWORD })),
            Some(&session),
        )
        .await;
    assert_eq!(changed.status, StatusCode::OK, "{}", changed.body);
    assert_eq!(env.confirm(&token, None).await["state"], "invalid");
    assert_eq!(env.me(&session).await["email"], "max@example.com");
    mails(&server, sent + 1).await;
}

#[tokio::test]
async fn address_taken_meanwhile_is_rejected_on_confirm() {
    let (env, server) = env_with_mail().await;
    env.add_user("max", "max@example.com").await;
    let session = env.session("max").await;
    env.request_change(&session, "new@example.com").await;
    let token = confirm_token(&mails(&server, 2).await[1]);

    // Meanwhile the address belongs to another (also locked) account.
    let other = env.add_user("new", "NEW@example.com").await;
    env.sql(move |conn| conn.execute("UPDATE users SET status = 'locked' WHERE id = ?1", [&other]))
        .await;
    assert_eq!(env.check(&token, Some(&session)).await["state"], "invalid");
    assert_eq!(
        env.confirm(&token, Some(&session)).await["state"],
        "invalid"
    );
    assert_eq!(env.me(&session).await["email"], "max@example.com");
    let resend = env
        .request(
            HOME,
            Method::POST,
            "/auth/me/email/resend",
            None,
            Some(&session),
        )
        .await;
    assert_eq!(resend.error(), "email_taken");
}

/// The full "taken" check knows locked accounts; every lookup counts towards
/// the send limit, even without a mail.
#[tokio::test]
async fn probing_taken_addresses_is_limited() {
    let (env, server) = env_with_mail().await;
    env.add_user("max", "max@example.com").await;
    let other = env.add_user("eva", "eva@example.com").await;
    env.sql(move |conn| conn.execute("UPDATE users SET status = 'locked' WHERE id = ?1", [&other]))
        .await;
    let session = env.session("max").await;
    for _ in 0..5 {
        let reply = env.request_change(&session, "eva@example.com").await;
        assert_eq!(reply.error(), "email_taken");
    }
    let limited = env.request_change(&session, "eva@example.com").await;
    assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
    mails(&server, 0).await;
}

#[tokio::test]
async fn sending_links_is_limited_per_user() {
    let (env, server) = env_with_mail().await;
    env.add_user("max", "max@example.com").await;
    let session = env.session("max").await;
    let first = env.request_change(&session, "new@example.com").await;
    assert_eq!(first.status, StatusCode::OK);
    for _ in 0..4 {
        let resent = env
            .request(
                HOME,
                Method::POST,
                "/auth/me/email/resend",
                None,
                Some(&session),
            )
            .await;
        assert_eq!(resent.status, StatusCode::OK, "{}", resent.body);
    }
    let limited = env
        .request(
            HOME,
            Method::POST,
            "/auth/me/email/resend",
            None,
            Some(&session),
        )
        .await;
    assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(limited.json()["retry_after"].as_u64().unwrap() > 0);
    mails(&server, 10).await;
}
