//! Sessions and devices via the API: list with device and place, single and
//! "sign out all others", known devices with "new sign-in", security events and mails, and the jobs
//! for cleanup and server diagnostics.

mod fake_stalwart;
mod geoip_db;

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
        password::{Hasher, Params},
        session, totp,
    },
    broker::crypto::SecretKey,
    config::Config,
    db::{
        self, Db,
        repo::{
            notifications::{self, Notification},
            servers as server_repo,
            users::{self, NewUser, Role},
        },
    },
    geoip::GeoIp,
    jobs,
    mailer::system_mail::{self, SystemMail},
    web::static_files::WebAssets,
};
use serde_json::{Value, json};
use tower::ServiceExt as _;
use url::Url;

const PASSWORD: &str = "Summer2026!";
const FIREFOX: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
const IPHONE: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 \
                      (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const HOME: [u8; 4] = [89, 12, 34, 56];
const AWAY: [u8; 4] = [91, 64, 1, 2];

struct Env {
    tmp: tempfile::TempDir,
    state: AppState,
}

/// Who makes a request: browser and address.
#[derive(Clone, Copy)]
struct From {
    agent: &'static str,
    ip: [u8; 4],
    /// Identifies as the installed app (`X-Roedy-App`).
    app: bool,
}

const DESKTOP: From = From {
    agent: FIREFOX,
    ip: HOME,
    app: false,
};
const PHONE: From = From {
    agent: IPHONE,
    ip: AWAY,
    app: false,
};

async fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let conn = db::open(tmp.path()).unwrap();
    let config = Config::default();
    let mut state = AppState::new(
        Db::from(conn),
        Arc::new(WebAssets::None),
        &config,
        Url::parse("https://app.example.com").unwrap(),
        SecretKey::random().unwrap(),
    )
    .unwrap();
    state.hasher = Arc::new(Hasher::with_params(Params::new(64, 1, 1, None).unwrap()));
    Env { tmp, state }
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
    async fn add_user(&self, username: &str, email: &str) -> String {
        self.add_with_role(username, email, Role::User).await
    }

    async fn add_with_role(&self, username: &str, email: &str, role: Role) -> String {
        let hash = self.state.hasher.hash(PASSWORD).await.unwrap();
        let (username, email) = (username.to_owned(), email.to_owned());
        db::call(&self.state.db, move |conn| {
            users::insert(
                conn,
                &NewUser {
                    username: &username,
                    email: &email,
                    display_name: "Max Mustermann",
                    role,
                    password_hash: &hash,
                },
            )
        })
        .await
        .unwrap()
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
        from: From,
        method: Method,
        path: &str,
        body: Option<Value>,
        cookies: &[(&str, &str)],
    ) -> Reply {
        let mut builder = Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"))
            .header(api::CSRF_HEADER, "fetch")
            .header(header::USER_AGENT, from.agent);
        if from.app {
            builder = builder.header(session::APP_HEADER, "1");
        }
        if !cookies.is_empty() {
            let cookie: Vec<String> = cookies.iter().map(|(k, v)| format!("{k}={v}")).collect();
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
            router(self.state.clone()).layer(MockConnectInfo(SocketAddr::from((from.ip, 4711))));
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

    async fn login(&self, from: From, login: &str) -> Reply {
        self.request(
            from,
            Method::POST,
            "/auth/login",
            Some(json!({ "login": login, "password": PASSWORD })),
            &[],
        )
        .await
    }

    async fn session(&self, from: From, login: &str) -> String {
        let reply = self.login(from, login).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.cookie(session::COOKIE).unwrap()
    }

    async fn as_user(
        &self,
        from: From,
        session: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Reply {
        self.request(from, method, path, body, &[(session::COOKIE, session)])
            .await
    }

    async fn notifications(&self, user: &str) -> Vec<Notification> {
        let user = user.to_owned();
        db::call(&self.state.db, move |conn| notifications::list(conn, &user))
            .await
            .unwrap()
    }

    async fn audit(&self) -> Vec<(String, Option<String>)> {
        self.sql(|conn| {
            conn.prepare("SELECT action, place FROM audit_log ORDER BY id")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
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

    fn clears_session(&self) -> bool {
        self.headers.get_all(header::SET_COOKIE).iter().any(|c| {
            c.to_str()
                .unwrap()
                .starts_with(&format!("{}=;", session::COOKIE))
        })
    }
}

/// Waits until the test server has sent `n` mails (the security mails go
/// out in the background), then checks that no further one follows.
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

/// The installed app identifies itself at sign-in; the user agent does not
/// reveal it.
#[tokio::test]
async fn installed_app_is_listed_with_its_system() {
    let env = env().await;
    env.add_user("max", "max@example.com").await;
    let desktop = env.session(DESKTOP, "max").await;
    // On the home screen "Safari/" is missing from the user agent.
    let app = From {
        agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) \
                AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
        ip: AWAY,
        app: true,
    };
    env.session(app, "max").await;
    // Without a recognizable system the device name stays.
    let unknown = From {
        agent: "Testclient",
        ip: AWAY,
        app: true,
    };
    env.session(unknown, "max").await;

    let listed = env
        .as_user(DESKTOP, &desktop, Method::GET, "/auth/sessions", None)
        .await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
    let sessions = listed.json()["sessions"].as_array().unwrap().clone();
    assert_eq!(sessions.len(), 3);
    assert_eq!(sessions[0]["device"], "Firefox on Linux");
    assert_eq!(sessions[0]["app"], Value::Null);
    assert_eq!(sessions[1]["device"], "Unknown device");
    assert_eq!(sessions[1]["app"], Value::Null);
    assert_eq!(sessions[2]["device"], "Browser on iPhone");
    assert_eq!(sessions[2]["device_type"], "mobile");
    assert_eq!(sessions[2]["app"], "iPhone");
}

#[tokio::test]
async fn lists_sessions_with_device_and_current_first() {
    let env = env().await;
    env.add_user("max", "max@example.com").await;
    let desktop = env.session(DESKTOP, "max").await;
    let phone = env.session(PHONE, "max").await;

    let listed = env
        .as_user(DESKTOP, &desktop, Method::GET, "/auth/sessions", None)
        .await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
    let sessions = listed.json()["sessions"].as_array().unwrap().clone();
    assert_eq!(sessions.len(), 2);
    // The own one first, although the phone was active last.
    assert_eq!(sessions[0]["current"], true);
    assert_eq!(sessions[0]["device"], "Firefox on Linux");
    assert_eq!(sessions[0]["device_type"], "desktop");
    assert_eq!(sessions[0]["ip"], "89.12.x.x");
    assert_eq!(sessions[0]["place"], Value::Null);
    assert_eq!(sessions[1]["current"], false);
    assert_eq!(sessions[1]["device"], "Safari on iPhone");
    assert_eq!(sessions[1]["device_type"], "mobile");
    assert_eq!(sessions[1]["ip"], "91.64.x.x");
    for s in &sessions {
        assert!(s["created_at"].is_string() && s["last_seen_at"].is_string());
    }

    // From the phone's point of view the phone is the current one.
    let from_phone = env
        .as_user(PHONE, &phone, Method::GET, "/auth/sessions", None)
        .await;
    assert_eq!(
        from_phone.json()["sessions"][0]["device"],
        "Safari on iPhone"
    );
    assert_eq!(from_phone.json()["sessions"][0]["current"], true);

    let anonymous = env
        .request(DESKTOP, Method::GET, "/auth/sessions", None, &[])
        .await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn revokes_single_sessions_and_the_own_like_logout() {
    let env = env().await;
    env.add_user("max", "max@example.com").await;
    env.add_user("eva", "eva@example.com").await;
    let desktop = env.session(DESKTOP, "max").await;
    let phone = env.session(PHONE, "max").await;
    let eva = env.session(DESKTOP, "eva").await;
    let ids = |reply: &Reply| -> Vec<String> {
        reply.json()["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap().to_owned())
            .collect()
    };
    let max_ids = ids(&env
        .as_user(DESKTOP, &desktop, Method::GET, "/auth/sessions", None)
        .await);
    let eva_ids = ids(&env
        .as_user(DESKTOP, &eva, Method::GET, "/auth/sessions", None)
        .await);

    let path = format!("/auth/sessions/{}", max_ids[1]);
    let revoked = env
        .as_user(DESKTOP, &desktop, Method::DELETE, &path, None)
        .await;
    assert_eq!(revoked.status, StatusCode::NO_CONTENT, "{}", revoked.body);
    assert!(!revoked.clears_session());
    let gone = env
        .as_user(PHONE, &phone, Method::GET, "/auth/me", None)
        .await;
    assert_eq!(gone.status, StatusCode::UNAUTHORIZED);
    let again = env
        .as_user(DESKTOP, &desktop, Method::DELETE, &path, None)
        .await;
    assert_eq!(again.status, StatusCode::NOT_FOUND);
    // Expired but not yet cleaned up: like ended.
    let stale = env.session(PHONE, "max").await;
    let stale_id = ids(&env
        .as_user(PHONE, &stale, Method::GET, "/auth/sessions", None)
        .await)[0]
        .clone();
    let expire = stale_id.clone();
    env.sql(move |conn| {
        conn.execute(
            "UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1",
            [&expire],
        )
    })
    .await;
    let expired = env
        .as_user(
            DESKTOP,
            &desktop,
            Method::DELETE,
            &format!("/auth/sessions/{stale_id}"),
            None,
        )
        .await;
    assert_eq!(expired.status, StatusCode::NOT_FOUND);
    // Other users' sessions are invisible.
    let foreign = format!("/auth/sessions/{}", eva_ids[0]);
    let denied = env
        .as_user(DESKTOP, &desktop, Method::DELETE, &foreign, None)
        .await;
    assert_eq!(denied.status, StatusCode::NOT_FOUND);
    let still = env
        .as_user(DESKTOP, &eva, Method::GET, "/auth/me", None)
        .await;
    assert_eq!(still.status, StatusCode::OK);

    // The own one: like "Sign out".
    let own = format!("/auth/sessions/{}", max_ids[0]);
    let out = env
        .as_user(DESKTOP, &desktop, Method::DELETE, &own, None)
        .await;
    assert_eq!(out.status, StatusCode::NO_CONTENT);
    assert!(out.clears_session());
    let me = env
        .as_user(DESKTOP, &desktop, Method::GET, "/auth/me", None)
        .await;
    assert_eq!(me.status, StatusCode::UNAUTHORIZED);

    let actions: Vec<String> = env.audit().await.into_iter().map(|(a, _)| a).collect();
    assert_eq!(
        actions
            .iter()
            .filter(|a| *a == "auth.session_revoke")
            .count(),
        1,
        "{actions:?}"
    );
    assert_eq!(actions.last().map(String::as_str), Some("auth.logout"));
}

#[tokio::test]
async fn revoke_others_keeps_the_own_session() {
    let env = env().await;
    env.add_user("max", "max@example.com").await;
    let desktop = env.session(DESKTOP, "max").await;
    let phone = env.session(PHONE, "max").await;
    let tablet = env.session(PHONE, "max").await;

    let reply = env
        .as_user(
            DESKTOP,
            &desktop,
            Method::POST,
            "/auth/sessions/revoke-others",
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.json(), json!({ "sessions_ended": 2 }));
    for other in [&phone, &tablet] {
        let gone = env
            .as_user(PHONE, other, Method::GET, "/auth/me", None)
            .await;
        assert_eq!(gone.status, StatusCode::UNAUTHORIZED);
    }
    let listed = env
        .as_user(DESKTOP, &desktop, Method::GET, "/auth/sessions", None)
        .await;
    assert_eq!(listed.json()["sessions"].as_array().unwrap().len(), 1);
    let again = env
        .as_user(
            DESKTOP,
            &desktop,
            Method::POST,
            "/auth/sessions/revoke-others",
            None,
        )
        .await;
    assert_eq!(again.json(), json!({ "sessions_ended": 0 }));
    let actions: Vec<String> = env.audit().await.into_iter().map(|(a, _)| a).collect();
    assert_eq!(
        actions
            .iter()
            .filter(|a| *a == "auth.sessions_revoke")
            .count(),
        2
    );
}

#[tokio::test]
async fn new_device_creates_event_and_mail_known_device_not() {
    let (env, server) = env_with_mail().await;
    let max = env.add_user("max", "max@example.com").await;
    // Without a remembered device the first sign-in is new too (only the device
    // the account is created with stays silent – `tests/setup.rs`).
    env.session(DESKTOP, "max").await;
    // The same device in the same network, newer version: known.
    let newer = From {
        agent: "Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0",
        ip: [89, 12, 34, 200],
        app: false,
    };
    env.session(newer, "max").await;
    assert_eq!(mails(&server, 1).await.len(), 1);
    assert_eq!(env.notifications(&max).await.len(), 1);

    // A phone: new.
    env.session(PHONE, "max").await;
    let mail = mails(&server, 2).await.pop().unwrap();
    assert_eq!(mail["subject"], "New sign-in to Roedy Mail");
    assert_eq!(mail["to"][0]["email"], "max@example.com");
    let body = text(&mail);
    assert!(body.contains("Device: Safari on iPhone"), "{body}");
    assert!(body.contains("IP address: 91.64.x.x"), "{body}");
    assert!(
        body.contains("https://app.example.com/account/security"),
        "{body}"
    );
    let event = env.notifications(&max).await.remove(0);
    assert_eq!(event.kind, "security.login");
    assert_eq!(event.topic, "security");
    assert_eq!(event.params["browser"], "Safari");
    assert_eq!(event.params["os"], "iPhone");
    assert_eq!(event.params["device_type"], "mobile");
    assert_eq!(event.params["ip"], "91.64.x.x");
    assert!(event.params["session_id"].is_string());

    // The same phone again: known. The same browser from another network:
    // new.
    env.session(PHONE, "max").await;
    let elsewhere = From {
        agent: FIREFOX,
        ip: [89, 13, 1, 1],
        app: false,
    };
    env.session(elsewhere, "max").await;
    let sent = mails(&server, 3).await;
    assert!(text(&sent[2]).contains("Device: Firefox on Linux"));
    assert_eq!(env.notifications(&max).await.len(), 3);
}

#[tokio::test]
async fn without_system_mail_only_the_event() {
    let env = env().await;
    let max = env.add_user("max", "max@example.com").await;
    env.session(DESKTOP, "max").await;
    env.session(PHONE, "max").await;
    let kinds: Vec<String> = env
        .notifications(&max)
        .await
        .into_iter()
        .map(|n| n.kind)
        .collect();
    assert_eq!(kinds, ["security.login", "security.login"]);
}

#[tokio::test]
async fn password_change_sends_mail_and_event() {
    let (env, server) = env_with_mail().await;
    let max = env.add_user("max", "max@example.com").await;
    let desktop = env.session(DESKTOP, "max").await;
    env.session(DESKTOP, "max").await;
    let changed = env
        .as_user(
            DESKTOP,
            &desktop,
            Method::PUT,
            "/auth/password",
            Some(json!({ "current_password": PASSWORD, "new_password": "Winter2026!x" })),
        )
        .await;
    assert_eq!(changed.status, StatusCode::OK, "{}", changed.body);
    // First "New sign-in" (no remembered device), then the change.
    let mail = mails(&server, 2).await.pop().unwrap();
    assert_eq!(mail["subject"], "Your password was changed");
    let body = text(&mail);
    for line in [
        "Device: Firefox on Linux\n",
        "Set a new password right away with",
        "and let your administrator know: they can suspend your account",
        "\n\nReset password:\nhttps://app.example.com/password/forgot\n",
    ] {
        assert!(body.contains(line), "{line:?} missing: {body}");
    }
    // No administrator: no hint about the operator.
    assert!(!body.contains("reset-admin"), "{body}");
    let event = env.notifications(&max).await.remove(0);
    assert_eq!(event.kind, "security.password");
    assert_eq!(
        event.params,
        json!({
            "browser": "Firefox",
            "os": "Linux",
            "device_type": "desktop",
            "sessions_ended": 1,
            "reset": false,
        })
    );

    // The same change again (submitted twice): the old password is no longer
    // the current one, the session stays.
    let twice = env
        .as_user(
            DESKTOP,
            &desktop,
            Method::PUT,
            "/auth/password",
            Some(json!({ "current_password": PASSWORD, "new_password": "Winter2026!x" })),
        )
        .await;
    assert_eq!(twice.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(twice.json()["error"], "invalid_password");
    let me = env
        .as_user(DESKTOP, &desktop, Method::GET, "/auth/me", None)
        .await;
    assert_eq!(me.status, StatusCode::OK);
}

/// The only active administrator cannot have themselves locked in the app:
/// "Password changed" and the first app name `roedy-mail reset-admin` instead
/// of the administration. Locked administrators do not
/// count.
#[tokio::test]
async fn sole_admin_is_told_about_reset_admin() {
    let (env, server) = env_with_mail().await;
    env.add_with_role("anna", "anna@example.com", Role::Admin)
        .await;
    let session = env.session(DESKTOP, "anna").await;
    mails(&server, 1).await;
    // The `n`-th new password; returns the text of "Password changed" (the
    // first mail was "New sign-in").
    let new_password = |n: usize| format!("Winter2026!{n}");
    let change = async |n: usize| {
        let current = if n == 1 {
            PASSWORD.to_owned()
        } else {
            new_password(n - 1)
        };
        let changed = env
            .as_user(
                DESKTOP,
                &session,
                Method::PUT,
                "/auth/password",
                Some(json!({ "current_password": current, "new_password": new_password(n) })),
            )
            .await;
        assert_eq!(changed.status, StatusCode::OK, "{}", changed.body);
        let mail = mails(&server, n + 1).await.pop().unwrap();
        assert_eq!(mail["subject"], "Your password was changed");
        let body = text(&mail).to_owned();
        assert!(
            body.contains("\nReset password:\nhttps://app.example.com/password/forgot\n"),
            "{body}"
        );
        body
    };
    let sole = "the server operator can reset your access with the command roedy-mail reset-admin.";
    let others = "and let your administrator know: they can suspend your account";

    // Alone: the operator.
    let body = change(1).await;
    assert!(body.contains(sole) && !body.contains(others), "{body}");

    // A second active administrator: the administration.
    env.add_with_role("lukas", "lukas@example.com", Role::Admin)
        .await;
    let body = change(2).await;
    assert!(
        body.contains(others) && !body.contains("reset-admin"),
        "{body}"
    );

    // The second one locked: the operator again.
    env.sql(|conn| {
        conn.execute(
            "UPDATE users SET status = 'locked' WHERE username = 'lukas'",
            [],
        )
    })
    .await;
    let body = change(3).await;
    assert!(body.contains(sole) && !body.contains(others), "{body}");

    // The first app, still alone.
    let enrolled = env
        .as_user(
            DESKTOP,
            &session,
            Method::POST,
            "/auth/totp/devices/enroll",
            None,
        )
        .await;
    let secret = totp_rs::Secret::try_from_base32(enrolled.json()["secret"].as_str().unwrap())
        .unwrap()
        .to_vec();
    let confirmed = env
        .as_user(
            DESKTOP,
            &session,
            Method::POST,
            "/auth/totp/devices/confirm",
            Some(json!({
                "id": enrolled.json()["id"],
                "name": "Phone",
                "password": new_password(3),
                "code": code(&secret),
            })),
        )
        .await;
    assert_eq!(confirmed.status, StatusCode::OK, "{}", confirmed.body);
    let added = mails(&server, 5).await.pop().unwrap();
    assert_eq!(added["subject"], "Authenticator app added");
    let body = text(&added);
    for line in [
        "administrator, so no one in Roedy Mail can suspend your account.",
        "ask the server operator to reset your access with the command roedy-mail reset-admin. \
         This sets a new password and removes all authenticator apps.",
        "\nReset password:\nhttps://app.example.com/password/forgot\n",
    ] {
        assert!(body.contains(line), "{line:?} missing: {body}");
    }
    assert!(!body.contains("Contact your administrator"), "{body}");
}

/// The app's code for the current time step.
fn code(secret: &[u8]) -> String {
    totp_rs::Builder::new()
        .with_secret(secret.to_vec())
        .build()
        .unwrap()
        .generate(totp::now())
        .to_string()
}

impl Env {
    /// Signs in with a recovery code.
    async fn recover(&self, from: From, login: &str, recovery: &Value) -> Reply {
        let first = self.login(from, login).await;
        let mfa = first.cookie(challenge::COOKIE).unwrap();
        self.request(
            from,
            Method::POST,
            "/auth/recovery",
            Some(json!({ "code": recovery })),
            &[(challenge::COOKIE, &mfa)],
        )
        .await
    }
}

#[tokio::test]
async fn mfa_changes_send_security_mails() {
    let (env, server) = env_with_mail().await;
    let max = env.add_user("max", "max@example.com").await;
    let desktop = env.session(DESKTOP, "max").await;
    mails(&server, 1).await;

    // Adding the first app: event and instant mail with name, device and
    // place; removing and changing the password now require a code of this
    // app, so the advice leads via "Forgot password" to the administration.
    let enrolled = env
        .as_user(
            DESKTOP,
            &desktop,
            Method::POST,
            "/auth/totp/devices/enroll",
            None,
        )
        .await;
    let secret = totp_rs::Secret::try_from_base32(enrolled.json()["secret"].as_str().unwrap())
        .unwrap()
        .to_vec();
    let confirmed = env
        .as_user(
            DESKTOP,
            &desktop,
            Method::POST,
            "/auth/totp/devices/confirm",
            Some(json!({
                "id": enrolled.json()["id"],
                "name": "Phone",
                "password": PASSWORD,
                "code": code(&secret),
            })),
        )
        .await;
    assert_eq!(confirmed.status, StatusCode::OK, "{}", confirmed.body);
    let added = mails(&server, 2).await.pop().unwrap();
    assert_eq!(added["subject"], "Authenticator app added");
    assert_eq!(added["to"][0]["email"], "max@example.com");
    let body = text(&added);
    for line in [
        "App: Phone\n",
        "Device: Firefox on Linux\n",
        "IP address: 89.12.x.x\n",
        "\n\nThis is your first app, so multi-factor authentication is now turned on.\n\n",
        "Contact your administrator right away: they can suspend your account",
        "to set a new password.",
        "\nReset password:\nhttps://app.example.com/password/forgot\n",
    ] {
        assert!(body.contains(line), "{line:?} missing: {body}");
    }
    assert!(!body.contains("reset-admin"), "{body}");
    assert!(!body.contains("Remove the app"), "{body}");
    assert!(!body.contains("/account/security"), "{body}");
    let codes = confirmed.json()["recovery_codes"].clone();

    // Recovery code from a new device: one mail that names the device, instead
    // of an additional "New sign-in".
    let done = env.recover(PHONE, "max", &codes[0]).await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.body);
    let recovered = mails(&server, 3).await.pop().unwrap();
    assert_eq!(
        recovered["subject"],
        "Recovery code used to sign in to Roedy Mail"
    );
    let body = text(&recovered);
    for line in [
        "\n\nThe sign-in came from a new device.\n\n",
        "Device: Safari on iPhone\n",
        "IP address: 91.64.x.x\n",
        "Unused: 9 of 10\n\nYou can generate new codes under Account > Security.",
    ] {
        assert!(body.contains(line), "{line:?} missing: {body}");
    }
    // From the now known device without this sentence.
    let again = env.recover(PHONE, "max", &codes[1]).await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.body);
    let body = text(&mails(&server, 4).await[3]).to_owned();
    assert!(body.contains("Unused: 8 of 10"), "{body}");
    assert!(!body.contains("new device"), "{body}");

    // Generating new codes: the previous ones are no longer valid, and a mail
    // reports that too (it used to be silent). A wrong code replaces nothing
    // and reports nothing.
    env.sql(|c| c.execute("UPDATE totp_devices SET last_step = 0", []))
        .await;
    let good = code(&secret);
    let wrong = if good == "000000" { "111111" } else { "000000" };
    let rejected = env
        .as_user(
            DESKTOP,
            &desktop,
            Method::POST,
            "/auth/recovery-codes",
            Some(json!({ "password": PASSWORD, "code": wrong })),
        )
        .await;
    assert_eq!(
        rejected.json()["error"],
        "invalid_code",
        "{}",
        rejected.body
    );
    mails(&server, 4).await;
    let renewed = env
        .as_user(
            DESKTOP,
            &desktop,
            Method::POST,
            "/auth/recovery-codes",
            Some(json!({ "password": PASSWORD, "code": code(&secret) })),
        )
        .await;
    assert_eq!(renewed.status, StatusCode::OK, "{}", renewed.body);
    let mail = mails(&server, 5).await.pop().unwrap();
    assert_eq!(mail["subject"], "New recovery codes generated");
    let body = text(&mail);
    for line in [
        "Your previous codes no longer work.\n",
        "Device: Firefox on Linux\n",
        "IP address: 89.12.x.x\n",
    ] {
        assert!(body.contains(line), "{line:?} missing: {body}");
    }
    // A code from the old set no longer signs anyone in.
    let old = env.recover(PHONE, "max", &codes[2]).await;
    assert_eq!(old.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", old.body);
    assert!(renewed.json()["recovery_codes"][0].is_string());
    mails(&server, 5).await;

    // Removing the last app: its own sentence in the mail.
    let id = enrolled.json()["id"].as_str().unwrap().to_owned();
    env.sql(|c| c.execute("UPDATE totp_devices SET last_step = 0", []))
        .await;
    let removed = env
        .as_user(
            DESKTOP,
            &desktop,
            Method::DELETE,
            &format!("/auth/totp/devices/{id}"),
            Some(json!({ "password": PASSWORD, "code": code(&secret) })),
        )
        .await;
    assert_eq!(removed.status, StatusCode::OK, "{}", removed.body);
    let mail = mails(&server, 6).await.pop().unwrap();
    assert_eq!(mail["subject"], "Authenticator app removed");
    let body = text(&mail);
    assert!(
        body.contains(
            "Phone” was removed from your account max@example.com.\n\nThat was your last app."
        ),
        "{body}"
    );

    let events = env.notifications(&max).await;
    let kinds: Vec<&str> = events.iter().map(|n| n.kind.as_str()).collect();
    assert_eq!(
        kinds,
        [
            "security.totp_remove",
            "security.recovery_codes",
            "security.recovery_used",
            "security.recovery_used",
            "security.totp_add",
            "security.login"
        ]
    );
    assert_eq!(events[0].params["last"], true);
    assert_eq!(events[1].params["browser"], "Firefox");
    assert_eq!(events[2].params["new_device"], false);
    assert_eq!(events[3].params["new_device"], true);
    assert_eq!(events[3].params["remaining"], 9);
    assert_eq!(events[3].params["total"], 10);
    assert_eq!(events[3].params["os"], "iPhone");
    assert_eq!(
        events[4].params,
        json!({
            "name": "Phone",
            "first": true,
            "sole_admin": false,
            "browser": "Firefox",
            "os": "Linux",
            "device_type": "desktop",
            "ip": "89.12.x.x",
        })
    );
}

#[tokio::test]
async fn second_app_keeps_the_usual_advice() {
    let (env, server) = env_with_mail().await;
    let max = env.add_user("max", "max@example.com").await;
    let desktop = env.session(DESKTOP, "max").await;
    let mut sent = mails(&server, 1).await;

    for (n, name) in [(2, "Phone"), (3, "Tablet")] {
        let enrolled = env
            .as_user(
                DESKTOP,
                &desktop,
                Method::POST,
                "/auth/totp/devices/enroll",
                None,
            )
            .await;
        let secret = totp_rs::Secret::try_from_base32(enrolled.json()["secret"].as_str().unwrap())
            .unwrap()
            .to_vec();
        let confirmed = env
            .as_user(
                DESKTOP,
                &desktop,
                Method::POST,
                "/auth/totp/devices/confirm",
                Some(json!({
                    "id": enrolled.json()["id"],
                    "name": name,
                    "password": PASSWORD,
                    "code": code(&secret),
                })),
            )
            .await;
        assert_eq!(confirmed.status, StatusCode::OK, "{}", confirmed.body);
        sent = mails(&server, n).await;
    }
    let body = text(&sent[2]);
    assert!(body.contains("App: Tablet\n"), "{body}");
    assert!(!body.contains("first app"), "{body}");
    assert!(
        body.contains("Remove the app, change your password, and sign out all other devices"),
        "{body}"
    );
    assert!(
        body.contains("https://app.example.com/account/security\n"),
        "{body}"
    );
    assert!(!body.contains("/password/forgot"), "{body}");
    let events = env.notifications(&max).await;
    assert_eq!(events[0].params["first"], false);
    assert_eq!(events[1].params["first"], true);
}

#[tokio::test]
async fn place_from_geoip_in_sessions_events_and_audit() {
    let mut env = env().await;
    let path = env.tmp.path().join("test-city.mmdb");
    std::fs::write(
        &path,
        geoip_db::build(&[
            geoip_db::Entry {
                network: [89, 12, 0, 0].into(),
                prefix: 16,
                city: Some("Berlin"),
                country: "Germany",
            },
            geoip_db::Entry {
                network: [91, 64, 0, 0].into(),
                prefix: 16,
                city: None,
                country: "Austria",
            },
        ]),
    )
    .unwrap();
    env.state.geoip = Some(Arc::new(GeoIp::open(&path).unwrap()));
    // A database without places (e.g. ASN) prevents the start.
    let asn = env.tmp.path().join("asn.mmdb");
    std::fs::write(&asn, geoip_db::build_typed(&[], "GeoLite2-ASN")).unwrap();
    let error = GeoIp::open(&asn).err().unwrap();
    assert!(
        format!("{error:#}").contains("contains no locations"),
        "{error:#}"
    );
    let max = env.add_user("max", "max@example.com").await;
    let desktop = env.session(DESKTOP, "max").await;
    env.session(PHONE, "max").await;

    let listed = env
        .as_user(DESKTOP, &desktop, Method::GET, "/auth/sessions", None)
        .await;
    let places: Vec<Value> = listed.json()["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["place"].clone())
        .collect();
    assert_eq!(places, [json!("Berlin, Germany"), json!("Austria")]);
    let event = env.notifications(&max).await.remove(0);
    assert_eq!(event.params["place"], "Austria");
    let logins: Vec<Option<String>> = env
        .audit()
        .await
        .into_iter()
        .filter(|(action, _)| action == "auth.login")
        .map(|(_, place)| place)
        .collect();
    assert_eq!(
        logins,
        [
            Some("Berlin, Germany".to_owned()),
            Some("Austria".to_owned())
        ]
    );
}

#[tokio::test]
async fn cleanup_job_deletes_only_expired_sessions() {
    let env = env().await;
    env.add_user("max", "max@example.com").await;
    let valid = env.session(DESKTOP, "max").await;
    env.session(PHONE, "max").await;
    env.sql(|conn| {
        conn.execute(
            "UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' \
             WHERE id = (SELECT id FROM sessions ORDER BY rowid DESC LIMIT 1)",
            [],
        )
    })
    .await;
    (jobs::session_cleanup::job().run)(env.state.clone())
        .await
        .unwrap();
    let left: i64 = env
        .sql(|conn| conn.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0)))
        .await;
    assert_eq!(left, 1);
    let me = env
        .as_user(DESKTOP, &valid, Method::GET, "/auth/me", None)
        .await;
    assert_eq!(me.status, StatusCode::OK);
}

#[tokio::test]
async fn probe_job_tests_servers_due() {
    let env = env().await;
    let server = Server::start(Options::default()).await;
    let url = server.url.clone();
    env.sql(move |conn| {
        server_repo::insert(
            conn,
            "s1",
            &server_repo::Fields {
                label: "Test",
                base_url: &url,
                domains: &[],
                client_id: Some(fake_stalwart::CLIENT_ID),
            },
            None,
        )
        .unwrap();
        Ok(())
    })
    .await;
    (jobs::server_probe::job().run)(env.state.clone())
        .await
        .unwrap();
    let (reach, tested): (String, Option<String>) = env
        .sql(|conn| {
            conn.query_row("SELECT reach, tested_at FROM servers", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
        })
        .await;
    assert_eq!(reach, "ok");
    let tested = tested.unwrap();
    // Just tested: the next run skips it.
    (jobs::server_probe::job().run)(env.state.clone())
        .await
        .unwrap();
    let again: String = env
        .sql(|conn| conn.query_row("SELECT tested_at FROM servers", [], |r| r.get(0)))
        .await;
    assert_eq!(again, tested);
}

#[tokio::test]
async fn probe_job_keeps_the_last_result_when_throttled() {
    let env = env().await;
    // Stalwart throttles every request (anonymous limit).
    let server = Server::start(Options {
        throttle_after: Some(0),
        ..Options::default()
    })
    .await;
    let url = server.url.clone();
    env.sql(move |conn| {
        server_repo::insert(
            conn,
            "s1",
            &server_repo::Fields {
                label: "Test",
                base_url: &url,
                domains: &[],
                client_id: Some(fake_stalwart::CLIENT_ID),
            },
            None,
        )
        .unwrap();
        conn.execute(
            "UPDATE servers SET reach = 'ok', cors = 'ok', oauth = 'ok', \
             tested_at = '2000-01-01T00:00:00.000Z'",
            [],
        )
    })
    .await;
    (jobs::server_probe::job().run)(env.state.clone())
        .await
        .unwrap();
    // No "not checked" for a day: result and time stay, the next run checks
    // again.
    let row: (String, String, String, String) = env
        .sql(|conn| {
            conn.query_row(
                "SELECT reach, cors, oauth, tested_at FROM servers",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
        })
        .await;
    assert_eq!(
        row,
        (
            "ok".into(),
            "ok".into(),
            "ok".into(),
            "2000-01-01T00:00:00.000Z".into()
        )
    );
}
