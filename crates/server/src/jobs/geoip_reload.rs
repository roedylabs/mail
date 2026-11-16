//! Reload the GeoIP database (daily) when a tool like `geoipupdate` has
//! replaced the file. Only with `ROEDY_GEOIP_DB`.

use std::time::Duration;

use super::Job;
use crate::{app::AppState, db};

const DAY: Duration = Duration::from_secs(24 * 60 * 60);

pub fn job() -> Job<AppState> {
    Job {
        name: "geoip_reload",
        first: DAY,
        every: DAY,
        run: |state| Box::pin(run(state)),
        wake: None,
    }
}

async fn run(state: AppState) -> anyhow::Result<()> {
    let Some(geoip) = state.geoip.clone() else {
        return Ok(());
    };
    // Reading and checking the file blocks.
    let reloaded = db::blocking(move || {
        let reloaded = geoip.reload_if_changed()?;
        Ok((reloaded, geoip))
    })
    .await?;
    if let (true, geoip) = reloaded {
        tracing::info!(path = %geoip.path().display(), "GeoIP database reloaded");
    }
    Ok(())
}
