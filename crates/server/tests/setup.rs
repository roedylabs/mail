//! Initial setup via the API (without network apart from the local test
//! server `fake_stalwart`): setup token with lockout per client IP, steps
//! only with token, completion in one transaction with a session, locked
//! afterwards – also for `roedy-mail setup-token`.

mod fake_stalwart;

use std::{net::SocketAddr, process::Command, sync::Arc};

use axum::{
    Router,
    body::Body,
    extract::connect_info::MockConnectInfo,
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header},
};
use fake_stalwart::{
    ADMIN, ADMIN_PASSWORD, CLIENT_ID, CLIENT_SECRET, MAIL_PASSWORD, MAIL_USER, Options, Server,
};
use http_body_util::BodyExt as _;
use roedy_jmap as jmap;
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
        repo::{app_settings, notifications, servers as server_repo},
    },
    mailer::system_mail,
    setup_token,
    web::static_files::WebAssets,
};
use serde_json::{Value, json};
use tower::ServiceExt as _;
use url::Url;

const APP: &str = "https://app.example.com";
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

fn complete_body(fake: &Server) -> Value {
    json!({
        "name": "Max Mustermann",
        "email": "Max@Example.com",
        "password": "Summer2026!",
        "server": {
            "label": "",
            "url": fake.url,
            "domains": ["example.com"],
            "client_id": CLIENT_ID,
        },
        "public_url": APP,
        "system_mail": { "user": MAIL_USER, "app_password": MAIL_PASSWORD },
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
        "/api/v1/setup/servers/test",
        Some(&s.token),
        json!({ "url": "https://mail.example.com" }),
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
    assert_eq!(reply.json(), json!({ "public_url": null }));
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
async fn steps_need_the_token() {
    let s = setup().await;
    let fake = Server::start(Options::default()).await;
    let steps = [
        ("/api/v1/setup/servers/test", json!({ "url": fake.url })),
        (
            "/api/v1/setup/servers/register-client",
            json!({ "url": fake.url, "username": ADMIN, "password": ADMIN_PASSWORD }),
        ),
        (
            "/api/v1/setup/system-mail/test",
            json!({ "url": fake.url, "user": MAIL_USER, "app_password": MAIL_PASSWORD }),
        ),
        ("/api/v1/setup/complete", complete_body(&fake)),
    ];
    for (path, body) in &steps {
        let reply = post(&s.state, path, None, body.clone()).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{path}");
        assert_eq!(reply.json()["error"], "bad_request", "{path}");
    }
    // A wrong token counts here too, and nothing is checked before the body.
    for (n, (path, body)) in steps.iter().enumerate() {
        let reply = post(&s.state, path, Some("ABCD-EFGH-JKLM"), body.clone()).await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY, "{path}");
        assert_eq!(reply.json()["remaining"], 4 - n, "{path}");
    }
    let reply = post(
        &s.state,
        "/api/v1/setup/complete",
        Some("x"),
        json!({ "broken": 1 }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(fake.registrations().is_empty());
    assert_eq!(fake.mail().requests(), 0);
    // A header that is not text is a failed attempt, not a missing header.
    let request = Request::post("/api/v1/setup/servers/test")
        .header(api::CSRF_HEADER, "fetch")
        .header(header::CONTENT_TYPE, "application/json")
        .header(TOKEN_HEADER, HeaderValue::from_bytes(b"ABCD-\xff").unwrap())
        .body(Body::from(json!({ "url": fake.url }).to_string()))
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
async fn tests_and_registers_the_server() {
    let s = setup().await;
    let fake = Server::start(Options::default()).await;
    let reply = post(
        &s.state,
        "/api/v1/setup/servers/test",
        Some(&s.token),
        json!({ "url": format!("{}/", fake.url), "client_id": CLIENT_ID, "public_url": APP }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let host = fake.url.trim_start_matches("http://");
    assert_eq!(
        reply.json(),
        json!({
            "url": fake.url, "host": host,
            "reach": "ok", "cors": "ok", "oauth": "ok", "reasons": {},
        })
    );
    // Without a client ID the diagnostics report that; nothing is stored.
    let reply = post(
        &s.state,
        "/api/v1/setup/servers/test",
        Some(&s.token),
        json!({ "url": fake.url, "public_url": APP }),
    )
    .await;
    assert_eq!(reply.json()["oauth"], "err");
    assert_eq!(reply.json()["reasons"], json!({ "oauth": "no_client_id" }));
    let servers = db::call(&s.state.db, |conn| {
        Ok(roedy_mail_server::db::repo::servers::list(conn)?.len())
    })
    .await
    .unwrap();
    assert_eq!(servers, 0);

    // Fields as in the registry; without `ROEDY_PUBLIC_URL` the public URL
    // belongs to them (redirect URI, CORS).
    let reply = post(
        &s.state,
        "/api/v1/setup/servers/test",
        Some(&s.token),
        json!({ "url": "http://stalwart:8080" }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        reply.json()["fields"],
        json!({ "url": { "code": "invalid" }, "public_url": { "code": "required" } })
    );

    let path = "/api/v1/setup/servers/register-client";
    let reply = post(
        &s.state,
        path,
        Some(&s.token),
        json!({ "url": fake.url, "username": ADMIN, "password": "incorrect", "public_url": APP }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        reply.json(),
        json!({ "error": "registration_failed", "reason": "auth_failed" })
    );
    let reply = post(
        &s.state,
        path,
        Some(&s.token),
        json!({ "url": fake.url, "username": ADMIN, "password": ADMIN_PASSWORD, "public_url": APP }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(
        reply.json(),
        json!({
            "client_id": CLIENT_ID,
            "redirect_uri": "https://app.example.com/oauth/callback",
            "has_secret": true,
        })
    );
    assert!(!reply.body.contains(CLIENT_SECRET));
    assert_eq!(
        fake.registrations()[0]["redirect_uris"],
        json!(["https://app.example.com/oauth/callback"])
    );
    let reply = post(
        &s.state,
        path,
        Some(&s.token),
        json!({ "url": fake.url, "username": " ", "password": "", "public_url": "ftp://x" }),
    )
    .await;
    assert_eq!(
        reply.json()["fields"],
        json!({
            "username": { "code": "required" },
            "password": { "code": "required" },
            "public_url": { "code": "invalid" },
        })
    );
    // Setup only logs the completion.
    assert!(audit(&s.state).await.is_empty());
}

#[tokio::test]
async fn tests_the_system_mail_account() {
    let s = setup().await;
    let fake = Server::start(Options::default()).await;
    let path = "/api/v1/setup/system-mail/test";
    let reply = post(
        &s.state,
        path,
        Some(&s.token),
        json!({ "url": fake.url, "user": MAIL_USER, "app_password": MAIL_PASSWORD }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(
        reply.json(),
        json!({ "identities": [
            { "id": "i1", "name": "Example Ltd", "email": MAIL_USER },
            { "id": "i2", "name": "Example Support", "email": "support@example.com" },
        ] })
    );
    // Nothing is sent.
    assert!(fake.mail().submitted.is_empty());

    let reply = post(
        &s.state,
        path,
        Some(&s.token),
        json!({ "url": fake.url, "user": MAIL_USER, "app_password": "incorrect" }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        reply.json(),
        json!({ "error": "mail_failed", "reason": "auth_failed" })
    );
    assert_eq!(fake.mail().failed_logins, 1);

    let reply = post(
        &s.state,
        path,
        Some(&s.token),
        json!({ "url": fake.url, "user": MAIL_USER, "app_password": MAIL_PASSWORD, "identity": "i9" }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::BAD_GATEWAY);
    assert_eq!(reply.json()["reason"], "no_identity");

    let reply = post(
        &s.state,
        path,
        Some(&s.token),
        json!({ "url": fake_stalwart::unreachable_url(), "user": MAIL_USER, "app_password": "x" }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::BAD_GATEWAY);
    assert_eq!(reply.json()["reason"], "unreachable");

    let reply = post(
        &s.state,
        path,
        Some(&s.token),
        json!({ "url": "", "user": "no reply", "app_password": "" }),
    )
    .await;
    assert_eq!(
        reply.json()["fields"],
        json!({
            "url": { "code": "required" },
            "user": { "code": "invalid" },
            "app_password": { "code": "required" },
        })
    );
}

#[tokio::test]
async fn complete_creates_everything_and_signs_in() {
    let s = setup().await;
    let fake = Server::start(Options::default()).await;
    let reply = post(
        &s.state,
        "/api/v1/setup/complete",
        Some(&s.token),
        complete_body(&fake),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let user = reply.json()["user"].clone();
    assert_eq!(user["username"], "max");
    assert_eq!(user["email"], "Max@Example.com");
    assert_eq!(user["display_name"], "Max Mustermann");
    assert_eq!(user["role"], "admin");
    let cookie = session_cookie(&reply);

    // The session is valid: administration with the server from step 4 and the
    // redirect URI from the public URL; the CSP allows it.
    let reply = get(&s.state, "/api/v1/admin/servers", &cookie).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let list = reply.json();
    let host = fake.url.trim_start_matches("http://");
    assert_eq!(
        list["redirect_uri"],
        "https://app.example.com/oauth/callback"
    );
    assert_eq!(list["servers"][0]["label"], host);
    assert_eq!(list["servers"][0]["url"], fake.url);
    assert_eq!(list["servers"][0]["domains"], json!(["example.com"]));
    assert_eq!(list["servers"][0]["client_id"], CLIENT_ID);
    assert_eq!(list["servers"][0]["has_secret"], false);
    let csp = reply.headers[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap();
    assert!(
        csp.contains(&format!("connect-src 'self' {}", fake.url)),
        "{csp}"
    );

    // Sending account with encrypted app password, usable by the mailer.
    let secrets = s.state.secrets.clone();
    let (account, public_url, token) = db::call(&s.state.db, move |conn| {
        Ok((
            system_mail::account(conn, &secrets)?,
            app_settings::get::<Url>(conn, app_settings::PUBLIC_URL)?,
            setup_token::current(conn)?,
        ))
    })
    .await
    .unwrap();
    let account = account.unwrap();
    assert_eq!(account.base_url.as_str(), format!("{}/", fake.url));
    assert_eq!(
        account.auth,
        jmap::Auth::Basic {
            username: MAIL_USER.into(),
            password: MAIL_PASSWORD.into(),
        }
    );
    assert!(s.state.mailer.test(&account).await.is_ok());
    assert_eq!(
        public_url.map(String::from).as_deref(),
        Some("https://app.example.com/")
    );
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
        ("/api/v1/setup/servers/test", json!({ "url": fake.url })),
        ("/api/v1/setup/complete", complete_body(&fake)),
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
    let fake = Server::start(Options::default()).await;
    let reply = post(
        &s.state,
        "/api/v1/setup/complete",
        Some(&s.token),
        complete_body(&fake),
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
    let fake = Server::start(Options::default()).await;
    let mut body = complete_body(&fake);
    body["password"] = json!("summer2026");
    body["server"]["client_id"] = json!(null);
    body["system_mail"]["user"] = json!("no reply");
    let reply = post(&s.state, "/api/v1/setup/complete", Some(&s.token), body).await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        reply.json()["fields"],
        json!({
            "password": { "code": "policy", "rules": ["case"] },
            "server.client_id": { "code": "required" },
            "system_mail.user": { "code": "invalid" },
        })
    );
    assert!(!reply.headers.contains_key(header::SET_COOKIE));
    let token = db::call(&s.state.db, |conn| setup_token::current(conn))
        .await
        .unwrap();
    assert_eq!(token.as_deref(), Some(s.token.as_str()));
}

#[tokio::test]
async fn configured_public_url_wins_and_system_mail_can_wait() {
    let s = setup_with(Config {
        public_url: Some(Url::parse(&format!("{APP}/")).unwrap()),
        ..Config::default()
    })
    .await;
    let reply = post(
        &s.state,
        "/api/v1/setup/token",
        None,
        json!({ "token": s.token }),
    )
    .await;
    assert_eq!(reply.json(), json!({ "public_url": APP }));

    let fake = Server::start(Options::default()).await;
    let mut body = complete_body(&fake);
    body["public_url"] = json!("https://other.example.com");
    body.as_object_mut().unwrap().remove("system_mail");
    body["server"]["client_secret"] = json!("confidential");
    let reply = post(&s.state, "/api/v1/setup/complete", Some(&s.token), body).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let cookie = session_cookie(&reply);
    let reply = get(&s.state, "/api/v1/admin/servers", &cookie).await;
    assert_eq!(
        reply.json()["redirect_uri"],
        "https://app.example.com/oauth/callback"
    );
    assert_eq!(reply.json()["servers"][0]["has_secret"], true);
    let (public_url, configured) = db::call(&s.state.db, |conn| {
        Ok((
            app_settings::get::<Url>(conn, app_settings::PUBLIC_URL)?,
            system_mail::is_configured(conn)?,
        ))
    })
    .await
    .unwrap();
    assert_eq!(public_url, None, "not stored only with ROEDY_PUBLIC_URL");
    assert!(!configured);
}

#[tokio::test]
async fn only_one_of_two_concurrent_completions_wins() {
    let s = setup().await;
    let fake = Server::start(Options::default()).await;
    let body = complete_body(&fake);
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
async fn mailer_lock_names_the_wait() {
    let s = setup().await;
    let fake = Server::start(Options::default()).await;
    let path = "/api/v1/setup/system-mail/test";
    let wrong = json!({ "url": fake.url, "user": MAIL_USER, "app_password": "incorrect" });
    for _ in 0..5 {
        let reply = post(&s.state, path, Some(&s.token), wrong.clone()).await;
        assert_eq!(reply.json()["reason"], "auth_failed");
    }
    // After that the backend does not ask this server for 15 minutes
    // (Fail2Ban), not even with the right password – and says for how long.
    let reply = post(
        &s.state,
        path,
        Some(&s.token),
        json!({ "url": fake.url, "user": MAIL_USER, "app_password": MAIL_PASSWORD }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(reply.json()["error"], "mail_failed");
    assert_eq!(reply.json()["reason"], "auth_locked");
    let wait = reply.json()["retry_after"].as_u64().unwrap();
    assert!((14 * 60..=15 * 60).contains(&wait), "{wait}");
    assert_eq!(fake.mail().failed_logins, 5);
}

#[tokio::test]
async fn test_knows_the_secret_of_a_registered_client() {
    // A server that only knows confidential clients.
    let s = setup().await;
    let fake = Server::start(Options {
        auth_methods: Some(&["client_secret_basic"]),
        ..Options::default()
    })
    .await;
    let test = || {
        post(
            &s.state,
            "/api/v1/setup/servers/test",
            Some(&s.token),
            json!({ "url": fake.url, "client_id": CLIENT_ID, "public_url": APP }),
        )
    };
    assert_eq!(
        test().await.json()["reasons"],
        json!({ "oauth": "no_public_client" })
    );
    let reply = post(
        &s.state,
        "/api/v1/setup/servers/register-client",
        Some(&s.token),
        json!({ "url": fake.url, "username": ADMIN, "password": ADMIN_PASSWORD, "public_url": APP }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    // The registration's secret counts without the browser knowing it.
    let reply = test().await;
    assert_eq!(reply.json()["oauth"], "ok", "{}", reply.body);
}

#[tokio::test]
async fn client_registered_for_another_public_url_is_rejected() {
    let s = setup().await;
    let fake = Server::start(Options::default()).await;
    let reply = post(
        &s.state,
        "/api/v1/setup/servers/register-client",
        Some(&s.token),
        json!({ "url": fake.url, "username": ADMIN, "password": ADMIN_PASSWORD, "public_url": APP }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);

    // The URL was changed after the registration.
    let mut body = complete_body(&fake);
    body["public_url"] = json!("https://mail.example.com");
    let reply = post(&s.state, "/api/v1/setup/complete", Some(&s.token), body).await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        reply.json()["fields"],
        json!({ "server.client_id": {
            "code": "redirect_mismatch",
            "redirect_uri": "https://app.example.com/oauth/callback",
        } })
    );

    let reply = post(
        &s.state,
        "/api/v1/setup/complete",
        Some(&s.token),
        complete_body(&fake),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    // The server takes over the registration's secret, which is
    // forgotten afterwards.
    let (sealed, id, left) = db::call(&s.state.db, |conn| {
        let (sealed, id): (Vec<u8>, String) =
            conn.query_row("SELECT oauth_client_secret_enc, id FROM servers", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        Ok((
            sealed,
            id,
            app_settings::get::<Value>(conn, "server_registrations")?,
        ))
    })
    .await
    .unwrap();
    assert_eq!(
        s.state
            .secrets
            .open(server_repo::SECRET_PURPOSE, &id, &sealed)
            .unwrap(),
        CLIENT_SECRET.as_bytes()
    );
    assert_eq!(left, None, "forgotten after completion");
}

#[tokio::test]
async fn conflicts_with_existing_servers_are_field_errors() {
    let s = setup().await;
    let fake = Server::start(Options::default()).await;
    let url = fake.url.clone();
    db::call(&s.state.db, move |conn| {
        server_repo::insert(
            conn,
            "s0",
            &server_repo::Fields {
                label: "Old",
                base_url: &url,
                domains: &["example.com".to_owned()],
                client_id: None,
            },
            None,
        )
    })
    .await
    .unwrap();
    let reply = post(
        &s.state,
        "/api/v1/setup/complete",
        Some(&s.token),
        complete_body(&fake),
    )
    .await;
    assert_eq!(
        reply.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        reply.body
    );
    assert_eq!(
        reply.json()["fields"],
        json!({
            "server.url": { "code": "taken", "server": "Old" },
            "server.domains": { "code": "taken", "domain": "example.com", "server": "Old" },
        })
    );
}

#[tokio::test]
async fn setup_token_command_reports_completion() {
    let s = setup().await;
    let fake = Server::start(Options::default()).await;
    let reply = post(
        &s.state,
        "/api/v1/setup/complete",
        Some(&s.token),
        complete_body(&fake),
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
