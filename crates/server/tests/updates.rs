//! Administration › Updates via the API: schedule, optional token with check,
//! "Check now", job, events and `public/config` – against our own server
//! instead of the GitHub API.

use std::{
    future::IntoFuture as _,
    io,
    net::SocketAddr,
    sync::{Arc, Mutex},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{OriginalUri, State, connect_info::MockConnectInfo},
    http::{HeaderMap, HeaderName, Method, Request, StatusCode, header},
    response::{IntoResponse, Response},
};
use http_body_util::BodyExt as _;
use jiff::Timestamp;
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
            app_settings, notifications, update_state,
            users::{self, NewUser, Role},
        },
    },
    jobs::update_check,
    settings::{self, Settings},
    updates,
    web::static_files::WebAssets,
};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tower::ServiceExt as _;
use url::Url;

const PASSWORD: &str = "Summer2026!";
const PATH: &str = "/admin/updates";
const CHECK: &str = "/admin/updates/check";
const REMOVE: &str = "/admin/updates/remove-pat";
/// Only has the shape of a token.
const TOKEN: &str = "ghp_abcdefghijklmnopqrstuvwxyz01a1F3";

/// What the mocked GitHub server answers and what it has seen.
struct Script {
    status: StatusCode,
    headers: Vec<(&'static str, &'static str)>,
    releases: Value,
    calls: Vec<(String, String)>,
}

#[derive(Clone)]
struct Github(Arc<Mutex<Script>>);

impl Github {
    async fn start() -> (Self, Url) {
        let github = Self(Arc::new(Mutex::new(Script {
            status: StatusCode::OK,
            headers: Vec::new(),
            releases: json!([]),
            calls: Vec::new(),
        })));
        let app = Router::new().fallback(reply).with_state(github.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        tokio::spawn(axum::serve(listener, app).into_future());
        (github, Url::parse(&url).unwrap())
    }

    fn answer(&self, status: StatusCode) {
        let mut script = self.0.lock().unwrap();
        script.status = status;
        script.headers.clear();
    }

    fn rate_limited(&self) {
        let mut script = self.0.lock().unwrap();
        script.status = StatusCode::FORBIDDEN;
        script.headers = vec![("x-ratelimit-remaining", "0")];
    }

    fn release(&self, tags: &[&str]) {
        let mut script = self.0.lock().unwrap();
        script.status = StatusCode::OK;
        script.headers.clear();
        script.releases = tags
            .iter()
            .map(|tag| {
                json!({
                    "tag_name": tag,
                    "body": "### Features\n\n- **web:** New page ([#1](https://x.test))\n",
                })
            })
            .collect();
    }

    fn calls(&self) -> Vec<(String, String)> {
        self.0.lock().unwrap().calls.clone()
    }
}

async fn reply(
    State(github): State<Github>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    let mut script = github.0.lock().unwrap();
    let auth = headers
        .get(header::AUTHORIZATION)
        .map(|value| value.to_str().unwrap().to_owned())
        .unwrap_or_default();
    script.calls.push((auth, uri.to_string()));
    let mut response = (script.status, Json(script.releases.clone())).into_response();
    for (name, value) in &script.headers {
        response
            .headers_mut()
            .insert(HeaderName::from_static(name), value.parse().unwrap());
    }
    response
}

struct Env {
    _tmp: tempfile::TempDir,
    state: AppState,
    github: Github,
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
        Url::parse("https://app.example.com").unwrap(),
        SecretKey::random().unwrap(),
    )
    .unwrap();
    state.hasher = Arc::new(Hasher::with_params(Params::new(64, 1, 1, None).unwrap()));
    let (github, url) = Github::start().await;
    state.github_api = Arc::new(url);
    let mut env = Env {
        _tmp: tmp,
        state,
        github,
        admin: String::new(),
        user: String::new(),
    };
    env.add_user("anna", "anna@example.com", Role::Admin).await;
    env.add_user("ben", "ben@example.com", Role::User).await;
    env.admin = env.session("anna").await;
    env.user = env.session("ben").await;
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
        reply.json()
    }

    async fn put(&self, body: Value) -> Reply {
        self.request(Method::PUT, PATH, Some(body), Some(&self.admin))
            .await
    }

    async fn post(&self, path: &str) -> Reply {
        self.request(Method::POST, path, None, Some(&self.admin))
            .await
    }

    async fn save_token(&self) -> Value {
        let reply = self.put(json!({ "pat": TOKEN })).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.json()
    }

    async fn check(&self) -> Value {
        let reply = self.post(CHECK).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.json()
    }

    /// Actions in the audit log, oldest first.
    async fn audit(&self) -> Vec<String> {
        db::call(&self.state.db, |conn| {
            let mut stmt = conn.prepare("SELECT action FROM audit_log ORDER BY rowid")?;
            let actions = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .filter_map(Result::ok)
                .filter(|action| action.starts_with("updates."))
                .collect();
            Ok(actions)
        })
        .await
        .unwrap()
    }

    /// Notifications of the person without security, oldest first.
    async fn notes(&self, login: &'static str) -> Vec<(String, Value)> {
        db::call(&self.state.db, move |conn| {
            let id: String =
                conn.query_row("SELECT id FROM users WHERE username = ?1", [login], |row| {
                    row.get(0)
                })?;
            let mut notes = notifications::list(conn, &id)?;
            notes.reverse();
            Ok(notes
                .into_iter()
                // The tests' sign-in reports itself.
                .filter(|note| note.topic != "security")
                .map(|note| (note.kind, note.params))
                .collect())
        })
        .await
        .unwrap()
    }

    async fn public_update(&self) -> Value {
        let reply = self
            .request(Method::GET, "/public/config", None, None)
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.json()["update"].clone()
    }

    async fn raw_settings(&self) -> String {
        db::call(&self.state.db, |conn| {
            Ok(app_settings::get::<Value>(conn, updates::KEY)?
                .map(|value| value.to_string())
                .unwrap_or_default())
        })
        .await
        .unwrap()
    }
}

#[tokio::test]
async fn only_admins_with_the_defaults() {
    let env = env().await;
    let path = PATH;
    let denied = env.request(Method::GET, path, None, Some(&env.user)).await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    let denied = env.request(Method::GET, path, None, None).await;
    assert_eq!(denied.status, StatusCode::UNAUTHORIZED);
    let denied = env
        .request(Method::POST, CHECK, None, Some(&env.user))
        .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);

    let view = env.get().await;
    assert_eq!(view["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(view["status"], "ok");
    assert_eq!(view["available"], false);
    assert_eq!(view["latest"], Value::Null);
    // Without a previous check, the first one is due right away – no token needed.
    assert!(view["next_at"].is_string());
    assert_eq!(view["auto"], true);
    assert_eq!(view["every"], "daily");
    assert_eq!(view["time"], "03:00");
    assert_eq!(view["weekday"], "monday");
    assert_eq!(view["show"], true);
    assert_eq!(view["pat"], Value::Null);
}

#[tokio::test]
async fn schedule_and_display_are_saved_and_logged() {
    let env = env().await;
    // The time zone comes from the administrator who changes the schedule.
    let Value::Object(changes) = json!({ "tz": "Asia/Tokyo" }) else {
        unreachable!()
    };
    let tokyo = Settings::default().apply(&changes).unwrap();
    db::call(&env.state.db, move |conn| {
        let id: String =
            conn.query_row("SELECT id FROM users WHERE username = 'anna'", [], |row| {
                row.get(0)
            })?;
        settings::save(conn, &id, 0, &tokyo)?;
        Ok(())
    })
    .await
    .unwrap();

    let reply = env
        .put(json!({
            "auto": false, "every": "weekly", "time": "04:30", "weekday": "friday", "show": false,
        }))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let view = env.get().await;
    assert_eq!(view["auto"], false);
    assert_eq!(view["every"], "weekly");
    assert_eq!(view["time"], "04:30");
    assert_eq!(view["weekday"], "friday");
    assert_eq!(view["show"], false);
    assert!(env.raw_settings().await.contains("Asia/Tokyo"));
    assert_eq!(env.audit().await, ["updates.settings"]);

    // Unchanged is no change.
    let reply = env.put(json!({ "time": "04:30" })).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(env.audit().await, ["updates.settings"]);
}

#[tokio::test]
async fn invalid_fields_change_nothing() {
    let env = env().await;
    let reply = env
        .put(json!({
            "every": "monthly", "time": "25:00", "weekday": "Mon", "pat": "secret", "auto": false,
        }))
        .await;
    assert_eq!(
        reply.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        reply.body
    );
    let fields = &reply.json()["fields"];
    for field in ["every", "time", "weekday", "pat"] {
        assert_eq!(fields[field]["code"], "invalid", "{field}: {fields}");
    }
    assert!(env.github.calls().is_empty());
    assert_eq!(env.get().await["auto"], true);
    assert_eq!(env.audit().await, Vec::<String>::new());

    let unknown = env.put(json!({ "check": true })).await;
    assert!(unknown.status.is_client_error(), "{}", unknown.status);
}

#[tokio::test]
async fn token_is_verified_before_it_is_saved() {
    let env = env().await;
    for (status, code) in [
        (StatusCode::UNAUTHORIZED, "invalid"),
        (StatusCode::NOT_FOUND, "invalid"),
        (StatusCode::FORBIDDEN, "invalid"),
        (StatusCode::BAD_GATEWAY, "unavailable"),
    ] {
        env.github.answer(status);
        let reply = env.put(json!({ "pat": TOKEN })).await;
        assert_eq!(
            reply.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{}",
            reply.body
        );
        assert_eq!(reply.json()["fields"]["pat"]["code"], code, "{status}");
    }
    env.github.rate_limited();
    let reply = env.put(json!({ "pat": TOKEN })).await;
    assert_eq!(reply.json()["fields"]["pat"]["code"], "unavailable");
    let view = env.get().await;
    assert_eq!(
        (&view["status"], &view["pat"]),
        (&json!("ok"), &Value::Null)
    );
    assert_eq!(env.audit().await, Vec::<String>::new());

    env.github.release(&[]);
    let view = env.save_token().await;
    assert_eq!(view["status"], "ok");
    assert_eq!(view["pat"]["prefix"], "ghp_");
    assert_eq!(view["pat"]["tail"], "a1F3");
    assert!(view["pat"]["saved_at"].is_string());
    assert!(view["next_at"].is_string());
    assert!(!view.to_string().contains(TOKEN));
    assert_eq!(env.audit().await, ["updates.pat"]);

    let (auth, path) = env.github.calls().pop().unwrap();
    assert_eq!(auth, format!("Bearer {TOKEN}"));
    assert_eq!(path, "/repos/roedylabs/mail/releases?per_page=30");
    let stored = env.raw_settings().await;
    assert!(!stored.contains(TOKEN), "{stored}");
}

#[tokio::test]
async fn without_a_token_checks_run_unauthenticated() {
    let env = env().await;
    env.github.release(&["v99.0.0"]);
    env.save_token().await;

    let reply = env.post(REMOVE).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let view = reply.json();
    assert_eq!(view["status"], "ok");
    assert_eq!(view["pat"], Value::Null);
    assert!(view["next_at"].is_string());
    assert!(!env.raw_settings().await.contains("enc"));

    // The public repository needs no token: no `Authorization` header.
    let view = env.check().await;
    assert_eq!(view["latest"], "99.0.0");
    let (auth, path) = env.github.calls().pop().unwrap();
    assert_eq!(auth, "");
    assert_eq!(path, "/repos/roedylabs/mail/releases?per_page=30");

    // Removing again changes nothing.
    assert_eq!(env.post(REMOVE).await.status, StatusCode::OK);
    assert_eq!(
        env.audit().await,
        [
            "updates.pat",
            "updates.available",
            "updates.pat_remove",
            "updates.check"
        ]
    );
}

#[tokio::test]
async fn a_new_version_is_reported_once_to_the_admins() {
    let env = env().await;
    env.github.release(&[]);
    let view = env.save_token().await;
    assert_eq!(view["latest"], Value::Null);
    assert_eq!(view["available"], false);

    env.github.release(&["v98.9.0", "v99.0.0", "v0.0.0"]);
    let view = env.check().await;
    assert_eq!(view["latest"], "99.0.0");
    assert_eq!(view["available"], true);
    assert_eq!(view["status"], "ok");
    assert!(view["checked_at"].is_string());
    let available = (
        "system.update_available".to_owned(),
        json!({ "version": "99.0.0" }),
    );
    assert_eq!(env.notes("anna").await, std::slice::from_ref(&available));
    assert!(env.notes("ben").await.is_empty());

    // The same version is not reported again.
    env.check().await;
    assert_eq!(env.notes("anna").await.len(), 1);

    env.github.release(&["v99.1.0"]);
    env.check().await;
    assert_eq!(
        env.notes("anna").await,
        [
            available,
            (
                "system.update_available".to_owned(),
                json!({ "version": "99.1.0" }),
            ),
        ]
    );
    assert_eq!(
        env.audit().await,
        [
            "updates.pat",
            "updates.available",
            "updates.check",
            "updates.check",
            "updates.available",
            "updates.check",
        ]
    );
}

#[tokio::test]
async fn saving_a_token_counts_as_a_check() {
    let env = env().await;
    env.github.release(&["v99.0.0"]);
    let view = env.save_token().await;
    assert_eq!(view["latest"], "99.0.0");
    assert_eq!(view["available"], true);
    assert_eq!(env.notes("anna").await.len(), 1);
    assert_eq!(env.audit().await, ["updates.pat", "updates.available"]);
}

#[tokio::test]
async fn an_older_release_is_no_news() {
    let env = env().await;
    env.github.release(&["v0.0.0"]);
    let view = env.save_token().await;
    assert_eq!(view["latest"], "0.0.0");
    assert_eq!(view["available"], false);
    assert!(env.notes("anna").await.is_empty());
}

#[tokio::test]
async fn a_failed_check_stays_in_the_status() {
    let env = env().await;
    env.github.release(&["v0.0.0"]);
    env.save_token().await;

    for (status, reason) in [
        (StatusCode::UNAUTHORIZED, "token"),
        (StatusCode::NOT_FOUND, "no_access"),
        (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
        (StatusCode::INTERNAL_SERVER_ERROR, "unreachable"),
    ] {
        env.github.answer(status);
        let view = env.check().await;
        assert_eq!(view["status"], "err", "{status}");
        assert_eq!(view["reason"], reason, "{status}");
        assert_eq!(view["latest"], "0.0.0");
    }

    env.github.release(&["v0.0.0"]);
    let view = env.check().await;
    assert_eq!(view["status"], "ok");
    assert_eq!(view["reason"], Value::Null);

    // The rate limit for unauthenticated requests shows the same way.
    env.post(REMOVE).await;
    env.github.rate_limited();
    let view = env.check().await;
    assert_eq!(view["status"], "err");
    assert_eq!(view["reason"], "rate_limited");
}

/// Collects the log of a test.
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

/// A rate limit or GitHub being away passes on its own and is no warning
/// (E2E fails on any WARN); a token or access problem needs the
/// administrator and is one. The status shows every failure.
#[tokio::test]
async fn only_failures_to_fix_are_warnings() {
    let env = env().await;
    for (status, reason, level) in [
        // 403 with the rate limit headers.
        (StatusCode::FORBIDDEN, "rate_limited", "INFO"),
        (StatusCode::TOO_MANY_REQUESTS, "rate_limited", "INFO"),
        (StatusCode::BAD_GATEWAY, "unreachable", "INFO"),
        (StatusCode::UNAUTHORIZED, "token", "WARN"),
        (StatusCode::NOT_FOUND, "no_access", "WARN"),
    ] {
        if status == StatusCode::FORBIDDEN {
            env.github.rate_limited();
        } else {
            env.github.answer(status);
        }
        let log = Log::default();
        let writer = log.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        let guard = tracing::subscriber::set_default(subscriber);
        updates::check(&env.state).await.unwrap();
        drop(guard);

        let out = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
        let line = out
            .lines()
            .find(|line| line.contains("update check failed"))
            .unwrap_or_else(|| panic!("{reason}: {out}"));
        assert!(line.contains(&format!(" {level} ")), "{line}");
        assert!(line.contains(&format!("reason=\"{reason}\"")), "{line}");
        assert_eq!(env.get().await["reason"], reason);
    }
}

#[tokio::test]
async fn checks_are_limited_per_admin() {
    let env = env().await;
    env.github.release(&["v0.0.0"]);
    env.save_token().await;
    // The token counts too.
    for _ in 1..20 {
        env.check().await;
    }
    assert_eq!(env.post(CHECK).await.status, StatusCode::TOO_MANY_REQUESTS);
    let reply = env.put(json!({ "pat": TOKEN })).await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(env.github.calls().len(), 20);
}

#[tokio::test]
async fn the_job_follows_the_schedule() {
    let env = env().await;
    env.github.release(&["v0.0.0"]);
    // Never checked: due right away, also without a token.
    update_check::run(env.state.clone()).await.unwrap();
    assert_eq!(
        env.github.calls(),
        [(
            String::new(),
            "/repos/roedylabs/mail/releases?per_page=30".to_owned()
        )]
    );
    // Just checked: the next run is in the future.
    update_check::run(env.state.clone()).await.unwrap();
    assert_eq!(env.github.calls().len(), 1);

    env.save_token().await;
    assert_eq!(env.github.calls().len(), 2);
    update_check::run(env.state.clone()).await.unwrap();
    assert_eq!(env.github.calls().len(), 2);

    // Two days ago: due, and the result moves the next run on.
    let long_ago: Timestamp = "2026-01-01T00:00:00Z".parse().unwrap();
    db::call(&env.state.db, move |conn| {
        update_state::succeeded(conn, Some("0.0.0"), None, long_ago)?;
        Ok(())
    })
    .await
    .unwrap();
    update_check::run(env.state.clone()).await.unwrap();
    assert_eq!(env.github.calls().len(), 3);
    let (auth, _) = env.github.calls().pop().unwrap();
    assert_eq!(auth, format!("Bearer {TOKEN}"));
    update_check::run(env.state.clone()).await.unwrap();
    assert_eq!(env.github.calls().len(), 3);

    // Switching automatic checks off stops the job.
    db::call(&env.state.db, move |conn| {
        update_state::succeeded(conn, Some("0.0.0"), None, long_ago)?;
        Ok(())
    })
    .await
    .unwrap();
    let reply = env.put(json!({ "auto": false })).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.json()["next_at"], Value::Null);
    update_check::run(env.state.clone()).await.unwrap();
    assert_eq!(env.github.calls().len(), 3);
    // The job does not show up in the audit log, only an administrator.
    assert_eq!(env.audit().await, ["updates.pat", "updates.settings"]);
}

#[tokio::test]
async fn public_config_shows_the_state_only_when_known_and_wanted() {
    let env = env().await;
    assert_eq!(env.public_update().await, Value::Null);

    // Checked without a token, but no release yet.
    env.github.release(&[]);
    env.check().await;
    assert_eq!(env.public_update().await, Value::Null);

    env.github.release(&["v0.0.0"]);
    env.check().await;
    assert_eq!(
        env.public_update().await,
        json!({ "available": false, "latest": "0.0.0" })
    );

    env.github.release(&["v99.0.0"]);
    env.check().await;
    assert_eq!(
        env.public_update().await,
        json!({ "available": true, "latest": "99.0.0" })
    );

    let reply = env.put(json!({ "show": false })).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(env.public_update().await, Value::Null);
    assert_eq!(reply.json()["update"], Value::Null);

    let reply = env.put(json!({ "show": true })).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(env.public_update().await["latest"], "99.0.0");
    assert_eq!(reply.json()["update"], env.public_update().await);

    // After a restart from the database.
    env.state.load().await.unwrap();
    assert_eq!(env.public_update().await["latest"], "99.0.0");
}

#[tokio::test]
async fn a_version_change_is_announced_at_start() {
    let env = env().await;
    // First start: no notification.
    updates::on_start(&env.state).await.unwrap();
    updates::on_start(&env.state).await.unwrap();
    assert!(env.notes("anna").await.is_empty());

    let version = updates::VERSION.to_owned();
    db::call(&env.state.db, move |conn| {
        assert_eq!(
            update_state::load(conn)?.installed_version.as_deref(),
            Some(version.as_str())
        );
        update_state::set_installed(conn, "0.0.1")?;
        update_state::succeeded(conn, Some("99.0.0"), Some("New page"), Timestamp::now())?;
        let tx = conn.transaction()?;
        drop(updates::installed(&tx, "99.0.0")?);
        tx.commit()?;
        assert_eq!(
            update_state::load(conn)?.installed_version.as_deref(),
            Some("99.0.0")
        );
        Ok(())
    })
    .await
    .unwrap();

    let installed = (
        "system.update_installed".to_owned(),
        json!({ "version": "99.0.0", "from": "0.0.1" }),
    );
    let news = (
        "news.release".to_owned(),
        json!({ "version": "99.0.0", "summary": "New page" }),
    );
    assert_eq!(env.notes("anna").await, [installed, news.clone()]);
    assert_eq!(env.notes("ben").await, [news]);
    assert_eq!(env.audit().await, ["updates.installed"]);

    // Started again: nothing new; summary only for the version it belongs to.
    db::call(&env.state.db, |conn| {
        drop(updates::installed(conn, "99.0.0")?);
        drop(updates::installed(conn, "99.1.0")?);
        Ok(())
    })
    .await
    .unwrap();
    let notes = env.notes("ben").await;
    assert_eq!(notes.len(), 2);
    assert_eq!(notes[1].1, json!({ "version": "99.1.0" }));
}
