//! Administration › Maintenance: backups via the API and background jobs:
//! create, list, download, delete,
//! restore with data, schedule, retention and events.

use std::{net::SocketAddr, path::Path, sync::Arc};

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
        AuthUser,
        password::{Hasher, Params},
        session,
    },
    backups::{self, Backup, Refused, archive},
    broker::crypto::SecretKey,
    config::Config,
    db::{
        self, Db, migrations,
        repo::{
            app_settings,
            audit_log::{Category, Entry},
            update_state,
            users::{self, NewUser, Role},
        },
    },
    instance::CLIENT_CACHE_VERSION,
    jobs, updates,
    web::static_files::WebAssets,
};
use rusqlite::Connection;
use serde_json::{Value, json};
use tower::ServiceExt as _;

const PASSWORD: &str = "Summer2026!";
const BACKUPS: &str = "/admin/backups";
const SCHEDULE: &str = "/admin/backups/schedule";

struct Env {
    tmp: tempfile::TempDir,
    state: AppState,
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

    fn error(&self) -> String {
        self.json()["error"].as_str().unwrap_or_default().to_owned()
    }
}

async fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let conn = db::open(tmp.path()).unwrap();
    let config = Config {
        data_dir: tmp.path().to_owned(),
        ..Config::default()
    };
    let mut state = AppState::new(
        Db::from(conn),
        Arc::new(WebAssets::None),
        &config,
        SecretKey::random().unwrap(),
    )
    .unwrap();
    state.hasher = Arc::new(Hasher::with_params(Params::new(64, 1, 1, None).unwrap()));
    let mut env = Env {
        tmp,
        state,
        admin: String::new(),
        user: String::new(),
    };
    env.add_user("anna", "Anna Becker", Role::Admin).await;
    env.add_user("mia", "Mia Wolf", Role::Admin).await;
    env.add_user("ben", "Ben Vogt", Role::User).await;
    env.admin = env.session("anna").await;
    env.user = env.session("ben").await;
    env
}

impl Env {
    async fn add_user(&self, username: &str, name: &str, role: Role) {
        let hash = self.state.hasher.hash(PASSWORD).await.unwrap();
        let (email, username, name) = (
            format!("{username}@example.com"),
            username.to_owned(),
            name.to_owned(),
        );
        db::call(&self.state.db, move |conn| {
            users::insert(
                conn,
                &NewUser {
                    username: &username,
                    email: &email,
                    display_name: &name,
                    role,
                    password_hash: &hash,
                },
            )
        })
        .await
        .unwrap();
    }

    async fn send(&self, request: Request<Body>) -> axum::response::Response {
        let app: Router = router(self.state.clone())
            .layer(MockConnectInfo(SocketAddr::from(([89, 12, 34, 56], 4711))));
        app.oneshot(request).await.unwrap()
    }

    fn builder(method: Method, path: &str) -> axum::http::request::Builder {
        Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"))
            .header(api::CSRF_HEADER, "fetch")
            .header(header::USER_AGENT, "Mozilla/5.0 Firefox/140.0")
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        session: Option<&str>,
    ) -> Reply {
        let response = self.raw(method, path, body, session).await;
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        Reply {
            status,
            body: String::from_utf8_lossy(&bytes).into_owned(),
        }
    }

    async fn raw(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        session: Option<&str>,
    ) -> axum::response::Response {
        let mut builder = Self::builder(method, path);
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
        self.send(request).await
    }

    async fn session(&self, login: &str) -> String {
        let request = Self::builder(Method::POST, "/auth/login")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "login": login, "password": PASSWORD }).to_string(),
            ))
            .unwrap();
        let response = self.send(request).await;
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

    async fn as_admin(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        self.request(method, path, body, Some(&self.admin)).await
    }

    async fn show(&self) -> Value {
        let reply = self.as_admin(Method::GET, BACKUPS, None).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.json()
    }

    /// "Back up now"; returns the row of the list.
    async fn create(&self) -> Value {
        let reply = self.as_admin(Method::POST, BACKUPS, None).await;
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
        reply.json()
    }

    /// Turns maintenance mode on or off like the switch on the page.
    async fn maintenance(&self, on: bool) {
        let reply = self
            .as_admin(Method::PUT, "/admin/maintenance", Some(json!({ "on": on })))
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    }

    /// Restores in maintenance mode, which a restore requires.
    async fn restore(&self, id: &str) -> Reply {
        if !self.state.maintenance.is_on() {
            self.maintenance(true).await;
        }
        self.restore_as_is(id).await
    }

    /// Restores without touching maintenance mode.
    async fn restore_as_is(&self, id: &str) -> Reply {
        self.as_admin(Method::POST, &format!("{BACKUPS}/{id}/restore"), None)
            .await
    }

    fn list(&self) -> Vec<Backup> {
        self.state.backups.list().unwrap()
    }

    /// Names in the backup directory that are not backups.
    fn leftovers(&self) -> Vec<String> {
        let dir = self.tmp.path().join("backups");
        std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| !name.ends_with(".tar.zst"))
            .collect()
    }

    /// `(action, details)` of the backup entries in the audit log.
    async fn audit(&self) -> Vec<(String, Option<Value>)> {
        db::call(&self.state.db, |conn| {
            let rows = conn
                .prepare(
                    "SELECT action, details FROM audit_log \
                     WHERE action LIKE 'backups.%' ORDER BY rowid",
                )?
                .query_map([], |row| {
                    let details: Option<String> = row.get(1)?;
                    Ok((
                        row.get(0)?,
                        details.map(|text| serde_json::from_str(&text).unwrap()),
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await
        .unwrap()
    }

    /// `(recipient, kind, details)` of the backup notifications.
    async fn notifications(&self) -> Vec<(String, String, Value)> {
        db::call(&self.state.db, |conn| {
            let rows = conn
                .prepare(
                    "SELECT u.username, n.kind, n.params FROM notifications n \
                     JOIN users u ON u.id = n.user_id \
                     WHERE n.kind LIKE 'system.backup%' ORDER BY u.username, n.rowid",
                )?
                .query_map([], |row| {
                    let params: String = row.get(2)?;
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        serde_json::from_str(&params).unwrap(),
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await
        .unwrap()
    }

    async fn usernames(&self) -> Vec<String> {
        db::call(&self.state.db, |conn| {
            let rows = conn
                .prepare("SELECT username FROM users ORDER BY username")?
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await
        .unwrap()
    }

    async fn run_job(&self) {
        jobs::backup::run(self.state.clone()).await.unwrap();
    }

    /// Changes the database in the file of `backup` and signs it again, as
    /// only this instance can.
    fn rewrite(&self, backup: &Backup, change: impl FnOnce(&Connection)) {
        let tmp = tempfile::tempdir().unwrap();
        let database = tmp.path().join("copy");
        let path = self.state.backups.path(backup);
        let manifest = archive::read(&path, &database, &self.state.secrets).unwrap();
        change(&Connection::open(&database).unwrap());
        std::fs::remove_file(&path).unwrap();
        archive::write(&database, &manifest, &self.state.secrets, &path).unwrap();
    }

    /// `(action, actor_id, actor_name)` of all audit log entries, oldest first.
    async fn audit_rows(&self) -> Vec<(String, Option<String>, Option<String>)> {
        db::call(&self.state.db, |conn| {
            let rows = conn
                .prepare("SELECT action, actor_id, actor_name FROM audit_log ORDER BY id")?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await
        .unwrap()
    }
}

/// The entries `(name, content)` of a backup file, read like anyone who can
/// read the file can: without the instance key.
fn entries(path: &Path) -> Vec<(String, Vec<u8>)> {
    let decoder = zstd::Decoder::new(std::fs::File::open(path).unwrap()).unwrap();
    let mut tar = tar::Archive::new(decoder);
    tar.entries()
        .unwrap()
        .map(|entry| {
            let mut entry = entry.unwrap();
            let name = entry.path().unwrap().to_string_lossy().into_owned();
            let mut data = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut data).unwrap();
            (name, data)
        })
        .collect()
}

/// The content of the entry `name` in a backup file.
fn entry(path: &Path, name: &str) -> Vec<u8> {
    entries(path)
        .into_iter()
        .find_map(|(entry, data)| (entry == name).then_some(data))
        .unwrap()
}

#[tokio::test]
async fn only_admins_reach_the_page() {
    let env = env().await;
    let id = "01KA0000000000000000000000";
    for (method, path) in [
        (Method::GET, BACKUPS.to_owned()),
        (Method::POST, BACKUPS.to_owned()),
        (Method::PUT, SCHEDULE.to_owned()),
        (Method::GET, format!("{BACKUPS}/{id}/download")),
        (Method::POST, format!("{BACKUPS}/{id}/restore")),
        (Method::DELETE, format!("{BACKUPS}/{id}")),
    ] {
        let anonymous = env.request(method.clone(), &path, None, None).await;
        assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED, "{path}");
        let user = env
            .request(method, &path, None, Some(&env.user.clone()))
            .await;
        assert_eq!(user.status, StatusCode::FORBIDDEN, "{path}");
    }
}

#[tokio::test]
async fn the_page_starts_empty_with_the_defaults() {
    let env = env().await;

    let view = env.show().await;

    assert_eq!(view["backups"], json!([]));
    assert_eq!(view["auto"], true);
    assert_eq!(view["every"], "daily");
    assert_eq!(view["keep"], 30);
    assert!(view["next_at"].is_string());
}

#[tokio::test]
async fn a_backup_holds_database_and_manifest() {
    let env = env().await;

    let row = env.create().await;

    assert_eq!(row["auto"], false);
    assert!(row["size"].as_u64().unwrap() > 0);
    let view = env.show().await;
    assert_eq!(view["backups"], json!([row]));
    let backup = &env.list()[0];
    assert!(backup.file.starts_with("roedy-mail-"));

    let tmp = tempfile::tempdir().unwrap();
    let database = tmp.path().join("copy");
    let manifest = archive::read(
        &env.state.backups.path(backup),
        &database,
        &env.state.secrets,
    )
    .unwrap();
    assert!(!manifest.auto);
    assert_eq!(manifest.schema, migrations::latest_version());
    let copy = Connection::open(&database).unwrap();
    let admins: i64 = copy
        .query_row(
            "SELECT COUNT(*) FROM users WHERE role = 'admin'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(admins, 2);
    assert_eq!(env.leftovers(), Vec::<String>::new());
    assert_eq!(
        env.audit().await,
        [(
            "backups.create".to_owned(),
            Some(json!({ "size": backup.size }))
        )]
    );
    // A manual backup triggers no event.
    assert_eq!(env.notifications().await, []);
}

#[cfg(unix)]
#[tokio::test]
async fn backups_stay_private() {
    use std::os::unix::fs::PermissionsExt as _;

    let env = env().await;
    env.create().await;

    let backup = &env.list()[0];
    let path = env.state.backups.path(backup);
    let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&path), 0o600);
    assert_eq!(mode(path.parent().unwrap()), 0o700);
}

#[tokio::test]
async fn storage_counts_the_backups() {
    let env = env().await;
    let storage = env
        .as_admin(Method::GET, "/admin/storage", None)
        .await
        .json();
    assert_eq!(storage["backups"], 0);
    assert_eq!(storage["backup_count"], 0);

    let first = env.create().await["size"].as_u64().unwrap();
    let second = env.create().await["size"].as_u64().unwrap();

    let storage = env
        .as_admin(Method::GET, "/admin/storage", None)
        .await
        .json();
    assert_eq!(storage["backups"], first + second);
    assert_eq!(storage["backup_count"], 2);
}

#[tokio::test]
async fn storage_stays_usable_without_a_readable_directory() {
    let env = env().await;
    std::fs::write(env.tmp.path().join("backups"), "in the way").unwrap();

    let storage = env.as_admin(Method::GET, "/admin/storage", None).await;
    let compact = env
        .as_admin(Method::POST, "/admin/storage/compact", None)
        .await;

    assert_eq!(storage.status, StatusCode::OK, "{}", storage.body);
    assert_eq!(storage.json()["backup_count"], 0);
    assert_eq!(compact.status, StatusCode::OK, "{}", compact.body);
}

#[tokio::test]
async fn the_download_is_the_file() {
    let env = env().await;
    let id = env.create().await["id"].as_str().unwrap().to_owned();
    let backup = &env.list()[0];

    let response = env
        .raw(
            Method::GET,
            &format!("{BACKUPS}/{id}/download"),
            None,
            Some(&env.admin),
        )
        .await;

    assert_eq!(response.status(), StatusCode::OK);
    let headers = response.headers().clone();
    assert_eq!(headers[header::CONTENT_TYPE], "application/zstd");
    assert_eq!(headers[header::CONTENT_LENGTH], backup.size.to_string());
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        headers[header::CONTENT_DISPOSITION],
        format!("attachment; filename=\"{}\"", backup.file)
    );
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        body.as_ref(),
        std::fs::read(env.state.backups.path(backup)).unwrap()
    );
    assert_eq!(env.audit().await[1].0, "backups.download");
}

#[tokio::test]
async fn deleting_removes_the_file() {
    let env = env().await;
    let id = env.create().await["id"].as_str().unwrap().to_owned();
    let path = env.state.backups.path(&env.list()[0]);

    let reply = env
        .as_admin(Method::DELETE, &format!("{BACKUPS}/{id}"), None)
        .await;

    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert!(!path.exists());
    assert_eq!(env.audit().await[1].0, "backups.delete");
    let again = env
        .as_admin(Method::DELETE, &format!("{BACKUPS}/{id}"), None)
        .await;
    assert_eq!(again.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn unknown_ids_reach_no_file() {
    let env = env().await;
    env.create().await;
    std::fs::write(env.tmp.path().join("secret.key"), "secret").unwrap();

    for id in [
        "01KA0000000000000000000000",
        "..%2Fsecret.key",
        "..%2F..%2Fsecret.key",
    ] {
        for (method, path) in [
            (Method::GET, format!("{BACKUPS}/{id}/download")),
            (Method::POST, format!("{BACKUPS}/{id}/restore")),
            (Method::DELETE, format!("{BACKUPS}/{id}")),
        ] {
            let reply = env.as_admin(method, &path, None).await;
            assert_eq!(reply.status, StatusCode::NOT_FOUND, "{path}");
        }
    }
    assert!(env.tmp.path().join("secret.key").exists());
}

#[tokio::test]
async fn the_schedule_changes_the_named_fields() {
    let env = env().await;

    let view = env
        .as_admin(
            Method::PUT,
            SCHEDULE,
            Some(json!({ "every": "weekly", "keep": 90 })),
        )
        .await
        .json();

    assert_eq!(view["every"], "weekly");
    assert_eq!(view["keep"], 90);
    assert_eq!(view["auto"], true);

    let off = env
        .as_admin(Method::PUT, SCHEDULE, Some(json!({ "auto": false })))
        .await
        .json();
    assert_eq!(off["auto"], false);
    assert_eq!(off["next_at"], Value::Null);
    assert_eq!(off["keep"], 90);

    // No change, no entry.
    env.as_admin(Method::PUT, SCHEDULE, Some(json!({ "auto": false })))
        .await;
    let audit = env.audit().await;
    assert_eq!(audit.len(), 2);
    assert_eq!(audit[0].0, "backups.schedule");
}

#[tokio::test]
async fn the_schedule_refuses_other_values() {
    let env = env().await;

    let keep = env
        .as_admin(Method::PUT, SCHEDULE, Some(json!({ "keep": 14 })))
        .await;
    assert_eq!(
        keep.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        keep.body
    );
    assert_eq!(keep.json()["fields"]["keep"]["code"], "invalid");

    for body in [json!({ "every": "hourly" }), json!({ "time": "03:00" })] {
        let reply = env.as_admin(Method::PUT, SCHEDULE, Some(body)).await;
        assert!(reply.status.is_client_error(), "{}", reply.body);
    }
    assert_eq!(env.show().await["keep"], 30);
}

#[tokio::test]
async fn only_one_backup_runs_at_a_time() {
    let env = env().await;
    let id = env.create().await["id"].as_str().unwrap().to_owned();
    let running = env.state.backups.try_begin().unwrap();

    let create = env.as_admin(Method::POST, BACKUPS, None).await;
    let restore = env.restore(&id).await;

    assert_eq!(create.status, StatusCode::CONFLICT);
    assert_eq!(create.error(), "backup_running");
    assert_eq!(restore.status, StatusCode::CONFLICT);
    assert_eq!(restore.error(), "backup_running");
    let delete = env
        .as_admin(Method::DELETE, &format!("{BACKUPS}/{id}"), None)
        .await;
    assert_eq!(delete.status, StatusCode::CONFLICT);
    assert_eq!(delete.error(), "backup_running");
    drop(running);
    assert_eq!(
        env.as_admin(Method::POST, BACKUPS, None).await.status,
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn restoring_needs_maintenance_mode() {
    let env = env().await;
    let id = env.create().await["id"].as_str().unwrap().to_owned();
    env.add_user("tom", "Tom Newman", Role::User).await;
    assert!(!env.state.maintenance.is_on());

    let reply = env.restore_as_is(&id).await;

    assert_eq!(reply.status, StatusCode::CONFLICT, "{}", reply.body);
    assert_eq!(reply.error(), "maintenance_required");
    // Nothing reset, no entry: like every refused restore.
    untouched(&env).await;
    assert_eq!(env.list().len(), 1);
    assert!(!env.state.maintenance.is_on());
}

#[tokio::test]
async fn restoring_is_refused_again_once_maintenance_mode_is_off() {
    let env = env().await;
    let id = env.create().await["id"].as_str().unwrap().to_owned();
    env.add_user("tom", "Tom Newman", Role::User).await;
    env.maintenance(true).await;
    // Another administrator turns it off before the confirmation.
    env.maintenance(false).await;

    let reply = env.restore_as_is(&id).await;

    assert_eq!(reply.status, StatusCode::CONFLICT, "{}", reply.body);
    assert_eq!(reply.error(), "maintenance_required");
    untouched(&env).await;
}

#[tokio::test]
async fn restoring_works_in_maintenance_mode() {
    let env = env().await;
    let id = env.create().await["id"].as_str().unwrap().to_owned();
    env.add_user("tom", "Tom Newman", Role::User).await;
    env.maintenance(true).await;

    let reply = env.restore_as_is(&id).await;

    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(env.usernames().await, ["anna", "ben", "mia"]);
    // Maintenance mode as in the backup: off.
    assert!(!env.state.maintenance.is_on());
    let audit: Vec<_> = env.audit().await.into_iter().map(|(a, _)| a).collect();
    assert_eq!(audit, ["backups.create", "backups.restore"]);
}

#[tokio::test]
async fn restoring_brings_back_the_data_and_what_the_server_keeps_in_memory() {
    let env = env().await;
    let mia = env.session("mia").await;
    let org = env
        .as_admin(
            Method::PUT,
            "/admin/org",
            Some(json!({ "name": "Old Ltd" })),
        )
        .await;
    assert_eq!(org.status, StatusCode::OK, "{}", org.body);
    let old = env.create().await["id"].as_str().unwrap().to_owned();

    // Everything after that is lost.
    env.add_user("tom", "Tom Newman", Role::User).await;
    env.as_admin(
        Method::PUT,
        "/admin/org",
        Some(json!({ "name": "New Ltd" })),
    )
    .await;
    env.as_admin(
        Method::PUT,
        "/admin/maintenance",
        Some(json!({ "on": true, "message": "Back soon" })),
    )
    .await;
    env.as_admin(Method::PUT, SCHEDULE, Some(json!({ "keep": 7 })))
        .await;
    db::call(&env.state.db, |conn| {
        app_settings::set(conn, CLIENT_CACHE_VERSION, &41_u64)
    })
    .await
    .unwrap();
    env.state.instance.set_client_cache_version(41);
    env.create().await;
    assert_eq!(env.list().len(), 2);

    let reply = env.restore(&old).await;

    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let view = reply.json();
    assert_eq!(view["keep"], 30);
    // The files are next to the database and all stay.
    assert_eq!(view["backups"].as_array().unwrap().len(), 2);
    assert_eq!(env.leftovers(), Vec::<String>::new());
    assert_eq!(env.usernames().await, ["anna", "ben", "mia"]);

    // The in-memory state follows.
    let config = env
        .request(Method::GET, "/public/config", None, None)
        .await
        .json();
    assert_eq!(config["org"]["name"], "Old Ltd");
    assert_eq!(config["maintenance"]["on"], false);
    assert_eq!(config["client_cache_version"], 42);
    assert_eq!(env.state.instance.org().name.as_deref(), Some("Old Ltd"));
    assert!(!env.state.maintenance.is_on());

    // The own session stays, all others end.
    assert_eq!(
        env.as_admin(Method::GET, BACKUPS, None).await.status,
        StatusCode::OK
    );
    for session in [&mia, &env.user] {
        let reply = env
            .request(Method::GET, "/auth/me", None, Some(session))
            .await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    }

    // The audit log is not reset: everything since the backup stays, plus
    // the new entry.
    let audit: Vec<_> = env.audit().await.into_iter().map(|(a, _)| a).collect();
    assert_eq!(
        audit,
        [
            "backups.create",
            "backups.schedule",
            "backups.create",
            "backups.restore"
        ]
    );

    // The file is what counts, not the connection.
    let reopened = db::open_existing(env.tmp.path()).unwrap();
    let mode: String = reopened
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
    let tom: i64 = reopened
        .query_row(
            "SELECT COUNT(*) FROM users WHERE username = 'tom'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tom, 0);
}

#[tokio::test]
async fn restoring_renews_banner_and_csp() {
    let env = env().await;
    let banner = |title: &str| Some(json!({ "on": true, "title": title, "text": "Notice" }));
    let reply = env
        .as_admin(Method::PUT, "/admin/banner", banner("Old"))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let id = env.create().await["id"].as_str().unwrap().to_owned();

    env.as_admin(Method::PUT, "/admin/banner", banner("New"))
        .await;
    db::call(&env.state.db, |conn| {
        Ok(conn.execute(
            "INSERT INTO servers (id, label, base_url, domains_json) \
             VALUES ('new', 'New', 'https://mail.example.com', '[]')",
            [],
        )?)
    })
    .await
    .unwrap();
    env.state.load().await.unwrap();
    let csp = |response: axum::response::Response| {
        response.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
            .to_owned()
    };
    let config = env.raw(Method::GET, "/public/config", None, None).await;
    assert!(csp(config).contains("https://mail.example.com"));

    assert_eq!(env.restore(&id).await.status, StatusCode::OK);

    let config = env.raw(Method::GET, "/public/config", None, None).await;
    assert!(!csp(config).contains("https://mail.example.com"));
    let config = env
        .request(Method::GET, "/public/config", None, None)
        .await
        .json();
    assert_eq!(config["banner"]["title"], "Old");
}

#[tokio::test]
async fn an_older_backup_reports_no_update_at_the_next_start() {
    let env = env().await;
    let id = env.create().await["id"].as_str().unwrap().to_owned();
    env.rewrite(&env.list()[0], |conn| {
        conn.execute("UPDATE update_state SET installed_version = '0.0.1'", [])
            .unwrap();
    });

    assert_eq!(env.restore(&id).await.status, StatusCode::OK);

    let installed = db::call(&env.state.db, |conn| {
        Ok(update_state::load(conn)?.installed_version)
    })
    .await
    .unwrap();
    assert_eq!(installed.as_deref(), Some(updates::VERSION));
}

/// Links from mails that ended since the backup do not come back: no reset,
/// no email change, no revoked invitation; open invitations stay.
#[tokio::test]
async fn restoring_brings_back_no_ended_links() {
    let env = env().await;
    db::call(&env.state.db, |conn| {
        let user: String =
            conn.query_row("SELECT id FROM users WHERE username = 'ben'", [], |r| {
                r.get(0)
            })?;
        conn.execute(
            "INSERT INTO password_resets (id, user_id, token_hash, expires_at) \
             VALUES ('r1', ?1, randomblob(32), '2999-01-01T00:00:00Z')",
            [&user],
        )?;
        conn.execute(
            "INSERT INTO email_changes (id, user_id, token_hash, new_email, expires_at) \
             VALUES ('e1', ?1, randomblob(32), 'ben@new.example', '2999-01-01T00:00:00Z')",
            [&user],
        )?;
        for (id, email) in [("i1", "open@example.com"), ("i2", "revoked@example.com")] {
            conn.execute(
                "INSERT INTO invitations (id, email, role, token_hash, token_enc, expires_at) \
                 VALUES (?1, ?2, 'admin', randomblob(32), x'00', '2999-01-01T00:00:00Z')",
                [id, email],
            )?;
        }
        Ok(())
    })
    .await
    .unwrap();
    let id = env.create().await["id"].as_str().unwrap().to_owned();
    db::call(&env.state.db, |conn| {
        conn.execute("DELETE FROM invitations WHERE id = 'i2'", [])?;
        conn.execute("UPDATE invitations SET role = 'user' WHERE id = 'i1'", [])?;
        conn.execute("UPDATE password_resets SET used_at = expires_at", [])?;
        Ok(())
    })
    .await
    .unwrap();

    let reply = env.restore(&id).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let left: (i64, i64, Vec<String>) = db::call(&env.state.db, |conn| {
        let count = |table: &str| -> rusqlite::Result<i64> {
            conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        };
        let mut invites = conn.prepare("SELECT id || ':' || role FROM invitations ORDER BY id")?;
        let invites = invites
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok((count("password_resets")?, count("email_changes")?, invites))
    })
    .await
    .unwrap();
    // i1 with the role of the running state, not the one from the backup.
    assert_eq!(left, (0, 0, vec!["i1:user".to_owned()]));
}

/// Whoever loses the rights during preparation resets nothing:
/// the check runs again right before the copy. Here with the state of the
/// request (`AuthUser`) after the demotion or sign-out.
#[tokio::test]
async fn restoring_needs_the_rights_until_the_copy() {
    let env = env().await;
    env.create().await;
    let backup = env.list().remove(0);
    env.add_user("lena", "Lena Newman", Role::Admin).await;
    env.session("lena").await;
    let lena = db::call(&env.state.db, |conn| {
        Ok(conn.query_row(
            "SELECT u.id, s.id FROM users AS u JOIN sessions AS s ON s.user_id = u.id \
             WHERE u.username = 'lena'",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?)
    })
    .await
    .unwrap();
    let admin = AuthUser {
        id: lena.0,
        username: "lena".into(),
        email: "lena@example.com".into(),
        display_name: "Lena Newman".into(),
        role: Role::Admin,
        session_id: lena.1,
    };
    let entry = || Entry::new(Category::System, "backups.restore");

    db::call(&env.state.db, |conn| {
        conn.execute("UPDATE users SET role = 'user' WHERE username = 'lena'", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let error = backups::restore(&env.state, &backup, admin.clone(), entry())
        .await
        .unwrap_err();
    assert_eq!(error.downcast_ref(), Some(&Refused::Forbidden));
    db::call(&env.state.db, |conn| {
        conn.execute(
            "UPDATE users SET role = 'admin' WHERE username = 'lena'",
            [],
        )?;
        conn.execute(
            "DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'lena')",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let error = backups::restore(&env.state, &backup, admin, entry())
        .await
        .unwrap_err();
    assert_eq!(error.downcast_ref(), Some(&Refused::Unauthorized));
    // Nothing reset: Lena still exists.
    assert!(env.usernames().await.contains(&"lena".to_owned()));
}

/// The handler checks maintenance mode before the preparation, the restore
/// again right before the copy: turned off in between, nothing is reset.
#[tokio::test]
async fn restoring_needs_maintenance_mode_until_the_copy() {
    let env = env().await;
    env.create().await;
    let backup = env.list().remove(0);
    env.add_user("tom", "Tom Newman", Role::User).await;
    let anna = db::call(&env.state.db, |conn| {
        Ok(conn.query_row(
            "SELECT u.id, s.id FROM users AS u JOIN sessions AS s ON s.user_id = u.id \
             WHERE u.username = 'anna'",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?)
    })
    .await
    .unwrap();
    let admin = AuthUser {
        id: anna.0,
        username: "anna".into(),
        email: "anna@example.com".into(),
        display_name: "Anna Becker".into(),
        role: Role::Admin,
        session_id: anna.1,
    };
    env.maintenance(true).await;
    env.maintenance(false).await;

    let error = backups::restore(
        &env.state,
        &backup,
        admin,
        Entry::new(Category::System, "backups.restore"),
    )
    .await
    .unwrap_err();

    assert_eq!(error.downcast_ref(), Some(&Refused::Maintenance));
    untouched(&env).await;
}

#[tokio::test]
async fn an_admin_unknown_to_the_backup_loses_the_session() {
    let env = env().await;
    let id = env.create().await["id"].as_str().unwrap().to_owned();
    env.add_user("lena", "Lena Newman", Role::Admin).await;
    let lena = env.session("lena").await;
    env.maintenance(true).await;

    let reply = env
        .request(
            Method::POST,
            &format!("{BACKUPS}/{id}/restore"),
            None,
            Some(&lena),
        )
        .await;

    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let after = env.request(Method::GET, BACKUPS, None, Some(&lena)).await;
    assert_eq!(after.status, StatusCode::UNAUTHORIZED);
    assert_eq!(env.usernames().await, ["anna", "ben", "mia"]);
    // The audit log keeps the name, even without the user.
    let actor: (Option<String>, Option<String>) = db::call(&env.state.db, |conn| {
        Ok(conn.query_row(
            "SELECT actor_id, actor_name FROM audit_log WHERE action = 'backups.restore'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?)
    })
    .await
    .unwrap();
    assert_eq!(actor, (None, Some("Lena Newman".to_owned())));
}

#[tokio::test]
async fn a_new_push_key_does_not_outlive_the_restore() {
    let env = env().await;
    let id = env.create().await["id"].as_str().unwrap().to_owned();
    let before = env.state.vapid().await.unwrap();

    assert_eq!(env.restore(&id).await.status, StatusCode::OK);

    let after = env.state.vapid().await.unwrap();
    assert!(!Arc::ptr_eq(&before, &after));
    let again = env.state.vapid().await.unwrap();
    assert!(Arc::ptr_eq(&after, &again));
}

/// Number of users; shows that a rejected backup changes nothing.
async fn untouched(env: &Env) {
    assert_eq!(env.usernames().await, ["anna", "ben", "mia", "tom"]);
    assert_eq!(
        env.as_admin(Method::GET, BACKUPS, None).await.status,
        StatusCode::OK
    );
    assert_eq!(env.leftovers(), Vec::<String>::new());
    assert!(
        env.audit()
            .await
            .iter()
            .all(|(action, _)| action != "backups.restore")
    );
}

#[tokio::test]
async fn a_damaged_file_changes_nothing() {
    let env = env().await;
    let id = env.create().await["id"].as_str().unwrap().to_owned();
    env.add_user("tom", "Tom Newman", Role::User).await;
    let path = env.state.backups.path(&env.list()[0]);
    let good = std::fs::read(&path).unwrap();
    std::fs::write(&path, &good[..good.len() / 2]).unwrap();

    let reply = env.restore(&id).await;

    assert_eq!(
        reply.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        reply.body
    );
    assert_eq!(reply.error(), "backup_invalid");
    untouched(&env).await;
}

#[tokio::test]
async fn a_damaged_database_changes_nothing() {
    let env = env().await;
    let id = env.create().await["id"].as_str().unwrap().to_owned();
    env.add_user("tom", "Tom Newman", Role::User).await;
    let backup = env.list().remove(0);
    let tmp = tempfile::tempdir().unwrap();
    let database = tmp.path().join("copy");
    let path = env.state.backups.path(&backup);
    let manifest = archive::read(&path, &database, &env.state.secrets).unwrap();
    std::fs::write(&database, "not a database, but long enough for a header").unwrap();
    std::fs::remove_file(&path).unwrap();
    archive::write(&database, &manifest, &env.state.secrets, &path).unwrap();

    let reply = env.restore(&id).await;

    assert_eq!(
        reply.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        reply.body
    );
    assert_eq!(reply.error(), "backup_invalid");
    untouched(&env).await;
}

#[tokio::test]
async fn a_backup_from_a_newer_version_changes_nothing() {
    let env = env().await;
    let id = env.create().await["id"].as_str().unwrap().to_owned();
    env.add_user("tom", "Tom Newman", Role::User).await;
    env.rewrite(&env.list()[0], |conn| {
        conn.execute(
            "INSERT INTO schema_migrations (version, name) VALUES (?1, 'future')",
            [migrations::latest_version() + 1],
        )
        .unwrap();
    });

    let reply = env.restore(&id).await;

    assert_eq!(reply.status, StatusCode::CONFLICT, "{}", reply.body);
    assert_eq!(reply.error(), "backup_newer");
    untouched(&env).await;
}

#[tokio::test]
async fn a_backup_with_another_key_changes_nothing() {
    let env = env().await;
    env.add_user("tom", "Tom Newman", Role::User).await;
    let other = self::env().await;
    let id = other.create().await["id"].as_str().unwrap().to_owned();
    let backup = other.list().remove(0);
    env.create().await;
    std::fs::copy(
        other.state.backups.path(&backup),
        env.state.backups.path(&backup),
    )
    .unwrap();

    let reply = env.restore(&id).await;

    assert_eq!(reply.status, StatusCode::CONFLICT, "{}", reply.body);
    assert_eq!(reply.error(), "backup_other_key");
    untouched(&env).await;
}

/// Whoever can write to the backup directory and read a backup, but does not
/// have the instance key, smuggles in no database: neither a changed one nor
/// one with an administrator of their own, packed with the copied manifest
/// (and with it the copied `key`).
#[tokio::test]
async fn a_forged_backup_with_a_copied_key_changes_nothing() {
    let env = env().await;
    let id = env.create().await["id"].as_str().unwrap().to_owned();
    env.add_user("tom", "Tom Newman", Role::User).await;
    let path = env.state.backups.path(&env.list()[0]);
    let manifest = entry(&path, "manifest.json");

    // A database of their own instance, with their own administrator.
    let other = self::env().await;
    other
        .add_user("mallory", "Mallory Example", Role::Admin)
        .await;
    other.create().await;
    let theirs = entry(&other.state.backups.path(&other.list()[0]), db::DB_FILE);
    // The real database, with one more administrator.
    let tmp = tempfile::tempdir().unwrap();
    let changed = tmp.path().join("changed");
    std::fs::write(&changed, entry(&path, db::DB_FILE)).unwrap();
    Connection::open(&changed)
        .unwrap()
        .execute("UPDATE users SET role = 'admin' WHERE username = 'ben'", [])
        .unwrap();
    let changed = std::fs::read(&changed).unwrap();

    for database in [theirs, changed] {
        archive::pack(
            &path,
            &[("manifest.json", &manifest), (db::DB_FILE, &database)],
        )
        .unwrap();
        assert_eq!(env.list().len(), 1, "still in the list");

        let reply = env.restore(&id).await;

        assert_eq!(
            reply.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{}",
            reply.body
        );
        assert_eq!(reply.error(), "backup_invalid");
        untouched(&env).await;
        let ben: String = db::call(&env.state.db, |conn| {
            Ok(
                conn.query_row("SELECT role FROM users WHERE username = 'ben'", [], |row| {
                    row.get(0)
                })?,
            )
        })
        .await
        .unwrap();
        assert_eq!(ben, "user");
    }
}

/// A file that unpacks to more than the limit stops early and leaves nothing
/// behind; zstd packs these 64 MiB into a few kilobytes.
#[tokio::test]
async fn a_backup_that_unpacks_too_large_changes_nothing() {
    let env = env().await;
    let id = env.create().await["id"].as_str().unwrap().to_owned();
    env.add_user("tom", "Tom Newman", Role::User).await;
    let path = env.state.backups.path(&env.list()[0]);
    let manifest = entry(&path, "manifest.json");
    let zeros = vec![0; usize::try_from(archive::MIN_LIMIT).unwrap() + 1];
    archive::pack(
        &path,
        &[("manifest.json", &manifest), (db::DB_FILE, &zeros)],
    )
    .unwrap();
    assert!(std::fs::metadata(&path).unwrap().len() < 1024 * 1024);

    let reply = env.restore(&id).await;

    assert_eq!(
        reply.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        reply.body
    );
    assert_eq!(reply.error(), "backup_invalid");
    untouched(&env).await;
}

/// The first format had no MAC; nothing shows where its database came from.
#[tokio::test]
async fn a_backup_in_the_old_format_changes_nothing() {
    let env = env().await;
    let id = env.create().await["id"].as_str().unwrap().to_owned();
    env.add_user("tom", "Tom Newman", Role::User).await;
    let path = env.state.backups.path(&env.list()[0]);
    let mut manifest: Value = serde_json::from_slice(&entry(&path, "manifest.json")).unwrap();
    manifest["format"] = json!(1);
    manifest.as_object_mut().unwrap().remove("mac");
    let manifest = serde_json::to_vec(&manifest).unwrap();
    let database = entry(&path, db::DB_FILE);
    archive::pack(
        &path,
        &[("manifest.json", &manifest), (db::DB_FILE, &database)],
    )
    .unwrap();

    let reply = env.restore(&id).await;

    assert_eq!(
        reply.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        reply.body
    );
    assert_eq!(reply.error(), "backup_older");
    untouched(&env).await;
}

/// The audit log is not reset: downloads, exports and sign-ins since the
/// backup stay. Entries of people the backup does not know keep the name, but
/// lose the reference.
#[tokio::test]
async fn restoring_keeps_the_audit_log_since_the_backup() {
    let env = env().await;
    let id = env.create().await["id"].as_str().unwrap().to_owned();
    let download = env
        .raw(
            Method::GET,
            &format!("{BACKUPS}/{id}/download"),
            None,
            Some(&env.admin),
        )
        .await;
    assert_eq!(download.status(), StatusCode::OK);
    let export = env
        .as_admin(Method::POST, "/admin/audit/export", None)
        .await;
    assert_eq!(export.status, StatusCode::OK, "{}", export.body);
    env.add_user("lena", "Lena Newman", Role::Admin).await;
    env.session("lena").await;
    let lena: String = db::call(&env.state.db, |conn| {
        Ok(
            conn.query_row("SELECT id FROM users WHERE username = 'lena'", [], |row| {
                row.get(0)
            })?,
        )
    })
    .await
    .unwrap();
    env.maintenance(true).await;
    let before = env.audit_rows().await;
    for action in ["backups.create", "backups.download", "audit.export"] {
        assert!(before.iter().any(|row| row.0 == action), "{action}");
    }
    assert!(
        before
            .iter()
            .any(|row| row.0 == "auth.login" && row.1.as_ref() == Some(&lena))
    );

    let reply = env.restore(&id).await;

    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(env.usernames().await, ["anna", "ben", "mia"]);
    let after = env.audit_rows().await;
    let (restore, kept) = after.split_last().unwrap();
    assert_eq!(restore.0, "backups.restore");
    let expected: Vec<_> = before
        .into_iter()
        .map(|(action, actor, name)| (action, actor.filter(|id| *id != lena), name))
        .collect();
    assert_eq!(kept, expected);
    assert!(kept.iter().any(|row| row.0 == "auth.login"
        && row.1.is_none()
        && row.2.as_deref() == Some("Lena Newman")));
}

#[tokio::test]
async fn a_copied_file_appears_in_the_list() {
    let env = env().await;
    env.create().await;
    let backup = env.list().remove(0);
    let copy = backup.file.replace("-manual-", "-auto-");
    let dir = env.state.backups.path(&backup);
    std::fs::copy(&dir, dir.with_file_name(copy)).unwrap();
    std::fs::write(dir.with_file_name("notes.txt"), "foreign").unwrap();

    let view = env.show().await;

    let autos: Vec<_> = view["backups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["auto"].as_bool().unwrap())
        .collect();
    assert_eq!(autos.len(), 2);
    assert!(autos.contains(&true));
}

#[tokio::test]
async fn the_job_creates_one_backup_and_tells_the_admins() {
    let env = env().await;

    env.run_job().await;

    let backups = env.list();
    assert_eq!(backups.len(), 1);
    assert!(backups[0].auto);
    let size = backups[0].size;
    let params = json!({ "size": size });
    assert_eq!(
        env.notifications().await,
        [
            (
                "anna".to_owned(),
                "system.backup_ok".to_owned(),
                params.clone()
            ),
            (
                "mia".to_owned(),
                "system.backup_ok".to_owned(),
                params.clone()
            ),
        ]
    );
    assert_eq!(
        env.audit().await,
        [("backups.auto".to_owned(), Some(params))]
    );

    // The next run is one day later.
    env.run_job().await;
    assert_eq!(env.list().len(), 1);
    let next: jiff::Timestamp = env.show().await["next_at"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let hours = (next.as_second() - jiff::Timestamp::now().as_second()) / 3600;
    assert!((23..=24).contains(&hours), "{hours}");
}

#[tokio::test]
async fn the_job_keeps_to_the_switch_and_the_setup() {
    let env = env().await;
    env.as_admin(Method::PUT, SCHEDULE, Some(json!({ "auto": false })))
        .await;
    env.run_job().await;
    assert_eq!(env.list(), []);

    env.as_admin(Method::PUT, SCHEDULE, Some(json!({ "auto": true })))
        .await;
    db::call(&env.state.db, |conn| {
        Ok(conn.execute("DELETE FROM users", [])?)
    })
    .await
    .unwrap();
    env.run_job().await;
    assert_eq!(env.list(), []);
}

#[tokio::test]
async fn the_job_waits_for_a_running_backup() {
    let env = env().await;
    let running = env.state.backups.try_begin().unwrap();

    env.run_job().await;
    assert_eq!(env.list(), []);

    drop(running);
    env.run_job().await;
    assert_eq!(env.list().len(), 1);
}

#[tokio::test]
async fn the_job_deletes_old_backups_only_after_a_success() {
    let env = env().await;
    env.create().await;
    let manual = env.list().remove(0);
    let path = env.state.backups.path(&manual);
    let id = "01KA0000000000000000000000";
    let old = path.with_file_name(format!("roedy-mail-20200101T000000Z-auto-{id}.tar.zst"));
    let old_manual =
        path.with_file_name(format!("roedy-mail-20200101T000000Z-manual-{id}.tar.zst"));
    std::fs::write(&old, "old").unwrap();
    std::fs::write(&old_manual, "old").unwrap();

    // Without a new backup everything stays: it is off, and the last rescue
    // should not expire.
    env.as_admin(Method::PUT, SCHEDULE, Some(json!({ "auto": false })))
        .await;
    env.run_job().await;
    assert!(old.exists());

    env.as_admin(Method::PUT, SCHEDULE, Some(json!({ "auto": true })))
        .await;
    env.run_job().await;

    assert!(!old.exists());
    assert!(old_manual.exists());
    assert_eq!(env.list().iter().filter(|b| b.auto).count(), 1);
}

#[tokio::test]
async fn a_failure_is_reported_once_and_tried_again_at_the_next_slot() {
    let env = env().await;
    // A file instead of the directory: like an unusable drive.
    let dir = env.tmp.path().join("backups");
    std::fs::write(&dir, "in the way").unwrap();

    env.run_job().await;
    env.run_job().await;

    assert_eq!(
        env.notifications().await,
        [
            (
                "anna".to_owned(),
                "system.backup_failed".to_owned(),
                json!({})
            ),
            (
                "mia".to_owned(),
                "system.backup_failed".to_owned(),
                json!({})
            ),
        ]
    );
    assert_eq!(env.audit().await, [("backups.failed".to_owned(), None)]);
}

#[tokio::test]
async fn a_failed_manual_backup_answers_with_an_error_and_is_logged() {
    let env = env().await;
    std::fs::write(env.tmp.path().join("backups"), "in the way").unwrap();

    let reply = env.as_admin(Method::POST, BACKUPS, None).await;

    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(env.audit().await, [("backups.failed".to_owned(), None)]);
    assert_eq!(env.notifications().await, []);
}
