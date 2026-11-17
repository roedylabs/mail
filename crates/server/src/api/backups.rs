//! Administration › Maintenance: backups.
//!
//! - `GET admin/backups`: list, schedule and next run. `legacy` marks a backup
//!   in the older format without an authenticity value: it cannot be restored.
//! - `POST admin/backups`: "Back up now".
//! - `PUT admin/backups/schedule`: changes the given fields.
//! - `GET admin/backups/:id/download`: the file.
//! - `POST admin/backups/:id/restore`: resets all data, only in maintenance
//!   mode (otherwise 409 `maintenance_required`) and only with a fitting
//!   authenticity value (otherwise 422 `backup_unverified`). The page asks for
//!   confirmation (`Sicherung wiederherstellen?`).
//! - `DELETE admin/backups/:id`.
//!
//! Only one backup or restore runs at a time; meanwhile nothing can be
//! deleted either (409 `backup_running`).

use std::{io, sync::Arc};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse as _, Response},
    routing::{delete, get, post, put},
};
use futures_util::{Stream, stream};
use jiff::Timestamp;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::{fs::File, io::AsyncReadExt as _};

use super::{ApiError, FieldErrors, JsonBody, servers::audit_entry};
use crate::{
    app::AppState,
    auth::AdminUser,
    backups::{self, Backup, Backups, Every, KEEP_DAYS, Refused},
    client_ip::ClientIp,
    db::{
        self,
        repo::audit_log::{self, Category},
    },
};

/// Chunks of the download.
const CHUNK: usize = 64 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/admin/backups", get(show).post(create))
        .route("/admin/backups/schedule", put(schedule))
        .route("/admin/backups/{id}", delete(remove))
        .route("/admin/backups/{id}/download", get(download))
        .route("/admin/backups/{id}/restore", post(restore))
}

/// Row of the list, size in bytes.
#[derive(Debug, Serialize)]
struct Row {
    id: String,
    at: String,
    size: u64,
    auto: bool,
    /// In the older format without an authenticity value
    /// ([`backups::Backups::legacy`]): restoring it is refused.
    legacy: bool,
}

impl From<(Backup, bool)> for Row {
    fn from((backup, legacy): (Backup, bool)) -> Self {
        Self {
            id: backup.id,
            at: backup.at.to_string(),
            size: backup.size,
            auto: backup.auto,
            legacy,
        }
    }
}

/// The backups and their `legacy` flags, in the same order.
type Scan = (Vec<Backup>, Vec<bool>);

/// Response of `GET`, `schedule` and `restore`.
#[derive(Debug, Serialize)]
struct View {
    backups: Vec<Row>,
    auto: bool,
    every: Every,
    /// Retention in days.
    keep: u32,
    /// `null` when none is scheduled ("Off").
    next_at: Option<String>,
}

impl View {
    /// `list` and the `legacy` flag of each backup, read beforehand
    /// ([`Self::scan`]); this only reads the database.
    fn load(conn: &Connection, (list, legacy): Scan) -> anyhow::Result<Self> {
        let settings = backups::load(conn)?;
        let now = Timestamp::now();
        let next_at = settings.next_at(backups::last_run(conn, &list)?, now);
        Ok(Self {
            backups: list.into_iter().zip(legacy).map(Row::from).collect(),
            auto: settings.auto,
            every: settings.every,
            keep: settings.keep,
            // A missed run does not lie in the past; the job catches up on it
            // right away.
            next_at: next_at.map(|at| at.max(now).to_string()),
        })
    }

    /// The list with the `legacy` flag of each backup. Reads the directory and
    /// a part of every file: on a blocking thread of its own, so that a slow
    /// backup directory (a share) does not hold up the database thread.
    async fn scan(backups: Arc<Backups>) -> anyhow::Result<Scan> {
        db::blocking(move || {
            let list = backups.list()?;
            let legacy = list.iter().map(|backup| backups.legacy(backup)).collect();
            Ok((list, legacy))
        })
        .await
    }
}

async fn view(state: &AppState) -> Result<Json<View>, ApiError> {
    let list = View::scan(state.backups.clone()).await?;
    let view = db::call(&state.db, move |conn| View::load(conn, list)).await?;
    Ok(Json(view))
}

async fn show(State(state): State<AppState>, _: AdminUser) -> Result<Json<View>, ApiError> {
    view(&state).await
}

fn running() -> ApiError {
    ApiError::rejected(StatusCode::CONFLICT, "backup_running")
}

/// The backup `id`, otherwise 404.
async fn find(state: &AppState, id: String) -> Result<Backup, ApiError> {
    let backups = state.backups.clone();
    db::blocking(move || Ok(backups.find(&id)?))
        .await?
        .ok_or(ApiError::NotFound)
}

/// "Back up now". Runs to the end and lands in the audit log, even if the
/// request is aborted before. Events exist only for scheduled backups: here
/// the person sees the result themselves.
async fn create(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
) -> Result<(StatusCode, Json<Row>), ApiError> {
    let guard = state.backups.try_begin().ok_or_else(running)?;
    let backup = tokio::spawn(async move {
        let _running = guard;
        let result = backups::create(&state, false).await;
        let entry = match &result {
            Ok(backup) => audit_entry(Category::System, "backups.create", &user, ip)
                .details(json!({ "size": backup.size })),
            Err(_) => audit_entry(Category::System, "backups.failed", &user, ip),
        };
        db::call(&state.db, move |conn| Ok(audit_log::insert(conn, &entry)?)).await?;
        result
    })
    .await
    .map_err(anyhow::Error::from)??;
    // A new backup always carries the authenticity value.
    Ok((StatusCode::CREATED, Json(Row::from((backup, false)))))
}

/// Body of `schedule`: the changed fields.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScheduleBody {
    auto: Option<bool>,
    every: Option<Every>,
    keep: Option<u32>,
}

async fn schedule(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
    JsonBody(body): JsonBody<ScheduleBody>,
) -> Result<Json<View>, ApiError> {
    if body.keep.is_some_and(|keep| !KEEP_DAYS.contains(&keep)) {
        let mut errors = FieldErrors::default();
        errors.code("keep", "invalid");
        return Err(errors.into_error());
    }
    db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        let before = backups::load(&tx)?;
        let next = backups::Settings {
            auto: body.auto.unwrap_or(before.auto),
            every: body.every.unwrap_or(before.every),
            keep: body.keep.unwrap_or(before.keep),
        };
        if next != before {
            backups::save(&tx, &next)?;
            audit_log::insert(
                &tx,
                &audit_entry(Category::Settings, "backups.schedule", &user, ip)
                    .details(serde_json::to_value(next)?),
            )?;
        }
        tx.commit()?;
        Ok(())
    })
    .await?;
    view(&state).await
}

/// The file in chunks: a large backup should not go into memory. Unlike the
/// audit log export a `GET`, so the browser downloads straight to disk.
async fn download(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let backup = find(&state, id).await?;
    let file = File::open(state.backups.path(&backup))
        .await
        .map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => ApiError::NotFound,
            _ => anyhow::Error::from(error).into(),
        })?;
    let size = file.metadata().await.map_err(anyhow::Error::from)?.len();
    db::call(&state.db, move |conn| {
        audit_log::insert(
            conn,
            &audit_entry(Category::System, "backups.download", &user, ip)
                .details(json!({ "size": size })),
        )?;
        Ok(())
    })
    .await?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/zstd".to_owned()),
            (header::CONTENT_LENGTH, size.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{}\"", backup.file),
            ),
            (header::CACHE_CONTROL, "no-store".to_owned()),
        ],
        Body::from_stream(chunks(file)),
    )
        .into_response())
}

fn chunks(file: File) -> impl Stream<Item = io::Result<Bytes>> {
    stream::try_unfold(file, |mut file| async move {
        let mut chunk = vec![0; CHUNK];
        let read = file.read(&mut chunk).await?;
        chunk.truncate(read);
        Ok((read > 0).then(|| (Bytes::from(chunk), file)))
    })
}

fn maintenance_required() -> ApiError {
    ApiError::rejected(StatusCode::CONFLICT, "maintenance_required")
}

fn refused(error: anyhow::Error) -> ApiError {
    match error.downcast_ref::<Refused>() {
        Some(Refused::Invalid) => {
            ApiError::rejected(StatusCode::UNPROCESSABLE_ENTITY, "backup_invalid")
        }
        Some(Refused::Newer) => ApiError::rejected(StatusCode::CONFLICT, "backup_newer"),
        Some(Refused::Unverified) => {
            ApiError::rejected(StatusCode::UNPROCESSABLE_ENTITY, "backup_unverified")
        }
        Some(Refused::OtherKey) => ApiError::rejected(StatusCode::CONFLICT, "backup_other_key"),
        Some(Refused::Unauthorized) => ApiError::Unauthorized,
        Some(Refused::Forbidden) => ApiError::Forbidden,
        Some(Refused::Maintenance) => maintenance_required(),
        None => error.into(),
    }
}

/// Resets all data. Runs to the end, even if the request is aborted before.
/// The own session stays if the user exists in the backup's state; otherwise
/// the next request leads to the sign-in.
///
/// Only in maintenance mode, so that nobody changes data while it is being
/// reset; otherwise 409 `maintenance_required` (the page shows the switch as
/// off), also if it is turned off before the copy, even if on again by then
/// ([`backups::restore`] checks again). A backup without an authenticity value
/// or with one that does not fit is refused with 422 `backup_unverified`. Like
/// every refused restore, this changes nothing and writes no audit entry.
async fn restore(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
    Path(id): Path<String>,
) -> Result<Json<View>, ApiError> {
    let guard = state.backups.try_begin().ok_or_else(running)?;
    let backup = find(&state, id).await?;
    let maintenance = state
        .maintenance
        .period()
        .ok_or_else(maintenance_required)?;
    let entry = audit_entry(Category::System, "backups.restore", &user, ip)
        .details(json!({ "at": backup.at.to_string() }));
    let worker = state.clone();
    tokio::spawn(async move {
        let _running = guard;
        backups::restore(&worker, &backup, user, entry, maintenance).await
    })
    .await
    .map_err(anyhow::Error::from)?
    .map_err(refused)?;
    view(&state).await
}

/// Deletes the file; not during a backup or restore that might be reading it
/// right now. "Undo" in the page's toast is up to the client.
async fn remove(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let _running = state.backups.try_begin().ok_or_else(running)?;
    let backup = find(&state, id).await?;
    let backups = state.backups.clone();
    let details = json!({ "at": backup.at.to_string(), "size": backup.size });
    let deleted = db::blocking(move || Ok(backups.delete(&backup)?)).await?;
    if !deleted {
        return Err(ApiError::NotFound);
    }
    db::call(&state.db, move |conn| {
        audit_log::insert(
            conn,
            &audit_entry(Category::System, "backups.delete", &user, ip).details(details),
        )?;
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
