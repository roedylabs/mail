//! Administration › Maintenance: maintenance mode and storage.
//!
//! - `GET admin/maintenance`: state with a custom notice, which
//!   `public/config` only names while the mode is on.
//! - `PUT admin/maintenance`: changes the given fields; `null` or an empty
//!   text deletes the notice. Turning it on ends the sessions of all users
//!   without administrator rights. Every switch is recorded in the audit log
//!   and goes to all administrators as an event.
//! - `GET admin/storage`: size of database, backups and logo files in bytes.
//! - `POST admin/storage/compact`: "Compact".

use axum::{
    Json, Router,
    extract::State,
    routing::{get, post},
};
use jiff::Timestamp;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{
    ApiError, FieldErrors, JsonBody, instance::text_error, nullable, servers::audit_entry,
};
use crate::{
    app::AppState,
    auth::AdminUser,
    backups::Backups,
    client_ip::ClientIp,
    db::{
        self,
        repo::{
            app_settings, assets,
            audit_log::{self, Category},
            sessions,
        },
    },
    events, instance,
    web::maintenance::Mode,
};

/// Longest custom notice in characters.
const MAX_MESSAGE: usize = 500;
/// Key in `app_settings`: time of the last compaction.
const COMPACTED_AT: &str = "storage_compacted_at";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/admin/maintenance", get(show).put(update))
        .route("/admin/storage", get(storage))
        .route("/admin/storage/compact", post(compact))
}

async fn show(State(state): State<AppState>, _: AdminUser) -> Json<Mode> {
    Json(state.maintenance.current())
}

/// Body of `PUT`: the changed fields.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Body {
    on: Option<bool>,
    #[serde(default, deserialize_with = "nullable")]
    message: Option<Option<String>>,
}

impl Body {
    /// The trimmed notice, if given; `Some(None)` deletes it.
    fn message(&self) -> Result<Option<Option<String>>, ApiError> {
        let Some(message) = &self.message else {
            return Ok(None);
        };
        let message = message.as_deref().unwrap_or_default().trim();
        // The input field is multi-line.
        if let Some(code) = text_error(&message.replace('\n', " "), MAX_MESSAGE) {
            let mut errors = FieldErrors::default();
            errors.code("message", code);
            return Err(errors.into_error());
        }
        Ok(Some((!message.is_empty()).then(|| message.to_owned())))
    }
}

/// Turning on, turning off and changing the notice. Sessions, audit log and
/// event belong to the switch, not to turning it on again. The in-memory state
/// follows on the database thread, so concurrent calls set it in the order of
/// their transactions.
async fn update(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
    JsonBody(body): JsonBody<Body>,
) -> Result<Json<Mode>, ApiError> {
    let message = body.message()?;
    let on = body.on;
    let maintenance = state.maintenance.clone();
    let mode = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        let before = Mode::load(&tx)?;
        let next = Mode {
            on: on.unwrap_or(before.on),
            message: message.unwrap_or_else(|| before.message.clone()),
        };
        if next != before {
            next.save(&tx)?;
        }
        if next.on != before.on {
            let entry = if next.on {
                let ended = sessions::delete_for_non_admins(&tx)?;
                audit_entry(Category::System, "maintenance.on", &user, ip)
                    .details(json!({ "sessions": ended }))
            } else {
                audit_entry(Category::System, "maintenance.off", &user, ip)
            };
            audit_log::insert(&tx, &entry)?;
            events::maintenance(&tx, next.on, &user.display_name)?;
        }
        tx.commit()?;
        maintenance.set(next.clone());
        Ok(next)
    })
    .await?;
    Ok(Json(mode))
}

/// Response of `storage` and `storage/compact`, sizes in bytes.
#[derive(Debug, Serialize)]
struct Storage {
    /// Without the logo files stored in the database, so the rows of the page
    /// do not count the used space twice.
    database: i64,
    /// All backups together.
    backups: u64,
    /// Their number (`1 Sicherung`, `Keine Sicherungen`).
    backup_count: usize,
    assets: i64,
    /// File name of the logo (`imageName`), if there is one.
    asset_name: Option<String>,
    /// Last compaction.
    compacted_at: Option<String>,
}

impl Storage {
    fn load(
        conn: &Connection,
        backups: &Backups,
        asset_name: Option<String>,
    ) -> anyhow::Result<Self> {
        let assets = assets::size(conn)?;
        // The page still shows the database then, and nothing went wrong
        // after compacting.
        let (backups, backup_count) = backups.usage().unwrap_or_else(|error| {
            tracing::warn!("backups not readable: {error}");
            (0, 0)
        });
        Ok(Self {
            database: (db::size(conn)? - assets).max(0),
            backups,
            backup_count,
            assets,
            asset_name,
            compacted_at: instance::load(conn, COMPACTED_AT, |_| None)?.flatten(),
        })
    }
}

/// `imageName` of the branding, as long as it has a logo.
fn asset_name(state: &AppState) -> Option<String> {
    let branding = state.instance.branding();
    let branding = &branding.branding;
    (branding.image.is_some() && !branding.image_name.is_empty())
        .then(|| branding.image_name.clone())
}

async fn storage(State(state): State<AppState>, _: AdminUser) -> Result<Json<Storage>, ApiError> {
    let name = asset_name(&state);
    let backups = state.backups.clone();
    let storage = db::call(&state.db, move |conn| Storage::load(conn, &backups, name)).await?;
    Ok(Json(storage))
}

/// Cleans up the database and raises the version of the browsers' cache. If
/// `VACUUM` fails (say without room for the copy), everything stays as it
/// was.
async fn compact(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
) -> Result<Json<Storage>, ApiError> {
    let name = asset_name(&state);
    let current = state.instance.clone();
    let backups = state.backups.clone();
    let storage = db::call(&state.db, move |conn| {
        db::compact(conn)?;
        let tx = conn.transaction()?;
        let version = instance::load_client_cache_version(&tx)? + 1;
        app_settings::set(&tx, instance::CLIENT_CACHE_VERSION, &version)?;
        app_settings::set(&tx, COMPACTED_AT, &Timestamp::now().to_string())?;
        audit_log::insert(
            &tx,
            &audit_entry(Category::System, "storage.compact", &user, ip),
        )?;
        tx.commit()?;
        current.set_client_cache_version(version);
        Storage::load(conn, &backups, name)
    })
    .await?;
    Ok(Json(storage))
}
