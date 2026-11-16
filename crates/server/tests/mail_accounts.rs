//! Mail accounts via the API against the local test server `fake_stalwart`:
//! creation per sign-in method, check via the JMAP session, duplicates, own
//! servers with policy and SSRF block, linking via the origin, default
//! account and encrypted tokens; token broker with refresh, rotation,
//! "sign-in required", re-sign-in, code exchange for confidential clients and
//! early refresh; color, "check connection", revocation on re-sign-in,
//! "delete account" and "delete local data".

mod fake_stalwart;

use std::{net::SocketAddr, sync::Arc};

use axum::{
    Router,
    body::Body,
    extract::connect_info::MockConnectInfo,
    http::{Method, Request, StatusCode, header},
};
use fake_stalwart::{
    CLIENT_ID, CLIENT_SECRET, CODE, MAIL_TOKEN, MAIL_USER, NAMED_TOKEN, OTHER_CODE, OTHER_REFRESH,
    OTHER_TOKEN, Options, REFRESH_TOKEN, Server, TokenRequest, VERIFIER, unreachable_url,
};
use http_body_util::BodyExt as _;
use roedy_mail_server::{
    api,
    app::{AppState, router},
    auth::session::{self, Client},
    broker::{crypto::SecretKey, token},
    config::Config,
    db::{
        self, Db,
        repo::{
            mail_accounts::{ACCESS_PURPOSE, SECRET_PURPOSE},
            notifications,
            users::{self, NewUser, Role},
        },
    },
    jobs::{quota_check, token_refresh},
    rate_limit::Key,
    web::static_files::WebAssets,
};
use serde_json::{Value, json};
use tower::ServiceExt as _;
use url::Url;

const REFRESH: &str = REFRESH_TOKEN;

struct Setup {
    _tmp: tempfile::TempDir,
    state: AppState,
    admin: String,
    user: String,
}

async fn setup() -> Setup {
    let tmp = tempfile::tempdir().unwrap();
    let db = Db::from(db::open(tmp.path()).unwrap());
    let config = Config {
        public_url: Some(Url::parse("https://app.example.com").unwrap()),
        ..Config::default()
    };
    let state = AppState::new(
        db,
        Arc::new(WebAssets::None),
        &config,
        SecretKey::random().unwrap(),
    )
    .unwrap();
    state.load().await.unwrap();
    let admin = login(&state, "admin", Role::Admin).await;
    let user = login(&state, "max", Role::User).await;
    Setup {
        _tmp: tmp,
        state,
        admin,
        user,
    }
}

/// Creates a user with a session and returns the cookie's token.
async fn login(state: &AppState, username: &'static str, role: Role) -> String {
    db::call(&state.db, move |conn| {
        let id = users::insert(
            conn,
            &NewUser {
                username,
                email: &format!("{username}@example.com"),
                display_name: "Erika Muster",
                role,
                password_hash: "$argon2id$test",
            },
        )?;
        let started = session::start(conn, &id, &Client::default(), true)?;
        let cookie = started.cookie.to_str()?.to_owned();
        Ok(cookie
            .strip_prefix(&format!("{}=", session::COOKIE))
            .and_then(|rest| rest.split(';').next())
            .unwrap()
            .to_owned())
    })
    .await
    .unwrap()
}

struct Reply {
    status: StatusCode,
    cache_control: Option<String>,
    body: String,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", self.body))
    }

    /// Code of the field error with 422 `invalid`.
    fn field(&self, field: &str) -> Value {
        assert_eq!(
            self.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{}",
            self.body
        );
        self.json()["fields"][field]["code"].clone()
    }
}

fn app(state: &AppState) -> Router {
    router(state.clone()).layer(MockConnectInfo(SocketAddr::from(([203, 0, 113, 9], 4711))))
}

async fn send(
    state: &AppState,
    method: Method,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> Reply {
    let mut builder = Request::builder()
        .method(method)
        .uri(format!("/api/v1{path}"))
        .header(api::CSRF_HEADER, "fetch");
    if let Some(token) = token {
        builder = builder.header(header::COOKIE, format!("{}={token}", session::COOKIE));
    }
    let body = match body {
        Some(body) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = app(state)
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let cache_control = response
        .headers()
        .get(header::CACHE_CONTROL)
        .map(|value| value.to_str().unwrap().to_owned());
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    Reply {
        status,
        cache_control,
        body: String::from_utf8(bytes.to_vec()).unwrap(),
    }
}

/// Server in the registry; returns the ID.
async fn register(s: &Setup, url: &str, client_id: Option<&str>) -> String {
    let reply = send(
        &s.state,
        Method::POST,
        "/admin/servers",
        Some(&s.admin),
        Some(json!({ "label": "Stalwart", "url": url, "client_id": client_id })),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    reply.json()["id"].as_str().unwrap().to_owned()
}

fn oauth(server_id: &str, email: &str, access: &str) -> Value {
    json!({
        "email": email,
        "server_id": server_id,
        "auth_kind": "oauth",
        "access_token": access,
        "refresh_token": REFRESH,
        "expires_in": 3600,
    })
}

fn token(server_id: &str, email: &str, token: &str) -> Value {
    json!({ "email": email, "server_id": server_id, "auth_kind": "token", "token": token })
}

async fn add(s: &Setup, session: &str, body: Value) -> Reply {
    send(
        &s.state,
        Method::POST,
        "/mail-accounts",
        Some(session),
        Some(body),
    )
    .await
}

async fn default_account(s: &Setup, session: &str) -> Value {
    let reply = send(&s.state, Method::GET, "/settings", Some(session), None).await;
    reply.json()["settings"]["defaultAccount"].clone()
}

/// Columns of an account directly from the database.
async fn stored(state: &AppState, id: &str) -> (Vec<u8>, Option<Vec<u8>>, Option<String>, String) {
    let id = id.to_owned();
    db::call(&state.db, move |conn| {
        Ok(conn.query_row(
            "SELECT secret_enc, access_token_enc, client_id, session_json \
             FROM mail_accounts WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?)
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn connects_accounts_of_both_kinds() {
    let fake = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;

    let first = add(&s, &s.user, oauth(&server, MAIL_USER, MAIL_TOKEN)).await;
    assert_eq!(first.status, StatusCode::CREATED, "{}", first.body);
    let first = first.json();
    let host = fake.url.trim_start_matches("http://");
    assert_eq!(first["email"], MAIL_USER);
    assert_eq!(first["username"], MAIL_USER);
    assert_eq!(first["url"], fake.url.as_str());
    assert_eq!(first["host"], host);
    assert_eq!(first["server_id"], server.as_str());
    assert_eq!(first["auth_kind"], "oauth");
    assert_eq!(first["color"], 0);
    assert_eq!(first["state"], "ok");
    assert_eq!(first["blocked"], false);
    let first_id = first["id"].as_str().unwrap().to_owned();
    // The first account becomes the default account.
    assert_eq!(default_account(&s, &s.user).await, first_id.as_str());

    // An own address with the origin of a registry server counts as that
    // server, even without a policy.
    let second = add(
        &s,
        &s.user,
        json!({ "email": "eva@example.com", "url": format!("{}/", fake.url), "auth_kind": "token", "token": OTHER_TOKEN }),
    )
    .await;
    assert_eq!(second.status, StatusCode::CREATED, "{}", second.body);
    let second = second.json();
    assert_eq!(second["email"], "eva@example.com");
    assert_eq!(second["server_id"], server.as_str());
    assert_eq!(second["auth_kind"], "token");
    assert_eq!(second["color"], 1);
    assert_eq!(default_account(&s, &s.user).await, first_id.as_str());

    // Username without address: the entered one if the account carries it,
    // otherwise the first identity (without placeholders).
    let named = add(
        &s,
        &s.user,
        token(&server, "ERIKA@example.com", NAMED_TOKEN),
    )
    .await;
    assert_eq!(named.status, StatusCode::CREATED, "{}", named.body);
    assert_eq!(named.json()["email"], "erika@example.com");
    // Fact "username": the name from the JMAP session, not the address.
    assert_eq!(named.json()["username"], "erika");
    let other = add(&s, &s.admin, token(&server, "max@example.com", NAMED_TOKEN)).await;
    assert_eq!(other.json()["email"], "info@example.com");

    let list = send(&s.state, Method::GET, "/mail-accounts", Some(&s.user), None).await;
    assert_eq!(list.status, StatusCode::OK);
    for secret in [MAIL_TOKEN, REFRESH, OTHER_TOKEN, NAMED_TOKEN] {
        assert!(!list.body.contains(secret), "{}", list.body);
    }
    let emails: Vec<Value> = list.json()["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["email"].clone())
        .collect();
    assert_eq!(
        emails,
        [
            json!(MAIL_USER),
            json!("eva@example.com"),
            json!("erika@example.com")
        ]
    );

    // Tokens only encrypted, bound to their row.
    let (secret, access, client_id, session_json) = stored(&s.state, &first_id).await;
    assert!(
        !secret
            .windows(REFRESH.len())
            .any(|w| w == REFRESH.as_bytes())
    );
    assert_eq!(
        s.state
            .secrets
            .open(SECRET_PURPOSE, &first_id, &secret)
            .unwrap(),
        REFRESH.as_bytes()
    );
    let access = access.unwrap();
    assert_eq!(
        s.state
            .secrets
            .open(ACCESS_PURPOSE, &first_id, &access)
            .unwrap(),
        MAIL_TOKEN.as_bytes()
    );
    assert!(
        s.state
            .secrets
            .open(SECRET_PURPOSE, "other", &secret)
            .is_err()
    );
    assert_eq!(client_id.as_deref(), Some(CLIENT_ID));
    let session: Value = serde_json::from_str(&session_json).unwrap();
    assert_eq!(
        session["primaryAccounts"]["urn:ietf:params:jmap:mail"],
        "a1"
    );

    let second_id = second["id"].as_str().unwrap();
    let (secret, access, client_id, _) = stored(&s.state, second_id).await;
    assert_eq!(
        s.state
            .secrets
            .open(SECRET_PURPOSE, second_id, &secret)
            .unwrap(),
        OTHER_TOKEN.as_bytes()
    );
    assert_eq!((access, client_id), (None, None));

    // Linked accounts of all users per server.
    let servers = send(
        &s.state,
        Method::GET,
        "/admin/servers",
        Some(&s.admin),
        None,
    )
    .await;
    assert_eq!(servers.json()["servers"][0]["accounts"], 4);
    let single = send(
        &s.state,
        Method::GET,
        &format!("/admin/servers/{server}"),
        Some(&s.admin),
        None,
    )
    .await;
    assert_eq!(single.json()["accounts"], 4);
}

#[tokio::test]
async fn duplicates_follow_the_logged_in_account() {
    let fake = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;

    let first = add(&s, &s.user, token(&server, MAIL_USER, MAIL_TOKEN)).await;
    assert_eq!(first.status, StatusCode::CREATED, "{}", first.body);
    let first = first.json();

    // A different address was entered, but the same account signed in.
    let dup = add(&s, &s.user, oauth(&server, "eva@example.com", MAIL_TOKEN)).await;
    assert_eq!(dup.status, StatusCode::CONFLICT, "{}", dup.body);
    assert_eq!(dup.json()["error"], "dup");
    assert_eq!(
        dup.json()["account"],
        json!({ "id": first["id"], "email": MAIL_USER })
    );

    // The address of the first account was entered, another one signed in –
    // with the client the browser used.
    let mut body = oauth(&server, MAIL_USER, OTHER_TOKEN);
    body["client_id"] = json!("client-before-registration");
    let other = add(&s, &s.user, body).await;
    assert_eq!(other.status, StatusCode::CREATED, "{}", other.body);
    assert_eq!(other.json()["email"], "eva@example.com");
    let (_, _, client_id, _) = stored(&s.state, other.json()["id"].as_str().unwrap()).await;
    assert_eq!(client_id.as_deref(), Some("client-before-registration"));

    // Another user may connect the same mailbox.
    let admin = add(&s, &s.admin, token(&server, MAIL_USER, MAIL_TOKEN)).await;
    assert_eq!(admin.status, StatusCode::CREATED, "{}", admin.body);
}

#[tokio::test]
async fn rejects_invalid_requests() {
    let fake = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let public = register(&s, "https://mail.no-client.example", None).await;

    let unauthenticated = send(
        &s.state,
        Method::POST,
        "/mail-accounts",
        None,
        Some(token(&server, MAIL_USER, MAIL_TOKEN)),
    )
    .await;
    assert_eq!(unauthenticated.status, StatusCode::UNAUTHORIZED);

    let mut body = token(&server, " ", MAIL_TOKEN);
    assert_eq!(
        add(&s, &s.user, body.clone()).await.field("email"),
        "required"
    );
    body["email"] = json!("max@");
    assert_eq!(add(&s, &s.user, body).await.field("email"), "invalid");

    let mut body = oauth(&server, MAIL_USER, MAIL_TOKEN);
    body.as_object_mut().unwrap().remove("refresh_token");
    assert_eq!(
        add(&s, &s.user, body).await.field("refresh_token"),
        "required"
    );
    let mut body = token(&server, MAIL_USER, "token with spaces");
    assert_eq!(
        add(&s, &s.user, body.clone()).await.field("token"),
        "invalid"
    );
    body["token"] = json!("x".repeat(8193));
    assert_eq!(
        add(&s, &s.user, body.clone()).await.field("token"),
        "too_long"
    );
    body.as_object_mut().unwrap().remove("token");
    assert_eq!(add(&s, &s.user, body).await.field("token"), "required");

    let mut body = token(&server, MAIL_USER, MAIL_TOKEN);
    body.as_object_mut().unwrap().remove("server_id");
    assert_eq!(
        add(&s, &s.user, body.clone()).await.field("server_id"),
        "required"
    );
    body["server_id"] = json!("01JBZ6V9W8X7Y6Z5A4B3C2D1E0");
    assert_eq!(
        add(&s, &s.user, body.clone()).await.field("server_id"),
        "not_found"
    );
    // Registry or own address, not both.
    body["server_id"] = json!(server);
    body["url"] = json!(fake.url);
    assert_eq!(add(&s, &s.user, body).await.field("url"), "conflict");
    let mut body = oauth(&server, MAIL_USER, MAIL_TOKEN);
    body["client_id"] = json!("client\nwith line break");
    assert_eq!(add(&s, &s.user, body).await.field("client_id"), "invalid");

    // Without a client in the registry no sign-in at the mail server.
    let reply = add(&s, &s.user, oauth(&public, MAIL_USER, MAIL_TOKEN)).await;
    assert_eq!(reply.field("auth_kind"), "no_client");

    let mut body = token(&server, MAIL_USER, MAIL_TOKEN);
    body["auth_kind"] = json!("password");
    assert_eq!(add(&s, &s.user, body).await.status, StatusCode::BAD_REQUEST);
    let mut body = token(&server, MAIL_USER, MAIL_TOKEN);
    body["password"] = json!("secret");
    assert_eq!(add(&s, &s.user, body).await.status, StatusCode::BAD_REQUEST);

    // Nothing created, and the mail server was not asked.
    let list = send(&s.state, Method::GET, "/mail-accounts", Some(&s.user), None).await;
    assert_eq!(list.json()["accounts"], json!([]));
    assert_eq!(fake.mail().failed_logins, 0);
}

#[tokio::test]
async fn reports_mail_server_errors() {
    let fake = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;

    let rejected = add(&s, &s.user, token(&server, MAIL_USER, "incorrect")).await;
    assert_eq!(rejected.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(rejected.json()["error"], "check_failed");
    assert_eq!(rejected.json()["reason"], "auth_failed");
    assert_eq!(fake.mail().failed_logins, 1);

    for (options, reason) in [
        (
            Options {
                foreign_api_url: true,
                ..Options::default()
            },
            "foreign_origin",
        ),
        (
            Options {
                foreign_download_url: true,
                ..Options::default()
            },
            "session_url_mismatch",
        ),
    ] {
        let other = Server::start(options).await;
        let id = register(&s, &other.url, None).await;
        let reply = add(&s, &s.admin, token(&id, MAIL_USER, MAIL_TOKEN)).await;
        assert_eq!(reply.status, StatusCode::BAD_GATEWAY, "{reason}");
        assert_eq!(reply.json()["reason"], reason);
    }
    let gone = register(&s, &unreachable_url(), None).await;
    let reply = add(&s, &s.admin, token(&gone, MAIL_USER, MAIL_TOKEN)).await;
    assert_eq!(reply.status, StatusCode::BAD_GATEWAY);
    assert_eq!(reply.json()["reason"], "unreachable");
}

#[tokio::test]
async fn rejected_tokens_lock_the_user() {
    let fake = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    for _ in 0..5 {
        let reply = add(&s, &s.user, token(&server, MAIL_USER, "incorrect")).await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    }
    // Locked without asking the mail server again.
    let locked = add(&s, &s.user, token(&server, MAIL_USER, MAIL_TOKEN)).await;
    assert_eq!(
        locked.status,
        StatusCode::TOO_MANY_REQUESTS,
        "{}",
        locked.body
    );
    assert_eq!(fake.mail().failed_logins, 5);
    // Other users are not.
    let admin = add(&s, &s.admin, token(&server, MAIL_USER, MAIL_TOKEN)).await;
    assert_eq!(admin.status, StatusCode::CREATED);
}

#[tokio::test]
async fn rejected_tokens_lock_only_their_server() {
    let fake = Server::start(Options::default()).await;
    let other = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let second = register(&s, &other.url, Some(CLIENT_ID)).await;
    // Four users with five rejected tokens each: 20 for the server.
    for name in ["eva", "ina", "ole", "uwe"] {
        let session = login(&s.state, name, Role::User).await;
        for _ in 0..5 {
            let reply = add(&s, &session, token(&server, MAIL_USER, "incorrect")).await;
            assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
        }
    }
    let locked = add(&s, &s.admin, token(&server, MAIL_USER, MAIL_TOKEN)).await;
    assert_eq!(
        locked.status,
        StatusCode::TOO_MANY_REQUESTS,
        "{}",
        locked.body
    );
    assert_eq!(fake.mail().failed_logins, 20);
    let elsewhere = add(&s, &s.admin, token(&second, MAIL_USER, MAIL_TOKEN)).await;
    assert_eq!(elsewhere.status, StatusCode::CREATED, "{}", elsewhere.body);
}

#[tokio::test]
async fn custom_servers_need_the_policy_and_public_addresses() {
    let s = setup().await;
    let custom = |url: &str, kind: &str| json!({ "email": MAIL_USER, "url": url, "auth_kind": kind, "token": MAIL_TOKEN, "access_token": MAIL_TOKEN, "refresh_token": REFRESH });

    let off = add(&s, &s.user, custom("https://mail.own.example", "token")).await;
    assert_eq!(off.field("url"), "not_allowed");

    let policy = send(
        &s.state,
        Method::PUT,
        "/admin/servers/policy",
        Some(&s.admin),
        Some(json!({ "allow_custom_servers": true })),
    )
    .await;
    assert_eq!(policy.status, StatusCode::OK);

    // Only `https://`, not even the registry's exception for localhost.
    for url in [
        "http://mail.own.example",
        "http://127.0.0.1:8080",
        "https://[::1]",
    ] {
        let reply = add(&s, &s.user, custom(url, "token")).await;
        assert_eq!(reply.field("url"), "invalid", "{url}");
    }
    for url in [
        "https://127.0.0.1",
        "https://10.1.2.3",
        "https://169.254.169.254",
        "https://localhost:8443",
    ] {
        let reply = add(&s, &s.user, custom(url, "token")).await;
        assert_eq!(reply.field("url"), "private", "{url}");
    }
    // Own servers have no registry client.
    let reply = add(&s, &s.user, custom("https://mail.own.example", "oauth")).await;
    assert_eq!(reply.field("auth_kind"), "no_client");
}

#[tokio::test]
async fn accounts_follow_the_origin_of_the_registry() {
    let fake = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let reply = add(&s, &s.user, oauth(&server, MAIL_USER, MAIL_TOKEN)).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);

    let account = |s: &Setup| {
        let state = s.state.clone();
        let session = s.user.clone();
        async move {
            send(&state, Method::GET, "/mail-accounts", Some(&session), None)
                .await
                .json()["accounts"][0]
                .clone()
        }
    };

    // Without the server the account is an own one – locked without a policy.
    let removed = send(
        &s.state,
        Method::DELETE,
        &format!("/admin/servers/{server}"),
        Some(&s.admin),
        None,
    )
    .await;
    assert_eq!(removed.status, StatusCode::NO_CONTENT);
    let orphan = account(&s).await;
    assert_eq!(orphan["server_id"], Value::Null);
    assert_eq!(orphan["blocked"], true);
    send(
        &s.state,
        Method::PUT,
        "/admin/servers/policy",
        Some(&s.admin),
        Some(json!({ "allow_custom_servers": true })),
    )
    .await;
    // `http://127.0.0.1` would not work as an own server even with a policy.
    assert_eq!(account(&s).await["blocked"], true);

    // A new entry with the same origin links it again.
    let again = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let linked = account(&s).await;
    assert_eq!(linked["server_id"], again.as_str());
    let servers = send(
        &s.state,
        Method::GET,
        "/admin/servers",
        Some(&s.admin),
        None,
    )
    .await;
    assert_eq!(servers.json()["servers"][0]["accounts"], 1);

    // A new URL of the server does not take the accounts along: their tokens
    // belong to the old origin.
    let moved = send(
        &s.state,
        Method::PATCH,
        &format!("/admin/servers/{again}"),
        Some(&s.admin),
        Some(json!({ "url": "https://mail.new.example" })),
    )
    .await;
    assert_eq!(moved.json()["accounts"], 0);
    assert_eq!(account(&s).await["server_id"], Value::Null);
}

#[tokio::test]
async fn default_account_follows_the_accounts() {
    let fake = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let id = |reply: Reply| {
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
        reply.json()["id"].as_str().unwrap().to_owned()
    };
    let a = id(add(&s, &s.user, token(&server, MAIL_USER, MAIL_TOKEN)).await);
    let b = id(add(&s, &s.user, token(&server, MAIL_USER, OTHER_TOKEN)).await);
    let foreign = id(add(&s, &s.admin, token(&server, MAIL_USER, MAIL_TOKEN)).await);
    assert_eq!(default_account(&s, &s.user).await, a.as_str());

    let put = |value: Value| {
        let state = s.state.clone();
        let session = s.user.clone();
        async move {
            let current = send(&state, Method::GET, "/settings", Some(&session), None).await;
            let version = current.json()["version"].clone();
            send(
                &state,
                Method::PUT,
                "/settings",
                Some(&session),
                Some(json!({ "version": version, "settings": { "defaultAccount": value } })),
            )
            .await
        }
    };
    // Own accounts only.
    let reply = put(json!(foreign)).await;
    assert_eq!(
        reply.json()["fields"]["settings.defaultAccount"]["code"],
        "invalid",
        "{}",
        reply.body
    );
    assert_eq!(put(json!(b)).await.status, StatusCode::OK);

    // Removed: the next account becomes the default account, finally none.
    let delete = |id: String| {
        let state = s.state.clone();
        let session = s.user.clone();
        async move {
            send(
                &state,
                Method::DELETE,
                &format!("/mail-accounts/{id}"),
                Some(&session),
                None,
            )
            .await
            .status
        }
    };
    assert_eq!(delete(foreign.clone()).await, StatusCode::NOT_FOUND);
    assert_eq!(delete(b.clone()).await, StatusCode::NO_CONTENT);
    assert_eq!(default_account(&s, &s.user).await, a.as_str());
    assert_eq!(delete(b).await, StatusCode::NOT_FOUND);

    // "All accounts" stays.
    assert_eq!(put(json!("all")).await.status, StatusCode::OK);
    let c = id(add(&s, &s.user, token(&server, MAIL_USER, NAMED_TOKEN)).await);
    assert_eq!(default_account(&s, &s.user).await, "all");
    assert_eq!(delete(c).await, StatusCode::NO_CONTENT);
    assert_eq!(default_account(&s, &s.user).await, "all");
    assert_eq!(put(json!(a)).await.status, StatusCode::OK);
    assert_eq!(delete(a).await, StatusCode::NO_CONTENT);
    assert_eq!(default_account(&s, &s.user).await, Value::Null);
}

// --- Token broker ---

async fn get_token(s: &Setup, session: &str, id: &str, refresh: bool) -> Reply {
    let query = if refresh { "?refresh=true" } else { "" };
    send(
        &s.state,
        Method::GET,
        &format!("/mail-accounts/{id}/token{query}"),
        Some(session),
        None,
    )
    .await
}

async fn reauth(s: &Setup, session: &str, id: &str, body: Value) -> Reply {
    send(
        &s.state,
        Method::POST,
        &format!("/mail-accounts/{id}/reauth"),
        Some(session),
        Some(body),
    )
    .await
}

/// Account of [`MAIL_USER`] with sign-in at the mail server.
async fn oauth_account(s: &Setup, session: &str, server: &str) -> String {
    let reply = add(s, session, oauth(server, MAIL_USER, MAIL_TOKEN)).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    reply.json()["id"].as_str().unwrap().to_owned()
}

/// Lets the access token expire in `secs` seconds (negative: expired).
async fn expire(state: &AppState, id: &str, secs: i64) {
    let id = id.to_owned();
    db::call(&state.db, move |conn| {
        conn.execute(
            "UPDATE mail_accounts SET access_expires_at = \
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?2 || ' seconds') WHERE id = ?1",
            (&id, format!("{secs:+}")),
        )?;
        Ok(())
    })
    .await
    .unwrap();
}

/// Stored refresh token or access token, decrypted.
async fn stored_secret(state: &AppState, id: &str) -> String {
    let (secret, ..) = stored(state, id).await;
    String::from_utf8(state.secrets.open(SECRET_PURPOSE, id, &secret).unwrap()).unwrap()
}

/// `state` of the account in `GET mail-accounts`.
async fn account_state(s: &Setup, id: &str) -> Value {
    let reply = send(&s.state, Method::GET, "/mail-accounts", Some(&s.user), None).await;
    reply.json()["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|account| account["id"] == id)
        .unwrap()["state"]
        .clone()
}

fn access_token(reply: &Reply) -> String {
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    reply.json()["accessToken"].as_str().unwrap().to_owned()
}

/// The fetch counts towards the user's limits and refreshes at the mail
/// server on demand; an image in a mail or a foreign page (cookie with
/// `SameSite=Lax`, but without `X-Requested-With`) must trigger neither.
#[tokio::test]
async fn token_needs_csrf_header() {
    let fake = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let id = oauth_account(&s, &s.user, &server).await;
    for method in [Method::GET, Method::HEAD] {
        for _ in 0..11 {
            let request = Request::builder()
                .method(method.clone())
                .uri(format!("/api/v1/mail-accounts/{id}/token?refresh=true"))
                .header(header::COOKIE, format!("{}={}", session::COOKIE, s.user))
                .body(Body::empty())
                .unwrap();
            let response = app(&s.state).oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{method}");
        }
    }
    assert!(fake.token_requests().is_empty());
    // The limits are untouched: refreshing on demand still works.
    let reply = get_token(&s, &s.user, &id, true).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(fake.token_requests().len(), 1);
}

#[tokio::test]
async fn hands_out_tokens_and_refreshes_before_expiry() {
    let fake = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let id = oauth_account(&s, &s.user, &server).await;

    // Still valid for an hour: the stored one, without the mail server.
    let reply = get_token(&s, &s.user, &id, false).await;
    assert_eq!(reply.cache_control.as_deref(), Some("no-store"));
    assert_eq!(access_token(&reply), MAIL_TOKEN);
    let body = reply.json();
    assert!(body["expiresAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(
        body["session"]["primaryAccounts"]["urn:ietf:params:jmap:mail"],
        "a1"
    );
    assert!(fake.token_requests().is_empty());

    // Expires in less than five minutes: refreshed, as the registry's public
    // client.
    expire(&s.state, &id, 60).await;
    let refreshed = access_token(&get_token(&s, &s.user, &id, false).await);
    assert_ne!(refreshed, MAIL_TOKEN);
    let requests = fake.token_requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].form["grant_type"], "refresh_token");
    assert_eq!(requests[0].form["refresh_token"], REFRESH);
    assert_eq!(requests[0].form["client_id"], CLIENT_ID);
    assert!(!requests[0].form.contains_key("client_secret"));
    assert_eq!(requests[0].authorization, None);
    // Stalwart v1 rotates: the new refresh token is stored.
    assert_ne!(stored_secret(&s.state, &id).await, REFRESH);
    assert_eq!(
        access_token(&get_token(&s, &s.user, &id, false).await),
        refreshed
    );
    assert_eq!(fake.token_requests().len(), 1);

    // On demand also earlier (the mail server rejected it).
    let forced = access_token(&get_token(&s, &s.user, &id, true).await);
    assert_ne!(forced, refreshed);
    assert_eq!(fake.token_requests().len(), 2);
    let bad = send(
        &s.state,
        Method::GET,
        &format!("/mail-accounts/{id}/token?refresh=yes"),
        Some(&s.user),
        None,
    )
    .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST, "{}", bad.body);

    // Accounts of other users and unknown ones: 404.
    let eva = login(&s.state, "eva", Role::User).await;
    assert_eq!(
        get_token(&s, &eva, &id, false).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        get_token(&s, &s.user, "01UNKNOWN", false).await.status,
        StatusCode::NOT_FOUND
    );

    // Access token: unchanged, without expiry.
    let token_account = add(&s, &s.user, token(&server, "eva@example.com", OTHER_TOKEN)).await;
    let token_id = token_account.json()["id"].as_str().unwrap().to_owned();
    let reply = get_token(&s, &s.user, &token_id, false).await;
    assert_eq!(access_token(&reply), OTHER_TOKEN);
    assert_eq!(reply.json()["expiresAt"], Value::Null);
    assert_eq!(fake.token_requests().len(), 2);

    // The browser exchanges itself: public client.
    let servers = send(&s.state, Method::GET, "/servers", Some(&s.user), None).await;
    assert_eq!(servers.json()["servers"][0]["backend_exchange"], false);
}

/// Strict rotation as in Stalwart v1: the new refresh token is
/// stored before the access token goes out; after a lost response the broker
/// uses the stored one again (the server then issues the same generation)
/// and never a replaced one.
#[tokio::test]
async fn rotates_refresh_tokens_strictly() {
    let fake = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let id = oauth_account(&s, &s.user, &server).await;
    let origin = url::Url::parse(&fake.url)
        .unwrap()
        .origin()
        .ascii_serialization();

    expire(&s.state, &id, -1).await;
    let first = access_token(&get_token(&s, &s.user, &id, false).await);
    let rotated = stored_secret(&s.state, &id).await;
    assert_ne!(rotated, REFRESH);
    // The old one is still valid as long as the new one is unused.
    assert!(fake.refresh_valid(REFRESH));
    assert!(fake.refresh_valid(&rotated));

    // The server rotates, the response gets lost: the previous one stays
    // stored, and the previous access token keeps going out.
    fake.lose_token_responses(true);
    assert_eq!(
        access_token(&get_token(&s, &s.user, &id, true).await),
        first
    );
    assert_eq!(stored_secret(&s.state, &id).await, rotated);
    assert_eq!(account_state(&s, &id).await, "ok");

    // After the pause the same one again – the server takes it because the new
    // one was never used.
    fake.lose_token_responses(false);
    s.state
        .limiter
        .reset(&token::REFRESH_FAILED_LIMIT, &Key::Server(origin));
    let again = access_token(&get_token(&s, &s.user, &id, true).await);
    assert_ne!(again, first);
    let requests = fake.token_requests();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[1].form["refresh_token"], rotated);
    assert_eq!(requests[2].form["refresh_token"], rotated);
    let newest = stored_secret(&s.state, &id).await;
    assert_ne!(newest, rotated);
    // From now on the server would revoke the grant if the first one came back.
    assert!(!fake.refresh_valid(REFRESH));
    assert!(fake.refresh_valid(&newest));
    assert_eq!(account_state(&s, &id).await, "ok");
}

#[tokio::test]
async fn concurrent_requests_refresh_once() {
    let fake = Server::start(Options {
        token_delay: std::time::Duration::from_millis(200),
        ..Options::default()
    })
    .await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let id = oauth_account(&s, &s.user, &server).await;
    expire(&s.state, &id, -1).await;

    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..5 {
        let (state, user, id) = (s.state.clone(), s.user.clone(), id.clone());
        tasks.spawn(async move {
            send(
                &state,
                Method::GET,
                &format!("/mail-accounts/{id}/token"),
                Some(&user),
                None,
            )
            .await
        });
    }
    let tokens: Vec<String> = tasks.join_all().await.iter().map(access_token).collect();
    assert!(tokens.iter().all(|token| *token == tokens[0]), "{tokens:?}");
    assert_ne!(tokens[0], MAIL_TOKEN);
    assert_eq!(fake.token_requests().len(), 1);
}

#[tokio::test]
async fn refresh_follows_a_new_login_meanwhile() {
    let fake = Server::start(Options {
        token_delay: std::time::Duration::from_millis(300),
        ..Options::default()
    })
    .await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let id = oauth_account(&s, &s.user, &server).await;
    expire(&s.state, &id, -1).await;

    let pending = {
        let (state, user, id) = (s.state.clone(), s.user.clone(), id.clone());
        tokio::spawn(async move {
            send(
                &state,
                Method::GET,
                &format!("/mail-accounts/{id}/token"),
                Some(&user),
                None,
            )
            .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    // Signed in again during the refresh, without `expires_in`: the new access
    // token counts as expired, so a refresh with the new refresh token instead
    // of "sign-in required".
    let again = reauth(
        &s,
        &s.user,
        &id,
        json!({ "access_token": MAIL_TOKEN, "refresh_token": REFRESH_TOKEN }),
    )
    .await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.body);
    let reply = pending.await.unwrap();
    assert_ne!(access_token(&reply), MAIL_TOKEN);
    assert_eq!(fake.token_requests().len(), 2);
    assert_eq!(account_state(&s, &id).await, "ok");
}

#[tokio::test]
async fn rejected_refresh_tokens_need_a_new_login() {
    let fake = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let id = oauth_account(&s, &s.user, &server).await;

    fake.revoke_refresh_tokens();
    expire(&s.state, &id, 60).await;
    let reply = get_token(&s, &s.user, &id, false).await;
    assert_eq!(reply.status, StatusCode::CONFLICT, "{}", reply.body);
    assert_eq!(reply.json()["error"], "needs_reauth");
    assert_eq!(account_state(&s, &id).await, "needs_reauth");
    // After that the broker no longer asks the mail server.
    let again = get_token(&s, &s.user, &id, false).await;
    assert_eq!(again.json()["error"], "needs_reauth");
    assert_eq!(fake.token_requests().len(), 1);
    let (_, access, ..) = stored(&s.state, &id).await;
    assert_eq!(access, None);
}

/// Stalwart v1 calls a client that may not redeem refresh tokens
/// `unauthorized_client` – the same refresh failed again and again. For the
/// code exchange it stays `rejected` with `detail` for the web app.
#[tokio::test]
async fn unauthorized_clients_need_a_new_login() {
    let fake = Server::start(Options {
        unauthorized_client: true,
        ..Options::default()
    })
    .await;
    let s = setup().await;
    let server = register_confidential(&s, &fake.url).await;
    let id = oauth_account(&s, &s.user, &server).await;

    expire(&s.state, &id, -1).await;
    let reply = get_token(&s, &s.user, &id, false).await;
    assert_eq!(reply.status, StatusCode::CONFLICT, "{}", reply.body);
    assert_eq!(reply.json()["error"], "needs_reauth");
    assert_eq!(account_state(&s, &id).await, "needs_reauth");
    let again = get_token(&s, &s.user, &id, false).await;
    assert_eq!(again.json()["error"], "needs_reauth");
    assert_eq!(fake.token_requests().len(), 1);

    let body = json!({ "code": CODE, "code_verifier": VERIFIER });
    let reply = reauth(&s, &s.user, &id, body).await;
    assert_eq!(
        reply.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        reply.body
    );
    assert_eq!(
        reply.json(),
        json!({ "error": "exchange_failed", "reason": "rejected", "detail": "unauthorized_client" })
    );
}

/// If the server returns no new refresh token on refresh (RFC 6749 › 6),
/// the previous one stays.
#[tokio::test]
async fn keeps_the_refresh_token_without_rotation() {
    let fake = Server::start(Options {
        keep_refresh: true,
        ..Options::default()
    })
    .await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let id = oauth_account(&s, &s.user, &server).await;

    expire(&s.state, &id, -1).await;
    let first = access_token(&get_token(&s, &s.user, &id, false).await);
    assert_eq!(stored_secret(&s.state, &id).await, REFRESH);
    let again = access_token(&get_token(&s, &s.user, &id, true).await);
    assert_ne!(again, first);
    let requests = fake.token_requests();
    assert_eq!(requests[1].form["refresh_token"], REFRESH);
}

/// The migration to Stalwart v1 takes over no tokens: every
/// account ends up in "sign-in required" at the first refresh, via the
/// fetch as via the early refresh, and after that the broker no longer asks
/// the mail server. It does not refresh access tokens.
#[tokio::test]
async fn accounts_need_a_new_login_after_the_migration() {
    let fake = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let fetched = oauth_account(&s, &s.user, &server).await;
    let eva = login(&s.state, "eva", Role::User).await;
    let prefetched = oauth_account(&s, &eva, &server).await;
    let keyed = add(&s, &eva, token(&server, "eva@example.com", OTHER_TOKEN)).await;
    assert_eq!(keyed.status, StatusCode::CREATED, "{}", keyed.body);
    let keyed = keyed.json()["id"].as_str().unwrap().to_owned();
    // Eva has fetched a token; the job refreshes her account.
    access_token(&get_token(&s, &eva, &prefetched, false).await);

    fake.revoke_refresh_tokens();
    expire(&s.state, &fetched, -1).await;
    expire(&s.state, &prefetched, 5 * 60).await;
    (token_refresh::job().run)(s.state.clone()).await.unwrap();
    assert_eq!(account_state(&s, &fetched).await, "ok");
    let reply = get_token(&s, &s.user, &fetched, false).await;
    assert_eq!(reply.json()["error"], "needs_reauth", "{}", reply.body);
    let reply = get_token(&s, &eva, &prefetched, false).await;
    assert_eq!(reply.json()["error"], "needs_reauth", "{}", reply.body);
    assert_eq!(account_state(&s, &fetched).await, "needs_reauth");
    assert_eq!(fake.token_requests().len(), 2);

    // After that no more requests, not from the job either.
    (token_refresh::job().run)(s.state.clone()).await.unwrap();
    get_token(&s, &s.user, &fetched, true).await;
    assert_eq!(fake.token_requests().len(), 2);
    assert_eq!(
        access_token(&get_token(&s, &eva, &keyed, false).await),
        OTHER_TOKEN
    );
}

#[tokio::test]
async fn temporary_errors_keep_the_account() {
    let fake = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let id = oauth_account(&s, &s.user, &server).await;
    let origin = url::Url::parse(&fake.url)
        .unwrap()
        .origin()
        .ascii_serialization();
    let resume = || {
        s.state
            .limiter
            .reset(&token::REFRESH_FAILED_LIMIT, &Key::Server(origin.clone()));
    };

    // As long as the previous one is valid, it keeps going out.
    fake.fail_tokens(Some(StatusCode::SERVICE_UNAVAILABLE));
    expire(&s.state, &id, 60).await;
    assert_eq!(
        access_token(&get_token(&s, &s.user, &id, false).await),
        MAIL_TOKEN
    );
    // After that nobody asks the mail server for a while, not even after a
    // rejected token.
    expire(&s.state, &id, -1).await;
    let requests = fake.token_requests().len();
    for refresh in [false, true] {
        let paused = get_token(&s, &s.user, &id, refresh).await;
        assert_eq!(
            paused.status,
            StatusCode::TOO_MANY_REQUESTS,
            "{}",
            paused.body
        );
    }
    assert_eq!(fake.token_requests().len(), requests);

    resume();
    let reply = get_token(&s, &s.user, &id, false).await;
    assert_eq!(reply.status, StatusCode::BAD_GATEWAY, "{}", reply.body);
    assert_eq!(reply.json()["error"], "refresh_failed");
    assert_eq!(reply.json()["reason"], "http_status");
    assert_eq!(account_state(&s, &id).await, "ok");

    // Netzfehler ebenso.
    resume();
    fake.stop().await;
    let reply = get_token(&s, &s.user, &id, false).await;
    assert_eq!(reply.status, StatusCode::BAD_GATEWAY, "{}", reply.body);
    assert_eq!(reply.json()["reason"], "unreachable");
    assert_eq!(account_state(&s, &id).await, "ok");
}

#[tokio::test]
async fn reauth_accepts_only_the_same_account() {
    let fake = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let id = oauth_account(&s, &s.user, &server).await;
    fake.revoke_refresh_tokens();
    expire(&s.state, &id, -1).await;
    assert_eq!(
        get_token(&s, &s.user, &id, false).await.status,
        StatusCode::CONFLICT
    );

    let tokens = |access: &str, refresh: &str| json!({ "access_token": access, "refresh_token": refresh, "expires_in": 3600 });
    // Another account on the same server.
    let other = reauth(&s, &s.user, &id, tokens(OTHER_TOKEN, OTHER_REFRESH)).await;
    assert_eq!(other.status, StatusCode::CONFLICT, "{}", other.body);
    assert_eq!(other.json()["error"], "other_account");
    assert_eq!(other.json()["account"]["email"], "eva@example.com");
    assert_eq!(account_state(&s, &id).await, "needs_reauth");
    // Rejected tokens and missing fields.
    let rejected = reauth(&s, &s.user, &id, tokens("incorrect", "new")).await;
    assert_eq!(rejected.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(rejected.json()["reason"], "auth_failed");
    let missing = reauth(&s, &s.user, &id, json!({ "access_token": MAIL_TOKEN })).await;
    assert_eq!(missing.field("refresh_token"), "required");
    let token_field = reauth(&s, &s.user, &id, json!({ "token": MAIL_TOKEN })).await;
    assert_eq!(token_field.field("access_token"), "required");
    // Accounts of other users.
    let eva = login(&s.state, "eva", Role::User).await;
    let foreign = reauth(&s, &eva, &id, tokens(MAIL_TOKEN, "new")).await;
    assert_eq!(foreign.status, StatusCode::NOT_FOUND);

    let done = reauth(&s, &s.user, &id, tokens(MAIL_TOKEN, "refresh-new")).await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.body);
    assert_eq!(done.json()["state"], "ok");
    assert_eq!(done.json()["id"], id.as_str());
    assert_eq!(stored_secret(&s.state, &id).await, "refresh-new");
    assert_eq!(
        access_token(&get_token(&s, &s.user, &id, false).await),
        MAIL_TOKEN
    );

    // Access token: the same account with a new token.
    let token_account = add(&s, &s.user, token(&server, "eva@example.com", OTHER_TOKEN)).await;
    let token_id = token_account.json()["id"].as_str().unwrap().to_owned();
    let wrong = reauth(&s, &s.user, &token_id, json!({ "token": NAMED_TOKEN })).await;
    assert_eq!(wrong.json()["error"], "other_account");
    let same = reauth(&s, &s.user, &token_id, json!({ "token": OTHER_TOKEN })).await;
    assert_eq!(same.status, StatusCode::OK, "{}", same.body);
}

/// Server with a confidential client in the registry.
async fn register_confidential(s: &Setup, url: &str) -> String {
    let reply = send(
        &s.state,
        Method::POST,
        "/admin/servers",
        Some(&s.admin),
        Some(json!({
            "label": "Stalwart",
            "url": url,
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
        })),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    reply.json()["id"].as_str().unwrap().to_owned()
}

/// `Authorization` of the registry's client with [`CLIENT_SECRET`]: ID and
/// secret encoded per RFC 6749, section 2.3.1.
fn basic() -> String {
    use base64::Engine as _;
    let pair = format!("{CLIENT_ID}:client%2Bsecret%2F%3D");
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(pair)
    )
}

fn code(server_id: &str, code: &str) -> Value {
    json!({
        "email": MAIL_USER,
        "server_id": server_id,
        "auth_kind": "oauth",
        "code": code,
        "code_verifier": VERIFIER,
    })
}

#[tokio::test]
async fn confidential_clients_exchange_codes_in_the_backend() {
    let fake = Server::start(Options {
        client_secret: Some(CLIENT_SECRET),
        ..Options::default()
    })
    .await;
    let s = setup().await;
    let server = register_confidential(&s, &fake.url).await;
    let servers = send(&s.state, Method::GET, "/servers", Some(&s.user), None).await;
    assert_eq!(servers.json()["servers"][0]["backend_exchange"], true);

    // Inputs: verifier per RFC 7636, code not next to tokens.
    let short = add(
        &s,
        &s.user,
        json!({ "email": MAIL_USER, "server_id": server, "auth_kind": "oauth", "code": CODE, "code_verifier": "short" }),
    )
    .await;
    assert_eq!(short.field("code_verifier"), "invalid");
    let mut both = code(&server, CODE);
    both["access_token"] = json!(MAIL_TOKEN);
    assert_eq!(add(&s, &s.user, both).await.field("code"), "conflict");
    assert!(fake.token_requests().is_empty());

    let created = add(&s, &s.user, code(&server, CODE)).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let id = created.json()["id"].as_str().unwrap().to_owned();
    let exchange = &fake.token_requests()[0];
    assert_eq!(exchange.form["grant_type"], "authorization_code");
    assert_eq!(exchange.form["code"], CODE);
    assert_eq!(exchange.form["code_verifier"], VERIFIER);
    assert_eq!(
        exchange.form["redirect_uri"],
        "https://app.example.com/oauth/callback"
    );
    // Secret via Basic, encoded per RFC 6749 (Stalwart v1 decodes it).
    assert!(!exchange.form.contains_key("client_secret"));
    assert!(!exchange.form.contains_key("client_id"));
    assert_eq!(exchange.authorization.as_deref(), Some(basic().as_str()));
    assert!(fake.refresh_valid(&stored_secret(&s.state, &id).await));
    let (_, _, client_id, _) = stored(&s.state, &id).await;
    assert_eq!(client_id.as_deref(), Some(CLIENT_ID));

    // Refresh with secret.
    expire(&s.state, &id, -1).await;
    access_token(&get_token(&s, &s.user, &id, false).await);
    let refresh = &fake.token_requests()[1];
    assert_eq!(refresh.form["grant_type"], "refresh_token");
    assert_eq!(refresh.authorization.as_deref(), Some(basic().as_str()));

    // Re-sign-in with code: the same account, otherwise rejected.
    let body = |code: &str| json!({ "code": code, "code_verifier": VERIFIER });
    let other = reauth(&s, &s.user, &id, body(OTHER_CODE)).await;
    assert_eq!(other.json()["error"], "other_account");
    let again = reauth(&s, &s.user, &id, body(&fake.new_code())).await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.body);

    // Redeemed code: rejected, and that counts against the user (five in 15
    // minutes).
    for _ in 0..5 {
        let used = reauth(&s, &s.user, &id, body(CODE)).await;
        assert_eq!(
            used.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{}",
            used.body
        );
        assert_eq!(used.json()["error"], "exchange_failed");
        assert_eq!(used.json()["reason"], "invalid_grant");
    }
    let locked = reauth(&s, &s.user, &id, body(CODE)).await;
    assert_eq!(
        locked.status,
        StatusCode::TOO_MANY_REQUESTS,
        "{}",
        locked.body
    );
}

#[tokio::test]
async fn codes_need_a_confidential_client_and_secrets_only_their_client() {
    let fake = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    // Public client: the browser exchanges itself.
    let reply = add(&s, &s.user, code(&server, CODE)).await;
    assert_eq!(reply.field("code"), "not_allowed");

    // The broker refreshes tokens of another client as that client, without the
    // secret of the registry's client (in Stalwart v1 a grant belongs to its
    // client).
    let confidential = Server::start(Options {
        client_secret: Some(CLIENT_SECRET),
        ..Options::default()
    })
    .await;
    let server = register_confidential(&s, &confidential.url).await;
    let mut body = oauth(&server, MAIL_USER, MAIL_TOKEN);
    body["client_id"] = json!("other-client");
    let created = add(&s, &s.user, body).await;
    let id = created.json()["id"].as_str().unwrap().to_owned();
    expire(&s.state, &id, -1).await;
    let reply = get_token(&s, &s.user, &id, false).await;
    assert_ne!(access_token(&reply), MAIL_TOKEN);
    let request = &confidential.token_requests()[0];
    assert_eq!(request.form["client_id"], "other-client");
    assert!(!request.form.contains_key("client_secret"));
    assert_eq!(request.authorization, None);
}

#[tokio::test]
async fn blocked_accounts_get_no_tokens() {
    let fake = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let id = oauth_account(&s, &s.user, &server).await;
    let removed = send(
        &s.state,
        Method::DELETE,
        &format!("/admin/servers/{server}"),
        Some(&s.admin),
        None,
    )
    .await;
    assert_eq!(removed.status, StatusCode::NO_CONTENT);

    let reply = get_token(&s, &s.user, &id, true).await;
    assert_eq!(reply.status, StatusCode::CONFLICT, "{}", reply.body);
    assert_eq!(reply.json()["error"], "blocked");
    let again = reauth(
        &s,
        &s.user,
        &id,
        json!({ "access_token": MAIL_TOKEN, "refresh_token": REFRESH }),
    )
    .await;
    assert_eq!(again.json()["error"], "blocked");
    assert!(fake.token_requests().is_empty());
}

#[tokio::test]
async fn prefetch_refreshes_active_accounts() {
    let fake = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let active = oauth_account(&s, &s.user, &server).await;
    let eva = login(&s.state, "eva", Role::User).await;
    let idle = oauth_account(&s, &eva, &server).await;

    // Seven minutes: `GET …/token` still hands it out, the job refreshes it.
    expire(&s.state, &active, 7 * 60).await;
    expire(&s.state, &idle, 60).await;
    assert_eq!(
        access_token(&get_token(&s, &s.user, &active, false).await),
        MAIL_TOKEN
    );
    assert!(fake.token_requests().is_empty());

    (token_refresh::job().run)(s.state.clone()).await.unwrap();
    // Only the active account: nobody has fetched a token for the other one.
    assert_eq!(fake.token_requests().len(), 1);
    let renewed = access_token(&get_token(&s, &s.user, &active, false).await);
    assert_ne!(renewed, MAIL_TOKEN);
    assert_eq!(fake.token_requests().len(), 1);
    // A second run has nothing to do.
    (token_refresh::job().run)(s.state.clone()).await.unwrap();
    assert_eq!(fake.token_requests().len(), 1);
}

async fn remove(s: &Setup, session: &str, id: &str) -> StatusCode {
    let reply = send(
        &s.state,
        Method::DELETE,
        &format!("/mail-accounts/{id}"),
        Some(session),
        None,
    )
    .await;
    reply.status
}

/// Waits until the background revocation has made `count` requests.
async fn revocations(fake: &Server, count: usize) -> Vec<TokenRequest> {
    for _ in 0..500 {
        let revocations = fake.revocations();
        if revocations.len() >= count {
            return revocations;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("no revocation at the mail server");
}

/// On removal the backend revokes the grant – with the secret
/// of the registry's client via Basic, otherwise with the client ID in the
/// body. Accounts with an access token or "sign-in required" do not ask
/// the mail server, and its errors do not affect the removal.
#[tokio::test]
async fn removing_an_account_revokes_its_grant() {
    let fake = Server::start(Options {
        client_secret: Some(CLIENT_SECRET),
        ..Options::default()
    })
    .await;
    let s = setup().await;
    let server = register_confidential(&s, &fake.url).await;

    let keyed = add(&s, &s.user, token(&server, "eva@example.com", OTHER_TOKEN)).await;
    let keyed = keyed.json()["id"].as_str().unwrap().to_owned();
    assert_eq!(remove(&s, &s.user, &keyed).await, StatusCode::NO_CONTENT);
    let created = add(&s, &s.user, code(&server, CODE)).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let id = created.json()["id"].as_str().unwrap().to_owned();
    let refresh = stored_secret(&s.state, &id).await;
    assert!(fake.grant_exists(&refresh));

    // Other users' accounts stay, and nobody asks the mail server.
    let eva = login(&s.state, "eva", Role::User).await;
    assert_eq!(remove(&s, &eva, &id).await, StatusCode::NOT_FOUND);
    assert_eq!(remove(&s, &s.user, &id).await, StatusCode::NO_CONTENT);
    let revoked = revocations(&fake, 1).await;
    assert_eq!(revoked[0].form["token"], refresh);
    assert_eq!(revoked[0].form["token_type_hint"], "refresh_token");
    assert!(!revoked[0].form.contains_key("client_secret"));
    assert_eq!(revoked[0].authorization.as_deref(), Some(basic().as_str()));
    assert!(!fake.grant_exists(&refresh));
    assert_eq!(remove(&s, &s.user, &id).await, StatusCode::NOT_FOUND);

    // Rejected refresh token: nothing to revoke.
    let created = add(&s, &s.user, code(&server, &fake.new_code())).await;
    let id = created.json()["id"].as_str().unwrap().to_owned();
    fake.revoke_refresh_tokens();
    expire(&s.state, &id, -1).await;
    assert_eq!(
        get_token(&s, &s.user, &id, false).await.json()["error"],
        "needs_reauth"
    );
    assert_eq!(remove(&s, &s.user, &id).await, StatusCode::NO_CONTENT);

    // Public client: client ID in the body. An error of the mail server does
    // not affect the removal.
    let public = Server::start(Options::default()).await;
    let server = register(&s, &public.url, Some(CLIENT_ID)).await;
    let id = oauth_account(&s, &s.user, &server).await;
    assert_eq!(remove(&s, &s.user, &id).await, StatusCode::NO_CONTENT);
    let revoked = revocations(&public, 1).await;
    assert_eq!(revoked[0].form["client_id"], CLIENT_ID);
    assert_eq!(revoked[0].authorization, None);
    assert!(!public.grant_exists(REFRESH));
    let id = oauth_account(&s, &s.user, &server).await;
    public.stop().await;
    assert_eq!(remove(&s, &s.user, &id).await, StatusCode::NO_CONTENT);
    assert_eq!(
        get_token(&s, &s.user, &id, false).await.status,
        StatusCode::NOT_FOUND
    );

    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(fake.revocations().len(), 1);
}

/// The revocation authenticates as the metadata name it for the revocation
/// endpoint. A wrong secret counts against the throttle for rejected
/// clients, and while it applies the backend does not ask. Accounts whose
/// server the backend may not ask (`blocked`) are not revoked.
#[tokio::test]
async fn revocation_follows_the_metadata_and_the_brake() {
    let fake = Server::start(Options {
        client_secret: Some("other-secret"),
        revocation_auth_methods: Some(&["client_secret_post"]),
        ..Options::default()
    })
    .await;
    let s = setup().await;
    let server = register_confidential(&s, &fake.url).await;
    for count in 1..=6 {
        let id = oauth_account(&s, &s.user, &server).await;
        assert_eq!(remove(&s, &s.user, &id).await, StatusCode::NO_CONTENT);
        if count <= 5 {
            revocations(&fake, count).await;
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let revoked = fake.revocations();
    assert_eq!(revoked.len(), 5);
    assert_eq!(revoked[0].form["client_id"], CLIENT_ID);
    assert_eq!(revoked[0].form["client_secret"], CLIENT_SECRET);
    assert_eq!(revoked[0].authorization, None);
    assert!(fake.grant_exists(REFRESH));

    // Server deleted from the registry, own servers not allowed: the account
    // is locked, and the mail server hears nothing.
    let other = Server::start(Options::default()).await;
    let server = register(&s, &other.url, Some(CLIENT_ID)).await;
    let id = oauth_account(&s, &s.user, &server).await;
    let deleted = send(
        &s.state,
        Method::DELETE,
        &format!("/admin/servers/{server}"),
        Some(&s.admin),
        None,
    )
    .await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.body);
    assert_eq!(
        get_token(&s, &s.user, &id, false).await.json()["error"],
        "blocked"
    );
    assert_eq!(remove(&s, &s.user, &id).await, StatusCode::NO_CONTENT);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(other.revocations().is_empty());
}

async fn update(s: &Setup, session: &str, id: &str, body: Value) -> Reply {
    send(
        &s.state,
        Method::PATCH,
        &format!("/mail-accounts/{id}"),
        Some(session),
        Some(body),
    )
    .await
}

async fn check(s: &Setup, session: &str, id: &str) -> Reply {
    send(
        &s.state,
        Method::POST,
        &format!("/mail-accounts/{id}/check"),
        Some(session),
        None,
    )
    .await
}

/// Color of an account: only the six predefined colors, only
/// own accounts, no label.
#[tokio::test]
async fn changes_the_color_of_own_accounts() {
    let fake = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let id = oauth_account(&s, &s.user, &server).await;

    let changed = update(&s, &s.user, &id, json!({ "color": 5 })).await;
    assert_eq!(changed.status, StatusCode::OK, "{}", changed.body);
    assert_eq!(changed.json()["color"], 5);
    assert_eq!(changed.json()["server_id"], server.as_str());
    assert_eq!(changed.json()["blocked"], false);
    for color in [-1, 6] {
        let wrong = update(&s, &s.user, &id, json!({ "color": color })).await;
        assert_eq!(wrong.field("color"), "invalid");
    }
    let label = update(&s, &s.user, &id, json!({ "label": "Work" })).await;
    assert_eq!(label.status, StatusCode::BAD_REQUEST, "{}", label.body);
    let eva = login(&s.state, "eva", Role::User).await;
    let foreign = update(&s, &eva, &id, json!({ "color": 1 })).await;
    assert_eq!(foreign.status, StatusCode::NOT_FOUND);
    let unchanged = update(&s, &s.user, &id, json!({})).await;
    assert_eq!(unchanged.status, StatusCode::OK);
    assert_eq!(unchanged.json()["color"], 5);
}

/// What the job `quota_check` leaves on an account: storage, last check, the
/// job's last attempt and the browser's last fetch.
async fn quota_row(
    state: &AppState,
    id: &str,
) -> (
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
) {
    let id = id.to_owned();
    db::call(&state.db, move |conn| {
        Ok(conn.query_row(
            "SELECT quota_used, last_check_at, quota_job_at, token_used_at, user_id \
             FROM mail_accounts WHERE id = ?1",
            [&id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?)
    })
    .await
    .unwrap()
}

/// Moves the last attempt of the job `quota_check` back by one day.
async fn quota_job_yesterday(state: &AppState, id: &str) {
    let id = id.to_owned();
    db::call(&state.db, move |conn| {
        conn.execute(
            "UPDATE mail_accounts SET quota_job_at = \
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours') WHERE id = ?1",
            [&id],
        )?;
        Ok(())
    })
    .await
    .unwrap();
}

/// Job `quota_check`: once a day `Quota/get` with an access token
/// of the broker, storage stored like "check connection", from 90 %
/// "storage almost full" – once, as long as the storage stays full. The
/// account does not count as active in the process, and a failed attempt
/// waits until the next day.
#[tokio::test]
async fn quota_check_reports_full_storage_once() {
    let mib = 1024 * 1024;
    let fake = Server::start(Options {
        quota: Some((95 * mib, 100 * mib)),
        ..Options::default()
    })
    .await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let id = oauth_account(&s, &s.user, &server).await;
    // An access token from the token endpoint instead of the fake's fixed token.
    expire(&s.state, &id, -1).await;
    let (_, _, _, used_before, user_id) = quota_row(&s.state, &id).await;
    let notified = |state: &AppState| {
        let (state, user_id) = (state.clone(), user_id.clone());
        async move {
            db::call(&state.db, move |conn| notifications::list(conn, &user_id))
                .await
                .unwrap()
        }
    };

    // If the broker is currently throttling the server, the next run asks again
    // – without recording an attempt.
    let origin = Url::parse(&fake.url)
        .unwrap()
        .origin()
        .ascii_serialization();
    let key = Key::Server(origin);
    let _ = s
        .state
        .limiter
        .acquire(&token::REFRESH_FAILED_LIMIT, key.clone());
    (quota_check::job().run)(s.state.clone()).await.unwrap();
    assert_eq!(quota_row(&s.state, &id).await.2, None);
    assert!(fake.token_requests().is_empty());
    s.state.limiter.reset(&token::REFRESH_FAILED_LIMIT, &key);

    (quota_check::job().run)(s.state.clone()).await.unwrap();
    let (quota_used, checked_at, job_at, used_after, _) = quota_row(&s.state, &id).await;
    assert_eq!(quota_used, Some(95 * 1024 * 1024));
    assert!(checked_at.is_some() && job_at.is_some());
    assert_eq!(
        used_after, used_before,
        "does not count as a fetch by the browser"
    );
    assert_eq!(fake.token_requests().len(), 1);
    let got = notified(&s.state).await;
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].kind, "account.quota");
    assert_eq!(got[0].params["account"], MAIL_USER);
    assert_eq!(got[0].params["mail_account_id"], id.as_str());
    assert_eq!(got[0].params["percent"], 95);
    let listed = send(&s.state, Method::GET, "/mail-accounts", Some(&s.user), None).await;
    assert_eq!(listed.json()["accounts"][0]["quota_used"], 95 * mib);

    // Nothing more on the same day, no second notification on the next.
    (quota_check::job().run)(s.state.clone()).await.unwrap();
    assert_eq!(quota_row(&s.state, &id).await.2, job_at);
    quota_job_yesterday(&s.state, &id).await;
    (quota_check::job().run)(s.state.clone()).await.unwrap();
    assert_eq!(notified(&s.state).await.len(), 1);

    // Mail server unreachable: attempt recorded, storage stays.
    let (_, checked_at, _, _, _) = quota_row(&s.state, &id).await;
    fake.stop().await;
    quota_job_yesterday(&s.state, &id).await;
    let (_, _, before, _, _) = quota_row(&s.state, &id).await;
    (quota_check::job().run)(s.state.clone()).await.unwrap();
    let (quota_used, kept, job_at, _, _) = quota_row(&s.state, &id).await;
    assert_eq!(quota_used, Some(95 * 1024 * 1024));
    assert_eq!(kept, checked_at);
    assert_ne!(job_at, before);
    assert_eq!(notified(&s.state).await.len(), 1);
}

/// "Check connection": session and `Quota/get` with an access
/// token of the broker, storage and time stored. The broker refreshes a
/// rejected access token once; errors of the mail server do not change the
/// account.
#[tokio::test]
async fn check_stores_the_storage_of_the_account() {
    let fake = Server::start(Options {
        quota: Some((2048, 104_857_600)),
        ..Options::default()
    })
    .await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let id = oauth_account(&s, &s.user, &server).await;
    // An access token from the token endpoint instead of the fake's fixed token.
    expire(&s.state, &id, -1).await;
    access_token(&get_token(&s, &s.user, &id, false).await);

    let checked = check(&s, &s.user, &id).await;
    assert_eq!(checked.status, StatusCode::OK, "{}", checked.body);
    let account = checked.json();
    assert_eq!(account["quota_used"], 2048);
    assert_eq!(account["quota_total"], 104_857_600);
    assert_eq!(account["state"], "ok");
    assert!(account["last_check_at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(fake.token_requests().len(), 1);
    let listed = send(&s.state, Method::GET, "/mail-accounts", Some(&s.user), None).await;
    assert_eq!(listed.json()["accounts"][0]["quota_total"], 104_857_600);

    // The mail server rejects the access token: refresh once.
    fake.forget_access_tokens();
    let renewed = check(&s, &s.user, &id).await;
    assert_eq!(renewed.status, StatusCode::OK, "{}", renewed.body);
    assert_eq!(fake.token_requests().len(), 2);

    let eva = login(&s.state, "eva", Role::User).await;
    assert_eq!(check(&s, &eva, &id).await.status, StatusCode::NOT_FOUND);

    // Access token on a server without a storage limit.
    let plain = Server::start(Options::default()).await;
    let plain_server = register(&s, &plain.url, None).await;
    let keyed = add(
        &s,
        &s.user,
        token(&plain_server, "eva@example.com", OTHER_TOKEN),
    )
    .await;
    let keyed = keyed.json()["id"].as_str().unwrap().to_owned();
    let unlimited = check(&s, &s.user, &keyed).await;
    assert_eq!(unlimited.status, StatusCode::OK, "{}", unlimited.body);
    assert_eq!(unlimited.json()["quota_used"], Value::Null);
    assert_eq!(unlimited.json()["quota_total"], Value::Null);
    let checked_at = unlimited.json()["last_check_at"].clone();
    assert!(checked_at.is_string());

    plain.stop().await;
    let failed = check(&s, &s.user, &keyed).await;
    assert_eq!(failed.status, StatusCode::BAD_GATEWAY, "{}", failed.body);
    assert_eq!(failed.json()["error"], "check_failed");
    assert_eq!(failed.json()["reason"], "unreachable");
    let listed = send(&s.state, Method::GET, "/mail-accounts", Some(&s.user), None).await;
    let kept = listed.json()["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|account| account["id"] == keyed.as_str())
        .unwrap()["last_check_at"]
        .clone();
    assert_eq!(kept, checked_at);

    // Without quotas for the account: fine, without storage.
    let partial = Server::start(Options {
        quota_unsupported: true,
        ..Options::default()
    })
    .await;
    let partial_server = register(&s, &partial.url, None).await;
    let other = add(
        &s,
        &s.user,
        token(&partial_server, "eva@example.com", OTHER_TOKEN),
    )
    .await;
    let other = other.json()["id"].as_str().unwrap().to_owned();
    let without = check(&s, &s.user, &other).await;
    assert_eq!(without.status, StatusCode::OK, "{}", without.body);
    assert_eq!(without.json()["quota_total"], Value::Null);

    // Forced refresh shares the limit with `GET …/token?refresh=true` (own user
    // and server, so that the rest of the test does not feel it).
    let strict = Server::start(Options::default()).await;
    let strict_server = register(&s, &strict.url, Some(CLIENT_ID)).await;
    let erika = login(&s.state, "erika", Role::User).await;
    let erikas = oauth_account(&s, &erika, &strict_server).await;
    for _ in 0..10 {
        access_token(&get_token(&s, &erika, &erikas, true).await);
    }
    let refreshes = strict.token_requests().len();
    strict.forget_access_tokens();
    let limited = check(&s, &erika, &erikas).await;
    assert_eq!(limited.status, StatusCode::BAD_GATEWAY, "{}", limited.body);
    assert_eq!(limited.json()["reason"], "auth_failed");
    assert_eq!(strict.token_requests().len(), refreshes);

    // Grant revoked: "sign-in required" as with `GET …/token`.
    fake.revoke_refresh_tokens();
    let lost = check(&s, &s.user, &id).await;
    assert_eq!(lost.status, StatusCode::CONFLICT, "{}", lost.body);
    assert_eq!(lost.json()["error"], "needs_reauth");
    assert_eq!(account_state(&s, &id).await, "needs_reauth");
}

/// "Sign in again" revokes the previous grant – not when the
/// browser sends the same refresh token again.
#[tokio::test]
async fn reauth_revokes_the_previous_grant() {
    let fake = Server::start(Options {
        client_secret: Some(CLIENT_SECRET),
        ..Options::default()
    })
    .await;
    let s = setup().await;
    let server = register_confidential(&s, &fake.url).await;
    let created = add(&s, &s.user, code(&server, CODE)).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let id = created.json()["id"].as_str().unwrap().to_owned();
    let previous = stored_secret(&s.state, &id).await;

    let body = json!({ "code": fake.new_code(), "code_verifier": VERIFIER });
    let done = reauth(&s, &s.user, &id, body).await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.body);
    let current = stored_secret(&s.state, &id).await;
    assert_ne!(current, previous);
    let revoked = revocations(&fake, 1).await;
    assert_eq!(revoked[0].form["token"], previous);
    assert_eq!(revoked[0].authorization.as_deref(), Some(basic().as_str()));
    assert!(!fake.grant_exists(&previous));
    assert!(fake.refresh_valid(&current));
    expire(&s.state, &id, -1).await;
    access_token(&get_token(&s, &s.user, &id, false).await);

    let public = Server::start(Options::default()).await;
    let public_server = register(&s, &public.url, Some(CLIENT_ID)).await;
    let id = oauth_account(&s, &s.user, &public_server).await;
    let same = json!({ "access_token": MAIL_TOKEN, "refresh_token": REFRESH, "expires_in": 3600 });
    let again = reauth(&s, &s.user, &id, same).await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.body);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(public.revocations().is_empty());
    assert!(public.grant_exists(REFRESH));
}

async fn delete_me(s: &Setup, session: &str, confirm: &str) -> Reply {
    send(
        &s.state,
        Method::DELETE,
        "/auth/me",
        Some(session),
        Some(json!({ "confirm": confirm })),
    )
    .await
}

async fn user_id(s: &Setup, session: &str) -> String {
    let me = send(&s.state, Method::GET, "/auth/me", Some(session), None).await;
    me.json()["id"].as_str().unwrap().to_owned()
}

/// The user's rows in the tables that depend on them.
async fn rows_of(state: &AppState, user_id: &str) -> Vec<(&'static str, i64)> {
    let user_id = user_id.to_owned();
    db::call(&state.db, move |conn| {
        let mut counts = Vec::new();
        for table in [
            "users",
            "sessions",
            "known_devices",
            "mail_accounts",
            "tags",
            "user_settings",
            "notifications",
        ] {
            let column = if table == "users" { "id" } else { "user_id" };
            let count: i64 = conn.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE {column} = ?1"),
                [&user_id],
                |row| row.get(0),
            )?;
            counts.push((table, count));
        }
        Ok(counts)
    })
    .await
    .unwrap()
}

/// If an administrator removes users – singly or in the selection – the token
/// broker then revokes the grants of their mail accounts as with "delete
/// account".
#[tokio::test]
async fn removing_users_revokes_the_grants_of_their_accounts() {
    let fake = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let with_refresh = |refresh: &str| {
        let mut body = oauth(&server, MAIL_USER, MAIL_TOKEN);
        body["refresh_token"] = json!(refresh);
        body
    };
    let max = user_id(&s, &s.user).await;
    let eva = login(&s.state, "eva", Role::User).await;
    let lea = login(&s.state, "lea", Role::User).await;
    for (session, refresh) in [
        (&s.user, "refresh-max"),
        (&eva, "refresh-eva"),
        (&lea, "refresh-lea"),
    ] {
        let created = add(&s, session, with_refresh(refresh)).await;
        assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    }
    let (eva, lea) = (user_id(&s, &eva).await, user_id(&s, &lea).await);

    let removed = send(
        &s.state,
        Method::DELETE,
        &format!("/users/{max}"),
        Some(&s.admin),
        None,
    )
    .await;
    assert_eq!(removed.status, StatusCode::NO_CONTENT, "{}", removed.body);
    let revoked = revocations(&fake, 1).await;
    assert_eq!(revoked[0].form["token"], "refresh-max");
    assert_eq!(revoked[0].form["token_type_hint"], "refresh_token");

    // In the selection with the own account, which stays.
    let admin = user_id(&s, &s.admin).await;
    let bulk = send(
        &s.state,
        Method::POST,
        "/users/bulk",
        Some(&s.admin),
        Some(json!({ "action": "remove", "ids": [&eva, &lea, &admin] })),
    )
    .await;
    assert_eq!(bulk.status, StatusCode::OK, "{}", bulk.body);
    let mut changed: Vec<String> = serde_json::from_value(bulk.json()["changed"].clone()).unwrap();
    changed.sort();
    let mut expected = vec![eva, lea];
    expected.sort();
    assert_eq!(changed, expected);
    let revoked = revocations(&fake, 3).await;
    let mut tokens: Vec<&str> = revoked[1..]
        .iter()
        .map(|revoked| revoked.form["token"].as_str())
        .collect();
    tokens.sort_unstable();
    assert_eq!(tokens, ["refresh-eva", "refresh-lea"]);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(fake.revocations().len(), 3);
}

/// "Delete account": only with the confirmation word, removes
/// the user with everything that depends on them, signs out, revokes the
/// grants of their mail accounts and is logged in the audit log.
#[tokio::test]
async fn deleting_the_app_account_removes_everything_and_revokes_grants() {
    let fake = Server::start(Options::default()).await;
    let s = setup().await;
    let server = register(&s, &fake.url, Some(CLIENT_ID)).await;
    let id = oauth_account(&s, &s.user, &server).await;
    let keyed = add(&s, &s.user, token(&server, "eva@example.com", OTHER_TOKEN)).await;
    assert_eq!(keyed.status, StatusCode::CREATED, "{}", keyed.body);
    let tag = send(
        &s.state,
        Method::POST,
        "/tags",
        Some(&s.user),
        Some(json!({ "name": "Important" })),
    )
    .await;
    assert_eq!(tag.status, StatusCode::CREATED, "{}", tag.body);
    let max = user_id(&s, &s.user).await;
    // A notification and a second session.
    let owner = max.clone();
    db::call(&s.state.db, move |conn| {
        conn.execute(
            "INSERT INTO notifications (id, user_id, topic, kind) \
             VALUES ('n1', ?1, 'account', 'account.welcome')",
            [&owner],
        )?;
        session::start(conn, &owner, &Client::default(), false)?;
        Ok(())
    })
    .await
    .unwrap();
    let before = rows_of(&s.state, &max).await;
    assert!(
        before
            .iter()
            .all(|(table, count)| *count > 0 || *table == "known_devices"),
        "{before:?}"
    );

    for wrong in ["remove", "", "DELETE"] {
        assert_eq!(
            delete_me(&s, &s.user, wrong).await.field("confirm"),
            "invalid"
        );
    }
    let missing = send(
        &s.state,
        Method::DELETE,
        "/auth/me",
        Some(&s.user),
        Some(json!({})),
    )
    .await;
    assert_eq!(missing.status, StatusCode::BAD_REQUEST);
    assert!(
        rows_of(&s.state, &max)
            .await
            .iter()
            .any(|(_, count)| *count > 0)
    );

    let deleted = delete_me(&s, &s.user, "delete").await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.body);
    assert!(
        rows_of(&s.state, &max)
            .await
            .iter()
            .all(|(_, count)| *count == 0),
        "{:?}",
        rows_of(&s.state, &max).await
    );
    let me = send(&s.state, Method::GET, "/auth/me", Some(&s.user), None).await;
    assert_eq!(me.status, StatusCode::UNAUTHORIZED);
    // Only the account with sign-in at the mail server has a grant.
    let revoked = revocations(&fake, 1).await;
    assert_eq!(revoked[0].form["token"], REFRESH);
    assert!(!fake.grant_exists(REFRESH));
    assert_eq!(
        get_token(&s, &s.admin, &id, false).await.status,
        StatusCode::NOT_FOUND
    );

    let logged = db::call(&s.state.db, move |conn| {
        Ok(conn.query_row(
            "SELECT category, actor_id, actor_name, target, details FROM audit_log \
             WHERE action = 'users.delete_self'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )?)
    })
    .await
    .unwrap();
    assert_eq!(logged.0, "users");
    assert_eq!(logged.1, None);
    assert_eq!(logged.2.as_deref(), Some("Erika Muster"));
    assert_eq!(logged.3.as_deref(), Some(max.as_str()));
    let details: Value = serde_json::from_str(&logged.4).unwrap();
    assert_eq!(
        details,
        json!({ "name": "Erika Muster", "email": "max@example.com", "role": "user" })
    );
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(fake.revocations().len(), 1);
}

/// The only active administrator cannot delete their account (409
/// `last_admin`); locked administrators do not count.
#[tokio::test]
async fn the_last_admin_cannot_delete_the_account() {
    let s = setup().await;
    let refused = delete_me(&s, &s.admin, "delete").await;
    assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.body);
    assert_eq!(refused.json()["error"], "last_admin");

    let max = user_id(&s, &s.user).await;
    let set = |sql: &'static str| {
        let (state, max) = (s.state.clone(), max.clone());
        async move {
            db::call(&state.db, move |conn| Ok(conn.execute(sql, [&max])?))
                .await
                .unwrap()
        }
    };
    set("UPDATE users SET role = 'admin', status = 'locked' WHERE id = ?1").await;
    let still = delete_me(&s, &s.admin, "delete").await;
    assert_eq!(still.json()["error"], "last_admin");
    set("UPDATE users SET status = 'active' WHERE id = ?1").await;
    let done = delete_me(&s, &s.admin, "delete").await;
    assert_eq!(done.status, StatusCode::NO_CONTENT, "{}", done.body);
    let refused = delete_me(&s, &s.user, "delete").await;
    assert_eq!(refused.json()["error"], "last_admin");
}

/// "Delete local data": only an entry in the audit log.
#[tokio::test]
async fn local_reset_is_only_logged() {
    let s = setup().await;
    let reset = send(
        &s.state,
        Method::POST,
        "/settings/local-reset",
        Some(&s.user),
        None,
    )
    .await;
    assert_eq!(reset.status, StatusCode::NO_CONTENT, "{}", reset.body);
    let anonymous = send(&s.state, Method::POST, "/settings/local-reset", None, None).await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
    // At most ten entries in ten minutes.
    for _ in 0..9 {
        let again = send(
            &s.state,
            Method::POST,
            "/settings/local-reset",
            Some(&s.user),
            None,
        )
        .await;
        assert_eq!(again.status, StatusCode::NO_CONTENT);
    }
    let limited = send(
        &s.state,
        Method::POST,
        "/settings/local-reset",
        Some(&s.user),
        None,
    )
    .await;
    assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
    let max = user_id(&s, &s.user).await;
    let logged = db::call(&s.state.db, move |conn| {
        Ok(conn.query_row(
            "SELECT category, actor_id, ip FROM audit_log WHERE action = 'settings.local_reset'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )?)
    })
    .await
    .unwrap();
    assert_eq!(
        logged,
        ("settings".into(), Some(max), Some("203.0.113.9".into()))
    );
}
