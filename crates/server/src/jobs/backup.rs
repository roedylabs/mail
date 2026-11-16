//! Scheduled backups: checks every
//! minute whether the schedule from Administration › Maintenance is due.
//! Pruning old backups follows a successful one (`backups::scheduled`).

use std::time::Duration;

use super::Job;
use crate::{app::AppState, backups};

pub fn job() -> Job<AppState> {
    Job {
        name: "backup",
        first: Duration::from_secs(60),
        every: Duration::from_secs(60),
        run: |state| Box::pin(run(state)),
        wake: None,
    }
}

pub async fn run(state: AppState) -> anyhow::Result<()> {
    backups::scheduled(&state).await
}
