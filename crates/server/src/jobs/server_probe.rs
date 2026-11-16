//! Daily server diagnosis: servers of the registry whose last test
//! (automatic or manual under Administration › Mail servers) is more than a
//! day ago are checked as with "Test connection". The job runs
//! hourly so that restarts do not shift the rhythm.

use std::time::Duration;

use super::Job;
use crate::{app::AppState, broker::probe, db, db::repo::servers};

pub fn job() -> Job<AppState> {
    Job {
        name: "server_probe",
        first: Duration::from_secs(5 * 60),
        every: Duration::from_secs(60 * 60),
        run: |state| Box::pin(run(state)),
        wake: None,
    }
}

async fn run(state: AppState) -> anyhow::Result<()> {
    let due = db::call(&state.db, |conn| {
        servers::due_for_test(conn, Duration::from_secs(24 * 60 * 60))
    })
    .await?;
    for server in due {
        // One after the other; an error only affects this server.
        if let Err(error) = probe::test_registered(&state, &server, true).await {
            tracing::warn!(server = %server.id, "diagnosis not stored: {error:#}");
        }
    }
    Ok(())
}
