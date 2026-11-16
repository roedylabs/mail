//! Table `update_state`: result of the last check and known versions.
//! Exactly one row, created by the migration.

use jiff::Timestamp;
use rusqlite::Connection;

/// The row of `update_state`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpdateState {
    /// Latest version according to the last successful check.
    pub latest: Option<String>,
    /// First item of its release notes for "New in version …".
    pub summary: Option<String>,
    /// Last attempt, including a failed one.
    pub checked_at: Option<String>,
    /// Reason if the last attempt failed (`updates::Failure`).
    pub reason: Option<String>,
    pub last_notified_version: Option<String>,
    pub installed_version: Option<String>,
}

impl UpdateState {
    /// Time of the last attempt; also `None` if it is unreadable.
    pub fn checked(&self) -> Option<Timestamp> {
        self.checked_at.as_deref().and_then(|at| at.parse().ok())
    }
}

pub fn load(conn: &Connection) -> rusqlite::Result<UpdateState> {
    conn.query_row(
        "SELECT latest, summary, checked_at, reason, last_notified_version, installed_version \
         FROM update_state WHERE id = 1",
        [],
        |row| {
            Ok(UpdateState {
                latest: row.get(0)?,
                summary: row.get(1)?,
                checked_at: row.get(2)?,
                reason: row.get(3)?,
                last_notified_version: row.get(4)?,
                installed_version: row.get(5)?,
            })
        },
    )
}

/// Successful check; `latest` is `None` if there is no release yet.
pub fn succeeded(
    conn: &Connection,
    latest: Option<&str>,
    summary: Option<&str>,
    at: Timestamp,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE update_state SET latest = ?1, summary = ?2, checked_at = ?3, reason = NULL \
         WHERE id = 1",
        (latest, summary, at.to_string()),
    )
    .map(drop)
}

/// Failed check: the last known version stays.
pub fn failed(conn: &Connection, reason: &str, at: Timestamp) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE update_state SET checked_at = ?2, reason = ?1 WHERE id = 1",
        (reason, at.to_string()),
    )
    .map(drop)
}

pub fn set_notified(conn: &Connection, version: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE update_state SET last_notified_version = ?1 WHERE id = 1",
        [version],
    )
    .map(drop)
}

pub fn set_installed(conn: &Connection, version: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE update_state SET installed_version = ?1 WHERE id = 1",
        [version],
    )
    .map(drop)
}
