//! Delete expired sessions and links from mails (hourly). They are no
//! longer valid anyway (`sessions::authenticate` and the links check the
//! expiry); the cleanup keeps the tables small and removes IP addresses
//! nobody needs any more. Pending email changes stay until the
//! person discards or replaces them (`email_changes::delete_stale`).

use std::time::Duration;

use super::Job;
use crate::{
    app::AppState,
    db,
    db::repo::{email_changes, password_resets, sessions},
};

pub fn job() -> Job<AppState> {
    Job {
        name: "session_cleanup",
        first: Duration::from_secs(60),
        every: Duration::from_secs(60 * 60),
        run: |state| Box::pin(run(state)),
        wake: None,
    }
}

async fn run(state: AppState) -> anyhow::Result<()> {
    let (deleted, links) = db::call(&state.db, |conn| {
        let deleted = sessions::delete_expired(conn)?;
        let links = password_resets::delete_expired(conn)? + email_changes::delete_stale(conn)?;
        Ok((deleted, links))
    })
    .await?;
    if deleted > 0 {
        tracing::info!(deleted, "expired sessions deleted");
    }
    if links > 0 {
        tracing::info!(deleted = links, "expired links from mails deleted");
    }
    Ok(())
}
