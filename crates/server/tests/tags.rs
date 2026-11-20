//! Tags via the API: create, rename, move, order, delete with
//! subtags, links per mail account, links go away with the mail account,
//! other users' accounts and tags rejected.

use std::{net::SocketAddr, sync::Arc};
use url::Url;

use axum::{
    body::Body,
    extract::connect_info::MockConnectInfo,
    http::{Method, Request, StatusCode, header},
};
use http_body_util::BodyExt as _;
use roedy_mail_server::{
    api,
    app::{AppState, router},
    auth::session::{self, Client},
    broker::crypto::SecretKey,
    config::Config,
    db::{
        self, Db,
        repo::{
            mail_accounts::{self, AuthKind, NewAccount},
            users::{self, NewUser, Role},
        },
    },
    web::static_files::WebAssets,
};
use serde_json::{Value, json};
use tower::ServiceExt as _;

struct Setup {
    _tmp: tempfile::TempDir,
    state: AppState,
    /// Session and ID of "max" and "erika".
    max: (String, String),
    erika: (String, String),
}

async fn setup() -> Setup {
    let tmp = tempfile::tempdir().unwrap();
    let db = Db::from(db::open(tmp.path()).unwrap());
    let state = AppState::new(
        db,
        Arc::new(WebAssets::None),
        &Config::default(),
        Url::parse("https://app.example.com").unwrap(),
        SecretKey::random().unwrap(),
    )
    .unwrap();
    let max = login(&state, "max").await;
    let erika = login(&state, "erika").await;
    Setup {
        _tmp: tmp,
        state,
        max,
        erika,
    }
}

/// Creates a user with a session; returns the cookie's token and the ID.
async fn login(state: &AppState, username: &'static str) -> (String, String) {
    db::call(&state.db, move |conn| {
        let id = users::insert(
            conn,
            &NewUser {
                username,
                email: &format!("{username}@example.com"),
                display_name: "Erika Muster",
                role: Role::User,
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
        Ok((token, id))
    })
    .await
    .unwrap()
}

/// Mail account directly in the database; tags need no mail server.
async fn account(state: &AppState, user_id: &str, email: &'static str) -> String {
    let user_id = user_id.to_owned();
    db::call(&state.db, move |conn| {
        let id = db::new_id()?;
        mail_accounts::insert(
            conn,
            &NewAccount {
                id: &id,
                user_id: &user_id,
                base_url: "https://mail.example.com",
                email,
                account_id: email,
                username: email,
                auth_kind: AuthKind::Token,
                client_id: None,
                backend_exchange: false,
                secret_enc: b"encrypted",
                access_token_enc: None,
                expires_in: None,
                session_json: "{}",
                color: 0,
            },
        )?;
        Ok(id)
    })
    .await
    .unwrap()
}

struct Reply {
    status: StatusCode,
    body: String,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", self.body))
    }

    /// Field error with 422 `invalid`.
    fn field(&self, field: &str) -> Value {
        assert_eq!(
            self.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{}",
            self.body
        );
        self.json()["fields"][field].clone()
    }

    fn id(&self) -> String {
        self.json()["id"].as_str().unwrap().to_owned()
    }
}

async fn send(
    state: &AppState,
    method: Method,
    path: &str,
    token: &str,
    body: Option<Value>,
) -> Reply {
    let mut builder = Request::builder()
        .method(method)
        .uri(format!("/api/v1{path}"))
        .header(api::CSRF_HEADER, "fetch")
        .header(header::COOKIE, format!("{}={token}", session::COOKIE));
    let body = match body {
        Some(body) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = router(state.clone())
        .layer(MockConnectInfo(SocketAddr::from(([203, 0, 113, 9], 4711))))
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    Reply {
        status,
        body: String::from_utf8(bytes.to_vec()).unwrap(),
    }
}

async fn create(s: &Setup, body: Value) -> Reply {
    send(&s.state, Method::POST, "/tags", &s.max.0, Some(body)).await
}

/// Creates a tag and returns its ID.
async fn tag(s: &Setup, name: &str, parent: Option<&str>) -> String {
    let reply = create(s, json!({ "name": name, "parent_id": parent })).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    reply.id()
}

async fn patch(s: &Setup, id: &str, body: Value) -> Reply {
    send(
        &s.state,
        Method::PATCH,
        &format!("/tags/{id}"),
        &s.max.0,
        Some(body),
    )
    .await
}

async fn put_links(s: &Setup, id: &str, links: Value) -> Reply {
    send(
        &s.state,
        Method::PUT,
        &format!("/tags/{id}/links"),
        &s.max.0,
        Some(json!({ "links": links })),
    )
    .await
}

/// The tags of "max" as (name, parent name, position) in tree order.
async fn tree(s: &Setup) -> Vec<(String, Option<String>, i64)> {
    let reply = send(&s.state, Method::GET, "/tags", &s.max.0, None).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let tags = reply.json()["tags"].as_array().unwrap().clone();
    let name_of = |id: &Value| {
        tags.iter()
            .find(|tag| tag["id"] == *id)
            .map(|tag| tag["name"].as_str().unwrap().to_owned())
    };
    tags.iter()
        .map(|tag| {
            (
                tag["name"].as_str().unwrap().to_owned(),
                name_of(&tag["parent_id"]),
                tag["position"].as_i64().unwrap(),
            )
        })
        .collect()
}

/// Links in API order: by mail account (ULID, random within one
/// millisecond).
fn sorted(links: &Value) -> Value {
    let mut links = links.as_array().unwrap().clone();
    links.sort_by(|a, b| {
        a["mail_account_id"]
            .as_str()
            .cmp(&b["mail_account_id"].as_str())
    });
    Value::Array(links)
}

fn row(name: &str, parent: Option<&str>, position: i64) -> (String, Option<String>, i64) {
    (name.to_owned(), parent.map(str::to_owned), position)
}

#[tokio::test]
async fn creates_tags_in_tree_order() {
    let s = setup().await;
    let reply = create(&s, json!({ "name": "  Important ", "color": 4 })).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let created = reply.json();
    assert_eq!(created["name"], "Important");
    assert_eq!(created["color"], 4);
    assert_eq!(created["parent_id"], Value::Null);
    assert_eq!(created["position"], 0);
    assert_eq!(created["links"], json!([]));

    let finance = create(&s, json!({ "name": "Finances", "color": 1 }))
        .await
        .id();
    // Subtags without a color take the parent tag's.
    let tax = tag(&s, "Taxes", Some(&finance)).await;
    tag(&s, "Invoices", Some(&finance)).await;
    tag(&s, "2025", Some(&tax)).await;
    tag(&s, "Private", None).await;

    assert_eq!(
        tree(&s).await,
        [
            row("Important", None, 0),
            row("Finances", None, 1),
            row("Taxes", Some("Finances"), 0),
            row("2025", Some("Taxes"), 0),
            row("Invoices", Some("Finances"), 1),
            row("Private", None, 2),
        ]
    );
    let reply = send(&s.state, Method::GET, "/tags", &s.max.0, None).await;
    assert_eq!(reply.json()["tags"][2]["color"], Value::Null);

    // Everyone only sees their own tags.
    let reply = send(&s.state, Method::GET, "/tags", &s.erika.0, None).await;
    assert_eq!(reply.json(), json!({ "tags": [] }));
}

#[tokio::test]
async fn rejects_invalid_tags() {
    let s = setup().await;
    let important = tag(&s, "Important", None).await;
    let trouble = tag(&s, "Éclair", None).await;

    let code = |reply: &Reply, field: &str| reply.field(field)["code"].clone();
    let reply = create(&s, json!({ "name": "   " })).await;
    assert_eq!(code(&reply, "name"), "required");
    let reply = create(&s, json!({ "name": "x".repeat(101) })).await;
    assert_eq!(code(&reply, "name"), "too_long");
    let reply = create(&s, json!({ "name": "Line\u{2028}Break" })).await;
    assert_eq!(code(&reply, "name"), "invalid");
    // Unique per level, case-insensitive, also outside ASCII.
    let reply = create(&s, json!({ "name": "important" })).await;
    assert_eq!(code(&reply, "name"), "taken");
    let reply = create(&s, json!({ "name": "éclair" })).await;
    assert_eq!(code(&reply, "name"), "taken");
    for color in [-1, 6] {
        let reply = create(&s, json!({ "name": "New", "color": color })).await;
        assert_eq!(code(&reply, "color"), "invalid");
    }
    let reply = create(&s, json!({ "name": "New", "parent_id": "unknown" })).await;
    assert_eq!(code(&reply, "parent_id"), "unknown");
    // Other users' tags do not exist for "max".
    let foreign = send(
        &s.state,
        Method::POST,
        "/tags",
        &s.erika.0,
        Some(json!({ "name": "Foreign" })),
    )
    .await
    .id();
    let reply = create(&s, json!({ "name": "New", "parent_id": foreign })).await;
    assert_eq!(code(&reply, "parent_id"), "unknown");
    let reply = create(&s, json!({ "name": "New", "colour": 1 })).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{}", reply.body);

    // The same name on another level and for another user.
    tag(&s, "Important", Some(&important)).await;
    let reply = send(
        &s.state,
        Method::POST,
        "/tags",
        &s.erika.0,
        Some(json!({ "name": "Important" })),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let reply = patch(&s, &trouble, json!({ "name": "IMPORTANT" })).await;
    assert_eq!(code(&reply, "name"), "taken");
}

#[tokio::test]
async fn renames_moves_and_orders_tags() {
    let s = setup().await;
    let a = tag(&s, "A", None).await;
    let b = tag(&s, "B", None).await;
    let c = tag(&s, "C", None).await;
    let b1 = tag(&s, "B1", Some(&b)).await;
    let b11 = tag(&s, "B11", Some(&b1)).await;

    // Rename and change color, change case of the own name.
    let reply = patch(&s, &a, json!({ "name": "Start", "color": 2 })).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.json()["name"], "Start");
    assert_eq!(reply.json()["color"], 2);
    let reply = patch(&s, &a, json!({ "name": "START", "color": null })).await;
    assert_eq!(reply.json()["name"], "START");
    assert_eq!(reply.json()["color"], Value::Null);

    // Move: to the end of the new level, the old one closes the gap.
    let reply = patch(&s, &a, json!({ "parent_id": b })).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(
        tree(&s).await,
        [
            row("B", None, 0),
            row("B1", Some("B"), 0),
            row("B11", Some("B1"), 0),
            row("START", Some("B"), 1),
            row("C", None, 1),
        ]
    );

    // Rename and move in one, also to a name the tag could not have on its
    // old level.
    let reply = patch(&s, &a, json!({ "name": "C", "parent_id": b1 })).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let reply = patch(&s, &a, json!({ "parent_id": null })).await;
    assert_eq!(reply.field("name")["code"], "taken");

    // No cycles: not under itself or one of its subtags.
    let reply = patch(&s, &b, json!({ "parent_id": b })).await;
    assert_eq!(reply.field("parent_id")["code"], "cycle");
    let reply = patch(&s, &b, json!({ "parent_id": b11 })).await;
    assert_eq!(reply.field("parent_id")["code"], "cycle");

    // Position on the same level; too large means at the end.
    let reply = patch(&s, &c, json!({ "position": 0 })).await;
    assert_eq!(reply.json()["position"], 0);
    let reply = patch(
        &s,
        &a,
        json!({ "name": "A", "parent_id": null, "position": 1 }),
    )
    .await;
    assert_eq!(reply.json()["position"], 1);
    assert_eq!(
        tree(&s).await,
        [
            row("C", None, 0),
            row("A", None, 1),
            row("B", None, 2),
            row("B1", Some("B"), 0),
            row("B11", Some("B1"), 0),
        ]
    );
    let reply = patch(&s, &c, json!({ "position": 99 })).await;
    assert_eq!(reply.json()["position"], 2);
    let reply = patch(&s, &c, json!({ "position": -1 })).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{}", reply.body);

    // Other users' and unknown tags.
    let reply = send(
        &s.state,
        Method::PATCH,
        &format!("/tags/{a}"),
        &s.erika.0,
        Some(json!({ "name": "Mine" })),
    )
    .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND, "{}", reply.body);
    let reply = patch(&s, "unknown", json!({ "name": "X" })).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND, "{}", reply.body);
}

#[tokio::test]
async fn deletes_tags_with_their_children_and_links() {
    let s = setup().await;
    let mail_account = account(&s.state, &s.max.1, "max@example.com").await;
    let a = tag(&s, "A", None).await;
    let b = tag(&s, "B", None).await;
    let b1 = tag(&s, "B1", Some(&b)).await;
    let b11 = tag(&s, "B11", Some(&b1)).await;
    tag(&s, "C", None).await;
    for (tag, mailbox) in [(&b, "mb-b"), (&b11, "mb-b11"), (&a, "mb-a")] {
        let reply = put_links(
            &s,
            tag,
            json!([{ "mail_account_id": mail_account, "mailbox_id": mailbox }]),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    }

    // Other users' tags stay.
    let reply = send(
        &s.state,
        Method::DELETE,
        &format!("/tags/{b}"),
        &s.erika.0,
        None,
    )
    .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND, "{}", reply.body);

    let reply = send(
        &s.state,
        Method::DELETE,
        &format!("/tags/{b}"),
        &s.max.0,
        None,
    )
    .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT, "{}", reply.body);
    assert_eq!(tree(&s).await, [row("A", None, 0), row("C", None, 1)]);
    let reply = send(
        &s.state,
        Method::DELETE,
        &format!("/tags/{b}"),
        &s.max.0,
        None,
    )
    .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND, "{}", reply.body);

    // The tags take their links with them; the mailboxes are free again.
    let links: i64 = db::call(&s.state.db, |conn| {
        Ok(conn.query_row("SELECT COUNT(*) FROM tag_links", [], |r| r.get(0))?)
    })
    .await
    .unwrap();
    assert_eq!(links, 1);
    let reply = put_links(
        &s,
        &a,
        json!([{ "mail_account_id": mail_account, "mailbox_id": "mb-b" }]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
}

#[tokio::test]
async fn sets_links_per_mail_account() {
    let s = setup().await;
    let home = account(&s.state, &s.max.1, "max@example.com").await;
    let work = account(&s.state, &s.max.1, "max@company.example").await;
    let foreign = account(&s.state, &s.erika.1, "erika@example.com").await;
    let important = tag(&s, "Important", None).await;
    let travel = tag(&s, "Travel", None).await;

    let links = json!([
        { "mail_account_id": home, "mailbox_id": "Ma1" },
        { "mail_account_id": work, "mailbox_id": "Mb_2-x" },
    ]);
    let reply = put_links(&s, &important, links.clone()).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let links = sorted(&links);
    assert_eq!(reply.json(), json!({ "links": links }));
    let path = format!("/tags/{important}/links");
    let reply = send(&s.state, Method::GET, &path, &s.max.0, None).await;
    assert_eq!(reply.json(), json!({ "links": links }));
    let reply = send(&s.state, Method::GET, "/tags", &s.max.0, None).await;
    assert_eq!(reply.json()["tags"][0]["links"], links);
    assert_eq!(reply.json()["tags"][1]["links"], json!([]));

    // Replace: whatever is missing goes away.
    let one = json!([{ "mail_account_id": work, "mailbox_id": "Mnew" }]);
    let reply = put_links(&s, &important, one.clone()).await;
    assert_eq!(reply.json(), json!({ "links": one }));

    // Other users' and unknown accounts, duplicate accounts, invalid mailboxes.
    let reply = put_links(
        &s,
        &travel,
        json!([
            { "mail_account_id": foreign, "mailbox_id": "Ma1" },
            { "mail_account_id": "unknown", "mailbox_id": "Ma1" },
            { "mail_account_id": home, "mailbox_id": "Ma1" },
            { "mail_account_id": home, "mailbox_id": "Ma2" },
            { "mail_account_id": work, "mailbox_id": "with/slash" },
        ]),
    )
    .await;
    assert_eq!(reply.field("links.0.mail_account_id")["code"], "unknown");
    assert_eq!(reply.field("links.1.mail_account_id")["code"], "unknown");
    assert_eq!(reply.field("links.2.mail_account_id"), Value::Null);
    assert_eq!(reply.field("links.3.mail_account_id")["code"], "duplicate");
    assert_eq!(reply.field("links.4.mailbox_id")["code"], "invalid");
    for mailbox in [String::new(), "x".repeat(256)] {
        let reply = put_links(
            &s,
            &travel,
            json!([{ "mail_account_id": home, "mailbox_id": mailbox }]),
        )
        .await;
        assert_eq!(reply.field("links.0.mailbox_id")["code"], "invalid");
    }
    // A mailbox belongs to at most one tag, per account.
    let reply = put_links(
        &s,
        &travel,
        json!([{ "mail_account_id": work, "mailbox_id": "Mnew" }]),
    )
    .await;
    assert_eq!(
        reply.field("links.0.mailbox_id"),
        json!({ "code": "taken", "tag": important })
    );
    let reply = put_links(
        &s,
        &travel,
        json!([{ "mail_account_id": home, "mailbox_id": "Mnew" }]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    // Rejected requests change nothing.
    let reply = send(&s.state, Method::GET, &path, &s.max.0, None).await;
    assert_eq!(reply.json(), json!({ "links": one }));

    // An empty list removes all links.
    let reply = put_links(&s, &important, json!([])).await;
    assert_eq!(reply.json(), json!({ "links": [] }));

    // Links of other users' and unknown tags.
    let reply = send(&s.state, Method::GET, &path, &s.erika.0, None).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND, "{}", reply.body);
    let reply = send(
        &s.state,
        Method::PUT,
        &path,
        &s.erika.0,
        Some(json!({ "links": [{ "mail_account_id": foreign, "mailbox_id": "Mx" }] })),
    )
    .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND, "{}", reply.body);
    let reply = put_links(&s, "unknown", json!([])).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND, "{}", reply.body);
}

#[tokio::test]
async fn removing_a_mail_account_removes_its_links() {
    let s = setup().await;
    let home = account(&s.state, &s.max.1, "max@example.com").await;
    let work = account(&s.state, &s.max.1, "max@company.example").await;
    let important = tag(&s, "Important", None).await;
    let reply = put_links(
        &s,
        &important,
        json!([
            { "mail_account_id": home, "mailbox_id": "Ma1" },
            { "mail_account_id": work, "mailbox_id": "Mb1" },
        ]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);

    let reply = send(
        &s.state,
        Method::DELETE,
        &format!("/mail-accounts/{home}"),
        &s.max.0,
        None,
    )
    .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT, "{}", reply.body);
    let reply = send(
        &s.state,
        Method::GET,
        &format!("/tags/{important}/links"),
        &s.max.0,
        None,
    )
    .await;
    assert_eq!(
        reply.json(),
        json!({ "links": [{ "mail_account_id": work, "mailbox_id": "Mb1" }] })
    );
    // The tag itself stays.
    assert_eq!(tree(&s).await, [row("Important", None, 0)]);
}

#[tokio::test]
async fn limits_names_depth_and_count() {
    let s = setup().await;
    // Names in NFC: decomposed and composed form are the same name.
    let reply = create(&s, json!({ "name": "E\u{0301}clair" })).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    assert_eq!(reply.json()["name"], "Éclair");
    let reply = create(&s, json!({ "name": "éclair" })).await;
    assert_eq!(reply.field("name")["code"], "taken");

    // At most nine levels, also for a moved subtree.
    let mut chain: Vec<String> = Vec::new();
    for level in 1..=9 {
        let id = tag(
            &s,
            &format!("Level {level}"),
            chain.last().map(String::as_str),
        )
        .await;
        chain.push(id);
    }
    let reply = create(&s, json!({ "name": "Level 10", "parent_id": chain[8] })).await;
    assert_eq!(reply.field("parent_id")["code"], "too_deep");
    let top = tag(&s, "Top", None).await;
    tag(&s, "Bottom", Some(&top)).await;
    let reply = patch(&s, &top, json!({ "parent_id": chain[7] })).await;
    assert_eq!(reply.field("parent_id")["code"], "too_deep");
    let reply = patch(&s, &top, json!({ "parent_id": chain[6] })).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    // The whole chain goes with its top tag.
    let path = format!("/tags/{}", chain[0]);
    let reply = send(&s.state, Method::DELETE, &path, &s.max.0, None).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT, "{}", reply.body);
    assert_eq!(tree(&s).await, [row("Éclair", None, 0)]);

    // At most 1000 tags per user.
    let user_id = s.max.1.clone();
    db::call(&s.state.db, move |conn| {
        let mut stmt =
            conn.prepare("INSERT INTO tags (id, user_id, name, position) VALUES (?1, ?2, ?3, ?4)")?;
        for i in 1..1000 {
            stmt.execute((format!("t{i}"), &user_id, format!("Tag {i}"), i))?;
        }
        Ok(())
    })
    .await
    .unwrap();
    let reply = create(&s, json!({ "name": "One more" })).await;
    assert_eq!(
        reply.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        reply.body
    );
    assert_eq!(reply.json()["error"], "too_many");
    assert_eq!(reply.json()["max"], 1000);
}
