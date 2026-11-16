//! Invitations, user management, "reset multi-factor authentication" and
//! maintenance mode via the API.

mod fake_stalwart;

use std::{collections::BTreeSet, net::SocketAddr, sync::Arc, time::Duration};

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
            email_changes, known_devices, notifications, servers as server_repo, totp_devices,
            users::{self, NewUser, Role},
        },
    },
    i18n,
    mailer::system_mail::{self, SystemMail},
    settings::Language,
    web::{maintenance::Mode, static_files::WebAssets},
};
use serde_json::{Value, json};
use tower::ServiceExt as _;
use url::Url;

const PASSWORD: &str = "Summer2026!";
const NEW_PASSWORD: &str = "Winter2026!";
const FIREFOX: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
const HOME: [u8; 4] = [89, 12, 34, 56];
const LINK: &str = "https://app.example.com/invite/";

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
    /// User whose browser is already known in the test.
    async fn add(&self, username: &str, name: &str, role: Role) -> String {
        let hash = self.state.hasher.hash(PASSWORD).await.unwrap();
        let (username, name) = (username.to_owned(), name.to_owned());
        let email = format!("{username}@example.com");
        let device = Device::parse(Some(FIREFOX)).hash(&self.state.secrets, HOME.into());
        db::call(&self.state.db, move |conn| {
            let id = users::insert(
                conn,
                &NewUser {
                    username: &username,
                    email: &email,
                    display_name: &name,
                    role,
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

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        cookies: &[(&str, &str)],
    ) -> Reply {
        let mut builder = Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"))
            .header(api::CSRF_HEADER, "fetch")
            .header(header::USER_AGENT, FIREFOX);
        if !cookies.is_empty() {
            let cookie: Vec<String> = cookies.iter().map(|(n, v)| format!("{n}={v}")).collect();
            builder = builder.header(header::COOKIE, cookie.join("; "));
        }
        let request = match body {
            Some(body) => builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string())),
            None => builder.body(Body::empty()),
        }
        .unwrap();
        let app: Router =
            router(self.state.clone()).layer(MockConnectInfo(SocketAddr::from((HOME, 4711))));
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

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        session: Option<&str>,
    ) -> Reply {
        let cookies: Vec<(&str, &str)> =
            session.map(|s| (session::COOKIE, s)).into_iter().collect();
        self.send(method, path, body, &cookies).await
    }

    async fn get(&self, path: &str, session: Option<&str>) -> Reply {
        self.request(Method::GET, path, None, session).await
    }

    async fn post(&self, path: &str, body: Value, session: Option<&str>) -> Reply {
        self.request(Method::POST, path, Some(body), session).await
    }

    async fn login(&self, login: &str, password: &str) -> Reply {
        self.post(
            "/auth/login",
            json!({ "login": login, "password": password }),
            None,
        )
        .await
    }

    async fn session(&self, username: &str) -> String {
        let reply = self
            .login(&format!("{username}@example.com"), PASSWORD)
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.cookie(session::COOKIE).unwrap()
    }

    /// Invites and returns the response.
    async fn invite(&self, admin: &str, emails: &[&str], role: &str) -> Reply {
        self.post(
            "/invites",
            json!({ "emails": emails, "role": role }),
            Some(admin),
        )
        .await
    }

    /// Invites an address; returns ID and token of the link.
    async fn invite_one(&self, admin: &str, email: &str, body: Value) -> (String, String) {
        let mut body = body;
        body["emails"] = json!([email]);
        let reply = self.post("/invites", body, Some(admin)).await;
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
        let id = reply.json()["invites"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let link = self.get(&format!("/invites/{id}/link"), Some(admin)).await;
        assert_eq!(link.status, StatusCode::OK, "{}", link.body);
        let url = link.json()["url"].as_str().unwrap().to_owned();
        (id, url.strip_prefix(LINK).unwrap().to_owned())
    }

    /// Multi-factor step of the invitation; returns the secret.
    async fn enroll(&self, token: &str) -> Vec<u8> {
        let reply = self
            .post(&format!("/invites/{token}/totp"), json!({}), None)
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        let body = reply.json();
        assert!(body["uri"].as_str().unwrap().starts_with("otpauth://totp/"));
        totp_rs::Secret::try_from_base32(body["secret"].as_str().unwrap())
            .unwrap()
            .to_vec()
    }

    async fn accept(&self, token: &str, body: Value) -> Reply {
        self.post(&format!("/invites/{token}/accept"), body, None)
            .await
    }

    async fn users(&self, admin: &str) -> Vec<Value> {
        let reply = self.get("/users", Some(admin)).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.json()["users"].as_array().unwrap().clone()
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

    async fn expire_invitations(&self) {
        self.sql(|conn| {
            conn.execute(
                "UPDATE invitations SET expires_at = '2000-01-01T00:00:00.000Z'",
                [],
            )
        })
        .await;
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

/// Token from the invitation link in the text variant.
fn link_token(mail: &Value) -> String {
    let text = text(mail);
    let start = text.find(LINK).unwrap_or_else(|| panic!("no link: {text}")) + LINK.len();
    text[start..start + 64].to_owned()
}

fn code(secret: &[u8]) -> String {
    totp_rs::Builder::new()
        .with_secret(secret.to_vec())
        .build()
        .unwrap()
        .generate(totp::now())
        .to_string()
}

fn row<'a>(rows: &'a [Value], email: &str) -> &'a Value {
    rows.iter()
        .find(|r| r["email"] == email)
        .unwrap_or_else(|| panic!("{email} missing: {rows:#?}"))
}

/// The invited person has no settings yet: the mail comes in the inviter's
/// language.
#[tokio::test]
async fn invitations_in_the_language_of_the_inviter() {
    let (env, server) = env_with_mail().await;
    env.add("anna", "Anna Becker", Role::Admin).await;
    let admin = env.session("anna").await;
    let reply = env
        .request(
            Method::PUT,
            "/settings",
            Some(json!({ "version": 0, "settings": { "lang": "de" } })),
            Some(&admin),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let reply = env.invite(&admin, &["jonas@example.com"], "user").await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let submitted = mails(&server, 1).await;
    // Not the default language: subject and text in German.
    let subject = i18n::tf(
        Language::German,
        "mail.invite.subject",
        &[("app", &"Roedy Mail")],
    );
    assert_eq!(submitted[0]["subject"], subject);
    let body = text(&submitted[0]);
    assert!(
        body.contains("Anna Becker") && !body.contains("has invited you"),
        "{body}"
    );
}

#[tokio::test]
async fn invites_are_created_even_if_a_mail_fails() {
    let (env, server) = env_with_mail().await;
    env.add("anna", "Anna Becker", Role::Admin).await;
    let admin = env.session("anna").await;
    server.reject_mail_to(Some("paul@example.com"));
    let reply = env
        .invite(
            &admin,
            &[
                "jonas@example.com",
                "paul@example.com",
                "eva@example.com",
                " JONAS@example.com",
            ],
            "user",
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let body = reply.json();
    assert_eq!(body["system_mail"], true);
    let sent: Vec<(&str, bool)> = body["invites"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| (i["email"].as_str().unwrap(), i["sent"].as_bool().unwrap()))
        .collect();
    // Duplicate addresses count once.
    assert_eq!(
        sent,
        [
            ("jonas@example.com", true),
            ("paul@example.com", false),
            ("eva@example.com", true)
        ]
    );
    let submitted = mails(&server, 2).await;
    assert_eq!(to(&submitted[0]), "jonas@example.com");
    assert!(
        text(&submitted[0]).contains("Anna Becker has invited you to Roedy Mail. Your role: User."),
        "{}",
        text(&submitted[0])
    );
    assert_eq!(server.mail().rejected.len(), 1);

    let rows = env.users(&admin).await;
    assert_eq!(rows.len(), 4);
    assert_eq!(row(&rows, "anna@example.com")["status"], "active");
    let paul = row(&rows, "paul@example.com");
    assert_eq!(paul["status"], "invited");
    assert_eq!(paul["mail_sent_at"], Value::Null, "not sent");
    assert_eq!(paul["invited_by"]["name"], "Anna Becker");
    assert!(row(&rows, "jonas@example.com")["mail_sent_at"].is_string());
    let invites = env
        .actions()
        .await
        .into_iter()
        .filter(|a| a == "users.invite")
        .count();
    assert_eq!(invites, 3);

    // The link from the mail is the same as "Copy link".
    let jonas = row(&rows, "jonas@example.com")["id"].as_str().unwrap();
    let link = env
        .get(&format!("/invites/{jonas}/link"), Some(&admin))
        .await;
    assert_eq!(
        link.json()["url"],
        format!("{LINK}{}", link_token(&submitted[0]))
    );
}

#[tokio::test]
async fn without_system_mail_invites_are_only_created() {
    let env = env().await;
    env.add("anna", "Anna Becker", Role::Admin).await;
    let admin = env.session("anna").await;
    let reply = env
        .post(
            "/invites",
            json!({ "emails": ["tim@example.com"], "role": "admin", "name": "Braun, Tim" }),
            Some(&admin),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let body = reply.json();
    assert_eq!(body["system_mail"], false);
    assert_eq!(body["invites"][0]["sent"], false);
    let id = body["invites"][0]["id"].as_str().unwrap();

    // Without system mail no "Resend".
    let resend = env
        .post(&format!("/invites/{id}/resend"), json!({}), Some(&admin))
        .await;
    assert_eq!(resend.status, StatusCode::BAD_GATEWAY);
    assert_eq!(resend.error(), "mail_failed");

    // The invitation page, without sign-in.
    let url = env
        .get(&format!("/invites/{id}/link"), Some(&admin))
        .await
        .json()["url"]
        .as_str()
        .unwrap()
        .to_owned();
    let token = url.strip_prefix(LINK).unwrap();
    let page = env.get(&format!("/invites/{token}"), None).await;
    assert_eq!(page.status, StatusCode::OK, "{}", page.body);
    let page = page.json();
    assert_eq!(page["email"], "tim@example.com");
    assert_eq!(page["name"], "Tim Braun");
    assert_eq!(page["role"], "admin");
    assert_eq!(page["inviter"], "Anna Becker");
    assert_eq!(page["expired"], false);
    assert_eq!(
        env.get(&format!("/invites/{}", "0".repeat(64)), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    // Without `X-Requested-With` (e.g. a foreign `<img>`) nothing counts
    // towards the per-IP limit.
    let request = Request::get(format!("/api/v1/invites/{token}"))
        .body(Body::empty())
        .unwrap();
    let app: Router =
        router(env.state.clone()).layer(MockConnectInfo(SocketAddr::from((HOME, 4711))));
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn taken_addresses_and_form_errors() {
    let env = env().await;
    let anna = env.add("anna", "Anna Becker", Role::Admin).await;
    let max = env.add("max", "Max Mustermann", Role::User).await;
    let eva = env.add("eva", "Eva Roth", Role::User).await;
    let admin = env.session("anna").await;
    env.invite_one(&admin, "jonas@example.com", json!({ "role": "user" }))
        .await;
    env.sql(move |conn| {
        conn.execute("UPDATE users SET status = 'locked' WHERE id = ?1", [&max])?;
        // Eva changes her address; the link has been sent. That does not
        // take the new address (an invitation makes the link invalid).
        let link = email_changes::reserve(conn, &eva, "new@example.com", &[7; 32]).unwrap();
        email_changes::release(conn, &link)?;
        Ok(())
    })
    .await;

    let reply = env
        .invite(
            &admin,
            &[
                "MAX@example.com",
                "jonas@example.com",
                "new@example.com",
                "broken",
                "free@example.com",
            ],
            "user",
        )
        .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        reply.json()["fields"],
        json!({ "emails.3": { "code": "invalid" } })
    );
    let reply = env
        .invite(
            &admin,
            &[
                "MAX@example.com",
                "jonas@example.com",
                "new@example.com",
                "free@example.com",
            ],
            "user",
        )
        .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        reply.json()["fields"],
        json!({
            "emails.0": { "code": "taken" },
            "emails.1": { "code": "taken" },
        })
    );
    // Nothing created, not even the free addresses.
    assert_eq!(env.users(&admin).await.len(), 4);

    let reply = env
        .post(
            "/invites",
            json!({ "emails": ["a@example.com", "b@example.com"], "role": "user", "name": "A" }),
            Some(&admin),
        )
        .await;
    assert_eq!(reply.json()["fields"]["name"]["code"], "single_only");
    let reply = env.invite(&admin, &[], "user").await;
    assert_eq!(reply.json()["fields"]["emails"]["code"], "required");
    let reply = env.invite(&admin, &["a@example.com"], "root").await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);

    // Administrators only.
    env.sql(move |conn| {
        conn.execute("UPDATE users SET status = 'active'", [])?;
        Ok(())
    })
    .await;
    let user = env.session("max").await;
    for path in ["/users", "/invites/x/link"] {
        assert_eq!(
            env.get(path, Some(&user)).await.status,
            StatusCode::FORBIDDEN
        );
    }
    let reply = env.invite(&user, &["a@example.com"], "user").await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    let _ = anna;
}

#[tokio::test]
async fn resend_keeps_the_link_and_renews_the_expiry() {
    let (env, server) = env_with_mail().await;
    env.add("anna", "Anna Becker", Role::Admin).await;
    env.add("lukas", "Lukas Wagner", Role::Admin).await;
    let admin = env.session("anna").await;
    let reply = env.invite(&admin, &["jonas@example.com"], "user").await;
    let id = reply.json()["invites"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let token = link_token(&mails(&server, 1).await[0]);

    // Expired: the page says so, accepting no longer works.
    env.expire_invitations().await;
    let page = env.get(&format!("/invites/{token}"), None).await.json();
    assert_eq!(page["expired"], true);
    let reply = env
        .post(&format!("/invites/{token}/totp"), json!({}), None)
        .await;
    assert_eq!(reply.error(), "invite_expired");

    // Resent by another administrator: the same link, new expiry, they count
    // as the inviter.
    let other = env.session("lukas").await;
    let reply = env
        .post(&format!("/invites/{id}/resend"), json!({}), Some(&other))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let invite = &reply.json()["invite"];
    assert_eq!(invite["expired"], false);
    assert!(invite["mail_sent_at"].is_string());
    let submitted = mails(&server, 2).await;
    assert_eq!(link_token(&submitted[1]), token);
    assert!(text(&submitted[1]).starts_with("Hi,\n\nLukas Wagner has invited you"));
    let page = env.get(&format!("/invites/{token}"), None).await.json();
    assert_eq!(
        (page["expired"].clone(), page["inviter"].clone()),
        (json!(false), json!("Lukas Wagner"))
    );

    // If sending fails, everything stays as it was.
    let before = row(&env.users(&admin).await, "jonas@example.com").clone();
    server.reject_mail_to(Some("jonas@example.com"));
    let reply = env
        .post(&format!("/invites/{id}/resend"), json!({}), Some(&admin))
        .await;
    assert_eq!(reply.status, StatusCode::BAD_GATEWAY);
    assert_eq!(reply.error(), "mail_failed");
    assert_eq!(row(&env.users(&admin).await, "jonas@example.com"), &before);
    let resends = env
        .actions()
        .await
        .into_iter()
        .filter(|a| a == "users.invite_resend")
        .count();
    assert_eq!(resends, 1);
}

/// "Extend": valid for seven days again, the same link, no mail;
/// the acting administrator becomes the inviter.
#[tokio::test]
async fn renew_keeps_the_link_without_a_mail() {
    let (env, server) = env_with_mail().await;
    env.add("anna", "Anna Becker", Role::Admin).await;
    env.add("lukas", "Lukas Wagner", Role::Admin).await;
    env.add("max", "Max Mustermann", Role::User).await;
    let admin = env.session("anna").await;
    let (id, token) = env
        .invite_one(&admin, "jonas@example.com", json!({ "role": "user" }))
        .await;
    mails(&server, 1).await;
    let link = env.get(&format!("/invites/{id}/link"), Some(&admin)).await;
    let sent_at = row(&env.users(&admin).await, "jonas@example.com")["mail_sent_at"].clone();
    assert!(sent_at.is_string());
    env.expire_invitations().await;
    let path = format!("/invites/{id}/renew");

    // Administrators only and only with `X-Requested-With`.
    let user = env.session("max").await;
    let reply = env.post(&path, json!({}), Some(&user)).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    let request = Request::post(format!("/api/v1{path}"))
        .header(header::COOKIE, format!("{}={admin}", session::COOKIE))
        .body(Body::empty())
        .unwrap();
    let app: Router =
        router(env.state.clone()).layer(MockConnectInfo(SocketAddr::from((HOME, 4711))));
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let rows = env.users(&admin).await;
    assert_eq!(row(&rows, "jonas@example.com")["expired"], true);
    let reply = env
        .post("/invites/unknown/renew", json!({}), Some(&admin))
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);

    // By another administrator: valid again, they count as the inviter.
    let other = env.session("lukas").await;
    let before = jiff::Timestamp::now();
    let reply = env.post(&path, json!({}), Some(&other)).await;
    let after = jiff::Timestamp::now();
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let invite = &reply.json()["invite"];
    assert_eq!(invite["id"], id.as_str());
    assert_eq!(invite["expired"], false);
    assert_eq!(invite["mail_sent_at"], sent_at, "no mail");
    assert_eq!(invite["invited_by"]["name"], "Lukas Wagner");
    let expires: jiff::Timestamp = invite["expires_at"].as_str().unwrap().parse().unwrap();
    let week = jiff::SignedDuration::from_hours(7 * 24);
    // Milliseconds as in the database.
    let slack = jiff::SignedDuration::from_millis(1);
    assert!(
        expires >= before + week - slack && expires <= after + week + slack,
        "{expires}"
    );
    assert_eq!(row(&env.users(&admin).await, "jonas@example.com"), invite);

    // The same link, and it is valid again.
    let again = env.get(&format!("/invites/{id}/link"), Some(&admin)).await;
    assert_eq!(again.json()["url"], link.json()["url"]);
    let page = env.get(&format!("/invites/{token}"), None).await.json();
    assert_eq!(
        (page["expired"].clone(), page["inviter"].clone()),
        (json!(false), json!("Lukas Wagner"))
    );
    mails(&server, 1).await;
    let renewals = env
        .actions()
        .await
        .into_iter()
        .filter(|a| a == "users.invite_renew")
        .count();
    assert_eq!(renewals, 1);
    let details = env
        .sql(|conn| {
            conn.query_row(
                "SELECT details FROM audit_log WHERE action = 'users.invite_renew'",
                [],
                |r| r.get::<_, String>(0),
            )
        })
        .await;
    assert_eq!(
        serde_json::from_str::<Value>(&details).unwrap(),
        json!({ "email": "jonas@example.com" })
    );

    // A valid invitation can be extended the same way.
    let reply = env.post(&path, json!({}), Some(&admin)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.json()["invite"]["invited_by"]["name"], "Anna Becker");

    // Withdrawn: 404.
    let reply = env
        .request(
            Method::DELETE,
            &format!("/invites/{id}"),
            None,
            Some(&admin),
        )
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    let reply = env.post(&path, json!({}), Some(&admin)).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    mails(&server, 1).await;
}

#[tokio::test]
async fn accepting_needs_a_code_and_signs_in() {
    let env = env().await;
    let anna = env.add("anna", "Anna Becker", Role::Admin).await;
    let admin = env.session("anna").await;
    let (_, token) = env
        .invite_one(
            &admin,
            "jonas@example.com",
            json!({ "role": "user", "name": "Schulz, Jonas" }),
        )
        .await;
    let page = env.get(&format!("/invites/{token}"), None).await.json();
    assert_eq!(page["name"], "Jonas Schulz");

    let body =
        |code: &str| json!({ "name": "Jonas Schulz", "password": NEW_PASSWORD, "code": code });
    // Without the multi-factor step no account.
    let reply = env.accept(&token, body("123456")).await;
    assert_eq!(reply.error(), "totp_required");

    let secret = env.enroll(&token).await;
    let wrong = code(b"a completely different secret");
    let reply = env.accept(&token, body(&wrong)).await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(reply.error(), "invalid_code");
    let reply = env
        .accept(
            &token,
            json!({ "name": " ", "password": "short", "code": code(&secret) }),
        )
        .await;
    let fields = &reply.json()["fields"];
    assert_eq!(fields["name"]["code"], "required");
    assert_eq!(fields["password"]["code"], "policy");

    let reply = env.accept(&token, body(&code(&secret))).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let accepted = reply.json();
    assert_eq!(accepted["user"]["email"], "jonas@example.com");
    assert_eq!(accepted["user"]["role"], "user");
    assert_eq!(accepted["user"]["display_name"], "Jonas Schulz");
    assert_eq!(accepted["recovery_codes"].as_array().unwrap().len(), 10);
    let jonas = env.session_cookie(&reply);
    let me = env.get("/auth/me", Some(&jonas)).await;
    assert_eq!(me.status, StatusCode::OK, "{}", me.body);
    let me = me.json();
    assert_eq!(me["mfa_enabled"], true);
    let jonas_id = me["id"].as_str().unwrap().to_owned();

    // The invitation is gone, the account has multi-factor.
    assert_eq!(
        env.get(&format!("/invites/{token}"), None).await.status,
        StatusCode::NOT_FOUND
    );
    let rows = env.users(&admin).await;
    assert_eq!(rows.len(), 2);
    let row = row(&rows, "jonas@example.com");
    assert_eq!(
        (row["status"].clone(), row["mfa"].clone()),
        (json!("active"), json!(true))
    );
    let login = env.login("jonas@example.com", NEW_PASSWORD).await;
    assert_eq!(login.json()["status"], "totp_required");

    // Administrators learn about it; the first device is known, the new
    // person gets "Welcome".
    assert_eq!(env.kinds(&anna).await, ["team.invite_accepted"]);
    assert_eq!(env.kinds(&jonas_id).await, ["news.welcome"]);
    let actions = env.actions().await;
    assert!(actions.ends_with(&["users.invite_accept".into(), "auth.login".into()]));
}

impl Env {
    /// Session that was created before maintenance mode (created directly).
    async fn session_while_on(&self, username: &str) -> String {
        let email = format!("{username}@example.com");
        let cookie = self
            .sql(move |conn| {
                let id = users::find_for_login(conn, &email)?.unwrap().user.id;
                Ok(session::start(conn, &id, &session::Client::default(), true)
                    .unwrap()
                    .cookie)
            })
            .await;
        let value = cookie.to_str().unwrap().split(';').next().unwrap();
        value[session::COOKIE.len() + 1..].to_owned()
    }

    fn session_cookie(&self, reply: &Reply) -> String {
        reply.cookie(session::COOKIE).expect("session cookie")
    }
}

#[tokio::test]
async fn expired_invitations_can_be_requested_once_a_day() {
    let env = env().await;
    let anna = env.add("anna", "Anna Becker", Role::Admin).await;
    let lukas = env.add("lukas", "Lukas Wagner", Role::Admin).await;
    let admin = env.session("anna").await;
    let (id, token) = env
        .invite_one(&admin, "jonas@example.com", json!({ "role": "user" }))
        .await;
    let path = format!("/invites/{token}/request");
    let reply = env.post(&path, json!({}), None).await;
    assert_eq!(reply.error(), "invite_valid");

    env.expire_invitations().await;
    for _ in 0..2 {
        let reply = env.post(&path, json!({}), None).await;
        assert_eq!(reply.status, StatusCode::ACCEPTED, "{}", reply.body);
    }
    // Reported once, to all administrators.
    for admin in [&anna, &lukas] {
        assert_eq!(env.kinds(admin).await, ["team.invite_requested"]);
    }
    let unknown = env
        .post(
            &format!("/invites/{}/request", "a".repeat(64)),
            json!({}),
            None,
        )
        .await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);

    // Withdrawn: the link is no longer valid.
    let path = format!("/invites/{id}");
    let reply = env.request(Method::DELETE, &path, None, Some(&admin)).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    let reply = env.request(Method::DELETE, &path, None, Some(&admin)).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(
        env.get(&format!("/invites/{token}"), None).await.status,
        StatusCode::NOT_FOUND
    );
    assert!(env.actions().await.contains(&"users.invite_revoke".into()));
}

#[tokio::test]
async fn role_lock_unlock_and_remove() {
    let env = env().await;
    let anna = env.add("anna", "Anna Becker", Role::Admin).await;
    let lukas = env.add("lukas", "Lukas Wagner", Role::Admin).await;
    let max = env.add("max", "Max Mustermann", Role::User).await;
    let admin = env.session("anna").await;
    let user = env.session("max").await;

    let reply = env
        .request(
            Method::PATCH,
            &format!("/users/{max}"),
            Some(json!({ "role": "admin" })),
            Some(&admin),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.json()["user"]["role"], "admin");
    assert_eq!(env.kinds(&lukas).await, ["team.role_changed"]);
    assert!(env.kinds(&anna).await.is_empty(), "not to the acting one");
    let reply = env
        .request(
            Method::PATCH,
            &format!("/users/{anna}"),
            Some(json!({ "role": "user" })),
            Some(&admin),
        )
        .await;
    assert_eq!(reply.error(), "own_account");

    // Locking signs out immediately and discards open links.
    let target = max.clone();
    env.sql(move |conn| {
        let link = email_changes::reserve(conn, &target, "new@example.com", &[7; 32]).unwrap();
        email_changes::release(conn, &link)?;
        Ok(())
    })
    .await;
    let reply = env
        .post(&format!("/users/{max}/lock"), json!({}), Some(&admin))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.json()["user"]["status"], "locked");
    assert_eq!(
        env.get("/auth/me", Some(&user)).await.status,
        StatusCode::UNAUTHORIZED
    );
    let target = max.clone();
    let open = env
        .sql(move |conn| email_changes::open(conn, &target))
        .await;
    assert_eq!(open, None);
    assert_eq!(
        env.kinds(&lukas).await,
        ["team.user_locked", "team.role_changed"]
    );
    let login = env.login("max@example.com", PASSWORD).await;
    assert_eq!(login.error(), "invalid_credentials");

    let reply = env
        .post(&format!("/users/{max}/unlock"), json!({}), Some(&admin))
        .await;
    assert_eq!(reply.json()["user"]["status"], "active");
    env.session("max").await;

    let path = format!("/users/{max}");
    let reply = env.request(Method::DELETE, &path, None, Some(&admin)).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    let reply = env.request(Method::DELETE, &path, None, Some(&admin)).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(env.users(&admin).await.len(), 2);
    let actions = env.actions().await;
    for action in ["users.role", "users.lock", "users.unlock", "users.remove"] {
        assert!(
            actions.contains(&action.to_owned()),
            "{action}: {actions:?}"
        );
    }
}

#[tokio::test]
async fn bulk_actions_mix_users_and_invitations() {
    let env = env().await;
    let anna = env.add("anna", "Anna Becker", Role::Admin).await;
    let max = env.add("max", "Max Mustermann", Role::User).await;
    let eva = env.add("eva", "Eva Roth", Role::User).await;
    let admin = env.session("anna").await;
    let (jonas, _) = env
        .invite_one(&admin, "jonas@example.com", json!({ "role": "user" }))
        .await;
    let target = eva.clone();
    env.sql(move |conn| users::lock(conn, &target)).await;

    let bulk = |action: &str, ids: &[&str], role: Option<&str>| {
        let mut body = json!({ "action": action, "ids": ids });
        if let Some(role) = role {
            body["role"] = json!(role);
        }
        body
    };
    let changed = |reply: Reply| -> BTreeSet<String> {
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.json()["changed"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| id.as_str().unwrap().to_owned())
            .collect()
    };
    let set = |ids: &[&String]| ids.iter().map(|id| (*id).clone()).collect::<BTreeSet<_>>();

    let reply = env
        .post(
            "/users/bulk",
            bulk("role", &[&max, &jonas], Some("admin")),
            Some(&admin),
        )
        .await;
    assert_eq!(changed(reply), set(&[&max, &jonas]));
    let rows = env.users(&admin).await;
    assert_eq!(row(&rows, "jonas@example.com")["role"], "admin");
    assert_eq!(row(&rows, "max@example.com")["role"], "admin");

    // Locking only active accounts, no invitations.
    let reply = env
        .post(
            "/users/bulk",
            bulk("lock", &[&max, &eva, &jonas], None),
            Some(&admin),
        )
        .await;
    assert_eq!(changed(reply), set(&[&max]));
    let reply = env
        .post(
            "/users/bulk",
            bulk("unlock", &[&max, &eva], None),
            Some(&admin),
        )
        .await;
    assert_eq!(changed(reply), set(&[&max, &eva]));
    let reply = env
        .post(
            "/users/bulk",
            bulk("remove", &[&eva, &jonas, "unknown"], None),
            Some(&admin),
        )
        .await;
    assert_eq!(changed(reply), set(&[&eva, &jonas]));
    assert_eq!(env.users(&admin).await.len(), 2);

    let reply = env
        .post(
            "/users/bulk",
            bulk("lock", &[&max, &anna], None),
            Some(&admin),
        )
        .await;
    // The own account stays, like everything that does not match.
    assert_eq!(changed(reply), set(&[&max]));
    let reply = env
        .post("/users/bulk", bulk("role", &[&max], None), Some(&admin))
        .await;
    assert_eq!(reply.json()["fields"]["role"]["code"], "required");
}

#[tokio::test]
async fn reset_mfa_removes_apps_and_tells_the_person() {
    let (env, server) = env_with_mail().await;
    let anna = env.add("anna", "Anna Becker", Role::Admin).await;
    let lukas = env.add("lukas", "Lukas Wagner", Role::User).await;
    let secret = env.add_device(&lukas).await;
    let admin = env.session("anna").await;
    // Lukas is signed in (without a code, the session is created directly in
    // the test) and has already entered the password in a second browser.
    let user = {
        let id = lukas.clone();
        env.sql(move |conn| {
            Ok(session::start(conn, &id, &session::Client::default(), true)
                .unwrap()
                .cookie)
        })
        .await
    };
    let user =
        user.to_str().unwrap().split(';').next().unwrap()[session::COOKIE.len() + 1..].to_owned();
    let pending = env.login("lukas@example.com", PASSWORD).await;
    assert_eq!(pending.json()["status"], "totp_required");
    let challenge_cookie = pending.cookie(challenge::COOKIE).unwrap();

    let reply = env
        .post(
            &format!("/users/{lukas}/reset-mfa"),
            json!({}),
            Some(&admin),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.json()["user"]["mfa"], false);
    let submitted = mails(&server, 1).await;
    assert_eq!(to(&submitted[0]), "lukas@example.com");
    assert!(
        text(&submitted[0]).contains(
            "Anna Becker reset multi-factor authentication for your Roedy Mail account on "
        ),
        "{}",
        text(&submitted[0])
    );
    assert_eq!(env.kinds(&lukas).await, ["security.mfa_reset"]);
    assert!(env.actions().await.contains(&"users.mfa_reset".into()));

    // The sessions stay; a new app does not make the old intermediate step
    // valid again.
    assert_eq!(
        env.get("/auth/me", Some(&user)).await.status,
        StatusCode::OK
    );
    let enroll = env
        .post("/auth/totp/devices/enroll", json!({}), Some(&user))
        .await
        .json();
    let fresh = totp_rs::Secret::try_from_base32(enroll["secret"].as_str().unwrap())
        .unwrap()
        .to_vec();
    let confirm = env
        .post(
            "/auth/totp/devices/confirm",
            json!({ "id": enroll["id"], "password": PASSWORD, "code": code(&fresh) }),
            Some(&user),
        )
        .await;
    assert_eq!(confirm.status, StatusCode::OK, "{}", confirm.body);
    let reply = env
        .send(
            Method::POST,
            "/auth/totp",
            Some(json!({ "code": code(&fresh) })),
            &[(challenge::COOKIE, &challenge_cookie)],
        )
        .await;
    assert_eq!(reply.error(), "login_expired");
    let _ = secret;

    // Without an app, not for the own account and not for invitations.
    let target = lukas.clone();
    env.sql(move |conn| totp_devices::delete_all(conn, &target))
        .await;
    let reply = env
        .post(
            &format!("/users/{lukas}/reset-mfa"),
            json!({}),
            Some(&admin),
        )
        .await;
    assert_eq!(reply.error(), "mfa_disabled");
    let reply = env
        .post(&format!("/users/{anna}/reset-mfa"), json!({}), Some(&admin))
        .await;
    assert_eq!(reply.error(), "own_account");
    let (invite, _) = env
        .invite_one(&admin, "jonas@example.com", json!({ "role": "user" }))
        .await;
    let reply = env
        .post(
            &format!("/users/{invite}/reset-mfa"),
            json!({}),
            Some(&admin),
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn reset_mfa_works_without_system_mail() {
    let env = env().await;
    env.add("anna", "Anna Becker", Role::Admin).await;
    let lukas = env.add("lukas", "Lukas Wagner", Role::Admin).await;
    env.add_device(&lukas).await;
    let admin = env.session("anna").await;
    let reply = env
        .post(
            &format!("/users/{lukas}/reset-mfa"),
            json!({}),
            Some(&admin),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let login = env.login("lukas@example.com", PASSWORD).await;
    assert_eq!(login.json()["status"], "ok", "only with password now");
}

#[tokio::test]
async fn directory_lists_active_users_for_everyone() {
    let env = env().await;
    env.add("anna", "Anna Becker", Role::Admin).await;
    env.add("max", "Max Mustermann", Role::User).await;
    let eva = env.add("eva", "Eva Roth", Role::User).await;
    env.sql(move |conn| users::lock(conn, &eva)).await;
    let user = env.session("max").await;
    let reply = env.get("/directory", Some(&user)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(
        reply.json()["users"],
        json!([
            { "name": "Anna Becker", "email": "anna@example.com" },
            { "name": "Max Mustermann", "email": "max@example.com" },
        ])
    );
    assert_eq!(
        env.get("/directory", None).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn maintenance_lets_only_admins_in() {
    let env = env().await;
    env.add("anna", "Anna Becker", Role::Admin).await;
    env.add("max", "Max Mustermann", Role::User).await;
    let admin = env.session("anna").await;
    let user = env.session("max").await;
    let (_, token) = env
        .invite_one(&admin, "jonas@example.com", json!({ "role": "user" }))
        .await;
    let secret = env.enroll(&token).await;
    let (_, admin_token) = env
        .invite_one(&admin, "mia@example.com", json!({ "role": "admin" }))
        .await;
    let admin_secret = env.enroll(&admin_token).await;

    env.state.maintenance.set(Mode {
        on: true,
        message: Some("Until 6 pm".into()),
    });
    // The session without administrator rights ends at the first request, the
    // request counts as not signed in.
    let reply = env.get("/auth/me", Some(&user)).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    let cleared = reply.headers.get(header::SET_COOKIE).unwrap();
    assert!(
        cleared.to_str().unwrap().contains("Max-Age=0"),
        "{cleared:?}"
    );
    let sessions = env
        .sql(|conn| conn.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get::<_, i64>(0)))
        .await;
    assert_eq!(sessions, 1, "only the administrator's");
    assert!(env.actions().await.contains(&"auth.logout".into()));
    assert_eq!(
        env.get("/auth/me", Some(&admin)).await.status,
        StatusCode::OK
    );

    let login = env.login("max@example.com", PASSWORD).await;
    assert_eq!(login.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        login.json(),
        json!({ "error": "maintenance", "message": "Until 6 pm" })
    );
    assert_eq!(login.cookie(session::COOKIE), None);
    let reply = env
        .accept(
            &token,
            json!({ "name": "Jonas", "password": NEW_PASSWORD, "code": code(&secret) }),
        )
        .await;
    assert_eq!(reply.error(), "maintenance");
    let reply = env
        .accept(
            &admin_token,
            json!({ "name": "Mia Koch", "password": NEW_PASSWORD, "code": code(&admin_secret) }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);

    // From a browser in which a person without administrator rights is still
    // signed in: public endpoints and an administrator's sign-in work.
    let other = env.session_while_on("max").await;
    let page = env.get(&format!("/invites/{token}"), Some(&other)).await;
    assert_eq!(page.status, StatusCode::OK, "{}", page.body);
    let reply = env
        .post(
            "/auth/login",
            json!({ "login": "anna@example.com", "password": PASSWORD }),
            Some(&other),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert!(reply.cookie(session::COOKIE).is_some());

    env.state.maintenance.set(Mode::default());
    assert_eq!(
        env.login("max@example.com", PASSWORD).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn invited_addresses_are_taken_for_email_changes() {
    let (env, _server) = env_with_mail().await;
    env.add("anna", "Anna Becker", Role::Admin).await;
    env.add("max", "Max Mustermann", Role::User).await;
    let admin = env.session("anna").await;
    let user = env.session("max").await;
    env.invite_one(&admin, "jonas@example.com", json!({ "role": "user" }))
        .await;
    let reply = env
        .request(
            Method::PATCH,
            "/auth/me",
            Some(json!({ "email": "Jonas@example.com", "password": PASSWORD })),
            Some(&user),
        )
        .await;
    assert_eq!(
        reply.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        reply.body
    );
    assert_eq!(reply.error(), "email_taken");
}

#[tokio::test]
async fn open_email_changes_do_not_block_invitations() {
    let (env, server) = env_with_mail().await;
    env.add("anna", "Anna Becker", Role::Admin).await;
    env.add("max", "Max Mustermann", Role::User).await;
    let admin = env.session("anna").await;
    let user = env.session("max").await;
    let reply = env
        .request(
            Method::PATCH,
            "/auth/me",
            Some(json!({ "email": "jonas@example.com", "password": PASSWORD })),
            Some(&user),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let sent = mails(&server, 2).await;
    assert_eq!(to(&sent[1]), "jonas@example.com");
    let prefix = "https://app.example.com/confirm-email/";
    let text = text(&sent[1]);
    let start = text.find(prefix).unwrap() + prefix.len();
    let token = text[start..start + 64].to_owned();

    env.invite_one(&admin, "Jonas@example.com", json!({ "role": "user" }))
        .await;
    // The invitation makes the link invalid, and resending stops.
    let check = env
        .post("/auth/email/check", json!({ "token": token }), None)
        .await;
    assert_eq!(check.json()["state"], "invalid", "{}", check.body);
    let resend = env
        .request(Method::POST, "/auth/me/email/resend", None, Some(&user))
        .await;
    assert_eq!(resend.error(), "email_taken");
    mails(&server, 3).await;
}

#[tokio::test]
async fn invite_mails_are_limited_per_admin() {
    let (env, server) = env_with_mail().await;
    env.add("anna", "Anna Becker", Role::Admin).await;
    let admin = env.session("anna").await;
    let emails: Vec<String> = (0..50).map(|i| format!("person{i}@example.com")).collect();
    let emails: Vec<&str> = emails.iter().map(String::as_str).collect();
    let reply = env.invite(&admin, &emails, "user").await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    mails(&server, 50).await;
    let reply = env.invite(&admin, &["another@example.com"], "user").await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(reply.json()["retry_after"].as_u64().unwrap() > 0);
    // Nothing created.
    assert_eq!(env.users(&admin).await.len(), 51);
}

#[tokio::test]
async fn wrong_codes_lock_the_invitation_for_a_while() {
    let env = env().await;
    env.add("anna", "Anna Becker", Role::Admin).await;
    let admin = env.session("anna").await;
    let (_, token) = env
        .invite_one(&admin, "jonas@example.com", json!({ "role": "user" }))
        .await;
    let secret = env.enroll(&token).await;
    let body = |code: String| json!({ "name": "Jonas", "password": NEW_PASSWORD, "code": code });
    let wrong = code(b"a completely different secret");
    for _ in 0..5 {
        let reply = env.accept(&token, body(wrong.clone())).await;
        assert_eq!(reply.error(), "invalid_code");
    }
    // Locked, even with the right code.
    let reply = env.accept(&token, body(code(&secret))).await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
}
