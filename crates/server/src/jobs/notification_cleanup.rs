//! Notification retention (daily): deletes what is older than
//! [`notifications::KEEP_DAYS`] and, per user, everything beyond the
//! newest [`notifications::MAX_PER_USER`]. The bell shows no more than
//! that anyway; the cleanup keeps the table small and removes the place and
//! truncated IP addresses of old sign-ins.

use std::time::Duration;

use super::Job;
use crate::{app::AppState, db, db::repo::notifications};

pub fn job() -> Job<AppState> {
    Job {
        name: "notification_cleanup",
        first: Duration::from_secs(5 * 60),
        every: Duration::from_secs(24 * 60 * 60),
        run: |state| Box::pin(run(state)),
        wake: None,
    }
}

async fn run(state: AppState) -> anyhow::Result<()> {
    let deleted = db::call(&state.db, |conn| {
        Ok(notifications::delete_old(
            conn,
            notifications::KEEP_DAYS,
            notifications::MAX_PER_USER,
        )?)
    })
    .await?;
    if deleted > 0 {
        tracing::info!(deleted, "old notifications deleted");
    }
    Ok(())
}
