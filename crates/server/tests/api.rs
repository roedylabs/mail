//! Frame of the API `/api/v1` (without network): JSON errors, CSRF header,
//! session cookie with extractors, client IP and rate limits. The routes
//! under `/probe` only exist here; they stand for the real endpoints.

use std::{net::SocketAddr, sync::Arc, time::Duration};
use url::Url;

use axum::{
    Json, Router,
    body::Body,
    extract::{State, connect_info::MockConnectInfo},
    http::{HeaderMap, Method, Request, StatusCode, header},
    response::IntoResponse,
    routing::{get, post},
};
use http_body_util::BodyExt as _;
use roedy_mail_server::{
    api::{self, ApiError},
    app::{AppState, router},
    auth::{
        AdminUser, CurrentUser,
        session::{self, Client, Token},
    },
    broker::crypto::SecretKey,
    client_ip::ClientIp,
    config::{Config, TrustProxy},
    db::{
        self, Db,
        repo::users::{self, NewUser, Role},
    },
    rate_limit::{Key, Policy},
    web::static_files::WebAssets,
};
use serde_json::{Value, json};
use tower::ServiceExt as _;

fn state(trust_proxy: TrustProxy) -> (tempfile::TempDir, AppState) {
    let tmp = tempfile::tempdir().unwrap();
    let db = Db::from(db::open(tmp.path()).unwrap());
    (
        tmp,
        AppState::new(
            db,
            Arc::new(WebAssets::None),
            &Config {
                trust_proxy,
                ..Config::default()
            },
            Url::parse("https://app.example.com").unwrap(),
            SecretKey::random().unwrap(),
        )
        .unwrap(),
    )
}

const PROBE_LIMIT: Policy = Policy::rate("probe", 2, Duration::from_secs(60));

async fn me(CurrentUser(user): CurrentUser) -> Json<Value> {
    Json(json!({ "id": user.id, "session": user.session_id }))
}

async fn maybe(user: Option<CurrentUser>) -> Json<Value> {
    Json(json!({ "user": user.map(|CurrentUser(u)| u.username) }))
}

async fn admin(AdminUser(user): AdminUser) -> Json<Value> {
    Json(json!({ "admin": user.username }))
}

async fn logout() -> impl IntoResponse {
    [(header::SET_COOKIE, session::clear_cookie())]
}

async fn ip(ClientIp(ip): ClientIp) -> String {
    ip.to_string()
}

async fn limited(State(state): State<AppState>, client: ClientIp) -> Result<(), ApiError> {
    state
        .limiter
        .acquire(&PROBE_LIMIT, Key::Ip(client.network()))?;
    Ok(())
}

/// Probe routes behind the same middleware stack as `/api/v1`.
fn probe(state: AppState) -> Router {
    let routes = Router::new()
        .route("/probe/me", get(me))
        .route("/probe/maybe", get(maybe))
        .route("/probe/admin", get(admin))
        .route("/probe/logout", post(logout))
        .route("/probe/ip", get(ip))
        .route("/probe/limited", get(limited));
    api::with_middleware(routes, state.clone())
        .layer(MockConnectInfo(SocketAddr::from(([10, 0, 0, 2], 4711))))
        .with_state(state)
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: String,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap()
    }

    fn set_cookies(&self) -> Vec<&str> {
        self.headers
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap())
            .collect()
    }
}

async fn send(app: Router, request: Request<Body>) -> Reply {
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

fn request(method: Method, path: &str, cookie: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, format!("{}={cookie}", session::COOKIE));
    }
    builder.body(Body::empty()).unwrap()
}

/// Creates a user with a session; returns user ID, session ID and the
/// token from the cookie.
async fn login(state: &AppState, username: &'static str, role: Role) -> (String, String, String) {
    db::call(&state.db, move |conn| {
        let id = users::insert(
            conn,
            &NewUser {
                username,
                email: &format!("{username}@example.com"),
                display_name: "Max Mustermann",
                role,
                password_hash: "$argon2id$test",
            },
        )?;
        let started = session::start(conn, &id, &Client::default(), true)?;
        let cookie = started.cookie.to_str()?.to_owned();
        let token = cookie
            .strip_prefix(&format!("{}=", session::COOKIE))
            .and_then(|rest| rest.split(';').next())
            .unwrap()
            .to_owned();
        Ok((id, started.id, token))
    })
    .await
    .unwrap()
}

async fn sql(state: &AppState, statement: &'static str, id: String) {
    db::call(&state.db, move |conn| Ok(conn.execute(statement, [id])?))
        .await
        .unwrap();
}

#[tokio::test]
async fn unknown_api_paths_are_json_not_found() {
    let (_tmp, state) = state(TrustProxy::default());
    let reply = send(
        router(state),
        request(Method::GET, "/api/v1/does-not-exist", None),
    )
    .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(reply.json(), json!({ "error": "not_found" }));
    assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(reply.headers[header::CONTENT_TYPE], "application/json");
}

#[tokio::test]
async fn api_root_with_and_without_slash_is_api() {
    let (_tmp, state) = state(TrustProxy::default());
    for path in ["/api/v1", "/api/v1/"] {
        let reply = send(router(state.clone()), request(Method::GET, path, None)).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(reply.json(), json!({ "error": "not_found" }), "{path}");
        assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store");
        let reply = send(router(state.clone()), request(Method::POST, path, None)).await;
        assert_eq!(reply.json(), json!({ "error": "csrf" }), "{path}");
    }
}

#[tokio::test]
async fn client_ip_without_connect_info_is_an_error() {
    let (_tmp, state) = state(TrustProxy(1));
    let app = api::with_middleware(Router::new().route("/probe/ip", get(ip)), state.clone())
        .with_state(state);
    let mut req = request(Method::GET, "/probe/ip", None);
    req.headers_mut()
        .insert("x-forwarded-for", "198.51.100.1".parse().unwrap());
    let reply = send(app, req).await;
    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn changing_requests_need_csrf_header() {
    let (_tmp, state) = state(TrustProxy::default());
    for method in [Method::POST, Method::PUT, Method::PATCH, Method::DELETE] {
        let reply = send(
            router(state.clone()),
            request(method.clone(), "/api/v1/does-not-exist", None),
        )
        .await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN, "{method}");
        assert_eq!(reply.json(), json!({ "error": "csrf" }));
        assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store");
    }

    let mut with_header = request(Method::POST, "/api/v1/does-not-exist", None);
    with_header
        .headers_mut()
        .insert(api::CSRF_HEADER, "fetch".parse().unwrap());
    let reply = send(router(state.clone()), with_header).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND, "header present");

    let mut empty = request(Method::POST, "/api/v1/does-not-exist", None);
    empty
        .headers_mut()
        .insert(api::CSRF_HEADER, "".parse().unwrap());
    assert_eq!(
        send(router(state.clone()), empty).await.status,
        StatusCode::FORBIDDEN
    );

    // Reading requests do not need it.
    let reply = send(
        router(state),
        request(Method::GET, "/api/v1/does-not-exist", None),
    )
    .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

/// An image in an HTML mail lives in the app's origin and would send the
/// cookie along; the app's `fetch` (`empty`) and links
/// (`document`, backup download) stay allowed.
#[tokio::test]
async fn subresource_requests_are_rejected() {
    let (_tmp, state) = state(TrustProxy::default());
    let (_user, _session_id, token) = login(&state, "max", Role::User).await;
    for (dest, status) in [
        ("image", StatusCode::FORBIDDEN),
        ("Style", StatusCode::FORBIDDEN),
        ("font", StatusCode::FORBIDDEN),
        ("iframe", StatusCode::FORBIDDEN),
        ("empty", StatusCode::OK),
        ("document", StatusCode::OK),
    ] {
        let mut req = request(Method::GET, "/probe/me", Some(&token));
        req.headers_mut()
            .insert("sec-fetch-dest", dest.parse().unwrap());
        let reply = send(probe(state.clone()), req).await;
        assert_eq!(reply.status, status, "{dest}");
        if status == StatusCode::FORBIDDEN {
            assert_eq!(reply.json(), json!({ "error": "csrf" }), "{dest}");
        }
    }
}

#[tokio::test]
async fn extractors_require_valid_session() {
    let (_tmp, state) = state(TrustProxy::default());
    let (user, session_id, token) = login(&state, "max", Role::User).await;

    let reply = send(
        probe(state.clone()),
        request(Method::GET, "/probe/me", None),
    )
    .await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    assert_eq!(reply.json(), json!({ "error": "unauthorized" }));
    assert!(reply.set_cookies().is_empty());

    let reply = send(
        probe(state.clone()),
        request(Method::GET, "/probe/me", Some(&token)),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json(), json!({ "id": user, "session": session_id }));
    assert!(reply.set_cookies().is_empty(), "fresh session");

    let reply = send(
        probe(state.clone()),
        request(Method::GET, "/probe/maybe", Some(&token)),
    )
    .await;
    assert_eq!(reply.json(), json!({ "user": "max" }));
    let reply = send(
        probe(state.clone()),
        request(Method::GET, "/probe/maybe", None),
    )
    .await;
    assert_eq!(reply.json(), json!({ "user": null }));

    let reply = send(
        probe(state.clone()),
        request(Method::GET, "/probe/admin", Some(&token)),
    )
    .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert_eq!(reply.json(), json!({ "error": "forbidden" }));
    let reply = send(
        probe(state.clone()),
        request(Method::GET, "/probe/admin", None),
    )
    .await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);

    let (_, _, admin_token) = login(&state, "eva", Role::Admin).await;
    let reply = send(
        probe(state),
        request(Method::GET, "/probe/admin", Some(&admin_token)),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json(), json!({ "admin": "eva" }));
}

#[tokio::test]
async fn invalid_sessions_clear_the_cookie() {
    let (_tmp, state) = state(TrustProxy::default());
    let (user, session_id, token) = login(&state, "max", Role::User).await;
    let cleared = |reply: &Reply| {
        reply.status == StatusCode::UNAUTHORIZED
            && reply.set_cookies() == [session::clear_cookie().to_str().unwrap()]
    };

    for bad in ["broken", &"0".repeat(64)] {
        let reply = send(
            probe(state.clone()),
            request(Method::GET, "/probe/me", Some(bad)),
        )
        .await;
        assert!(cleared(&reply), "{bad}: {:?}", reply.set_cookies());
    }

    sql(
        &state,
        "UPDATE users SET status = 'locked' WHERE id = ?1",
        user.clone(),
    )
    .await;
    let reply = send(
        probe(state.clone()),
        request(Method::GET, "/probe/me", Some(&token)),
    )
    .await;
    assert!(cleared(&reply), "locked");
    sql(
        &state,
        "UPDATE users SET status = 'active' WHERE id = ?1",
        user,
    )
    .await;

    sql(
        &state,
        "UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1",
        session_id,
    )
    .await;
    let reply = send(
        probe(state),
        request(Method::GET, "/probe/me", Some(&token)),
    )
    .await;
    assert!(cleared(&reply), "expired");
}

#[tokio::test]
async fn activity_renews_cookie_unless_handler_sets_it() {
    let (_tmp, state) = state(TrustProxy::default());
    let (_, session_id, token) = login(&state, "max", Role::User).await;
    let stale = "UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1";

    sql(&state, stale, session_id.clone()).await;
    let reply = send(
        probe(state.clone()),
        request(Method::GET, "/probe/me", Some(&token)),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK);
    let renewed = Token::parse(&token).unwrap().cookie(true);
    assert_eq!(reply.set_cookies(), [renewed.to_str().unwrap()]);

    sql(&state, stale, session_id).await;
    let mut out = request(Method::POST, "/probe/logout", Some(&token));
    out.headers_mut()
        .insert(api::CSRF_HEADER, "fetch".parse().unwrap());
    let reply = send(probe(state), out).await;
    assert_eq!(
        reply.set_cookies(),
        [session::clear_cookie().to_str().unwrap()]
    );
}

#[tokio::test]
async fn client_ip_follows_trust_proxy() {
    let forwarded = || {
        let mut req = request(Method::GET, "/probe/ip", None);
        req.headers_mut()
            .insert("x-forwarded-for", "6.6.6.6, 198.51.100.1".parse().unwrap());
        req
    };
    let (_tmp, direct) = state(TrustProxy(0));
    assert_eq!(send(probe(direct), forwarded()).await.body, "10.0.0.2");
    let (_tmp, proxied) = state(TrustProxy(1));
    assert_eq!(send(probe(proxied), forwarded()).await.body, "198.51.100.1");
}

#[tokio::test]
async fn rate_limit_answers_429_with_retry_after() {
    let (_tmp, state) = state(TrustProxy::default());
    for _ in 0..2 {
        let reply = send(
            probe(state.clone()),
            request(Method::GET, "/probe/limited", None),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
    }
    let reply = send(probe(state), request(Method::GET, "/probe/limited", None)).await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(reply.headers[header::RETRY_AFTER], "30");
    assert_eq!(
        reply.json(),
        json!({ "error": "rate_limited", "retry_after": 30 })
    );
}
