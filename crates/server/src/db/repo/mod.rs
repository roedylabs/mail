//! Data access per table. The functions are synchronous and run in
//! `db::call` or in `spawn_blocking`.

pub mod app_settings;
pub mod assets;
pub mod audit_log;
pub mod email_changes;
pub mod invitations;
pub mod known_devices;
pub mod mail_accounts;
pub mod notification_deliveries;
pub mod notifications;
pub mod password_resets;
pub mod push_subscriptions;
pub mod recovery_codes;
pub mod servers;
pub mod sessions;
pub mod tags;
pub mod totp_devices;
pub mod update_state;
pub mod user_settings;
pub mod users;

use rusqlite::Connection;

/// Discards all open links from a user's mails: email address changes (also
/// reserved ones) and password reset links. For the steps `security_email`
/// recommends (change or reset the password, "Sign out all others"), for
/// `reset-admin`, on locking and after confirming a new address – a link sent
/// to the previous one must have no effect after that.
pub fn discard_links(conn: &Connection, user_id: &str) -> rusqlite::Result<()> {
    email_changes::discard(conn, user_id)?;
    password_resets::discard(conn, user_id)?;
    Ok(())
}
