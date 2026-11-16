//! Administration › Maintenance via the API (`maintenance` and `storage`):
//! maintenance mode with notice,
//! sessions, event and audit log, storage and compaction.

use std::{
    io,
    net::SocketAddr,
    sync::{Arc, Mutex},
};

use axum::{
    Router,
    body::Body,
    extract::connect_info::MockConnectInfo,
    http::{Method, Request, StatusCode, header},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
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
            app_settings,
            users::{self, NewUser, Role},
        },
    },
    instance::CLIENT_CACHE_VERSION,
    web::{maintenance::Mode, static_files::WebAssets},
};
use serde_json::{Value, json};
use tower::ServiceExt as _;

const PASSWORD: &str = "Summer2026!";
const MAINTENANCE: &str = "/admin/maintenance";
const STORAGE: &str = "/admin/storage";
const COMPACT: &str = "/admin/storage/compact";

struct Env {
    _tmp: tempfile::TempDir,
    state: AppState,
    admin: String,
    user: String,
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
    state.hasher = Arc::new(Hasher::with_params(Params::new(64, 1, 1, None).unwrap()));
    let mut env = Env {
        _tmp: tmp,
        state,
        admin: String::new(),
        user: String::new(),
    };
    env.add_user("anna", "Anna Becker", Role::Admin).await;
    env.add_user("mia", "Mia Wolf", Role::Admin).await;
    env.add_user("ben", "Ben Vogt", Role::User).await;
    env.admin = env.session("anna").await;
    env.user = env.session("ben").await;
    env
}

impl Env {
    async fn add_user(&self, username: &str, name: &str, role: Role) {
        let hash = self.state.hasher.hash(PASSWORD).await.unwrap();
        let (email, username, name) = (
            format!("{username}@example.com"),
            username.to_owned(),
            name.to_owned(),
        );
        db::call(&self.state.db, move |conn| {
            users::insert(
                conn,
                &NewUser {
                    username: &username,
                    email: &email,
                    display_name: &name,
                    role,
                    password_hash: &hash,
                },
            )
        })
        .await
        .unwrap();
    }

    async fn send(&self, request: Request<Body>) -> axum::response::Response {
        let app: Router = router(self.state.clone())
            .layer(MockConnectInfo(SocketAddr::from(([89, 12, 34, 56], 4711))));
        app.oneshot(request).await.unwrap()
    }

    fn builder(method: Method, path: &str) -> axum::http::request::Builder {
        Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"))
            .header(api::CSRF_HEADER, "fetch")
            .header(header::USER_AGENT, "Mozilla/5.0 Firefox/140.0")
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        session: Option<&str>,
    ) -> Reply {
        let mut builder = Self::builder(method, path);
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
        let response = self.send(request).await;
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        Reply {
            status,
            body: String::from_utf8(bytes.to_vec()).unwrap(),
        }
    }

    async fn login(&self, login: &str) -> axum::response::Response {
        let request = Self::builder(Method::POST, "/auth/login")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "login": login, "password": PASSWORD }).to_string(),
            ))
            .unwrap();
        self.send(request).await
    }

    async fn session(&self, login: &str) -> String {
        let response = self.login(login).await;
        assert_eq!(response.status(), StatusCode::OK);
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

    async fn put(&self, body: Value) -> Reply {
        self.request(Method::PUT, MAINTENANCE, Some(body), Some(&self.admin))
            .await
    }

    async fn config(&self) -> Value {
        self.request(Method::GET, "/public/config", None, None)
            .await
            .json()
    }

    async fn storage(&self) -> Value {
        let reply = self
            .request(Method::GET, STORAGE, None, Some(&self.admin))
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.json()
    }

    /// Number of sessions of users without administrator rights.
    async fn user_sessions(&self) -> i64 {
        db::call(&self.state.db, |conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM sessions s JOIN users u ON u.id = s.user_id \
                 WHERE u.role <> 'admin'",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap()
    }

    /// `(recipient, kind, details)` of all notifications, by recipient.
    async fn notifications(&self) -> Vec<(String, String, Value)> {
        db::call(&self.state.db, |conn| {
            let rows = conn
                .prepare(
                    "SELECT u.username, n.kind, n.params FROM notifications n \
                     JOIN users u ON u.id = n.user_id \
                     WHERE n.kind LIKE 'system.maintenance%' ORDER BY u.username, n.rowid",
                )?
                .query_map([], |row| {
                    let params: String = row.get(2)?;
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        serde_json::from_str(&params).unwrap(),
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await
        .unwrap()
    }

    /// `(action, details)` of the maintenance entries in the audit log.
    async fn audit(&self) -> Vec<(String, Option<String>)> {
        db::call(&self.state.db, |conn| {
            let rows = conn
                .prepare(
                    "SELECT action, details FROM audit_log \
                     WHERE action LIKE 'maintenance.%' OR action = 'storage.compact' ORDER BY id",
                )?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await
        .unwrap()
    }
}

#[tokio::test]
async fn only_admins_reach_the_page() {
    let env = env().await;
    let calls = [
        (Method::GET, MAINTENANCE, None),
        (Method::PUT, MAINTENANCE, Some(json!({ "on": true }))),
        (Method::GET, STORAGE, None),
        (Method::POST, COMPACT, None),
    ];
    for (method, path, body) in calls {
        let reply = env
            .request(method.clone(), path, body.clone(), Some(&env.user))
            .await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN, "{method} {path}");
        let reply = env.request(method.clone(), path, body, None).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{method} {path}");
    }
    assert!(!env.state.maintenance.is_on());
    assert!(env.audit().await.is_empty());
}

/// Collects the log output.
#[derive(Clone, Default)]
struct Log(Arc<Mutex<Vec<u8>>>);

impl io::Write for Log {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The expected rejection in maintenance mode is not logged as ERROR.
#[tokio::test]
async fn rejected_login_logs_no_error() {
    let env = env().await;
    let reply = env.put(json!({ "on": true })).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);

    let log = Log::default();
    let writer = log.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let response = env.login("ben").await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);

    let out = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
    assert!(!out.contains("ERROR"), "{out}");
}

#[tokio::test]
async fn switching_on_ends_user_sessions_and_tells_all_admins() {
    let env = env().await;
    assert_eq!(env.user_sessions().await, 1);

    let reply = env
        .put(json!({ "on": true, "message": " Until 6 pm " }))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.json(), json!({ "on": true, "message": "Until 6 pm" }));

    // Ended when switching, not only on the next request.
    assert_eq!(env.user_sessions().await, 0);
    let config = env.config().await;
    assert_eq!(
        config["maintenance"],
        json!({ "on": true, "message": "Until 6 pm" })
    );
    let by = json!({ "by": "Anna Becker" });
    assert_eq!(
        env.notifications().await,
        vec![
            ("anna".into(), "system.maintenance_on".into(), by.clone()),
            ("mia".into(), "system.maintenance_on".into(), by.clone()),
        ],
    );
    assert_eq!(
        env.audit().await,
        vec![("maintenance.on".into(), Some(r#"{"sessions":1}"#.into()))],
    );

    // The administrator stays, the user can no longer get in.
    let me = env
        .request(Method::GET, "/auth/me", None, Some(&env.admin))
        .await;
    assert_eq!(me.status, StatusCode::OK);
    let me = env
        .request(Method::GET, "/auth/me", None, Some(&env.user))
        .await;
    assert_eq!(me.status, StatusCode::UNAUTHORIZED);
    let login = env.login("ben").await;
    assert_eq!(login.status(), StatusCode::SERVICE_UNAVAILABLE);

    // Switching off: open for everyone again, event and audit log, notice stays.
    let reply = env.put(json!({ "on": false })).await;
    assert_eq!(
        reply.json(),
        json!({ "on": false, "message": "Until 6 pm" })
    );
    assert_eq!(
        env.config().await["maintenance"],
        json!({ "on": false, "message": null })
    );
    let shown = env
        .request(Method::GET, MAINTENANCE, None, Some(&env.admin))
        .await;
    assert_eq!(
        shown.json(),
        json!({ "on": false, "message": "Until 6 pm" })
    );
    assert_eq!(env.login("ben").await.status(), StatusCode::OK);
    let notifications = env.notifications().await;
    assert_eq!(notifications.len(), 4);
    assert_eq!(
        notifications[1],
        ("anna".into(), "system.maintenance_off".into(), by)
    );
    assert_eq!(env.audit().await[1], ("maintenance.off".into(), None));
}

#[tokio::test]
async fn only_a_change_of_the_mode_counts() {
    let env = env().await;
    // Switching off what is off, and setting the notice: only stored.
    let reply = env.put(json!({ "on": false, "message": "Draft" })).await;
    assert_eq!(reply.json(), json!({ "on": false, "message": "Draft" }));
    assert_eq!(env.user_sessions().await, 1);
    assert!(env.audit().await.is_empty());
    assert!(env.notifications().await.is_empty());

    env.put(json!({ "on": true })).await;
    assert_eq!(env.audit().await.len(), 1);

    // Switching on again and changing the notice while it applies.
    let reply = env.put(json!({ "on": true, "message": "Tomorrow" })).await;
    assert_eq!(reply.json(), json!({ "on": true, "message": "Tomorrow" }));
    assert_eq!(env.config().await["maintenance"]["message"], "Tomorrow");
    assert_eq!(env.audit().await.len(), 1);
    assert_eq!(env.notifications().await.len(), 2);

    // An empty text or `null` deletes the notice (the web app shows
    // `MAINT_MSG`), a missing field leaves it.
    let reply = env.put(json!({ "message": "  " })).await;
    assert_eq!(reply.json(), json!({ "on": true, "message": null }));
    env.put(json!({ "message": "Tomorrow" })).await;
    let reply = env.put(json!({})).await;
    assert_eq!(reply.json(), json!({ "on": true, "message": "Tomorrow" }));
    let reply = env.put(json!({ "message": null })).await;
    assert_eq!(reply.json(), json!({ "on": true, "message": null }));
}

#[tokio::test]
async fn message_is_checked_and_may_span_lines() {
    let env = env().await;
    for (message, code) in [
        ("x".repeat(501), "too_long"),
        ("Until\u{0}6 pm".to_owned(), "invalid"),
    ] {
        let reply = env.put(json!({ "on": true, "message": message })).await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(reply.json()["fields"]["message"]["code"], code);
    }
    assert!(!env.state.maintenance.is_on());
    assert_eq!(env.user_sessions().await, 1);

    let reply = env.put(json!({ "message": "line 1\nline 2" })).await;
    assert_eq!(reply.json()["message"], "line 1\nline 2");
    let reply = env.put(json!({ "message": "x".repeat(500) })).await;
    assert_eq!(reply.status, StatusCode::OK);
    let reply = env.put(json!({ "open": true })).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn mode_survives_a_restart() {
    let env = env().await;
    env.put(json!({ "on": true, "message": "Until 6 pm" }))
        .await;
    env.state.maintenance.set(Mode::default());
    env.state.load().await.unwrap();
    assert_eq!(
        env.state.maintenance.current(),
        Mode {
            on: true,
            message: Some("Until 6 pm".into())
        }
    );
}

#[tokio::test]
async fn storage_counts_logo_apart_from_database() {
    let env = env().await;
    let plain = env.storage().await;
    assert!(plain["database"].as_i64().unwrap() > 0);
    assert_eq!(plain["assets"], 0);
    assert_eq!(plain["asset_name"], Value::Null);
    assert_eq!(plain["compacted_at"], Value::Null);

    let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>"#;
    let url = format!("data:image/svg+xml;base64,{}", STANDARD.encode(svg));
    let reply = env
        .request(
            Method::PUT,
            "/admin/branding",
            Some(json!({ "kind": "image", "image": url, "imageName": "logo.svg" })),
            Some(&env.admin),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);

    let logo = env.storage().await;
    let assets = logo["assets"].as_i64().unwrap();
    assert!(assets > 0, "{logo}");
    assert_eq!(logo["asset_name"], "logo.svg");
    // The database counts without the logo stored in it.
    let total: i64 = db::call(&env.state.db, |conn| Ok(db::size(conn)?))
        .await
        .unwrap();
    assert_eq!(logo["database"].as_i64().unwrap(), total - assets);
}

#[tokio::test]
async fn compact_shrinks_the_database_and_renews_browser_caches() {
    let env = env().await;
    assert_eq!(env.config().await["client_cache_version"], 0);
    db::call(&env.state.db, |conn| {
        conn.execute_batch("CREATE TABLE ballast (data BLOB NOT NULL)")?;
        for _ in 0..64 {
            conn.execute("INSERT INTO ballast (data) VALUES (zeroblob(65536))", [])?;
        }
        conn.execute("DELETE FROM ballast", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let before = env.storage().await["database"].as_i64().unwrap();

    let reply = env
        .request(Method::POST, COMPACT, None, Some(&env.admin))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let after = reply.json();
    assert!(after["database"].as_i64().unwrap() < before / 2, "{after}");
    assert!(after["compacted_at"].is_string(), "{after}");
    assert_eq!(env.storage().await["compacted_at"], after["compacted_at"]);
    assert_eq!(env.config().await["client_cache_version"], 1);
    assert_eq!(env.audit().await, vec![("storage.compact".into(), None)]);

    let reply = env
        .request(Method::POST, COMPACT, None, Some(&env.admin))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(env.config().await["client_cache_version"], 2);

    // The version comes from the database after a restart.
    env.state.instance.set_client_cache_version(0);
    let instance = env.state.instance.clone();
    db::call(&env.state.db, move |conn| instance.load(conn))
        .await
        .unwrap();
    assert_eq!(env.config().await["client_cache_version"], 2);
}

#[tokio::test]
async fn unreadable_settings_neither_stop_the_server_nor_the_page() {
    let env = env().await;
    let instance = env.state.instance.clone();
    db::call(&env.state.db, move |conn| {
        app_settings::set(conn, CLIENT_CACHE_VERSION, &"broken")?;
        app_settings::set(conn, "storage_compacted_at", &12)?;
        instance.load(conn)
    })
    .await
    .unwrap();
    assert_eq!(env.config().await["client_cache_version"], 0);
    assert_eq!(env.storage().await["compacted_at"], Value::Null);

    let reply = env
        .request(Method::POST, COMPACT, None, Some(&env.admin))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert!(reply.json()["compacted_at"].is_string());
    assert_eq!(env.config().await["client_cache_version"], 1);
}
