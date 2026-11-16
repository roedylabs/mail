//! Early refresh: accounts for which the browser
//! fetched an access token in the last hour get a new one
//! before the old one expires – so the browser does not wait for the mail
//! server on its next fetch. The job runs every minute; errors are already
//! in the token broker's log.

use std::time::Duration;

use super::Job;
use crate::{
    app::AppState,
    broker::token::{self, ACTIVE, PREFETCH_MARGIN},
    db::{self, repo::mail_accounts},
};

pub fn job() -> Job<AppState> {
    Job {
        name: "token_refresh",
        first: Duration::from_secs(60),
        every: Duration::from_secs(60),
        run: |state| Box::pin(run(state)),
        wake: None,
    }
}

async fn run(state: AppState) -> anyhow::Result<()> {
    let due = db::call(&state.db, |conn| {
        Ok(mail_accounts::due_for_refresh(
            conn,
            ACTIVE,
            PREFETCH_MARGIN,
        )?)
    })
    .await?;
    for id in due {
        // One after the other; an error only affects this account.
        if let Err(token::Error::Internal(error)) = token::prefetch(&state, &id).await {
            tracing::warn!(account = %id, "early refresh failed: {error:#}");
        }
    }
    Ok(())
}
