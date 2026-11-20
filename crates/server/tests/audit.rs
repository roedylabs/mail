//! Audit log via the API: only for
//! administrators, filters, pages, export and retention with cleanup job.

use std::{net::SocketAddr, sync::Arc};
use url::Url;

use axum::{
    Router,
    body::Body,
    extract::connect_info::MockConnectInfo,
    http::{HeaderMap, Method, Request, StatusCode, header},
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
            audit_log::{self, Category, Entry},
            users::{self, NewUser, Role},
        },
    },
    jobs::audit_retention,
    web::static_files::WebAssets,
};
use serde_json::{Value, json};
use tower::ServiceExt as _;

const PASSWORD: &str = "Summer2026!";

struct Env {
    _tmp: tempfile::TempDir,
    state: AppState,
    /// Session of the administrator.
    admin: String,
    /// Session of a user without administrator rights.
    user: String,
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

/// Actions as text for comparisons.
fn acts(page: &Value) -> Vec<String> {
    page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            format!(
                "{}{}",
                e["who"].as_str().unwrap(),
                e["act"].as_str().unwrap()
            )
        })
        .collect()
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
    let mut env = Env {
        _tmp: tmp,
        state,
        admin: String::new(),
        user: String::new(),
    };
    env.add_user("anna", "anna@example.com", Role::Admin).await;
    env.add_user("max", "max@example.com", Role::User).await;
    env.admin = env.login("anna").await;
    env.user = env.login("max").await;
    env.sql("DELETE FROM audit_log").await;
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

    async fn login(&self, login: &str) -> String {
        let reply = self
            .request(
                Method::POST,
                "/auth/login",
                Some(json!({ "login": login, "password": PASSWORD })),
                None,
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply
            .headers
            .get_all(header::SET_COOKIE)
            .iter()
            .find_map(|c| {
                c.to_str()
                    .unwrap()
                    .strip_prefix(&format!("{}=", session::COOKIE))?
                    .split(';')
                    .next()
                    .map(str::to_owned)
            })
            .unwrap()
    }

    async fn sql(&self, sql: &'static str) {
        db::call(&self.state.db, move |conn| {
            conn.execute(sql, [])?;
            Ok(())
        })
        .await
        .unwrap();
    }

    async fn add(&self, entry: Entry) {
        db::call(&self.state.db, move |conn| {
            audit_log::insert(conn, &entry)?;
            Ok(())
        })
        .await
        .unwrap();
    }

    /// Entry from `days` days ago.
    async fn add_aged(&self, entry: Entry, days: u32) {
        db::call(&self.state.db, move |conn| {
            audit_log::insert(conn, &entry)?;
            conn.execute(
                "UPDATE audit_log SET at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?1) \
                 WHERE id = last_insert_rowid()",
                [format!("-{days} days")],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    }

    /// One entry per category.
    async fn seed(&self) {
        let mut login =
            Entry::new(Category::Login, "auth.login").details(json!({ "method": "password" }));
        login.actor_name = Some("Max Mustermann".into());
        login.place = Some("Berlin, Germany".into());
        self.add(login).await;
        let mut lock = Entry::new(Category::Users, "users.lock")
            .details(json!({ "name": "Mia Koch", "email": "m@example.com", "sessions_ended": 1 }));
        lock.actor_name = Some("Anna Becker".into());
        self.add(lock).await;
        let mut mail = Entry::new(Category::Settings, "system_mail.update")
            .details(json!({ "fields": ["user"] }));
        mail.actor_name = Some("Anna Becker".into());
        self.add(mail).await;
        self.add(
            Entry::new(Category::System, "backups.auto")
                .details(json!({ "size": 1_288_490_189_u64 })),
        )
        .await;
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
            .header(api::CSRF_HEADER, "fetch");
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
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        Reply {
            status,
            headers,
            body: String::from_utf8(bytes.to_vec()).unwrap(),
        }
    }

    async fn get(&self, path: &str) -> Reply {
        self.request(Method::GET, path, None, Some(&self.admin))
            .await
    }

    async fn export(&self, path: &str) -> Reply {
        self.request(Method::POST, path, None, Some(&self.admin))
            .await
    }

    async fn page(&self, path: &str) -> Value {
        let reply = self.get(path).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.json()
    }

    async fn put_days(&self, days: u32) -> Reply {
        self.request(
            Method::PUT,
            "/admin/audit/retention",
            Some(json!({ "days": days })),
            Some(&self.admin),
        )
        .await
    }

    async fn rows(&self) -> i64 {
        db::call(&self.state.db, |conn| {
            Ok(conn.query_row("SELECT count(*) FROM audit_log", [], |row| row.get(0))?)
        })
        .await
        .unwrap()
    }
}

#[tokio::test]
async fn only_administrators_reach_the_log() {
    let env = env().await;
    for path in ["/admin/audit", "/admin/audit/retention"] {
        let anonymous = env.request(Method::GET, path, None, None).await;
        assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED, "{path}");
        let user = env.request(Method::GET, path, None, Some(&env.user)).await;
        assert_eq!(user.status, StatusCode::FORBIDDEN, "{path}");
    }
    for (method, path) in [
        (Method::PUT, "/admin/audit/retention"),
        (Method::POST, "/admin/audit/export"),
    ] {
        let body = (method == Method::PUT).then(|| json!({ "days": 30 }));
        let anonymous = env.request(method.clone(), path, body.clone(), None).await;
        assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED, "{path}");
        let user = env.request(method, path, body, Some(&env.user)).await;
        assert_eq!(user.status, StatusCode::FORBIDDEN, "{path}");
    }
}

/// The export writes to the audit log: no `GET`, and it needs the CSRF
/// check like every changing request.
#[tokio::test]
async fn export_needs_post_and_the_csrf_header() {
    let env = env().await;
    let get = env.get("/admin/audit/export").await;
    assert_eq!(get.status, StatusCode::METHOD_NOT_ALLOWED);

    let request = Request::builder()
        .method(Method::POST)
        .uri("/api/v1/admin/audit/export")
        .header(header::COOKIE, format!("{}={}", session::COOKIE, env.admin))
        .body(Body::empty())
        .unwrap();
    let app: Router = router(env.state.clone())
        .layer(MockConnectInfo(SocketAddr::from(([89, 12, 34, 56], 4711))));
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(env.rows().await, 0, "nothing in the audit log");
}

#[tokio::test]
async fn lists_entries_newest_first() {
    let env = env().await;
    env.seed().await;

    let page = env.page("/admin/audit").await;
    assert_eq!(
        acts(&page),
        [
            "System created an automatic backup",
            "Anna Becker changed the email settings",
            "Anna Becker suspended Mia Koch",
            "Max Mustermann signed in",
        ]
    );
    assert_eq!(
        page["counts"],
        json!({ "all": 4, "login": 1, "users": 1, "settings": 1, "system": 1 })
    );
    assert_eq!(page["next"], Value::Null);
    let backup = &page["entries"][0];
    assert_eq!(backup["cat"], "system");
    assert_eq!(backup["icon"], "ti-database");
    assert_eq!(backup["meta"], "1.2 GB");
    assert_eq!(backup["warn"], false);
    assert!(backup["at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(page["entries"][3]["meta"], "Berlin, Germany");
}

#[tokio::test]
async fn filters_by_category_search_and_time() {
    let env = env().await;
    env.seed().await;
    let mut old = Entry::new(Category::Login, "auth.logout");
    old.actor_name = Some("Jonas Schulz".into());
    env.add_aged(old, 10).await;

    // Category: the counts still apply to all categories.
    let page = env.page("/admin/audit?cat=users").await;
    assert_eq!(acts(&page), ["Anna Becker suspended Mia Koch"]);
    assert_eq!(page["counts"]["all"], 5);
    assert_eq!(page["counts"]["login"], 2);

    // Search in person, action, place and category, case-insensitive.
    for (q, found) in [
        ("MIA", 1),
        ("anna", 2),
        ("berlin", 1),
        ("suspended", 1),
        ("settings", 1),
        ("system", 1),
        ("does%20not%20exist", 0),
    ] {
        let page = env.page(&format!("/admin/audit?q={q}")).await;
        assert_eq!(page["counts"]["all"], found, "{q}");
        assert_eq!(page["entries"].as_array().unwrap().len(), found, "{q}");
    }

    // Search and category together: the counts only count the search.
    let page = env.page("/admin/audit?q=anna&cat=settings").await;
    assert_eq!(acts(&page).len(), 1);
    assert_eq!(page["counts"]["all"], 2);
    assert_eq!(page["counts"]["users"], 1);

    // Period: `to` excludes, `from` includes.
    let before = jiff::Timestamp::now() - jiff::SignedDuration::from_hours(24);
    let at = before.strftime("%Y-%m-%dT%H:%M:%SZ");
    let page = env.page(&format!("/admin/audit?to={at}")).await;
    assert_eq!(acts(&page), ["Jonas Schulz signed out"]);
    let page = env.page(&format!("/admin/audit?from={at}")).await;
    assert_eq!(page["counts"]["all"], 4);
    assert_eq!(page["counts"]["login"], 1);

    assert_eq!(
        env.export("/admin/audit/export?to=yesterday").await.status,
        StatusCode::BAD_REQUEST
    );

    // Empty filters as without filters (the page's form).
    let page = env.page("/admin/audit?cat=&q=&from=&to=").await;
    assert_eq!(page["counts"]["all"], 5);

    for path in [
        "/admin/audit?cat=unknown",
        "/admin/audit?from=yesterday",
        "/admin/audit?limit=many",
    ] {
        assert_eq!(
            env.get(path).await.status,
            StatusCode::BAD_REQUEST,
            "{path}"
        );
    }
}

#[tokio::test]
async fn pages_through_the_matches() {
    let env = env().await;
    for name in ["A", "B", "C", "D", "E"] {
        let mut entry = Entry::new(Category::Login, "auth.logout");
        entry.actor_name = Some(name.into());
        env.add(entry).await;
    }

    let first = env.page("/admin/audit?limit=2").await;
    assert_eq!(acts(&first).len(), 2);
    assert!(acts(&first)[0].starts_with('E'));
    assert_eq!(first["counts"]["all"], 5);
    let next = first["next"].as_i64().unwrap();

    let second = env
        .page(&format!("/admin/audit?limit=2&before={next}"))
        .await;
    assert!(acts(&second)[0].starts_with('C'));
    assert_eq!(second["counts"]["all"], 5, "the counts apply to all pages");
    let next = second["next"].as_i64().unwrap();

    let last = env
        .page(&format!("/admin/audit?limit=2&before={next}"))
        .await;
    assert_eq!(acts(&last).len(), 1);
    assert_eq!(last["next"], Value::Null);

    // The same pages with a search.
    let found = env.page("/admin/audit?limit=2&q=signed%20out").await;
    assert_eq!(acts(&found), acts(&first));
    assert_eq!(found["next"], first["next"]);

    // Exactly one full page: no empty next page.
    for path in [
        "/admin/audit?limit=5",
        "/admin/audit?limit=5&q=signed%20out",
    ] {
        let all = env.page(path).await;
        assert_eq!(acts(&all).len(), 5, "{path}");
        assert_eq!(all["next"], Value::Null, "{path}");
    }
    assert_eq!(acts(&env.page("/admin/audit?limit=0").await).len(), 1);
}

#[tokio::test]
async fn next_only_counts_rows_of_the_chosen_category() {
    let env = env().await;
    env.seed().await;
    for path in [
        "/admin/audit?cat=users&limit=1",
        "/admin/audit?cat=users&limit=1&q=anna",
    ] {
        let page = env.page(path).await;
        assert_eq!(acts(&page).len(), 1, "{path}");
        assert_eq!(page["next"], Value::Null, "{path}");
    }
}

#[tokio::test]
async fn a_page_holds_at_most_five_hundred_entries() {
    let env = env().await;
    db::call(&env.state.db, |conn| {
        let tx = conn.transaction()?;
        for _ in 0..501 {
            audit_log::insert(&tx, &Entry::new(Category::Login, "auth.logout"))?;
        }
        tx.commit()?;
        Ok(())
    })
    .await
    .unwrap();
    for path in [
        "/admin/audit?limit=1000",
        "/admin/audit?limit=1000&q=signed%20out",
    ] {
        let page = env.page(path).await;
        assert_eq!(acts(&page).len(), 500, "{path}");
        assert!(page["next"].is_i64(), "{path}");
        assert_eq!(page["counts"]["all"], 501, "{path}");
    }
}

#[tokio::test]
async fn exports_all_matches_as_csv_and_records_it() {
    let env = env().await;
    env.seed().await;
    let mut hostile = Entry::new(Category::Login, "auth.logout");
    hostile.actor_name = Some("=HYPERLINK(\"x\")".into());
    env.add(hostile).await;

    let reply = env.export("/admin/audit/export?cat=login").await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply.headers[header::CONTENT_TYPE],
        "text/csv; charset=utf-8"
    );
    let disposition = reply.headers[header::CONTENT_DISPOSITION].to_str().unwrap();
    assert!(disposition.starts_with("attachment; filename=\""));
    assert!(disposition.ends_with(".csv\""));
    assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store");

    let body = reply.body.strip_prefix('\u{feff}').expect("BOM");
    let lines: Vec<&str> = body.split("\r\n").collect();
    assert_eq!(lines.len(), 4, "{body}");
    assert_eq!(lines[0], r#""Time";"Category";"Person";"Action";"Details""#);
    assert!(
        lines[1].ends_with(r#";"Sign-in";"'=HYPERLINK(""x"")";"signed out";"""#),
        "{}",
        lines[1]
    );
    assert!(
        lines[2].ends_with(r#";"Sign-in";"Max Mustermann";"signed in";"Berlin, Germany""#),
        "{}",
        lines[2]
    );
    assert_eq!(lines[3], "");

    // The colon at the start is dropped in the export.
    let mut failed =
        Entry::new(Category::Login, "auth.login_failed").details(json!({ "reason": "locked" }));
    failed.actor_name = Some("Mia Koch".into());
    env.add(failed).await;
    let reply = env.export("/admin/audit/export?q=denied").await;
    assert!(
        reply
            .body
            .contains(r#";"Mia Koch";"Sign-in denied, account suspended";"#),
        "{}",
        reply.body
    );

    // The export itself is in the audit log.
    let page = env.page("/admin/audit?cat=system").await;
    assert_eq!(
        acts(&page)[0],
        "Anna Becker exported the audit log",
        "the last export with one hit"
    );
    assert_eq!(page["entries"][0]["meta"], "1 entry");
    assert_eq!(page["counts"]["system"], 3);
}

#[tokio::test]
async fn retention_defaults_to_ninety_days_and_takes_only_the_choices() {
    let env = env().await;
    assert_eq!(env.page("/admin/audit/retention").await["days"], 90);

    let reply = env.put_days(45).await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(reply.json()["fields"]["days"]["code"], "invalid");
    assert_eq!(env.rows().await, 0);

    let reply = env.put_days(365).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.json()["days"], 365);
    assert_eq!(env.page("/admin/audit/retention").await["days"], 365);
    let page = env.page("/admin/audit").await;
    assert_eq!(
        acts(&page),
        ["Anna Becker changed the audit log retention to 1 year"]
    );
    assert_eq!(page["entries"][0]["cat"], "settings");

    // The same retention again changes nothing.
    assert_eq!(env.put_days(365).await.status, StatusCode::OK);
    assert_eq!(env.rows().await, 1);

    let reply = env
        .request(
            Method::PUT,
            "/admin/audit/retention",
            Some(json!({ "days": 30, "more": 1 })),
            Some(&env.admin),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn old_entries_vanish_from_the_list_and_the_job_deletes_them() {
    let env = env().await;
    let mut old = Entry::new(Category::Login, "auth.logout");
    old.actor_name = Some("Jonas Schulz".into());
    env.add_aged(old, 40).await;
    let mut older = Entry::new(Category::Login, "auth.logout");
    older.actor_name = Some("Mia Koch".into());
    env.add_aged(older, 100).await;

    // Older than the retention shows neither in the list nor in the export, even before cleanup.
    let page = env.page("/admin/audit").await;
    assert_eq!(acts(&page), ["Jonas Schulz signed out"]);
    let export = env.export("/admin/audit/export").await;
    assert!(!export.body.contains("Mia Koch"), "{}", export.body);

    // A shorter retention deletes nothing right away: it can be undone.
    env.put_days(30).await;
    let page = env.page("/admin/audit?q=Jonas").await;
    assert_eq!(page["counts"]["all"], 0);
    env.put_days(90).await;
    let page = env.page("/admin/audit?q=Jonas").await;
    assert_eq!(page["counts"]["all"], 1);

    // The job deletes what exceeds the retention …
    let before = env.rows().await;
    audit_retention::run(env.state.clone()).await.unwrap();
    assert_eq!(env.rows().await, before - 1);
    env.put_days(365).await;
    let page = env.page("/admin/audit?q=Mia").await;
    assert_eq!(page["counts"]["all"], 0, "deleted stays deleted");

    // … and follows the configured retention.
    env.put_days(30).await;
    audit_retention::run(env.state.clone()).await.unwrap();
    env.put_days(365).await;
    let page = env.page("/admin/audit?q=Jonas").await;
    assert_eq!(page["counts"]["all"], 0);
}
