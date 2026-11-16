//! Background jobs: [`scheduler`] runs them,
//! [`start`] registers the jobs of `roedy-mail serve`.

pub mod audit_retention;
pub mod backup;
pub mod geoip_reload;
pub mod notification_cleanup;
pub mod notification_mailer;
pub mod push_sender;
pub mod quota_check;
pub mod scheduler;
pub mod server_probe;
pub mod session_cleanup;
pub mod token_refresh;
pub mod update_check;

use crate::app::AppState;
pub use scheduler::{Job, Scheduler};

/// Starts the server's jobs; [`Scheduler::shutdown`] stops them.
pub fn start(state: &AppState) -> Scheduler {
    let mut jobs = vec![
        session_cleanup::job(),
        audit_retention::job(),
        server_probe::job(),
        token_refresh::job(),
        quota_check::job(),
        notification_cleanup::job(),
        notification_mailer::job(),
        push_sender::job(),
        update_check::job(),
        backup::job(),
    ];
    if state.geoip.is_some() {
        jobs.push(geoip_reload::job());
    }
    Scheduler::start(state, jobs)
}
