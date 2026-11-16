//! Operational endpoints: `/healthz` reports that the process
//! responds, `/readyz` that it can serve requests (database readable).

use std::time::Duration;

use axum::{
    Json,
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;

use crate::{app::AppState, db};

const READY_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Serialize)]
struct Health {
    status: &'static str,
}

fn respond(code: StatusCode, status: &'static str) -> Response {
    (
        code,
        [(header::CACHE_CONTROL, "no-store")],
        Json(Health { status }),
    )
        .into_response()
}

pub async fn healthz() -> Response {
    respond(StatusCode::OK, "ok")
}

pub async fn readyz(State(state): State<AppState>) -> Response {
    // Reads a table instead of `SELECT 1` so that file errors (I/O, locks)
    // show up as well.
    let probe = db::call(&state.db, |conn| {
        Ok(
            conn.query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get::<_, i64>(0)
            })?,
        )
    });
    match tokio::time::timeout(READY_TIMEOUT, probe).await {
        Ok(Ok(_)) => respond(StatusCode::OK, "ok"),
        Ok(Err(error)) => {
            tracing::warn!(%error, "database not ready");
            respond(StatusCode::SERVICE_UNAVAILABLE, "unavailable")
        }
        Err(_) => {
            tracing::warn!(timeout = ?READY_TIMEOUT, "database not responding");
            respond(StatusCode::SERVICE_UNAVAILABLE, "unavailable")
        }
    }
}
