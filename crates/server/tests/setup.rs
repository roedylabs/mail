//! Initial setup via the API: setup token with lockout per client IP,
//! completion only with token in one transaction with a session and the
//! administrator's appearance, locked afterwards – also for `roedy-mail
//! setup-token`.

use std::{net::SocketAddr, process::Command, sync::Arc};

use axum::{
    Router,
    body::Body,
    extract::connect_info::MockConnectInfo,
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header},
};
use http_body_util::BodyExt as _;
use roedy_mail_server::{
    api::{self, setup::TOKEN_HEADER},
    app::{AppState, router},
    auth::{
        password::{Hasher, Params},
        session,
    },
    broker::crypto::SecretKey,
    config::Config,
    db::{
        self, Db,
        repo::{app_settings, notifications},
    },
    mailer::system_mail,
    setup_token,
    web::static_files::WebAssets,
};
use serde_json::{Value, json};
use tower::ServiceExt as _;
use url::Url;

const CLIENT: [u8; 4] = [203, 0, 113, 9];

struct Setup {
    tmp: tempfile::TempDir,
    state: AppState,
    token: String,
}

async fn setup_with(config: Config) -> Setup {
    let tmp = tempfile::tempdir().unwrap();
    let conn = db::open(tmp.path()).unwrap();
    let token = setup_token::ensure(&conn).unwrap().unwrap();
    let mut state = AppState::new(
        Db::from(conn),
        Arc::new(WebAssets::None),
        &config,
        Url::parse("https://app.example.com").unwrap(),
        SecretKey::random().unwrap(),
    )
    .unwrap();
    // Low cost so that completion stays fast.
    state.hasher = Arc::new(Hasher::with_params(Params::new(64, 1, 1, None).unwrap()));
    state.load().await.unwrap();
    Setup { tmp, state, token }
}

async fn setup() -> Setup {
    setup_with(Config::default()).await
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
}

fn app(state: &AppState, ip: [u8; 4]) -> Router {
    router(state.clone()).layer(MockConnectInfo(SocketAddr::from((ip, 4711))))
}

/// `POST` to the setup API, with the token in the header if given.
async fn post_from(
    state: &AppState,
    ip: [u8; 4],
    path: &str,
    token: Option<&str>,
    body: Value,
    cookie: Option<&str>,
) -> Reply {
    let mut builder = Request::builder()
        .method(Method::POST)
        .uri(path)
        .header(api::CSRF_HEADER, "fetch")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::USER_AGENT, "Mozilla/5.0 (Test)");
    if let Some(token) = token {
        builder = builder.header(TOKEN_HEADER, token);
    }
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, format!("{}={cookie}", session::COOKIE));
    }
    read_reply(
        app(state, ip)
            .oneshot(builder.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap(),
    )
    .await
}

async fn post(state: &AppState, path: &str, token: Option<&str>, body: Value) -> Reply {
    post_from(state, CLIENT, path, token, body, None).await
}

async fn get(state: &AppState, path: &str, cookie: &str) -> Reply {
    let request = Request::get(path)
        .header(header::COOKIE, format!("{}={cookie}", session::COOKIE))
        .body(Body::empty())
        .unwrap();
    read_reply(app(state, CLIENT).oneshot(request).await.unwrap()).await
}

async fn read_reply(response: axum::response::Response) -> Reply {
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    Reply {
        status,
        headers,
        body: String::from_utf8(bytes.to_vec()).unwrap(),
    }
}

/// Token from `Set-Cookie`.
fn session_cookie(reply: &Reply) -> String {
    let cookie = reply.headers[header::SET_COOKIE].to_str().unwrap();
    assert!(
        cookie.contains("HttpOnly; Secure; SameSite=Lax"),
        "{cookie}"
    );
    cookie
        .strip_prefix(&format!("{}=", session::COOKIE))
        .and_then(|rest| rest.split(';').next())
        .unwrap()
        .to_owned()
}

fn complete_body() -> Value {
    json!({
        "name": "Max Mustermann",
        "email": "Max@Example.com",
        "password": "Summer2026!",
        "settings": { "lang": "de", "mode": "dark", "accent": "sage" },
    })
}

async fn audit(state: &AppState) -> Vec<(String, String, String)> {
    db::call(&state.db, |conn| {
        let mut stmt =
            conn.prepare("SELECT category, action, actor_name FROM audit_log ORDER BY id")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn token_locks_after_five_failures_per_client() {
    let s = setup().await;
    for remaining in (1..5).rev() {
        let reply = post(
            &s.state,
            "/api/v1/setup/token",
            None,
            json!({ "token": "AAAA-AAAA-AAAA" }),
        )
        .await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            reply.json(),
            json!({ "error": "invalid_token", "remaining": remaining })
        );
    }
    // The fifth failed attempt locks for 30 seconds ("Too many attempts.").
    let reply = post(
        &s.state,
        "/api/v1/setup/token",
        None,
        json!({ "token": "" }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(reply.headers[header::RETRY_AFTER], "30");
    assert_eq!(
        reply.json(),
        json!({ "error": "rate_limited", "retry_after": 30 })
    );
    // While locked even the right token does not count, not in the steps either.
    let reply = post(
        &s.state,
        "/api/v1/setup/token",
        None,
        json!({ "token": s.token }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
    let reply = post(
        &s.state,
        "/api/v1/setup/complete",
        Some(&s.token),
        complete_body(),
    )
    .await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);

    // Other clients are not affected; spelling as in the input field does not matter.
    let typed = s.token.replace('-', "").to_lowercase();
    let reply = post_from(
        &s.state,
        [198, 51, 100, 7],
        "/api/v1/setup/token",
        None,
        json!({ "token": typed }),
        None,
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.json(), json!({}));
    assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store");
}

#[tokio::test]
async fn correct_tokens_do_not_count() {
    let s = setup().await;
    for _ in 0..10 {
        let reply = post(
            &s.state,
            "/api/v1/setup/token",
            None,
            json!({ "token": s.token }),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
    }
    let reply = post(
        &s.state,
        "/api/v1/setup/token",
        None,
        json!({ "token": "x" }),
    )
    .await;
    assert_eq!(reply.json()["remaining"], 4);
}

#[tokio::test]
async fn completion_needs_the_token() {
    let s = setup().await;
    let path = "/api/v1/setup/complete";
    let reply = post(&s.state, path, None, complete_body()).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.json()["error"], "bad_request");
    // A wrong token counts here too, and nothing is checked before the body.
    for remaining in [4, 3] {
        let reply = post(
            &s.state,
            path,
            Some("ABCD-EFGH-JKLM"),
            json!({ "broken": 1 }),
        )
        .await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(reply.json()["remaining"], remaining);
    }
    // A header that is not text is a failed attempt, not a missing header.
    let request = Request::post(path)
        .header(api::CSRF_HEADER, "fetch")
        .header(header::CONTENT_TYPE, "application/json")
        .header(TOKEN_HEADER, HeaderValue::from_bytes(b"ABCD-\xff").unwrap())
        .body(Body::from(complete_body().to_string()))
        .unwrap();
    let reply = read_reply(
        app(&s.state, [192, 0, 2, 7])
            .oneshot(request)
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(reply.json()["remaining"], 4);
    // Changing requests need `X-Requested-With`, as everywhere.
    let request = Request::post("/api/v1/setup/token")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "token": s.token }).to_string()))
        .unwrap();
    let reply = read_reply(
        app(&s.state, [192, 0, 2, 1])
            .oneshot(request)
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(reply.json()["error"], "csrf");
}

#[tokio::test]
async fn mail_server_and_system_mail_steps_are_gone() {
    let s = setup().await;
    for path in [
        "/api/v1/setup/servers/test",
        "/api/v1/setup/servers/register-client",
        "/api/v1/setup/system-mail/test",
    ] {
        let reply = post(
            &s.state,
            path,
            Some(&s.token),
            json!({ "url": "https://mail.example.com" }),
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{path}");
    }
    // Neither counted towards the lockout.
    let reply = post(
        &s.state,
        "/api/v1/setup/token",
        None,
        json!({ "token": "x" }),
    )
    .await;
    assert_eq!(reply.json()["remaining"], 4);
}

#[tokio::test]
async fn complete_creates_the_administrator_with_their_appearance() {
    let s = setup().await;
    let reply = post(
        &s.state,
        "/api/v1/setup/complete",
        Some(&s.token),
        complete_body(),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let user = reply.json()["user"].clone();
    assert_eq!(user["username"], "max");
    assert_eq!(user["email"], "Max@Example.com");
    assert_eq!(user["display_name"], "Max Mustermann");
    assert_eq!(user["role"], "admin");
    let cookie = session_cookie(&reply);

    // The session is valid; the settings are the administrator's own, with
    // the defaults for everything else.
    let reply = get(&s.state, "/api/v1/settings", &cookie).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let stored = reply.json();
    assert_eq!(stored["version"], 1);
    assert_eq!(stored["settings"]["lang"], "de");
    assert_eq!(stored["settings"]["mode"], "dark");
    assert_eq!(stored["settings"]["accent"], "sage");
    assert_eq!(stored["settings"]["density"], "normal");

    // The setup stores neither mail server, system mail nor address: they come from the
    // administration and `ROEDY_PUBLIC_URL`.
    let reply = get(&s.state, "/api/v1/admin/servers", &cookie).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.json()["servers"], json!([]));
    let (public_url, configured, token) = db::call(&s.state.db, |conn| {
        Ok((
            app_settings::get::<Url>(conn, app_settings::PUBLIC_URL)?,
            system_mail::is_configured(conn)?,
            setup_token::current(conn)?,
        ))
    })
    .await
    .unwrap();
    assert_eq!(public_url, None, "public URL not stored");
    assert!(!configured);
    assert_eq!(token, None, "setup token deleted");
    assert_eq!(
        audit(&s.state).await,
        [
            (
                "system".into(),
                "setup.complete".into(),
                "Max Mustermann".into()
            ),
            ("login".into(), "auth.login".into(), "Max Mustermann".into()),
        ]
    );

    // Afterwards all setup endpoints are locked, also with the old token.
    for (path, body) in [
        ("/api/v1/setup/token", json!({ "token": s.token })),
        ("/api/v1/setup/complete", complete_body()),
    ] {
        let reply = post(&s.state, path, Some(&s.token), body.clone()).await;
        assert_eq!(reply.status, StatusCode::CONFLICT, "{path}");
        assert_eq!(reply.json(), json!({ "error": "setup_done" }), "{path}");
        // Also without a token: this way the page sees that nothing is left to do.
        let reply = post(&s.state, path, None, body).await;
        assert_eq!(reply.status, StatusCode::CONFLICT, "{path}");
    }
}

#[tokio::test]
async fn the_setup_device_is_known_without_a_notice() {
    let s = setup().await;
    let reply = post(
        &s.state,
        "/api/v1/setup/complete",
        Some(&s.token),
        complete_body(),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let id = reply.json()["user"]["id"].as_str().unwrap().to_owned();
    let login = json!({ "login": "max", "password": "Summer2026!" });
    let kinds = || async {
        let id = id.clone();
        db::call(&s.state.db, move |conn| notifications::list(conn, &id))
            .await
            .unwrap()
            .into_iter()
            .map(|n| n.kind)
            .collect::<Vec<_>>()
    };

    // The same device as during setup: known.
    // "Welcome" on account creation.
    assert_eq!(kinds().await, ["news.welcome"]);
    let again = post(&s.state, "/api/v1/auth/login", None, login.clone()).await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.body);
    assert_eq!(kinds().await, ["news.welcome"]);
    // From another network: "New sign-in".
    let elsewhere = post_from(
        &s.state,
        [198, 51, 100, 1],
        "/api/v1/auth/login",
        None,
        login,
        None,
    )
    .await;
    assert_eq!(elsewhere.status, StatusCode::OK, "{}", elsewhere.body);
    assert_eq!(kinds().await, ["security.login", "news.welcome"]);
}

#[tokio::test]
async fn complete_validates_before_storing_anything() {
    let s = setup().await;
    let path = "/api/v1/setup/complete";
    let mut body = complete_body();
    body["password"] = json!("summer2026");
    body["name"] = json!("Max (Admin) 2");
    let reply = post(&s.state, path, Some(&s.token), body).await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        reply.json()["fields"],
        json!({
            "name": { "code": "invalid" },
            "password": { "code": "policy", "rules": ["case"] },
        })
    );
    assert!(!reply.headers.contains_key(header::SET_COOKIE));

    // The old fields, an unknown appearance or missing settings: 400.
    let mut old = complete_body();
    old["public_url"] = json!("https://app.example.com");
    let mut server = complete_body();
    server["server"] = json!({ "url": "https://mail.example.com" });
    let mut system_mail = complete_body();
    system_mail["system_mail"] = json!({ "user": "noreply", "app_password": "x" });
    let mut accent = complete_body();
    accent["settings"]["accent"] = json!("teal");
    let mut extra = complete_body();
    extra["settings"]["density"] = json!("compact");
    let mut missing = complete_body();
    missing["settings"].as_object_mut().unwrap().remove("mode");
    let mut without = complete_body();
    without.as_object_mut().unwrap().remove("settings");
    for body in [old, server, system_mail, accent, extra, missing, without] {
        let reply = post(&s.state, path, Some(&s.token), body.clone()).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{body}");
    }

    let (token, users) = db::call(&s.state.db, |conn| {
        Ok((
            setup_token::current(conn)?,
            conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get::<_, i64>(0))?,
        ))
    })
    .await
    .unwrap();
    assert_eq!(token.as_deref(), Some(s.token.as_str()));
    assert_eq!(users, 0);
}

#[tokio::test]
async fn a_public_url_from_an_older_setup_stays() {
    let s = setup().await;
    db::call(&s.state.db, |conn| {
        app_settings::set(
            conn,
            app_settings::PUBLIC_URL,
            &Url::parse("https://old.example.com/")?,
        )
    })
    .await
    .unwrap();
    let reply = post(
        &s.state,
        "/api/v1/setup/complete",
        Some(&s.token),
        complete_body(),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    // The next start still finds it (`resolve_public_url`).
    let stored = db::call(&s.state.db, |conn| {
        app_settings::get::<Url>(conn, app_settings::PUBLIC_URL)
    })
    .await
    .unwrap();
    assert_eq!(
        stored.map(String::from).as_deref(),
        Some("https://old.example.com/")
    );
}

#[tokio::test]
async fn only_one_of_two_concurrent_completions_wins() {
    let s = setup().await;
    let body = complete_body();
    let path = "/api/v1/setup/complete";
    let (a, b) = tokio::join!(
        post(&s.state, path, Some(&s.token), body.clone()),
        post(&s.state, path, Some(&s.token), body.clone()),
    );
    let mut statuses = [a.status, b.status];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::CREATED, StatusCode::CONFLICT]);
    let users = db::call(&s.state.db, |conn| {
        Ok(conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get::<_, i64>(0))?)
    })
    .await
    .unwrap();
    assert_eq!(users, 1);
}

#[tokio::test]
async fn setup_token_command_reports_completion() {
    let s = setup().await;
    let reply = post(
        &s.state,
        "/api/v1/setup/complete",
        Some(&s.token),
        complete_body(),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED);
    let output = Command::new(env!("CARGO_BIN_EXE_roedy-mail"))
        .arg("setup-token")
        .env("ROEDY_DATA_DIR", s.tmp.path())
        .env("ROEDY_LOG_FORMAT", "text")
        .env_remove("ROEDY_PUBLIC_URL")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Setup is complete"), "{stderr}");
    assert!(!String::from_utf8_lossy(&output.stdout).contains(&s.token));
}
