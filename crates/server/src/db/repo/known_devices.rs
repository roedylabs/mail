//! Table `known_devices`: devices a user has already signed in from
//! `auth::device::Device::hash` computes the ID.
//!
//! The code that creates the account (setup, later the accepted invitation)
//! remembers its first device without a notice. Every sign-in from an
//! unknown device is new after that – also for accounts without a remembered
//! device, so that no sign-in goes unnoticed just because there was nothing
//! to compare yet.

use rusqlite::Connection;

/// Remembers the device; `true` if it was unknown.
pub fn remember(conn: &Connection, user_id: &str, hash: &[u8; 32]) -> rusqlite::Result<bool> {
    let added = conn.execute(
        "INSERT INTO known_devices (user_id, device_hash) VALUES (?1, ?2) \
         ON CONFLICT (user_id, device_hash) DO NOTHING",
        (user_id, hash.as_slice()),
    )?;
    Ok(added == 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::users::{
        Role,
        tests::{add, conn},
    };

    #[test]
    fn new_once_per_user_and_device() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        let eva = add(&conn, "eva", "eva@example.com", Role::User);
        assert!(remember(&conn, &max, &[1; 32]).unwrap());
        assert!(!remember(&conn, &max, &[1; 32]).unwrap());
        assert!(remember(&conn, &max, &[2; 32]).unwrap());
        // Per user: the same device is new for another user.
        assert!(remember(&conn, &eva, &[1; 32]).unwrap());

        conn.execute("DELETE FROM users WHERE id = ?1", [&max])
            .unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM known_devices", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 1);
    }
}
