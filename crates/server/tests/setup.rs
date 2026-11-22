//! Initial setup via the API: setup token with lockout per client IP,
//! authenticator app and recovery codes as a pending enrollment with its own
//! lockout, completion only with token and confirmed enrollment in one
//! transaction with a session, the administrator's appearance, app and
//! codes, locked afterwards – also for `roedy-mail setup-token`.

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
        challenge,
        password::{Hasher, Params},
        session, totp,
    },
    broker::crypto::SecretKey,
    config::Config,
    db::{
        self, Db,
        repo::{app_settings, notifications, recovery_codes},
    },
    mailer::system_mail,
    settings::Language,
    setup_token, setup_totp,
    web::static_files::WebAssets,
};
use serde_json::{Value, json};
use tower::ServiceExt as _;
use url::Url;

const CLIENT: [u8; 4] = [203, 0, 113, 9];
/// The administrator's address in [`complete_body`].
const EMAIL: &str = "Max@Example.com";

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

    fn error(&self) -> Value {
        self.json()["error"].clone()
    }

    /// Value of the cookie `name` from `Set-Cookie`.
    fn cookie(&self, name: &str) -> String {
        self.headers
            .get_all(header::SET_COOKIE)
            .iter()
            .find_map(|c| {
                c.to_str()
                    .unwrap()
                    .strip_prefix(&format!("{name}="))?
                    .split(';')
                    .next()
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| panic!("no cookie {name}: {:?}", self.headers))
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
    cookies: &[(&str, &str)],
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
    for (name, value) in cookies {
        builder = builder.header(header::COOKIE, format!("{name}={value}"));
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
    post_from(state, CLIENT, path, token, body, &[]).await
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
        "email": EMAIL,
        "password": "Summer2026!",
        "settings": { "lang": "de", "mode": "dark", "accent": "sage" },
    })
}

/// Code of the authenticator app for `secret` at `time` (seconds).
fn code_at(secret: &[u8], time: u64) -> String {
    totp_rs::Builder::new()
        .with_secret(secret.to_vec())
        .build()
        .unwrap()
        .generate(time)
        .to_string()
}

fn code(secret: &[u8]) -> String {
    code_at(secret, totp::now())
}

/// Six digits that match none of the time steps the server accepts now.
fn wrong_code(secret: &[u8]) -> String {
    let now = totp::now();
    (0..1_000_000)
        .map(|n| format!("{n:06}"))
        .find(|code| {
            [now, now + 30]
                .iter()
                .all(|&t| totp::matching_step(secret, code, t).unwrap().is_none())
        })
        .unwrap()
}

/// `setup/totp` for `email`.
async fn enroll_reply(s: &Setup, email: &str) -> Reply {
    post(
        &s.state,
        "/api/v1/setup/totp",
        Some(&s.token),
        json!({ "email": email }),
    )
    .await
}

/// `setup/totp` for `email`: the secret from the answer.
async fn enroll(s: &Setup, email: &str) -> Vec<u8> {
    let reply = enroll_reply(s, email).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    totp_rs::Secret::try_from_base32(reply.json()["secret"].as_str().unwrap())
        .unwrap()
        .to_vec()
}

async fn verify(s: &Setup, code: &str) -> Reply {
    post(
        &s.state,
        "/api/v1/setup/totp/verify",
        Some(&s.token),
        json!({ "code": code }),
    )
    .await
}

fn recovery_codes_of(reply: &Reply) -> Vec<String> {
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    serde_json::from_value(reply.json()["recovery_codes"].clone()).unwrap()
}

/// The authenticator app of the administrator in [`complete_body`], set up
/// and confirmed: secret and recovery codes.
async fn confirmed(s: &Setup) -> (Vec<u8>, Vec<String>) {
    let secret = enroll(s, EMAIL).await;
    let codes = recovery_codes_of(&verify(s, &code(&secret)).await);
    (secret, codes)
}

async fn complete(s: &Setup) -> Reply {
    post(
        &s.state,
        "/api/v1/setup/complete",
        Some(&s.token),
        complete_body(),
    )
    .await
}

/// Raw value of the pending enrollment in `app_settings`.
async fn stored_enrollment(state: &AppState) -> Option<String> {
    db::call(&state.db, |conn| {
        Ok(conn
            .query_row(
                "SELECT json FROM app_settings WHERE key = 'setup_totp'",
                [],
                |r| r.get(0),
            )
            .ok())
    })
    .await
    .unwrap()
}

async fn count(state: &AppState, table: &'static str) -> i64 {
    db::call(&state.db, move |conn| {
        Ok(conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?)
    })
    .await
    .unwrap()
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
        &[],
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
    let (secret, _) = confirmed(&s).await;
    let reply = complete(&s).await;
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
        ("/api/v1/setup/totp", json!({ "email": EMAIL })),
        (
            "/api/v1/setup/totp/verify",
            json!({ "code": code(&secret) }),
        ),
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
    let (secret, codes) = confirmed(&s).await;
    let reply = complete(&s).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let id = reply.json()["user"]["id"].as_str().unwrap().to_owned();
    // Password, then the second step at `path` with `code`.
    let sign_in = |ip: [u8; 4], path: &'static str, code: String| {
        let state = s.state.clone();
        async move {
            let login = json!({ "login": "max", "password": "Summer2026!" });
            let pending = post_from(&state, ip, "/api/v1/auth/login", None, login, &[]).await;
            assert_eq!(pending.status, StatusCode::OK, "{}", pending.body);
            assert_eq!(pending.json()["status"], "totp_required");
            let mfa = pending.cookie(challenge::COOKIE);
            post_from(
                &state,
                ip,
                path,
                None,
                json!({ "code": code }),
                &[(challenge::COOKIE, &mfa)],
            )
            .await
        }
    };
    let notices = || async {
        let id = id.clone();
        db::call(&s.state.db, move |conn| notifications::list(conn, &id))
            .await
            .unwrap()
    };
    let kinds = || async {
        notices()
            .await
            .into_iter()
            .map(|n| n.kind)
            .collect::<Vec<_>>()
    };

    // The same device as during setup: known.
    // "Welcome" on account creation.
    assert_eq!(kinds().await, ["news.welcome"]);
    let next = code_at(&secret, totp::now() + 30);
    let again = sign_in(CLIENT, "/api/v1/auth/totp", next).await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.body);
    assert_eq!(kinds().await, ["news.welcome"]);
    // From another network, with a recovery code: its notice names the new
    // device.
    let elsewhere = sign_in([198, 51, 100, 1], "/api/v1/auth/recovery", codes[0].clone()).await;
    assert_eq!(elsewhere.status, StatusCode::OK, "{}", elsewhere.body);
    assert_eq!(kinds().await, ["security.recovery_used", "news.welcome"]);
    assert_eq!(notices().await[0].params["new_device"], true);
}

#[tokio::test]
async fn enrollment_answers_secret_and_uri() {
    let s = setup().await;
    let reply = enroll_reply(&s, " max@example.com ").await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store");
    let body = reply.json();
    let secret = body["secret"].as_str().unwrap().to_owned();
    assert_eq!(secret.len(), 32, "{secret}");
    assert!(
        secret
            .bytes()
            .all(|b| b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b)),
        "{secret}"
    );
    let uri = body["uri"].as_str().unwrap();
    assert!(
        uri.starts_with("otpauth://totp/Roedy%20Mail:max%40example.com?"),
        "{uri}"
    );
    assert!(uri.contains(&format!("secret={secret}")), "{uri}");
    assert!(uri.contains("issuer=Roedy%20Mail"), "{uri}");
    assert_eq!(body.as_object().unwrap().len(), 2, "{body}");

    // Stored sealed only: neither the secret nor a code in plain text.
    let stored = stored_enrollment(&s.state).await.unwrap();
    assert!(!stored.contains(&secret), "{stored}");
    let pending = db::call(&s.state.db, |conn| setup_totp::get(conn))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pending.email, "max@example.com");
    assert_eq!(pending.step, None);
    let opened = pending.open(&s.state.secrets).unwrap();
    assert_eq!(opened.codes.len(), 10);
    for code in &opened.codes {
        assert!(!stored.contains(code.as_str()), "{code} in {stored}");
    }

    // A second call: a new secret, the first one no longer applies.
    let first = totp_rs::Secret::try_from_base32(&secret).unwrap().to_vec();
    let second = enroll(&s, "max@example.com").await;
    assert_ne!(first, second);
    let reply = verify(&s, &code(&first)).await;
    assert_eq!(reply.error(), "invalid_code");

    // The address is checked like in `setup/complete`; nothing else is taken.
    let reply = enroll_reply(&s, "max@example").await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        reply.json()["fields"],
        json!({ "email": { "code": "invalid" } })
    );
    for body in [json!({}), json!({ "email": EMAIL, "name": "Max" })] {
        let reply = post(&s.state, "/api/v1/setup/totp", Some(&s.token), body.clone()).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{body}");
    }
}

#[tokio::test]
async fn the_mfa_steps_need_the_token() {
    let s = setup().await;
    let steps = [
        ("/api/v1/setup/totp", json!({ "email": EMAIL })),
        ("/api/v1/setup/totp/verify", json!({ "code": "123456" })),
    ];
    for (path, body) in &steps {
        let reply = post(&s.state, path, None, body.clone()).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{path}");
        assert_eq!(reply.error(), "bad_request", "{path}");
    }
    // A wrong token counts towards the same lockout as in `setup/token`.
    for ((path, body), remaining) in steps.iter().zip([4, 3]) {
        let reply = post(&s.state, path, Some("ABCD-EFGH-JKLM"), body.clone()).await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY, "{path}");
        assert_eq!(
            reply.json(),
            json!({ "error": "invalid_token", "remaining": remaining }),
            "{path}"
        );
    }
    assert_eq!(stored_enrollment(&s.state).await, None);
}

#[tokio::test]
async fn verification_confirms_each_time_step_once_and_answers_the_codes() {
    let s = setup().await;
    let reply = verify(&s, "123456").await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(reply.json(), json!({ "error": "totp_required" }));

    let secret = enroll(&s, EMAIL).await;
    // Not six digits: rejected without counting.
    for input in ["", "12345", "12a456", "1234567"] {
        let reply = verify(&s, input).await;
        assert_eq!(reply.json(), json!({ "error": "invalid_code" }), "{input}");
    }
    let now = totp::now();
    let first = code_at(&secret, now);
    let reply = verify(&s, &format!("{} {}", &first[..3], &first[3..])).await;
    let codes = recovery_codes_of(&reply);
    assert_eq!(reply.json().as_object().unwrap().len(), 1);
    assert_eq!(codes.len(), 10);
    let mut unique = codes.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), 10);
    for code in &codes {
        let (a, b) = code.split_once('-').unwrap_or_else(|| panic!("{code}"));
        assert!(
            [a, b].iter().all(|part| part.len() == 4
                && part
                    .bytes()
                    .all(|c| b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789".contains(&c))),
            "{code}"
        );
    }

    // The same time step again: used.
    let reply = verify(&s, &first).await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(reply.json(), json!({ "error": "code_used" }));
    // A newer one confirms again with the same codes.
    let reply = verify(&s, &code_at(&secret, now + 30)).await;
    assert_eq!(recovery_codes_of(&reply), codes);
    let pending = db::call(&s.state.db, |conn| setup_totp::get(conn))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pending.step, Some(now / 30 + 1));
    let stored = stored_enrollment(&s.state).await.unwrap();
    for code in &codes {
        assert!(!stored.contains(code.as_str()), "{code} in {stored}");
    }

    // Nothing of the administrator is stored yet.
    assert_eq!(count(&s.state, "users").await, 0);
    assert_eq!(count(&s.state, "totp_devices").await, 0);
    assert_eq!(count(&s.state, "recovery_codes").await, 0);
}

#[tokio::test]
async fn five_wrong_codes_lock_the_verification() {
    let s = setup().await;
    let secret = enroll(&s, EMAIL).await;
    let wrong = wrong_code(&secret);
    for _ in 0..5 {
        let reply = verify(&s, &wrong).await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(reply.json(), json!({ "error": "invalid_code" }));
    }
    // Locked for 15 minutes, even for the right code and a new secret.
    let reply = verify(&s, &code(&secret)).await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(reply.headers[header::RETRY_AFTER], "900");
    assert_eq!(
        reply.json(),
        json!({ "error": "rate_limited", "retry_after": 900 })
    );
    let fresh = enroll(&s, EMAIL).await;
    let reply = verify(&s, &code(&fresh)).await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
    // The setup token's lockout is untouched.
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
async fn completion_needs_a_confirmed_enrollment_for_the_address() {
    let s = setup().await;
    let expect_required = |reply: Reply| {
        assert_eq!(
            reply.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{}",
            reply.body
        );
        assert_eq!(reply.json(), json!({ "error": "totp_required" }));
        assert!(!reply.headers.contains_key(header::SET_COOKIE));
    };
    // Without an enrollment.
    expect_required(complete(&s).await);
    // Not confirmed.
    let secret = enroll(&s, EMAIL).await;
    expect_required(complete(&s).await);
    // Confirmed for another address (the spelling counts).
    let other = enroll(&s, "max@example.com").await;
    recovery_codes_of(&verify(&s, &code(&other)).await);
    expect_required(complete(&s).await);
    // The old secret no longer applies.
    let reply = verify(&s, &code(&secret)).await;
    assert_eq!(reply.error(), "invalid_code");

    // Nothing stored, the token and the enrollment stay.
    for table in ["users", "totp_devices", "recovery_codes", "sessions"] {
        assert_eq!(count(&s.state, table).await, 0, "{table}");
    }
    let token = db::call(&s.state.db, |conn| setup_token::current(conn))
        .await
        .unwrap();
    assert_eq!(token.as_deref(), Some(s.token.as_str()));
    assert!(stored_enrollment(&s.state).await.is_some());
}

#[tokio::test]
async fn completion_stores_the_app_and_the_recovery_codes() {
    let s = setup().await;
    let secret = enroll(&s, EMAIL).await;
    let now = totp::now();
    let first = code_at(&secret, now);
    let codes = recovery_codes_of(&verify(&s, &first).await);
    let reply = complete(&s).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    assert_eq!(reply.json().as_object().unwrap().len(), 1, "{}", reply.body);
    let id = reply.json()["user"]["id"].as_str().unwrap().to_owned();

    // One confirmed app, named in the administrator's language, with the
    // step of the confirmation; ten unused codes; the enrollment is gone.
    let user = id.clone();
    let (devices, summary, pending) = db::call(&s.state.db, move |conn| {
        let mut stmt = conn.prepare(
            "SELECT name, confirmed_at IS NOT NULL, last_step, secret_enc FROM totp_devices \
             WHERE user_id = ?1",
        )?;
        let devices = stmt
            .query_map([&user], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, bool>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, Vec<u8>>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok((
            devices,
            recovery_codes::summary(conn, &user)?,
            setup_totp::get(conn)?,
        ))
    })
    .await
    .unwrap();
    assert_eq!(devices.len(), 1);
    let (name, confirmed, last_step, sealed) = &devices[0];
    assert_eq!(name, &totp::default_name(&[], Language::German));
    assert!(confirmed);
    assert_eq!(*last_step, i64::try_from(now / 30).unwrap());
    assert!(!sealed.windows(secret.len()).any(|w| w == secret.as_slice()));
    let summary = summary.unwrap();
    assert_eq!((summary.total, summary.unused), (10, 10));
    assert_eq!(pending, None);
    assert_eq!(stored_enrollment(&s.state).await, None);
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

    // Signing in again asks for the code; the code from the confirmation is
    // used up, the next one signs in.
    let login = json!({ "login": "max", "password": "Summer2026!" });
    let pending = post(&s.state, "/api/v1/auth/login", None, login.clone()).await;
    assert_eq!(pending.status, StatusCode::OK, "{}", pending.body);
    assert_eq!(pending.json()["status"], "totp_required");
    let mfa = pending.cookie(challenge::COOKIE);
    let second_step = |path: &'static str, code: String| {
        let (state, mfa) = (s.state.clone(), mfa.clone());
        async move {
            post_from(
                &state,
                CLIENT,
                path,
                None,
                json!({ "code": code }),
                &[(challenge::COOKIE, &mfa)],
            )
            .await
        }
    };
    let reply = second_step("/api/v1/auth/totp", first).await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(reply.error(), "code_used");
    let reply = second_step("/api/v1/auth/totp", code_at(&secret, now + 30)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.json()["user"]["id"], id);

    // The recovery codes from the verification are the administrator's.
    let pending = post(&s.state, "/api/v1/auth/login", None, login).await;
    let mfa = pending.cookie(challenge::COOKIE);
    let reply = post_from(
        &s.state,
        CLIENT,
        "/api/v1/auth/recovery",
        None,
        json!({ "code": codes[9] }),
        &[(challenge::COOKIE, &mfa)],
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
}

#[tokio::test]
async fn a_new_enrollment_during_completion_needs_a_new_confirmation() {
    let s = setup().await;
    confirmed(&s).await;
    // A second tab starts over: its secret is not confirmed yet.
    enroll(&s, EMAIL).await;
    let reply = complete(&s).await;
    assert_eq!(reply.json(), json!({ "error": "totp_required" }));
    assert_eq!(count(&s.state, "users").await, 0);
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
    confirmed(&s).await;
    let reply = complete(&s).await;
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
    confirmed(&s).await;
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
    confirmed(&s).await;
    let reply = complete(&s).await;
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
