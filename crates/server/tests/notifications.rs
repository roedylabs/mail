//! Notifications via the API:
//! list with texts and targets from the event catalog, read, remove, team and
//! system only for administrators, and the job `notification_cleanup`.

use std::{net::SocketAddr, sync::Arc};
use url::Url;

use axum::{
    Router,
    body::Body,
    extract::connect_info::MockConnectInfo,
    http::{Method, Request, StatusCode, header},
};
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
            notifications,
            users::{self, NewUser, Role},
        },
    },
    jobs,
    web::static_files::WebAssets,
};
use serde_json::{Value, json};
use tower::ServiceExt as _;

const PASSWORD: &str = "Summer2026!";
const FIREFOX: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

struct Env {
    _tmp: tempfile::TempDir,
    state: AppState,
}

struct Reply {
    status: StatusCode,
    body: String,
    cookie: Option<String>,
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
    Env { _tmp: tmp, state }
}

impl Env {
    async fn add(&self, username: &str, role: Role) -> String {
        let hash = self.state.hasher.hash(PASSWORD).await.unwrap();
        let username = username.to_owned();
        db::call(&self.state.db, move |conn| {
            users::insert(
                conn,
                &NewUser {
                    username: &username,
                    email: &format!("{username}@example.com"),
                    display_name: "Max Mustermann",
                    role,
                    password_hash: &hash,
                },
            )
        })
        .await
        .unwrap()
    }

    async fn notify(&self, user: &str, topic: &'static str, kind: &'static str, params: Value) {
        let user = user.to_owned();
        db::call(&self.state.db, move |conn| {
            notifications::insert(conn, &user, topic, kind, &params)
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
            .header(header::USER_AGENT, FIREFOX);
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
        let prefix = format!("{}=", session::COOKIE);
        let cookie = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .find_map(|c| {
                let value = c.to_str().ok()?.strip_prefix(&prefix)?;
                Some(value.split(';').next()?.to_owned())
            });
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        Reply {
            status,
            body: String::from_utf8(bytes.to_vec()).unwrap(),
            cookie,
        }
    }

    /// Signs in `username`; the first sign-in from this device reports
    /// "New sign-in".
    async fn session(&self, username: &str) -> String {
        let reply = self
            .request(
                Method::POST,
                "/auth/login",
                Some(json!({ "login": username, "password": PASSWORD })),
                None,
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.cookie.unwrap()
    }

    async fn list(&self, session: &str) -> Value {
        let reply = self
            .request(Method::GET, "/notifications", None, Some(session))
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.json()
    }
}

fn titles(list: &Value) -> Vec<&str> {
    list["notifications"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["title"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn lists_texts_and_targets_from_the_catalog() {
    let env = env().await;
    let max = env.add("max", Role::User).await;
    let session = env.session("max").await;
    env.notify(
        &max,
        "account",
        "account.quota",
        json!({ "mail_account_id": "m1", "account": "max@example.com", "percent": 92,
                "used": 4_939_212_390_u64, "limit": 5_368_709_120_u64 }),
    )
    .await;
    env.notify(&max, "security", "security.passkey_add", json!({}))
        .await;

    let list = env.list(&session).await;
    assert_eq!(list["unread"], 3);
    let items = list["notifications"].as_array().unwrap();
    assert_eq!(items.len(), 3);
    // Unknown event: icon and title of the topic, no text, no target.
    assert_eq!(items[0]["kind"], "security.passkey_add");
    assert_eq!(items[0]["icon"], "ti-shield-lock");
    assert_eq!(items[0]["title"], "Security");
    assert_eq!(items[0]["text"], "");
    assert_eq!(items[0]["target"], Value::Null);
    assert_eq!(
        items[1]["text"],
        "max@example.com is 92% full (4.6 GB of 5 GB)."
    );
    assert_eq!(
        items[1]["target"],
        json!({ "view": "mailacct", "page": "overview", "mail_account_id": "m1",
                "path": "/account/mail-accounts/m1/overview" })
    );
    // "New sign-in" from the sign-in above, with a shortened IP address.
    let login = &items[2];
    assert_eq!(login["kind"], "security.login");
    assert_eq!(login["topic"], "security");
    assert_eq!(login["icon"], "ti-device-desktop");
    assert_eq!(login["title"], "New sign-in");
    assert_eq!(
        login["text"],
        "Firefox on Linux, IP address 89.12.x.x. Not you? Sign out the device."
    );
    assert_eq!(
        login["target"],
        json!({ "view": "settings", "page": "security", "path": "/account/security" })
    );
    assert_eq!(login["read_at"], Value::Null);
    assert!(login["created_at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(login.get("params"), None, "details stay in the backend");

    let anonymous = env.request(Method::GET, "/notifications", None, None).await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn team_and_system_only_for_admins() {
    let env = env().await;
    let anna = env.add("anna", Role::Admin).await;
    let max = env.add("max", Role::User).await;
    for user in [&anna, &max] {
        env.notify(
            user,
            "team",
            "team.invite_requested",
            json!({ "invitation_id": "i1", "email": "lea@example.com" }),
        )
        .await;
        env.notify(user, "system", "system.backup_failed", json!({}))
            .await;
        env.notify(user, "news", "news.welcome", json!({})).await;
    }
    let admin = env.session("anna").await;
    let user = env.session("max").await;

    let list = env.list(&admin).await;
    assert_eq!(
        titles(&list),
        [
            "New sign-in",
            "Welcome",
            "Backup failed",
            "New invitation requested"
        ]
    );
    assert_eq!(
        list["notifications"][3]["target"],
        json!({ "view": "admin", "page": "users", "invitation_id": "i1",
                "path": "/admin/users" })
    );
    let list = env.list(&user).await;
    assert_eq!(titles(&list), ["New sign-in", "Welcome"]);
    assert_eq!(list["unread"], 2);

    // Hidden ones can be neither removed nor marked.
    let id = env
        .request(Method::GET, "/notifications", None, Some(&admin))
        .await
        .json()["notifications"][3]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let own_team = db::call(&env.state.db, move |conn| {
        Ok(notifications::list(conn, &max)?
            .into_iter()
            .find(|n| n.topic == "team")
            .unwrap()
            .id)
    })
    .await
    .unwrap();
    let gone = env
        .request(
            Method::DELETE,
            &format!("/notifications/{own_team}"),
            None,
            Some(&user),
        )
        .await;
    assert_eq!(gone.status, StatusCode::NOT_FOUND);
    let foreign = env
        .request(
            Method::DELETE,
            &format!("/notifications/{id}"),
            None,
            Some(&user),
        )
        .await;
    assert_eq!(
        foreign.status,
        StatusCode::NOT_FOUND,
        "other users' do not exist"
    );
    let read = env
        .request(
            Method::POST,
            "/notifications/read",
            Some(json!({ "all": true })),
            Some(&user),
        )
        .await;
    assert_eq!(read.json(), json!({ "unread": 0 }));
    let list = env.list(&admin).await;
    assert_eq!(list["unread"], 4, "another user's stay unread");
}

#[tokio::test]
async fn marks_read_and_removes() {
    let env = env().await;
    let max = env.add("max", Role::User).await;
    let session = env.session("max").await;
    env.notify(&max, "news", "news.welcome", json!({})).await;
    env.notify(
        &max,
        "account",
        "account.profile",
        json!({ "fields": ["name"] }),
    )
    .await;
    let list = env.list(&session).await;
    let id = |i: usize| list["notifications"][i]["id"].as_str().unwrap().to_owned();
    let (profile, welcome, login) = (id(0), id(1), id(2));

    let read = |body: Value| {
        env.request(
            Method::POST,
            "/notifications/read",
            Some(body),
            Some(&session),
        )
    };
    let reply = read(json!({ "ids": [profile, "unknown"] })).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.json(), json!({ "unread": 2 }));
    let list = env.list(&session).await;
    assert!(list["notifications"][0]["read_at"].is_string());
    assert_eq!(list["notifications"][1]["read_at"], Value::Null);

    for (body, field, code) in [
        (json!({}), "ids", "required"),
        (json!({ "ids": [welcome], "all": true }), "all", "conflict"),
        (
            json!({ "ids": vec!["x"; notifications::MAX_PER_USER + 1] }),
            "ids",
            "too_many",
        ),
    ] {
        let reply = read(body).await;
        assert_eq!(
            reply.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{}",
            reply.body
        );
        assert_eq!(
            reply.json()["fields"][field]["code"],
            code,
            "{}",
            reply.body
        );
    }
    let reply = read(json!({ "all": true, "x": 1 })).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);

    let reply = env
        .request(
            Method::DELETE,
            &format!("/notifications/{welcome}"),
            None,
            Some(&session),
        )
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT, "{}", reply.body);
    let again = env
        .request(
            Method::DELETE,
            &format!("/notifications/{welcome}"),
            None,
            Some(&session),
        )
        .await;
    assert_eq!(again.status, StatusCode::NOT_FOUND);
    let list = env.list(&session).await;
    assert_eq!(titles(&list), ["Profile changed", "New sign-in"]);
    assert_eq!(list["notifications"][1]["id"], login);
    assert_eq!(list["unread"], 1);

    let reply = read(json!({ "all": true })).await;
    assert_eq!(reply.json(), json!({ "unread": 0 }));
}

#[tokio::test]
async fn cleanup_job_keeps_the_newest() {
    let env = env().await;
    let max = env.add("max", Role::User).await;
    for _ in 0..notifications::MAX_PER_USER + 2 {
        env.notify(&max, "news", "news.welcome", json!({})).await;
    }
    let old = max.clone();
    db::call(&env.state.db, move |conn| {
        conn.execute(
            "UPDATE notifications SET created_at = '2020-01-01T00:00:00.000Z' \
             WHERE rowid = (SELECT max(rowid) FROM notifications WHERE user_id = ?1)",
            [&old],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    (jobs::notification_cleanup::job().run)(env.state.clone())
        .await
        .unwrap();
    let left = db::call(&env.state.db, move |conn| notifications::list(conn, &max))
        .await
        .unwrap();
    // The old one by age, plus the oldest one above the limit.
    assert_eq!(left.len(), notifications::MAX_PER_USER);
    assert!(left.iter().all(|n| !n.created_at.starts_with("2020")));
}
