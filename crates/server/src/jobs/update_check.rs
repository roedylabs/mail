//! Check for new versions: checks
//! every minute whether the schedule from Administration › Updates is due,
//! and then asks GitHub. A failed attempt counts as a check, the
//! next one follows at the next date.

use std::time::Duration;

use jiff::Timestamp;

use super::Job;
use crate::{app::AppState, db, updates};

pub fn job() -> Job<AppState> {
    Job {
        name: "update_check",
        first: Duration::from_secs(60),
        every: Duration::from_secs(60),
        run: |state| Box::pin(run(state)),
        wake: None,
    }
}

pub async fn run(state: AppState) -> anyhow::Result<()> {
    let now = Timestamp::now();
    if db::call(&state.db, move |conn| updates::due(conn, now)).await? {
        updates::check(&state).await?;
    }
    Ok(())
}
