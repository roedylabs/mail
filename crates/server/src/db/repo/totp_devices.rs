//! Table `totp_devices`: the users' authenticator apps. Verification and
//! encryption are handled by `auth::totp`.

use rusqlite::{Connection, OptionalExtension as _};

/// Confirmed device for the list under Account › Security.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

/// Encrypted secret of a confirmed device.
pub struct Sealed {
    pub id: String,
    pub name: String,
    pub secret_enc: Vec<u8>,
}

/// Starts a setup; an earlier unconfirmed one of the same user is dropped (at
/// most one per user).
pub fn insert_pending(
    conn: &Connection,
    id: &str,
    user_id: &str,
    secret_enc: &[u8],
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM totp_devices WHERE user_id = ?1 AND confirmed_at IS NULL",
        [user_id],
    )?;
    tx.execute(
        "INSERT INTO totp_devices (id, user_id, secret_enc) VALUES (?1, ?2, ?3)",
        (id, user_id, secret_enc),
    )?;
    tx.commit()
}

/// Creates an already confirmed device – for the first app from an
/// invitation whose code was verified on acceptance (`step` as in
/// [`confirm`]).
pub fn insert_confirmed(
    conn: &Connection,
    id: &str,
    user_id: &str,
    name: &str,
    secret_enc: &[u8],
    step: u64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO totp_devices (id, user_id, name, secret_enc, confirmed_at, last_step) \
         VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?5)",
        (id, user_id, name, secret_enc, step_value(step)),
    )?;
    Ok(())
}

/// Confirmed devices, oldest first.
pub fn list(conn: &Connection, user_id: &str) -> rusqlite::Result<Vec<Device>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, created_at, last_used_at FROM totp_devices \
         WHERE user_id = ?1 AND confirmed_at IS NOT NULL ORDER BY created_at, rowid",
    )?;
    stmt.query_map([user_id], |row| {
        Ok(Device {
            id: row.get(0)?,
            name: row.get(1)?,
            created_at: row.get(2)?,
            last_used_at: row.get(3)?,
        })
    })?
    .collect()
}

/// Whether the user has at least one confirmed device (then multi-factor
/// authentication is active).
pub fn has_confirmed(conn: &Connection, user_id: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM totp_devices \
                        WHERE user_id = ?1 AND confirmed_at IS NOT NULL)",
        [user_id],
        |row| row.get(0),
    )
}

pub fn confirmed_secrets(conn: &Connection, user_id: &str) -> rusqlite::Result<Vec<Sealed>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, secret_enc FROM totp_devices \
         WHERE user_id = ?1 AND confirmed_at IS NOT NULL ORDER BY created_at, rowid",
    )?;
    stmt.query_map([user_id], |row| {
        Ok(Sealed {
            id: row.get(0)?,
            name: row.get(1)?,
            secret_enc: row.get(2)?,
        })
    })?
    .collect()
}

/// Encrypted secret of a started, not yet confirmed setup of the user.
pub fn pending_secret(
    conn: &Connection,
    user_id: &str,
    id: &str,
) -> rusqlite::Result<Option<Vec<u8>>> {
    conn.query_row(
        "SELECT secret_enc FROM totp_devices \
         WHERE id = ?1 AND user_id = ?2 AND confirmed_at IS NULL",
        (id, user_id),
        |row| row.get(0),
    )
    .optional()
}

/// Accepts the time step `step` if it is after the last accepted one; `false`
/// if the code was already used.
pub fn accept(conn: &Connection, id: &str, step: u64) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE totp_devices \
         SET last_step = ?2, last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE id = ?1 AND confirmed_at IS NOT NULL AND (last_step IS NULL OR last_step < ?2)",
        (id, step_value(step)),
    )?;
    Ok(n == 1)
}

/// Confirms a started setup with a name and the time step of the code;
/// `false` if it is already confirmed.
pub fn confirm(conn: &Connection, id: &str, name: &str, step: u64) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE totp_devices \
         SET name = ?2, last_step = ?3, \
             created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
             confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE id = ?1 AND confirmed_at IS NULL",
        (id, name, step_value(step)),
    )?;
    Ok(n == 1)
}

/// Name of a confirmed device if it belongs to the user.
pub fn name(conn: &Connection, user_id: &str, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT name FROM totp_devices \
         WHERE id = ?1 AND user_id = ?2 AND confirmed_at IS NOT NULL",
        (id, user_id),
        |row| row.get(0),
    )
    .optional()
}

/// Removes a confirmed device of the user; `false` if it does not exist (any
/// more).
pub fn delete(conn: &Connection, user_id: &str, id: &str) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "DELETE FROM totp_devices WHERE id = ?1 AND user_id = ?2 AND confirmed_at IS NOT NULL",
        (id, user_id),
    )?;
    Ok(n > 0)
}

/// Removes all devices of the user, including started ones (`reset-admin`).
pub fn delete_all(conn: &Connection, user_id: &str) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM totp_devices WHERE user_id = ?1", [user_id])
}

/// Time steps fit into `i64` until well after the year 3000.
fn step_value(step: u64) -> i64 {
    i64::try_from(step).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::users::{
        Role,
        tests::{add, conn},
    };

    #[test]
    fn pending_devices_do_not_count() {
        let conn = conn();
        let user = add(&conn, "max", "max@example.com", Role::User);
        insert_pending(&conn, "a", &user, b"x").unwrap();
        assert!(!has_confirmed(&conn, &user).unwrap());
        assert!(list(&conn, &user).unwrap().is_empty());
        assert!(confirmed_secrets(&conn, &user).unwrap().is_empty());
        assert!(!accept(&conn, "a", 1).unwrap(), "not confirmed");
        assert!(!delete(&conn, &user, "a").unwrap());
        assert!(pending_secret(&conn, &user, "a").unwrap().is_some());

        // A new setup replaces the started one.
        insert_pending(&conn, "b", &user, b"y").unwrap();
        assert!(pending_secret(&conn, &user, "a").unwrap().is_none());
        assert!(confirm(&conn, "b", "Phone", 10).unwrap());
        assert!(
            pending_secret(&conn, &user, "b").unwrap().is_none(),
            "confirmed"
        );
        assert!(
            !confirm(&conn, "b", "Phone", 11).unwrap(),
            "already confirmed"
        );
        assert!(has_confirmed(&conn, &user).unwrap());
        assert_eq!(name(&conn, &user, "b").unwrap().as_deref(), Some("Phone"));
        // Confirmed devices stay on a new setup.
        insert_pending(&conn, "c", &user, b"z").unwrap();
        assert_eq!(list(&conn, &user).unwrap().len(), 1);
    }

    #[test]
    fn steps_are_accepted_once() {
        let conn = conn();
        let user = add(&conn, "max", "max@example.com", Role::User);
        insert_pending(&conn, "a", &user, b"x").unwrap();
        confirm(&conn, "a", "Phone", 10).unwrap();
        assert!(!accept(&conn, "a", 10).unwrap(), "code of the confirmation");
        assert!(!accept(&conn, "a", 9).unwrap());
        assert!(accept(&conn, "a", 11).unwrap());
        assert!(!accept(&conn, "a", 11).unwrap());
        let device = &list(&conn, &user).unwrap()[0];
        assert!(device.last_used_at.is_some());
    }

    #[test]
    fn devices_belong_to_their_user() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        let eva = add(&conn, "eva", "eva@example.com", Role::User);
        insert_pending(&conn, "a", &max, b"x").unwrap();
        confirm(&conn, "a", "Phone", 1).unwrap();
        insert_pending(&conn, "p", &max, b"y").unwrap();
        assert!(pending_secret(&conn, &eva, "p").unwrap().is_none());
        assert!(name(&conn, &eva, "a").unwrap().is_none());
        assert!(!delete(&conn, &eva, "a").unwrap());
        assert_eq!(delete_all(&conn, &max).unwrap(), 2);
        conn.execute("DELETE FROM users WHERE id = ?1", [&eva])
            .unwrap();
    }

    #[test]
    fn deleting_user_removes_devices() {
        let conn = conn();
        let user = add(&conn, "max", "max@example.com", Role::User);
        insert_pending(&conn, "a", &user, b"x").unwrap();
        conn.execute("DELETE FROM users WHERE id = ?1", [&user])
            .unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM totp_devices", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }
}
