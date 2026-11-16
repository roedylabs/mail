//! Sign-in via the API: email or username,
//! authenticator apps with codes valid only once, recovery codes, sign-out,
//! `auth/me`, changing the password and the management under
//! Account › Security.

use std::{net::SocketAddr, sync::Arc};

use axum::{
    Router,
    body::Body,
    extract::connect_info::MockConnectInfo,
    http::{HeaderMap, Method, Request, StatusCode, header},
};
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
            servers as server_repo, totp_devices,
            users::{self, NewUser, Role},
        },
    },
    mailer::system_mail::{self, SystemMail},
    web::static_files::WebAssets,
};
use serde_json::{Value, json};
use tower::ServiceExt as _;

const PASSWORD: &str = "Summer2026!";
const CLIENT: [u8; 4] = [203, 0, 113, 7];

struct Env {
    _tmp: tempfile::TempDir,
    state: AppState,
}

fn fast_hasher() -> Arc<Hasher> {
    Arc::new(Hasher::with_params(Params::new(64, 1, 1, None).unwrap()))
}

async fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let conn = db::open(tmp.path()).unwrap();
    let mut state = AppState::new(
        Db::from(conn),
        Arc::new(WebAssets::None),
        &Config::default(),
        SecretKey::random().unwrap(),
    )
    .unwrap();
    state.hasher = fast_hasher();
    Env { _tmp: tmp, state }
}

impl Env {
    async fn add_user(&self, username: &str, email: &str, role: Role) -> String {
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

    /// Confirmed authenticator app with a new secret (without an accepted time
    /// step, so that every current code is fresh).
    async fn add_device(&self, user_id: &str, name: &str) -> Vec<u8> {
        let id = db::new_id().unwrap();
        let secret = totp::generate_secret().unwrap().to_vec();
        let sealed = self
            .state
            .secrets
            .seal(totp::SECRET_PURPOSE, &id, &secret)
            .unwrap();
        let (user_id, name) = (user_id.to_owned(), name.to_owned());
        db::call(&self.state.db, move |conn| {
            totp_devices::insert_pending(conn, &id, &user_id, &sealed)?;
            totp_devices::confirm(conn, &id, &name, 0)?;
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

    /// Waits until `n` entries `action` are in the audit log – the API writes
    /// failed sign-ins in the background.
    async fn wait_for_audit(&self, action: &'static str, n: i64) {
        for _ in 0..200 {
            let count: i64 = self
                .sql(move |c| {
                    c.query_row(
                        "SELECT COUNT(*) FROM audit_log WHERE action = ?1",
                        [action],
                        |r| r.get(0),
                    )
                })
                .await;
            if count >= n {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("{action} not {n} times in the audit log");
    }

    async fn audit_actions(&self) -> Vec<String> {
        self.sql(|conn| {
            conn.prepare("SELECT action FROM audit_log ORDER BY id")?
                .query_map([], |r| r.get(0))?
                .collect()
        })
        .await
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        cookies: &[(&str, &str)],
    ) -> Reply {
        self.request_from(CLIENT, method, path, body, cookies).await
    }

    async fn request_from(
        &self,
        ip: [u8; 4],
        method: Method,
        path: &str,
        body: Option<Value>,
        cookies: &[(&str, &str)],
    ) -> Reply {
        let mut builder = Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"))
            .header(api::CSRF_HEADER, "fetch")
            .header(header::USER_AGENT, "Mozilla/5.0 (Test)");
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

    async fn login(&self, login: &str, password: &str) -> Reply {
        self.request(
            Method::POST,
            "/auth/login",
            Some(json!({ "login": login, "password": password })),
            &[],
        )
        .await
    }

    /// Sign-in with code; returns the session cookie.
    async fn login_with_code(&self, login: &str, code: &str) -> Reply {
        let first = self.login(login, PASSWORD).await;
        assert_eq!(first.json()["status"], "totp_required", "{}", first.body);
        let mfa = first.cookie(challenge::COOKIE).unwrap();
        self.request(
            Method::POST,
            "/auth/totp",
            Some(json!({ "code": code })),
            &[(challenge::COOKIE, &mfa)],
        )
        .await
    }

    async fn session_for(&self, login: &str) -> String {
        let reply = self.login(login, PASSWORD).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.cookie(session::COOKIE).unwrap()
    }

    async fn as_user(
        &self,
        session: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Reply {
        self.request(method, path, body, &[(session::COOKIE, session)])
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

    fn error(&self) -> String {
        self.json()["error"].as_str().unwrap_or_default().to_owned()
    }

    fn set_cookies(&self) -> Vec<String> {
        self.headers
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap().to_owned())
            .collect()
    }

    /// Value of a set (not deleted) cookie.
    fn cookie(&self, name: &str) -> Option<String> {
        self.set_cookies().iter().find_map(|c| {
            let value = c.strip_prefix(&format!("{name}="))?.split(';').next()?;
            (!value.is_empty()).then(|| value.to_owned())
        })
    }
}

/// The app's code for the time step `offset` relative to now (only 0 and 1:
/// if the test crosses a step boundary, both stay valid).
fn code(secret: &[u8], offset: u64) -> String {
    totp_rs::Builder::new()
        .with_secret(secret.to_vec())
        .build()
        .unwrap()
        .generate(totp::now() + offset * 30)
        .to_string()
}

#[tokio::test]
async fn login_with_email_or_username() {
    let env = env().await;
    let id = env.add_user("max", "Max@Example.com", Role::User).await;

    for login in ["max@example.com", " MAX ", "Max@Example.com"] {
        let reply = env.login(login, PASSWORD).await;
        assert_eq!(reply.status, StatusCode::OK, "{login}: {}", reply.body);
        assert_eq!(reply.json()["status"], "ok");
        assert_eq!(reply.json()["user"]["id"], id);
        assert_eq!(reply.json()["user"]["username"], "max");
        let cookie = reply
            .set_cookies()
            .into_iter()
            .find(|c| c.starts_with(session::COOKIE))
            .unwrap();
        assert!(cookie.contains("Max-Age=2592000"), "{cookie}");
    }
    let actions = env.audit_actions().await;
    assert_eq!(actions, ["auth.login", "auth.login", "auth.login"]);
    let method: String = env
        .sql(|c| {
            c.query_row("SELECT details ->> 'method' FROM audit_log", [], |r| {
                r.get(0)
            })
        })
        .await;
    assert_eq!(method, "password");
}

#[tokio::test]
async fn wrong_password_unknown_and_locked_look_the_same() {
    let env = env().await;
    let id = env.add_user("max", "max@example.com", Role::User).await;
    env.add_user("eva", "eva@example.com", Role::User).await;
    env.sql(|c| {
        c.execute(
            "UPDATE users SET status = 'locked' WHERE username = 'eva'",
            [],
        )
    })
    .await;

    for (login, password) in [
        ("max", "Summer2026?"),
        ("moritz@example.com", PASSWORD),
        ("eva", PASSWORD),
    ] {
        let reply = env.login(login, password).await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY, "{login}");
        assert_eq!(reply.json(), json!({ "error": "invalid_credentials" }));
        assert!(reply.cookie(session::COOKIE).is_none());
    }
    // Only known accounts in the audit log, never the input.
    env.wait_for_audit("auth.login_failed", 2).await;
    let rows: Vec<(String, String, String)> = env
        .sql(|c| {
            c.prepare("SELECT action, target, details FROM audit_log ORDER BY id")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect()
        })
        .await;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].0, "auth.login_failed");
    assert_eq!(rows[0].1, id);
    assert_eq!(rows[0].2, r#"{"reason":"password"}"#);
    assert_eq!(rows[1].2, r#"{"reason":"locked"}"#);

    let reply = env.login(" ", "").await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        reply.json()["fields"],
        json!({ "login": { "code": "required" }, "password": { "code": "required" } })
    );
}

#[tokio::test]
async fn remember_me_controls_cookie_lifetime() {
    let env = env().await;
    env.add_user("max", "max@example.com", Role::User).await;
    let reply = env
        .request(
            Method::POST,
            "/auth/login",
            Some(json!({ "login": "max", "password": PASSWORD, "remember": false })),
            &[],
        )
        .await;
    let cookie = reply
        .set_cookies()
        .into_iter()
        .find(|c| c.starts_with(session::COOKIE))
        .unwrap();
    assert!(!cookie.contains("Max-Age"), "{cookie}");
    let token = reply.cookie(session::COOKIE).unwrap();

    // The renewed cookie also stays without a lifetime.
    env.sql(|c| {
        c.execute(
            "UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00.000Z'",
            [],
        )
    })
    .await;
    let me = env.as_user(&token, Method::GET, "/auth/me", None).await;
    assert_eq!(me.status, StatusCode::OK);
    let renewed = me.set_cookies();
    assert_eq!(renewed.len(), 1, "{renewed:?}");
    assert!(!renewed[0].contains("Max-Age"), "{renewed:?}");
}

#[tokio::test]
async fn outdated_hash_is_replaced_after_login() {
    let env = env().await;
    let id = env.add_user("max", "max@example.com", Role::User).await;
    // The server now expects other parameters.
    let mut state = env.state.clone();
    state.hasher = Arc::new(Hasher::with_params(Params::new(128, 1, 1, None).unwrap()));
    let env = Env {
        _tmp: env._tmp,
        state,
    };
    let reply = env.login("max", PASSWORD).await;
    assert_eq!(reply.status, StatusCode::OK);
    // Rehashing happens in the background.
    let mut hash = String::new();
    for _ in 0..200 {
        let id = id.clone();
        hash = env
            .sql(move |c| {
                c.query_row(
                    "SELECT password_hash FROM users WHERE id = ?1",
                    [&id],
                    |r| r.get(0),
                )
            })
            .await;
        if hash.contains("m=128,t=1,p=1") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(hash.contains("m=128,t=1,p=1"), "{hash}");
    assert!(!env.state.hasher.is_outdated(&hash));
    assert_eq!(env.login("max", PASSWORD).await.status, StatusCode::OK);
}

#[tokio::test]
async fn totp_with_two_devices_and_codes_only_once() {
    let env = env().await;
    let id = env.add_user("max", "max@example.com", Role::User).await;
    let phone = env.add_device(&id, "Phone").await;
    let tablet = env.add_device(&id, "Tablet").await;

    // Without a second factor there is no session.
    let first = env.login("max", PASSWORD).await;
    assert_eq!(first.status, StatusCode::OK);
    assert_eq!(first.json(), json!({ "status": "totp_required" }));
    assert!(first.cookie(session::COOKIE).is_none());
    let mfa = first
        .set_cookies()
        .into_iter()
        .find(|c| c.starts_with(challenge::COOKIE))
        .unwrap();
    assert!(mfa.contains("Max-Age=300"), "{mfa}");

    // One code for all attempts: a recomputed one would be a different, fresh
    // one after a step boundary.
    let phone_code = code(&phone, 0);
    let ok = env.login_with_code("max", &phone_code).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);
    assert_eq!(ok.json()["user"]["id"], id);
    assert!(ok.cookie(session::COOKIE).is_some());
    assert!(
        ok.set_cookies()
            .iter()
            .any(|c| c.starts_with("__Host-roedy_mfa=; Max-Age=0")),
        "{:?}",
        ok.set_cookies()
    );

    // The same code a second time: rejected without counting towards the limit
    // (six times, the limit is five).
    for _ in 0..6 {
        let again = env.login_with_code("max", &phone_code).await;
        assert_eq!(again.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(again.error(), "code_used");
    }
    // The second device has its own time step.
    let tablet_ok = env.login_with_code("max", &code(&tablet, 0)).await;
    assert_eq!(tablet_ok.status, StatusCode::OK, "{}", tablet_ok.body);
    // A later code of the same device is valid again.
    let later = env.login_with_code("max", &code(&phone, 1)).await;
    assert_eq!(later.status, StatusCode::OK, "{}", later.body);

    let details: Vec<String> = env
        .sql(|c| {
            c.prepare("SELECT details FROM audit_log WHERE action = 'auth.login' ORDER BY id")?
                .query_map([], |r| r.get(0))?
                .collect()
        })
        .await;
    assert_eq!(
        details,
        [
            r#"{"device":"Phone","method":"totp"}"#,
            r#"{"device":"Tablet","method":"totp"}"#,
            r#"{"device":"Phone","method":"totp"}"#,
        ]
    );
}

#[tokio::test]
async fn same_code_concurrently_is_accepted_once() {
    let env = env().await;
    let id = env.add_user("max", "max@example.com", Role::User).await;
    let secret = env.add_device(&id, "Phone").await;
    let code = code(&secret, 0);
    let (a, b) = tokio::join!(
        env.login_with_code("max", &code),
        env.login_with_code("max", &code)
    );
    let mut results = [a.status, b.status];
    results.sort();
    assert_eq!(
        results,
        [StatusCode::OK, StatusCode::UNPROCESSABLE_ENTITY],
        "{} / {}",
        a.body,
        b.body
    );
    let rejected = if a.status == StatusCode::OK { &b } else { &a };
    assert_eq!(rejected.error(), "code_used");
}

#[tokio::test]
async fn wrong_codes_count_and_lock() {
    let env = env().await;
    let id = env.add_user("max", "max@example.com", Role::User).await;
    let secret = env.add_device(&id, "Phone").await;
    let good = code(&secret, 0);
    let wrong = if good == "000000" { "111111" } else { "000000" };

    // Not six digits: no attempt. With the address, because correct passwords
    // are limited per spelling (ten at once); the lockout for wrong codes
    // applies per account.
    for _ in 0..6 {
        let reply = env.login_with_code("max@example.com", "12345").await;
        assert_eq!(reply.error(), "invalid_code");
    }
    for _ in 0..4 {
        let reply = env.login_with_code("max", wrong).await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(reply.error(), "invalid_code");
    }
    let locked = env.login_with_code("max", wrong).await;
    assert_eq!(locked.error(), "invalid_code");
    let locked = env.login_with_code("max", &good).await;
    assert_eq!(locked.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(locked.headers[header::RETRY_AFTER], "900");
    env.wait_for_audit("auth.login_failed", 5).await;
    let failed: i64 = env
        .sql(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM audit_log WHERE action = 'auth.login_failed' \
                 AND details ->> 'reason' = 'totp'",
                [],
                |r| r.get(0),
            )
        })
        .await;
    assert_eq!(failed, 5);
}

#[tokio::test]
async fn second_step_needs_a_valid_challenge() {
    let env = env().await;
    let id = env.add_user("max", "max@example.com", Role::User).await;
    let secret = env.add_device(&id, "Phone").await;

    let reply = env
        .request(
            Method::POST,
            "/auth/totp",
            Some(json!({ "code": "123456" })),
            &[],
        )
        .await;
    assert_eq!(reply.error(), "login_expired");
    let reply = env
        .request(
            Method::POST,
            "/auth/recovery",
            Some(json!({ "code": "ABCD-EFGH" })),
            &[(challenge::COOKIE, &"0".repeat(64))],
        )
        .await;
    assert_eq!(reply.error(), "login_expired");

    // A changed password invalidates the intermediate step.
    let first = env.login("max", PASSWORD).await;
    let mfa = first.cookie(challenge::COOKIE).unwrap();
    env.sql(|c| {
        c.execute(
            "UPDATE users SET password_changed_at = '2030-01-01T00:00:00.000Z'",
            [],
        )
    })
    .await;
    let reply = env
        .request(
            Method::POST,
            "/auth/totp",
            Some(json!({ "code": code(&secret, 0) })),
            &[(challenge::COOKIE, &mfa)],
        )
        .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(reply.error(), "login_expired");

    // A completed intermediate step is not valid a second time.
    let first = env.login("max", PASSWORD).await;
    let mfa = first.cookie(challenge::COOKIE).unwrap();
    let body = Some(json!({ "code": code(&secret, 0) }));
    let ok = env
        .request(
            Method::POST,
            "/auth/totp",
            body,
            &[(challenge::COOKIE, &mfa)],
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);
    let again = env
        .request(
            Method::POST,
            "/auth/totp",
            Some(json!({ "code": code(&secret, 1) })),
            &[(challenge::COOKIE, &mfa)],
        )
        .await;
    assert_eq!(again.error(), "login_expired");
}

/// First authenticator app via the setup in the browser; returns secret,
/// recovery codes and the confirmation code.
async fn enroll_first_device(env: &Env, session: &str) -> (Vec<u8>, Vec<String>, String) {
    let enrolled = env
        .as_user(session, Method::POST, "/auth/totp/devices/enroll", None)
        .await;
    assert_eq!(enrolled.status, StatusCode::OK, "{}", enrolled.body);
    let secret = totp_rs::Secret::try_from_base32(enrolled.json()["secret"].as_str().unwrap())
        .unwrap()
        .to_vec();
    let confirm_code = code(&secret, 0);
    let confirmed = env
        .as_user(
            session,
            Method::POST,
            "/auth/totp/devices/confirm",
            Some(json!({
                "id": enrolled.json()["id"],
                "password": PASSWORD,
                "code": confirm_code,
            })),
        )
        .await;
    assert_eq!(confirmed.status, StatusCode::OK, "{}", confirmed.body);
    let codes = confirmed.json()["recovery_codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_str().unwrap().to_owned())
        .collect();
    (secret, codes, confirm_code)
}

#[tokio::test]
async fn recovery_codes_work_once() {
    let env = env().await;
    env.add_user("max", "max@example.com", Role::User).await;
    let session = env.session_for("max").await;
    let (_, codes, _) = enroll_first_device(&env, &session).await;
    assert_eq!(codes.len(), 10);

    let use_code = |code: String| {
        let env = &env;
        async move {
            let first = env.login("max@example.com", PASSWORD).await;
            let mfa = first.cookie(challenge::COOKIE).unwrap();
            env.request(
                Method::POST,
                "/auth/recovery",
                Some(json!({ "code": code })),
                &[(challenge::COOKIE, &mfa)],
            )
            .await
        }
    };
    let ok = use_code(codes[3].to_lowercase().replace('-', " ")).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);
    assert!(ok.cookie(session::COOKIE).is_some());
    let again = use_code(codes[3].clone()).await;
    assert_eq!(again.error(), "code_used");
    let wrong = use_code("ZZZZ-ZZZZ".into()).await;
    assert_eq!(wrong.error(), "invalid_code");

    let overview = env
        .as_user(&session, Method::GET, "/auth/totp/devices", None)
        .await;
    assert_eq!(overview.json()["recovery"]["total"], 10);
    assert_eq!(overview.json()["recovery"]["unused"], 9);
    let details: String = env
        .sql(|c| {
            c.query_row(
                "SELECT details FROM audit_log WHERE action = 'auth.login' ORDER BY id DESC",
                [],
                |r| r.get(0),
            )
        })
        .await;
    assert_eq!(details, r#"{"method":"recovery","remaining":9}"#);
}

#[tokio::test]
async fn logout_ends_the_session() {
    let env = env().await;
    env.add_user("max", "max@example.com", Role::User).await;
    let session = env.session_for("max").await;
    let reply = env
        .as_user(&session, Method::POST, "/auth/logout", None)
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert_eq!(
        reply.set_cookies(),
        [session::clear_cookie().to_str().unwrap()]
    );
    let me = env.as_user(&session, Method::GET, "/auth/me", None).await;
    assert_eq!(me.status, StatusCode::UNAUTHORIZED);
    // Without a session: nothing to do, the cookie is deleted anyway.
    let reply = env.request(Method::POST, "/auth/logout", None, &[]).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert_eq!(env.audit_actions().await, ["auth.login", "auth.logout"]);
}

#[tokio::test]
async fn me_reports_system_mail_only_to_admins() {
    let env = env().await;
    env.add_user("max", "max@example.com", Role::Admin).await;
    env.add_user("eva", "eva@example.com", Role::User).await;
    let admin = env.session_for("max").await;
    let user = env.session_for("eva").await;

    let me = env.as_user(&admin, Method::GET, "/auth/me", None).await;
    assert_eq!(me.status, StatusCode::OK);
    let body = me.json();
    assert_eq!(body["username"], "max");
    assert_eq!(body["role"], "admin");
    assert_eq!(body["mfa_enabled"], false);
    assert!(body["password_changed_at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(body["system_mail_configured"], false);
    let me = env.as_user(&user, Method::GET, "/auth/me", None).await;
    assert!(
        me.json().get("system_mail_configured").is_none(),
        "{}",
        me.body
    );

    // With a sending account on a server of the registry: set up; without the
    // server no longer.
    let secrets = env.state.secrets.clone();
    env.sql(move |conn| {
        server_repo::insert(
            conn,
            "s1",
            &server_repo::Fields {
                label: "VPS 1",
                base_url: "https://mail.s1.test",
                domains: &[],
                client_id: Some("c"),
            },
            None,
        )
        .unwrap();
        let mail = SystemMail::new(&secrets, "s1", "noreply", "kT9v", None).unwrap();
        system_mail::save(conn, &mail).unwrap();
        Ok(())
    })
    .await;
    let me = env.as_user(&admin, Method::GET, "/auth/me", None).await;
    assert_eq!(me.json()["system_mail_configured"], true);
    env.sql(|conn| conn.execute("DELETE FROM servers", []))
        .await;
    let me = env.as_user(&admin, Method::GET, "/auth/me", None).await;
    assert_eq!(me.json()["system_mail_configured"], false);

    let anonymous = env.request(Method::GET, "/auth/me", None, &[]).await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn me_reports_sole_admin() {
    let env = env().await;
    env.add_user("max", "max@example.com", Role::Admin).await;
    env.add_user("eva", "eva@example.com", Role::User).await;
    let admin = env.session_for("max").await;
    let user = env.session_for("eva").await;
    let sole = |session| {
        let env = &env;
        async move {
            let me = env.as_user(session, Method::GET, "/auth/me", None).await;
            assert_eq!(me.status, StatusCode::OK);
            me.json()["sole_admin"].clone()
        }
    };

    assert_eq!(sole(&admin).await, true);
    assert_eq!(sole(&user).await, false);
    // A second active administrator lifts the block, a locked one does not
    // (like `DELETE auth/me` with `last_admin`).
    env.add_user("lea", "lea@example.com", Role::Admin).await;
    assert_eq!(sole(&admin).await, false);
    env.sql(|conn| {
        conn.execute(
            "UPDATE users SET status = 'locked' WHERE username = 'lea'",
            [],
        )
    })
    .await;
    assert_eq!(sole(&admin).await, true);
}

#[tokio::test]
async fn change_password_checks_password_before_code() {
    let env = env().await;
    let id = env.add_user("max", "max@example.com", Role::User).await;
    let session = env.session_for("max").await;
    let other = env.session_for("max").await;
    let secret = env.add_device(&id, "Phone").await;
    let code = code(&secret, 0);
    let change = |current: &str, new: &str, code: Option<&str>| {
        let mut body = json!({ "current_password": current, "new_password": new });
        if let Some(code) = code {
            body["code"] = code.into();
        }
        env.as_user(&session, Method::PUT, "/auth/password", Some(body))
    };

    let reply = change(PASSWORD, "short", None).await;
    assert_eq!(
        reply.json()["fields"],
        json!({
            "new_password": { "code": "policy", "rules": ["len", "case", "num"] },
            "code": { "code": "required" },
        })
    );
    // Wrong password: the code stays unused.
    let reply = change("Incorrect2026!", "Winter2026!", Some(&code)).await;
    assert_eq!(reply.error(), "invalid_password");
    let reply = change(PASSWORD, "Winter2026!", Some(&code)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert!(reply.json()["password_changed_at"].is_string());
    // For the "other devices were signed out" toast.
    assert_eq!(reply.json()["sessions_ended"], 1);
    // The code is valid only once.
    let reply = change("Winter2026!", "Autumn2026!", Some(&code)).await;
    assert_eq!(reply.error(), "code_used");

    assert_eq!(
        env.login("max", PASSWORD).await.error(),
        "invalid_credentials"
    );
    let first = env.login("max", "Winter2026!").await;
    assert_eq!(first.json()["status"], "totp_required");
    // All other sessions end, the own one stays.
    let me = env.as_user(&other, Method::GET, "/auth/me", None).await;
    assert_eq!(me.status, StatusCode::UNAUTHORIZED);
    let me = env.as_user(&session, Method::GET, "/auth/me", None).await;
    assert_eq!(me.status, StatusCode::OK);
    let details: String = env
        .sql(|c| {
            c.query_row(
                "SELECT details FROM audit_log WHERE action = 'auth.password_change'",
                [],
                |r| r.get(0),
            )
        })
        .await;
    assert_eq!(details, r#"{"sessions_ended":1}"#);
    assert!(
        env.audit_actions()
            .await
            .contains(&"auth.password_change".to_owned())
    );
}

#[tokio::test]
async fn change_password_counts_only_active_other_sessions() {
    let env = env().await;
    env.add_user("max", "max@example.com", Role::User).await;
    let session = env.session_for("max").await;
    let stale = env.session_for("max").await;
    // Expired but not yet cleaned up: no signed-in device, so no "other
    // devices were signed out" either.
    env.sql(|c| {
        c.execute(
            "UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' \
             WHERE rowid = (SELECT max(rowid) FROM sessions)",
            [],
        )
    })
    .await;
    let me = env.as_user(&stale, Method::GET, "/auth/me", None).await;
    assert_eq!(me.status, StatusCode::UNAUTHORIZED);

    let body = json!({ "current_password": PASSWORD, "new_password": "Winter2026!" });
    let reply = env
        .as_user(&session, Method::PUT, "/auth/password", Some(body))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.json()["sessions_ended"], 0);
    let left: i64 = env
        .sql(|c| c.query_row("SELECT count(*) FROM sessions", [], |r| r.get(0)))
        .await;
    assert_eq!(left, 1);
}

#[tokio::test]
async fn reauth_limit_is_shared_per_user() {
    let env = env().await;
    env.add_user("max", "max@example.com", Role::User).await;
    let session = env.session_for("max").await;
    let (secret, _, _) = enroll_first_device(&env, &session).await;
    let device = env
        .as_user(&session, Method::GET, "/auth/totp/devices", None)
        .await
        .json()["devices"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let pending = env
        .as_user(&session, Method::POST, "/auth/totp/devices/enroll", None)
        .await
        .json()["id"]
        .clone();
    let wrong = json!({ "password": "Incorrect2026!", "code": "123456" });
    // Five failed attempts across all actions with password and code …
    for (method, path, body) in [
        (
            Method::POST,
            "/auth/recovery-codes".to_owned(),
            wrong.clone(),
        ),
        (
            Method::POST,
            "/auth/totp/devices/confirm".to_owned(),
            json!({ "id": pending, "password": "Incorrect2026!", "code": "123456" }),
        ),
        (
            Method::DELETE,
            format!("/auth/totp/devices/{device}"),
            wrong.clone(),
        ),
        (
            Method::PUT,
            "/auth/password".to_owned(),
            json!({
                "current_password": "Incorrect2026!",
                "new_password": "Winter2026!",
                "code": "123456",
            }),
        ),
        (
            Method::POST,
            "/auth/recovery-codes".to_owned(),
            wrong.clone(),
        ),
    ] {
        let reply = env.as_user(&session, method, &path, Some(body)).await;
        assert_eq!(reply.error(), "invalid_password", "{path}");
    }
    // … lock all of them, even with correct details.
    let reply = env
        .as_user(
            &session,
            Method::POST,
            "/auth/recovery-codes",
            Some(json!({ "password": PASSWORD, "code": code(&secret, 1) })),
        )
        .await;
    assert_eq!(
        reply.status,
        StatusCode::TOO_MANY_REQUESTS,
        "{}",
        reply.body
    );
    assert_eq!(reply.headers[header::RETRY_AFTER], "900");

    // Argon2 does not even check passwords that are too long.
    let long = "x".repeat(1025);
    let reply = env
        .as_user(
            &session,
            Method::PUT,
            "/auth/password",
            Some(json!({ "current_password": long, "new_password": "Winter2026!", "code": "123456" })),
        )
        .await;
    assert_eq!(
        reply.json()["fields"],
        json!({ "current_password": { "code": "too_long" } })
    );
}

#[tokio::test]
async fn new_login_ends_the_previous_session() {
    let env = env().await;
    let id = env.add_user("max", "max@example.com", Role::User).await;
    env.add_user("eva", "eva@example.com", Role::User).await;
    let old = env.session_for("max").await;
    // Signing in with another account in the same browser.
    let reply = env
        .request(
            Method::POST,
            "/auth/login",
            Some(json!({ "login": "eva", "password": PASSWORD })),
            &[(session::COOKIE, &old)],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let me = env.as_user(&old, Method::GET, "/auth/me", None).await;
    assert_eq!(me.status, StatusCode::UNAUTHORIZED);

    // Also via the second step.
    let secret = env.add_device(&id, "Phone").await;
    let old = env.session_for("eva").await;
    let first = env.login("max", PASSWORD).await;
    let mfa = first.cookie(challenge::COOKIE).unwrap();
    let reply = env
        .request(
            Method::POST,
            "/auth/totp",
            Some(json!({ "code": code(&secret, 0) })),
            &[(challenge::COOKIE, &mfa), (session::COOKIE, &old)],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let me = env.as_user(&old, Method::GET, "/auth/me", None).await;
    assert_eq!(me.status, StatusCode::UNAUTHORIZED);
    let sessions: i64 = env
        .sql(|c| c.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0)))
        .await;
    assert_eq!(sessions, 2, "one per account");
}

#[tokio::test]
async fn wrong_code_keeps_the_challenge() {
    let env = env().await;
    let id = env.add_user("max", "max@example.com", Role::User).await;
    let secret = env.add_device(&id, "Phone").await;
    let good = code(&secret, 0);
    let wrong = if good == "000000" { "111111" } else { "000000" };
    let first = env.login("max", PASSWORD).await;
    let mfa = first.cookie(challenge::COOKIE).unwrap();
    let cookies = [(challenge::COOKIE, mfa.as_str())];
    let step = |path: &'static str, code: String| {
        env.request(Method::POST, path, Some(json!({ "code": code })), &cookies)
    };
    assert_eq!(
        step("/auth/totp", wrong.into()).await.error(),
        "invalid_code"
    );
    assert_eq!(
        step("/auth/recovery", "ZZZZ-ZZZZ".into()).await.error(),
        "invalid_code"
    );
    let ok = step("/auth/totp", good).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);
}

#[tokio::test]
async fn challenge_ends_when_mfa_is_turned_off() {
    let env = env().await;
    let id = env.add_user("max", "max@example.com", Role::User).await;
    env.add_device(&id, "Phone").await;
    let first = env.login("max", PASSWORD).await;
    let mfa = first.cookie(challenge::COOKIE).unwrap();
    env.sql(|c| c.execute("DELETE FROM totp_devices", [])).await;
    let reply = env
        .request(
            Method::POST,
            "/auth/totp",
            Some(json!({ "code": "123456" })),
            &[(challenge::COOKIE, &mfa)],
        )
        .await;
    assert_eq!(reply.error(), "login_expired");
    // No failed attempt in the audit log.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(
        !env.audit_actions()
            .await
            .contains(&"auth.login_failed".to_owned())
    );
}

/// If the person removes the last app themselves, an open intermediate step
/// does not come back to life when they confirm a new one within five
/// minutes (as after "reset multi-factor authentication").
#[tokio::test]
async fn removing_the_last_device_ends_open_challenges() {
    let env = env().await;
    env.add_user("max", "max@example.com", Role::User).await;
    let session = env.session_for("max").await;
    let (secret, _, _) = enroll_first_device(&env, &session).await;
    let mfa = env
        .login("max", PASSWORD)
        .await
        .cookie(challenge::COOKIE)
        .unwrap();
    let devices = env
        .as_user(&session, Method::GET, "/auth/totp/devices", None)
        .await
        .json();
    let id = devices["devices"][0]["id"].as_str().unwrap().to_owned();
    let removed = env
        .as_user(
            &session,
            Method::DELETE,
            &format!("/auth/totp/devices/{id}"),
            Some(json!({ "password": PASSWORD, "code": code(&secret, 1) })),
        )
        .await;
    assert_eq!(removed.status, StatusCode::OK, "{}", removed.body);
    let (new_secret, _, _) = enroll_first_device(&env, &session).await;
    let reply = env
        .request(
            Method::POST,
            "/auth/totp",
            Some(json!({ "code": code(&new_secret, 1) })),
            &[(challenge::COOKIE, &mfa)],
        )
        .await;
    assert_eq!(reply.error(), "login_expired");
}

#[tokio::test]
async fn login_needs_csrf_header() {
    let env = env().await;
    env.add_user("max", "max@example.com", Role::User).await;
    let request = Request::post("/api/v1/auth/login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({ "login": "max", "password": PASSWORD }).to_string(),
        ))
        .unwrap();
    let app: Router =
        router(env.state.clone()).layer(MockConnectInfo(SocketAddr::from((CLIENT, 4711))));
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn manage_devices_and_recovery_codes() {
    let env = env().await;
    env.add_user("max", "max@example.com", Role::User).await;
    let session = env.session_for("max").await;

    // Without an app no codes.
    let reply = env
        .as_user(
            &session,
            Method::POST,
            "/auth/recovery-codes",
            Some(json!({ "password": PASSWORD, "code": "123456" })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    assert_eq!(reply.error(), "mfa_disabled");

    let enrolled = env
        .as_user(&session, Method::POST, "/auth/totp/devices/enroll", None)
        .await;
    let body = enrolled.json();
    assert_eq!(body["secret"].as_str().unwrap().len(), 32);
    let uri = body["uri"].as_str().unwrap();
    assert!(
        uri.starts_with("otpauth://totp/Roedy%20Mail:max%40example.com?"),
        "{uri}"
    );
    // No device yet.
    let me = env.as_user(&session, Method::GET, "/auth/me", None).await;
    assert_eq!(me.json()["mfa_enabled"], false);

    let (secret, codes, confirm_code) = enroll_first_device(&env, &session).await;
    let overview = env
        .as_user(&session, Method::GET, "/auth/totp/devices", None)
        .await
        .json();
    assert_eq!(overview["devices"].as_array().unwrap().len(), 1);
    assert_eq!(overview["devices"][0]["name"], "Authenticator app");
    assert_eq!(overview["recovery"]["unused"], 10);
    // The confirmation code is not valid again for signing in.
    let reply = env.login_with_code("max", &confirm_code).await;
    assert_eq!(reply.error(), "code_used");

    // Second app: name from the input, no new codes.
    let second = env
        .as_user(&session, Method::POST, "/auth/totp/devices/enroll", None)
        .await
        .json();
    let second_secret = totp_rs::Secret::try_from_base32(second["secret"].as_str().unwrap())
        .unwrap()
        .to_vec();
    let confirm = |code: String, password: &str| {
        env.as_user(
            &session,
            Method::POST,
            "/auth/totp/devices/confirm",
            Some(json!({
                "id": second["id"],
                "name": " Tablet ",
                "password": password,
                "code": code,
            })),
        )
    };
    assert_eq!(
        confirm(code(&second_secret, 0), "Incorrect2026!")
            .await
            .error(),
        "invalid_password"
    );
    let wrong = confirm(code(&secret, 1), PASSWORD).await;
    assert_eq!(wrong.error(), "invalid_code", "code of another app");
    let added = confirm(code(&second_secret, 0), PASSWORD).await;
    assert_eq!(added.status, StatusCode::OK, "{}", added.body);
    assert_eq!(added.json()["recovery_codes"], Value::Null);
    assert_eq!(added.json()["devices"][1]["name"], "Tablet");
    // Confirmed is confirmed: no code checks via this route.
    let again = confirm(code(&second_secret, 1), PASSWORD).await;
    assert_eq!(again.status, StatusCode::NOT_FOUND);

    // New codes invalidate the old ones.
    let regenerated = env
        .as_user(
            &session,
            Method::POST,
            "/auth/recovery-codes",
            Some(json!({ "password": PASSWORD, "code": code(&second_secret, 1) })),
        )
        .await;
    assert_eq!(regenerated.status, StatusCode::OK, "{}", regenerated.body);
    let fresh = regenerated.json()["recovery_codes"].clone();
    assert_eq!(fresh.as_array().unwrap().len(), 10);
    assert!(!fresh.as_array().unwrap().contains(&json!(codes[0])));

    // Removing with the code of the app to be removed; with the last one the
    // codes go away.
    let first_id = added.json()["devices"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let second_id = added.json()["devices"][1]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    env.sql(|c| c.execute("UPDATE totp_devices SET last_step = 0", []))
        .await;
    let removed = env
        .as_user(
            &session,
            Method::DELETE,
            &format!("/auth/totp/devices/{first_id}"),
            Some(json!({ "password": PASSWORD, "code": code(&secret, 0) })),
        )
        .await;
    assert_eq!(removed.status, StatusCode::OK, "{}", removed.body);
    assert_eq!(removed.json()["devices"].as_array().unwrap().len(), 1);
    assert_eq!(removed.json()["recovery"]["unused"], 10);
    let missing = env
        .as_user(
            &session,
            Method::DELETE,
            &format!("/auth/totp/devices/{first_id}"),
            Some(json!({ "password": PASSWORD, "code": code(&second_secret, 0) })),
        )
        .await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    let last = env
        .as_user(
            &session,
            Method::DELETE,
            &format!("/auth/totp/devices/{second_id}"),
            Some(json!({ "password": PASSWORD, "code": code(&second_secret, 0) })),
        )
        .await;
    assert_eq!(last.status, StatusCode::OK, "{}", last.body);
    assert_eq!(last.json(), json!({ "devices": [], "recovery": null }));
    assert_eq!(env.login("max", PASSWORD).await.json()["status"], "ok");

    let actions = env.audit_actions().await;
    for action in ["auth.totp_add", "auth.recovery_codes", "auth.totp_remove"] {
        assert!(
            actions.contains(&action.to_owned()),
            "{action}: {actions:?}"
        );
    }
}

#[tokio::test]
async fn devices_of_other_users_are_invisible() {
    let env = env().await;
    let max = env.add_user("max", "max@example.com", Role::User).await;
    env.add_user("eva", "eva@example.com", Role::User).await;
    env.add_device(&max, "Phone").await;
    let device: String = env
        .sql(|c| c.query_row("SELECT id FROM totp_devices", [], |r| r.get(0)))
        .await;
    let eva = env.session_for("eva").await;
    let list = env
        .as_user(&eva, Method::GET, "/auth/totp/devices", None)
        .await;
    assert_eq!(list.json(), json!({ "devices": [], "recovery": null }));
    let reply = env
        .as_user(
            &eva,
            Method::DELETE,
            &format!("/auth/totp/devices/{device}"),
            Some(json!({ "password": PASSWORD, "code": "123456" })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn account_lockout_after_wrong_passwords() {
    let env = env().await;
    env.add_user("max", "max@example.com", Role::User).await;
    // A success does not count.
    assert_eq!(env.login("max", PASSWORD).await.status, StatusCode::OK);
    for _ in 0..10 {
        let reply = env.login("Max@Example.com", "Incorrect2026!").await;
        assert_eq!(reply.error(), "invalid_credentials");
    }
    // Different case is the same spelling.
    let reply = env.login("max@example.com", PASSWORD).await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(reply.headers[header::RETRY_AFTER], "300");
    // From another address as well (lockout per spelling, not per IP).
    let reply = env
        .request_from(
            [198, 51, 100, 1],
            Method::POST,
            "/auth/login",
            Some(json!({ "login": "max@example.com", "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
    // The username counts on its own.
    assert_eq!(env.login("max", PASSWORD).await.status, StatusCode::OK);
}

/// The lockout answers the same for known and unknown accounts; otherwise a
/// 429 after failed attempts under another spelling would reveal the
/// account.
#[tokio::test]
async fn account_lockout_does_not_reveal_accounts() {
    let env = env().await;
    env.add_user("kai", "kai@example.com", Role::User).await;
    env.add_user("max", "max@example.com", Role::User).await;
    let login_from = |ip: [u8; 4], login: &str| {
        env.request_from(
            ip,
            Method::POST,
            "/auth/login",
            Some(json!({ "login": login, "password": "Incorrect2026!" })),
            &[],
        )
    };
    // Failed attempts under `first`, then one under `then`; one client IP per
    // case (limit per IP: 20). `K` is the Kelvin sign, which `to_lowercase`
    // turns into `k`, but `COLLATE NOCASE` does not.
    let cases = [
        (
            [198, 51, 100, 1],
            "\u{212A}ai@example.com",
            "kai@example.com",
        ),
        (
            [198, 51, 100, 2],
            "\u{212A}im@example.com",
            "kim@example.com",
        ),
        ([198, 51, 100, 3], "max@example.com", "max"),
        ([198, 51, 100, 4], "moritz@example.com", "moritz"),
    ];
    for (ip, first, then) in cases {
        for _ in 0..10 {
            assert_eq!(login_from(ip, first).await.error(), "invalid_credentials");
        }
        let reply = login_from(ip, then).await;
        assert_eq!(reply.error(), "invalid_credentials", "{first} → {then}");
    }
}

/// Correct passwords are also limited per spelling: ten at
/// once, then one per 90 s – before the hash, otherwise a sign-in loop
/// would occupy Argon2 for everyone. Failed attempts use none of it, and
/// the limit does not apply per IP (offices behind a NAT).
#[tokio::test]
async fn successful_logins_are_limited_per_spelling() {
    let env = env().await;
    env.add_user("max", "max@example.com", Role::User).await;
    // Failed attempts (below the lockout of ten) return their reservation.
    for _ in 0..9 {
        let reply = env.login("max@example.com", "Incorrect2026!").await;
        assert_eq!(reply.error(), "invalid_credentials");
    }
    for n in 0..10 {
        let reply = env.login("Max@Example.com", PASSWORD).await;
        assert_eq!(reply.status, StatusCode::OK, "sign-in {n}: {}", reply.body);
    }
    let sessions =
        || env.sql(|c| c.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get::<_, i64>(0)));
    assert_eq!(sessions().await, 10);
    let reply = env.login("max@example.com", PASSWORD).await;
    assert_eq!(
        reply.status,
        StatusCode::TOO_MANY_REQUESTS,
        "{}",
        reply.body
    );
    assert_waits_about(&reply, 90);
    assert_eq!(sessions().await, 10, "no session after 429");
    // From another address as well.
    let reply = env
        .request_from(
            [198, 51, 100, 1],
            Method::POST,
            "/auth/login",
            Some(json!({ "login": "max@example.com", "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
    // The username counts on its own, as with the lockout.
    assert_eq!(env.login("max", PASSWORD).await.status, StatusCode::OK);

    // With an authenticator app the password already counts: the hash ran.
    let kai = env.add_user("kai", "kai@example.com", Role::User).await;
    env.add_device(&kai, "Phone").await;
    for _ in 0..10 {
        let reply = env.login("kai", PASSWORD).await;
        assert_eq!(reply.json()["status"], "totp_required", "{}", reply.body);
    }
    let reply = env.login("kai", PASSWORD).await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
}

/// Failed attempts by third parties answer the same for known and unknown
/// accounts, even after the owner has signed in: their reservations of the
/// success limit are returned, and below the limit nobody sees anything of
/// it. A 429 without failed attempts only happens when someone with the
/// password has used it up.
#[tokio::test]
async fn success_limit_does_not_reveal_accounts() {
    let env = env().await;
    env.add_user("max", "max@example.com", Role::User).await;
    for _ in 0..9 {
        assert_eq!(
            env.login("max@example.com", PASSWORD).await.status,
            StatusCode::OK
        );
    }
    let attempts = |ip: [u8; 4], login: &'static str| {
        let env = &env;
        async move {
            let mut replies = Vec::new();
            for _ in 0..11 {
                let reply = env
                    .request_from(
                        ip,
                        Method::POST,
                        "/auth/login",
                        Some(json!({ "login": login, "password": "Incorrect2026!" })),
                        &[],
                    )
                    .await;
                let retry = reply
                    .headers
                    .get(header::RETRY_AFTER)
                    .map(|v| v.to_str().unwrap().to_owned());
                replies.push((reply.status, reply.error(), retry));
            }
            replies
        }
    };
    let known = attempts([198, 51, 100, 1], "max@example.com").await;
    let unknown = attempts([198, 51, 100, 2], "moritz@example.com").await;
    assert_eq!(known, unknown);
    assert_eq!(known[0].1, "invalid_credentials");
    // The lockout for wrong passwords applies to both alike.
    assert_eq!(known[10].0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(known[10].2.as_deref(), Some("300"));
}

/// Concurrent failed attempts do not reveal that someone has just signed in:
/// they hold no slots of the success limit. Otherwise, for the known account
/// the tenth of ten concurrent attempts would get 429 because the owner used
/// a slot, for the unknown one none would.
#[tokio::test]
async fn concurrent_failures_do_not_reveal_recent_logins() {
    let mut env = env().await;
    // Slower hashes so that all ten requests are in progress at once.
    env.state.hasher = Arc::new(Hasher::with_params(Params::new(4096, 2, 1, None).unwrap()));
    env.add_user("max", "max@example.com", Role::User).await;
    assert_eq!(
        env.login("max@example.com", PASSWORD).await.status,
        StatusCode::OK
    );
    let burst = |ip: [u8; 4], login: &'static str| {
        let env = &env;
        futures_util::future::join_all((0..10).map(move |_| async move {
            let reply = env
                .request_from(
                    ip,
                    Method::POST,
                    "/auth/login",
                    Some(json!({ "login": login, "password": "Incorrect2026!" })),
                    &[],
                )
                .await;
            (reply.status, reply.error())
        }))
    };
    let known = burst([198, 51, 100, 1], "max@example.com").await;
    let unknown = burst([198, 51, 100, 2], "moritz@example.com").await;
    let rejected = (
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_credentials".to_owned(),
    );
    assert_eq!(known, vec![rejected.clone(); 10]);
    assert_eq!(unknown, known);
}

/// Correct passwords in a session are limited per user: otherwise a
/// loop over "new recovery codes" would trigger any number of hashes.
#[tokio::test]
async fn reauth_successes_are_limited_per_user() {
    let env = env().await;
    env.add_user("max", "max@example.com", Role::User).await;
    let session = env.session_for("max").await;
    // Confirming the app checks the password: the first success.
    let (_, _, used) = enroll_first_device(&env, &session).await;
    // Wrong passwords (below the lockout of five) use none of the success
    // limit.
    for _ in 0..4 {
        let reply = env
            .as_user(
                &session,
                Method::POST,
                "/auth/recovery-codes",
                Some(json!({ "password": "Incorrect2026!", "code": used })),
            )
            .await;
        assert_eq!(reply.error(), "invalid_password");
    }
    let body = json!({ "password": PASSWORD, "code": used });
    // Already used codes do not count towards the lockout, but the password
    // counts towards the success limit.
    for n in 1..10 {
        let reply = env
            .as_user(
                &session,
                Method::POST,
                "/auth/recovery-codes",
                Some(body.clone()),
            )
            .await;
        assert_eq!(reply.error(), "code_used", "check {n}: {}", reply.body);
    }
    let reply = env
        .as_user(&session, Method::POST, "/auth/recovery-codes", Some(body))
        .await;
    assert_eq!(
        reply.status,
        StatusCode::TOO_MANY_REQUESTS,
        "{}",
        reply.body
    );
    assert_waits_about(&reply, 90);
}

/// Wait time of a limit by GCRA: the interval minus the time since the
/// first event, rounded up – on a slow runner also a bit less than `secs`.
fn assert_waits_about(reply: &Reply, secs: u64) {
    let header: u64 = reply.headers[header::RETRY_AFTER]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((secs - 5..=secs).contains(&header), "Retry-After {header}");
    assert_eq!(reply.json()["retry_after"], header);
}

#[tokio::test]
async fn ip_limit_covers_many_accounts() {
    let env = env().await;
    for n in 0..20 {
        let reply = env.login(&format!("unknown{n}"), "Incorrect2026!").await;
        assert_eq!(reply.error(), "invalid_credentials");
    }
    let reply = env.login("unknown20", "Incorrect2026!").await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(reply.headers[header::RETRY_AFTER], "30");
}
