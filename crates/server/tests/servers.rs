//! Mail server registry via the API (without network apart from the local
//! test server `fake_stalwart`): permissions, maintenance with checks,
//! secret, diagnostics, DCR, audit log, CSP and other security headers.

mod fake_stalwart;

use std::{fs, net::SocketAddr, sync::Arc};

use axum::{
    Router,
    body::Body,
    extract::connect_info::MockConnectInfo,
    http::{HeaderMap, Method, Request, StatusCode, header},
};
use fake_stalwart::{
    ADMIN, ADMIN_PASSWORD, CLIENT_ID, CLIENT_SECRET, Options, RETRY_AFTER, Server,
};
use http_body_util::BodyExt as _;
use roedy_mail_server::{
    api,
    app::{AppState, router},
    auth::session::{self, Client},
    broker::crypto::SecretKey,
    config::{Config, TrustProxy},
    db::{
        self, Db,
        repo::{
            servers::SECRET_PURPOSE,
            users::{self, NewUser, Role},
        },
    },
    mailer::system_mail::{self, SystemMail},
    web::static_files::WebAssets,
};
use serde_json::{Value, json};
use tower::ServiceExt as _;
use url::Url;

const APP: &str = "https://app.example.com";

struct Setup {
    _tmp: tempfile::TempDir,
    state: AppState,
    admin: String,
    user: String,
}

async fn setup_with(config: Config, web: WebAssets) -> Setup {
    let tmp = tempfile::tempdir().unwrap();
    let db = Db::from(db::open(tmp.path()).unwrap());
    let state = state(db, &config, web, APP);
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

async fn setup() -> Setup {
    setup_with(Config::default(), WebAssets::None).await
}

/// App state on `db` with `public_url` as the app's address.
fn state(db: Db, config: &Config, web: WebAssets, public_url: &str) -> AppState {
    AppState::new(
        db,
        Arc::new(web),
        config,
        Url::parse(public_url).unwrap(),
        SecretKey::random().unwrap(),
    )
    .unwrap()
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
    headers: HeaderMap,
    body: String,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", self.body))
    }

    fn csp(&self) -> &str {
        self.headers[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
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
        .uri(path)
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
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    Reply {
        status,
        headers,
        body: String::from_utf8(bytes.to_vec()).unwrap(),
    }
}

/// The stored client secret of the server `id`, decrypted.
async fn stored_secret(state: &AppState, id: &str) -> Option<String> {
    let lookup = id.to_owned();
    let sealed: Option<Vec<u8>> = db::call(&state.db, move |conn| {
        Ok(conn.query_row(
            "SELECT oauth_client_secret_enc FROM servers WHERE id = ?1",
            [lookup],
            |r| r.get(0),
        )?)
    })
    .await
    .unwrap();
    sealed.map(|sealed| {
        String::from_utf8(state.secrets.open(SECRET_PURPOSE, id, &sealed).unwrap()).unwrap()
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

fn vps1() -> Value {
    json!({
        "label": "VPS 1",
        "url": "https://mail.s1.test/",
        "domains": ["@S1.test", "example.com"],
        "client_id": "roedy-abc123",
        "client_secret": "very-secret",
    })
}

#[tokio::test]
async fn only_admins_change_the_registry() {
    let s = setup().await;
    let admin_routes = [
        (Method::GET, "/api/v1/admin/servers"),
        (Method::POST, "/api/v1/admin/servers"),
        (Method::GET, "/api/v1/admin/servers/x"),
        (Method::PATCH, "/api/v1/admin/servers/x"),
        (Method::DELETE, "/api/v1/admin/servers/x"),
        (Method::POST, "/api/v1/admin/servers/x/test"),
        (Method::POST, "/api/v1/admin/servers/register-client"),
        (Method::GET, "/api/v1/admin/servers/policy"),
        (Method::PUT, "/api/v1/admin/servers/policy"),
    ];
    for (method, path) in admin_routes {
        let reply = send(&s.state, method.clone(), path, None, None).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{method} {path}");
        let reply = send(&s.state, method.clone(), path, Some(&s.user), None).await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN, "{method} {path}");
        assert_eq!(reply.json(), json!({ "error": "forbidden" }));
    }
    let reply = send(&s.state, Method::GET, "/api/v1/servers", None, None).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    let reply = send(
        &s.state,
        Method::GET,
        "/api/v1/servers",
        Some(&s.user),
        None,
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply.json(),
        json!({ "servers": [], "allow_custom_servers": false })
    );
}

#[tokio::test]
async fn maintains_servers_with_secret_audit_and_csp() {
    let s = setup().await;
    let reply = send(&s.state, Method::GET, "/healthz", None, None).await;
    assert!(
        reply.csp().contains("connect-src 'self';"),
        "{}",
        reply.csp()
    );

    let reply = send(
        &s.state,
        Method::POST,
        "/api/v1/admin/servers",
        Some(&s.admin),
        Some(vps1()),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let created = reply.json();
    let id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(
        created,
        json!({
            "id": id,
            "label": "VPS 1",
            "url": "https://mail.s1.test",
            "host": "mail.s1.test",
            "domains": ["s1.test", "example.com"],
            "client_id": "roedy-abc123",
            "has_secret": true,
            "reach": "unk",
            "cors": "unk",
            "oauth": "unk",
            "tested_at": null,
            "accounts": 0,
        })
    );
    assert!(!reply.body.contains("very-secret"));
    // The CSP follows the registry.
    assert!(
        reply
            .csp()
            .contains("connect-src 'self' https://mail.s1.test;"),
        "{}",
        reply.csp()
    );

    // The secret is stored encrypted and bound to the row in the database.
    let lookup = id.clone();
    let sealed: Vec<u8> = db::call(&s.state.db, move |conn| {
        Ok(conn.query_row(
            "SELECT oauth_client_secret_enc FROM servers WHERE id = ?1",
            [lookup],
            |r| r.get(0),
        )?)
    })
    .await
    .unwrap();
    assert!(!String::from_utf8_lossy(&sealed).contains("very-secret"));
    assert_eq!(
        s.state.secrets.open(SECRET_PURPOSE, &id, &sealed).unwrap(),
        b"very-secret"
    );
    assert!(
        s.state
            .secrets
            .open(SECRET_PURPOSE, "other-id", &sealed)
            .is_err()
    );

    // Users see the server without secret.
    let reply = send(
        &s.state,
        Method::GET,
        "/api/v1/servers",
        Some(&s.user),
        None,
    )
    .await;
    let list = reply.json();
    assert_eq!(list["servers"][0]["client_id"], "roedy-abc123");
    assert!(list["servers"][0].get("has_secret").is_none());
    let reply = send(
        &s.state,
        Method::GET,
        "/api/v1/admin/servers",
        Some(&s.admin),
        None,
    )
    .await;
    assert_eq!(
        reply.json()["redirect_uri"],
        "https://app.example.com/oauth/callback"
    );
    assert_eq!(reply.json()["servers"][0]["id"], id.as_str());
    let path = format!("/api/v1/admin/servers/{id}");
    let reply = send(&s.state, Method::GET, &path, Some(&s.admin), None).await;
    assert_eq!(reply.json(), created);

    // Field checks.
    let reply = send(
        &s.state,
        Method::POST,
        "/api/v1/admin/servers",
        Some(&s.admin),
        Some(json!({ "label": " ", "url": "https://MAIL.s1.test", "domains": ["s1.test", "x"] })),
    )
    .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        reply.json(),
        json!({
            "error": "invalid",
            "fields": {
                "label": { "code": "required" },
                "url": { "code": "taken", "server": "VPS 1" },
                "domains": { "code": "invalid", "domain": "x" },
            }
        })
    );
    let reply = send(
        &s.state,
        Method::POST,
        "/api/v1/admin/servers",
        Some(&s.admin),
        Some(json!({ "label": "VPS 2", "url": "http://mail.s2.test", "domains": ["example.com"], "client_secret": "x" })),
    )
    .await;
    assert_eq!(
        reply.json()["fields"],
        json!({
            "url": { "code": "invalid" },
            "domains": { "code": "taken", "domain": "example.com", "server": "VPS 1" },
        })
    );
    let reply = send(
        &s.state,
        Method::POST,
        "/api/v1/admin/servers",
        Some(&s.admin),
        Some(json!({ "label": "VPS 2", "url": "https://mail.s2.test", "client_secret": "x" })),
    )
    .await;
    assert_eq!(
        reply.json()["fields"],
        json!({ "client_secret": { "code": "needs_client_id" } })
    );
    let reply = send(
        &s.state,
        Method::POST,
        "/api/v1/admin/servers",
        Some(&s.admin),
        Some(json!({ "label": "VPS 2", "url": "https://mail.s2.test", "unknown": 1 })),
    )
    .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.json()["error"], "bad_request");

    // Partial changes: the secret stays on an empty value, `null` removes it.
    let reply = send(
        &s.state,
        Method::PATCH,
        &path,
        Some(&s.admin),
        Some(json!({ "label": "VPS One", "client_secret": "" })),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(
        (
            reply.json()["label"].as_str(),
            reply.json()["has_secret"].as_bool()
        ),
        (Some("VPS One"), Some(true))
    );
    let reply = send(
        &s.state,
        Method::PATCH,
        &path,
        Some(&s.admin),
        Some(json!({ "client_secret": null })),
    )
    .await;
    assert_eq!(reply.json()["has_secret"], false);
    assert_eq!(reply.json()["client_id"], "roedy-abc123");
    let reply = send(
        &s.state,
        Method::PATCH,
        &path,
        Some(&s.admin),
        Some(json!({ "client_secret": "new" })),
    )
    .await;
    assert_eq!(reply.json()["has_secret"], true);
    // The secret belongs to the old client, not to a new one (e.g. via DCR).
    let reply = send(
        &s.state,
        Method::PATCH,
        &path,
        Some(&s.admin),
        Some(json!({ "client_id": "roedy-new" })),
    )
    .await;
    assert_eq!(reply.json()["client_id"], "roedy-new");
    assert_eq!(reply.json()["has_secret"], false);
    // Nor to a new URL: it would otherwise go via Basic to that server's token
    // endpoint.
    let reply = send(
        &s.state,
        Method::PATCH,
        &path,
        Some(&s.admin),
        Some(json!({ "client_secret": "new" })),
    )
    .await;
    assert_eq!(reply.json()["has_secret"], true);
    let reply = send(
        &s.state,
        Method::PATCH,
        &path,
        Some(&s.admin),
        Some(json!({ "url": "https://other.s1.test" })),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.json()["has_secret"], false);
    // Without a client ID no secret.
    let reply = send(
        &s.state,
        Method::PATCH,
        &path,
        Some(&s.admin),
        Some(json!({ "client_id": null })),
    )
    .await;
    assert_eq!(
        (
            reply.json()["client_id"].clone(),
            reply.json()["has_secret"].clone()
        ),
        (Value::Null, json!(false))
    );
    let reply = send(
        &s.state,
        Method::PATCH,
        &path,
        Some(&s.admin),
        Some(json!({ "url": "https://new.s1.test" })),
    )
    .await;
    assert_eq!(reply.json()["url"], "https://new.s1.test");
    assert!(
        reply
            .csp()
            .contains("connect-src 'self' https://new.s1.test;"),
        "{}",
        reply.csp()
    );
    let reply = send(
        &s.state,
        Method::PATCH,
        "/api/v1/admin/servers/missing",
        Some(&s.admin),
        Some(json!({ "label": "x" })),
    )
    .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);

    let reply = send(&s.state, Method::DELETE, &path, Some(&s.admin), None).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert!(
        reply.csp().contains("connect-src 'self';"),
        "{}",
        reply.csp()
    );
    let reply = send(&s.state, Method::DELETE, &path, Some(&s.admin), None).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);

    let entries = audit(&s.state).await;
    let actions: Vec<&str> = entries.iter().map(|(_, a, _)| a.as_str()).collect();
    assert_eq!(
        actions,
        [
            "servers.create",
            "servers.update",
            "servers.update",
            "servers.update",
            "servers.update",
            "servers.update",
            "servers.update",
            "servers.update",
            "servers.update",
            "servers.delete"
        ]
    );
    assert!(
        entries
            .iter()
            .all(|(c, _, n)| c == "system" && n == "Erika Muster")
    );
}

#[tokio::test]
async fn policy_opens_connect_src() {
    let s = setup().await;
    let path = "/api/v1/admin/servers/policy";
    let reply = send(&s.state, Method::GET, path, Some(&s.admin), None).await;
    assert_eq!(reply.json(), json!({ "allow_custom_servers": false }));

    let reply = send(
        &s.state,
        Method::PUT,
        path,
        Some(&s.admin),
        Some(json!({ "allow_custom_servers": true })),
    )
    .await;
    assert_eq!(reply.json(), json!({ "allow_custom_servers": true }));
    assert!(
        reply.csp().contains("connect-src 'self' https:;"),
        "{}",
        reply.csp()
    );
    let reply = send(
        &s.state,
        Method::GET,
        "/api/v1/servers",
        Some(&s.user),
        None,
    )
    .await;
    assert_eq!(reply.json()["allow_custom_servers"], true);
    // `https:` does not cover `http://` servers of the registry (development).
    create(&s, "http://localhost:8080", None).await;
    create(&s, "https://mail.s1.test", None).await;
    let reply = send(&s.state, Method::GET, "/healthz", None, None).await;
    assert!(
        reply
            .csp()
            .contains("connect-src 'self' https: http://localhost:8080;"),
        "{}",
        reply.csp()
    );

    // Saving unchanged does not write to the audit log a second time.
    send(
        &s.state,
        Method::PUT,
        path,
        Some(&s.admin),
        Some(json!({ "allow_custom_servers": true })),
    )
    .await;
    let reply = send(
        &s.state,
        Method::PUT,
        path,
        Some(&s.admin),
        Some(json!({ "allow_custom_servers": false })),
    )
    .await;
    assert!(
        reply
            .csp()
            .contains("connect-src 'self' http://localhost:8080 https://mail.s1.test;"),
        "{}",
        reply.csp()
    );
    let actions: Vec<_> = audit(&s.state)
        .await
        .into_iter()
        .filter(|(c, _, _)| c == "settings")
        .map(|(_, a, _)| a)
        .collect();
    assert_eq!(actions, ["servers.policy", "servers.policy"]);
}

#[tokio::test]
async fn list_names_the_server_of_the_system_mail() {
    let s = setup().await;
    let first = create(&s, "https://mail.s1.test", None).await;
    let second = create(&s, "https://mail.s2.test", None).await;
    let list = async |s: &Setup| {
        send(
            &s.state,
            Method::GET,
            "/api/v1/admin/servers",
            Some(&s.admin),
            None,
        )
        .await
        .json()
    };
    assert_eq!(list(&s).await["system_mail_server"], Value::Null);

    let secrets = s.state.secrets.clone();
    let id = second.clone();
    db::call(&s.state.db, move |conn| {
        let mail = SystemMail::new(&secrets, &id, "noreply", "kT9v", None)?;
        system_mail::save(conn, &mail)
    })
    .await
    .unwrap();
    assert_eq!(list(&s).await["system_mail_server"], second.as_str());

    // An unreadable sending account only costs the hint, not the list.
    db::call(&s.state.db, |conn| {
        conn.execute(
            "UPDATE app_settings SET json = '\"broken\"' WHERE key = 'system_mail'",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let body = list(&s).await;
    assert_eq!(body["system_mail_server"], Value::Null);
    assert_eq!(body["servers"].as_array().map(Vec::len), Some(2));
    let secrets = s.state.secrets.clone();
    let id = second.clone();
    db::call(&s.state.db, move |conn| {
        let mail = SystemMail::new(&secrets, &id, "noreply", "kT9v", None)?;
        system_mail::save(conn, &mail)
    })
    .await
    .unwrap();

    // Removed: no longer named (system mail then counts as not set up).
    let path = format!("/api/v1/admin/servers/{second}");
    let reply = send(&s.state, Method::DELETE, &path, Some(&s.admin), None).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    let body = list(&s).await;
    assert_eq!(body["system_mail_server"], Value::Null);
    assert_eq!(body["servers"][0]["id"], first.as_str());
}

async fn create(s: &Setup, url: &str, client_id: Option<&str>) -> String {
    let reply = send(
        &s.state,
        Method::POST,
        "/api/v1/admin/servers",
        Some(&s.admin),
        Some(json!({ "label": "Test", "url": url, "client_id": client_id })),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    reply.json()["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn test_records_diagnosis() {
    let s = setup().await;
    let fake = Server::start(Options::default()).await;
    let id = create(&s, &fake.url, Some(CLIENT_ID)).await;
    let reply = send(
        &s.state,
        Method::POST,
        &format!("/api/v1/admin/servers/{id}/test"),
        Some(&s.admin),
        None,
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let result = reply.json();
    assert_eq!(
        (
            &result["server"]["reach"],
            &result["server"]["cors"],
            &result["server"]["oauth"]
        ),
        (&json!("ok"), &json!("ok"), &json!("ok"))
    );
    assert!(result["server"]["tested_at"].is_string());
    assert_eq!(result["reasons"], json!({}));

    // CORS missing, OAuth client missing.
    let fake = Server::start(Options {
        cors: false,
        ..Options::default()
    })
    .await;
    let id = create(&s, &fake.url, None).await;
    let reply = send(
        &s.state,
        Method::POST,
        &format!("/api/v1/admin/servers/{id}/test"),
        Some(&s.admin),
        None,
    )
    .await;
    let result = reply.json();
    assert_eq!(
        (
            &result["server"]["reach"],
            &result["server"]["cors"],
            &result["server"]["oauth"]
        ),
        (&json!("ok"), &json!("err"), &json!("err"))
    );
    assert_eq!(
        result["reasons"],
        json!({ "cors": "origin_not_allowed", "oauth": "no_client_id" })
    );

    // A new URL discards the old result.
    let reply = send(
        &s.state,
        Method::PATCH,
        &format!("/api/v1/admin/servers/{id}"),
        Some(&s.admin),
        Some(json!({ "url": fake_stalwart::unreachable_url() })),
    )
    .await;
    assert_eq!(
        (&reply.json()["reach"], &reply.json()["tested_at"]),
        (&json!("unk"), &Value::Null)
    );
    let reply = send(
        &s.state,
        Method::POST,
        &format!("/api/v1/admin/servers/{id}/test"),
        Some(&s.admin),
        None,
    )
    .await;
    assert_eq!(
        (
            &reply.json()["server"]["reach"],
            &reply.json()["server"]["cors"]
        ),
        (&json!("err"), &json!("unk"))
    );

    let reply = send(
        &s.state,
        Method::POST,
        "/api/v1/admin/servers/missing/test",
        Some(&s.admin),
        None,
    )
    .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn registers_client_via_dcr() {
    let s = setup().await;
    let fake = Server::start(Options::default()).await;
    let path = "/api/v1/admin/servers/register-client";
    let reply = send(
        &s.state,
        Method::POST,
        path,
        Some(&s.admin),
        Some(json!({ "url": fake.url, "username": ADMIN, "password": ADMIN_PASSWORD })),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    // The secret stays in the backend.
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
    assert_eq!(
        fake.registrations()[0]["token_endpoint_auth_method"],
        "client_secret_basic"
    );
    assert_eq!(
        audit(&s.state).await,
        [(
            "system".into(),
            "servers.register_client".into(),
            "Erika Muster".into()
        )]
    );

    let reply = send(
        &s.state,
        Method::POST,
        path,
        Some(&s.admin),
        Some(json!({ "url": "mail.s1.test", "username": " ", "password": "" })),
    )
    .await;
    assert_eq!(
        reply.json(),
        json!({
            "error": "invalid",
            "fields": {
                "url": { "code": "invalid" },
                "username": { "code": "required" },
                "password": { "code": "required" },
            }
        })
    );

    // Wrong password: rejected, locked after five attempts (the mail server's
    // Fail2Ban would otherwise hit the backend's address).
    for _ in 0..5 {
        let reply = send(
            &s.state,
            Method::POST,
            path,
            Some(&s.admin),
            Some(json!({ "url": fake.url, "username": ADMIN, "password": "incorrect" })),
        )
        .await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            reply.json(),
            json!({ "error": "registration_failed", "reason": "auth_failed" })
        );
    }
    let reply = send(
        &s.state,
        Method::POST,
        path,
        Some(&s.admin),
        Some(json!({ "url": fake.url, "username": ADMIN, "password": ADMIN_PASSWORD })),
    )
    .await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn registered_secret_goes_to_the_saved_server() {
    let s = setup().await;
    let fake = Server::start(Options::default()).await;
    let register = || {
        send(
            &s.state,
            Method::POST,
            "/api/v1/admin/servers/register-client",
            Some(&s.admin),
            Some(json!({ "url": fake.url, "username": ADMIN, "password": ADMIN_PASSWORD })),
        )
    };
    assert_eq!(register().await.status, StatusCode::OK);

    // "Add" with the client ID takes over the secret, once.
    let id = create(&s, &fake.url, Some(CLIENT_ID)).await;
    assert_eq!(
        stored_secret(&s.state, &id).await.as_deref(),
        Some(CLIENT_SECRET)
    );
    let reply = send(
        &s.state,
        Method::GET,
        &format!("/api/v1/admin/servers/{id}"),
        Some(&s.admin),
        None,
    )
    .await;
    assert_eq!(reply.json()["has_secret"], true);
    let reply = send(
        &s.state,
        Method::GET,
        "/api/v1/servers",
        Some(&s.user),
        None,
    )
    .await;
    assert_eq!(reply.json()["servers"][0]["backend_exchange"], true);
    assert!(!reply.body.contains(CLIENT_SECRET));
    let other = send(
        &s.state,
        Method::POST,
        "/api/v1/admin/servers",
        Some(&s.admin),
        Some(json!({ "label": "B", "url": "https://mail.s2.test", "client_id": CLIENT_ID })),
    )
    .await;
    assert_eq!(other.status, StatusCode::CREATED, "{}", other.body);
    let other = other.json()["id"].as_str().unwrap().to_owned();
    assert_eq!(stored_secret(&s.state, &other).await, None);

    // "Save": a new client ID without a secret removes the old one …
    let path = format!("/api/v1/admin/servers/{id}");
    let patch = |body: Value| send(&s.state, Method::PATCH, &path, Some(&s.admin), Some(body));
    let reply = patch(json!({ "client_id": "by-hand" })).await;
    assert_eq!(reply.json()["has_secret"], false, "{}", reply.body);
    // … unless it comes from a registration.
    assert_eq!(register().await.status, StatusCode::OK);
    let reply = patch(json!({ "client_id": CLIENT_ID })).await;
    assert_eq!(reply.json()["has_secret"], true, "{}", reply.body);
    assert_eq!(
        stored_secret(&s.state, &id).await.as_deref(),
        Some(CLIENT_SECRET)
    );

    // An entered secret takes precedence; the registration is gone afterwards.
    assert_eq!(register().await.status, StatusCode::OK);
    patch(json!({ "client_id": "by-hand" })).await;
    let reply = patch(json!({ "client_id": CLIENT_ID, "client_secret": "own" })).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(stored_secret(&s.state, &id).await.as_deref(), Some("own"));
    patch(json!({ "client_id": "by-hand" })).await;
    patch(json!({ "client_id": CLIENT_ID })).await;
    assert_eq!(stored_secret(&s.state, &id).await, None);

    // By hand: confidential (ID and secret) or public (ID only).
    let reply = patch(json!({ "client_id": "confidential", "client_secret": "s3cret" })).await;
    assert_eq!(reply.json()["has_secret"], true);
    let reply = patch(json!({ "client_id": "public" })).await;
    assert_eq!(reply.json()["has_secret"], false);
}

#[tokio::test]
async fn registered_client_only_fits_its_redirect_uri() {
    // Public URL changed after the registration (restart with a different
    // `ROEDY_PUBLIC_URL`).
    let s = setup().await;
    let changed = state(
        s.state.db.clone(),
        &Config::default(),
        WebAssets::None,
        "https://new.example.com/",
    );
    changed.load().await.unwrap();
    let fake = Server::start(Options::default()).await;
    let reply = send(
        &s.state,
        Method::POST,
        "/api/v1/admin/servers/register-client",
        Some(&s.admin),
        Some(json!({ "url": fake.url, "username": ADMIN, "password": ADMIN_PASSWORD })),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let reply = send(
        &changed,
        Method::POST,
        "/api/v1/admin/servers",
        Some(&s.admin),
        Some(json!({ "label": "Test", "url": fake.url, "client_id": CLIENT_ID })),
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
        json!({ "client_id": {
            "code": "redirect_mismatch",
            "redirect_uri": "https://app.example.com/oauth/callback",
        } })
    );
    // With the old URL it matches again.
    let id = create(&s, &fake.url, Some(CLIENT_ID)).await;
    assert_eq!(
        stored_secret(&s.state, &id).await.as_deref(),
        Some(CLIENT_SECRET)
    );
}

#[tokio::test]
async fn register_client_maps_errors_of_stalwart_v1() {
    let s = setup().await;
    let register = |url: String| {
        send(
            &s.state,
            Method::POST,
            "/api/v1/admin/servers/register-client",
            Some(&s.admin),
            Some(json!({ "url": url, "username": ADMIN, "password": ADMIN_PASSWORD })),
        )
    };
    for (options, status, reply) in [
        (
            Options {
                register_status: Some(StatusCode::PAYMENT_REQUIRED),
                ..Options::default()
            },
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({ "error": "registration_failed", "reason": "mfa_required" }),
        ),
        (
            Options {
                register_status: Some(StatusCode::FORBIDDEN),
                ..Options::default()
            },
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({ "error": "registration_failed", "reason": "forbidden" }),
        ),
        (
            Options {
                register_status: Some(StatusCode::TOO_MANY_REQUESTS),
                ..Options::default()
            },
            StatusCode::BAD_GATEWAY,
            json!({ "error": "registration_failed", "reason": "throttled", "retry_after": RETRY_AFTER }),
        ),
        (
            Options {
                v016: true,
                ..Options::default()
            },
            StatusCode::BAD_GATEWAY,
            json!({ "error": "registration_failed", "reason": "unsupported_version" }),
        ),
    ] {
        let fake = Server::start(options).await;
        let result = register(fake.url.clone()).await;
        assert_eq!((result.status, result.json()), (status, reply));
        // Only the mail server's response, no 429 from the app.
        assert!(result.headers.get(header::RETRY_AFTER).is_none());
    }
}

#[tokio::test]
async fn test_reports_throttling() {
    let s = setup().await;
    let fake = Server::start(Options {
        throttle_after: Some(0),
        ..Options::default()
    })
    .await;
    let id = create(&s, &fake.url, Some(CLIENT_ID)).await;
    let reply = send(
        &s.state,
        Method::POST,
        &format!("/api/v1/admin/servers/{id}/test"),
        Some(&s.admin),
        None,
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let result = reply.json();
    assert_eq!(
        (
            &result["server"]["reach"],
            &result["server"]["cors"],
            &result["server"]["oauth"]
        ),
        (&json!("unk"), &json!("unk"), &json!("unk"))
    );
    assert_eq!(
        result["reasons"],
        json!({ "reach": "throttled", "cors": "throttled", "oauth": "throttled" })
    );
    assert_eq!(result["retry_after"], RETRY_AFTER);
}

#[tokio::test]
async fn register_client_needs_reachable_server() {
    let s = setup().await;
    let body = json!({ "url": fake_stalwart::unreachable_url(), "username": ADMIN, "password": ADMIN_PASSWORD });
    let reply = send(
        &s.state,
        Method::POST,
        "/api/v1/admin/servers/register-client",
        Some(&s.admin),
        Some(body),
    )
    .await;
    assert_eq!(reply.status, StatusCode::BAD_GATEWAY);
    assert_eq!(
        reply.json(),
        json!({ "error": "registration_failed", "reason": "unreachable" })
    );
}

#[tokio::test]
async fn security_headers_on_every_response() {
    let s = setup().await;
    for path in ["/healthz", "/api/v1/servers", "/api/v1/does-not-exist"] {
        let reply = send(&s.state, Method::GET, path, None, None).await;
        assert_eq!(
            reply.headers[header::REFERRER_POLICY],
            "no-referrer",
            "{path}"
        );
        assert_eq!(
            reply.headers[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff",
            "{path}"
        );
        assert!(
            reply.headers["permissions-policy"]
                .to_str()
                .unwrap()
                .contains("camera=()")
        );
        assert_eq!(
            reply.headers["cross-origin-opener-policy"], "same-origin",
            "{path}"
        );
        assert!(reply.csp().contains("frame-ancestors 'none'"), "{path}");
        assert!(
            reply
                .headers
                .get(header::STRICT_TRANSPORT_SECURITY)
                .is_none(),
            "{path}"
        );
    }

    // HSTS only behind a reverse proxy with TLS.
    let s = setup_with(
        Config {
            trust_proxy: TrustProxy(1),
            ..Config::default()
        },
        WebAssets::None,
    )
    .await;
    let reply = send(&s.state, Method::GET, "/healthz", None, None).await;
    assert_eq!(
        reply.headers[header::STRICT_TRANSPORT_SECURITY],
        "max-age=31536000"
    );
}

#[tokio::test]
async fn csp_allows_inline_bootstrap_of_index() {
    let tmp = tempfile::tempdir().unwrap();
    let script = "\n  import('/_app/start.js').then((kit) => kit.start());\n";
    fs::write(
        tmp.path().join("index.html"),
        format!("<!doctype html><script src=\"/_app/x.js\"></script><div><script>{script}</script></div>"),
    )
    .unwrap();
    let s = setup_with(Config::default(), WebAssets::new(Some(tmp.path())).unwrap()).await;

    use base64::Engine as _;
    use sha2::Digest as _;
    let hash = format!(
        "'sha256-{}'",
        base64::engine::general_purpose::STANDARD.encode(sha2::Sha256::digest(script))
    );
    for path in ["/", "/mailbox/inbox"] {
        let reply = send(&s.state, Method::GET, path, None, None).await;
        assert_eq!(reply.status, StatusCode::OK);
        assert!(
            reply.csp().contains(&format!("script-src 'self' {hash};")),
            "{}",
            reply.csp()
        );
        let etag = reply.headers[header::ETAG].to_str().unwrap().to_owned();

        // The 304 response carries the hash too, otherwise it would replace the
        // CSP of the stored page.
        let request = Request::get(path)
            .header(header::IF_NONE_MATCH, etag)
            .body(Body::empty())
            .unwrap();
        let response = app(&s.state).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        let csp = response.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap();
        assert!(csp.contains(&hash), "{csp}");
    }
    // Other files need no hashes.
    let reply = send(&s.state, Method::GET, "/healthz", None, None).await;
    assert!(
        reply.csp().contains("script-src 'self';"),
        "{}",
        reply.csp()
    );
}
