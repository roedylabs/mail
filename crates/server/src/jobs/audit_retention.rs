//! Audit log retention (daily): deletes what is older than the
//! configured period (30, 90 or 365 days, `audit_log::keep_days`).
//! Reading and export already hide such entries; the cleanup keeps the
//! table small and removes IP addresses and places of old entries.

use std::time::Duration;

use super::Job;
use crate::{app::AppState, db, db::repo::audit_log};

pub fn job() -> Job<AppState> {
    Job {
        name: "audit_retention",
        first: Duration::from_secs(10 * 60),
        every: Duration::from_secs(24 * 60 * 60),
        run: |state| Box::pin(run(state)),
        wake: None,
    }
}

pub async fn run(state: AppState) -> anyhow::Result<()> {
    let deleted = db::call(&state.db, |conn| {
        let days = audit_log::keep_days(conn)?;
        Ok(audit_log::delete_old(conn, days)?)
    })
    .await?;
    if deleted > 0 {
        tracing::info!(deleted, "old audit log entries deleted");
    }
    Ok(())
}
