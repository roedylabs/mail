//! Table `password_resets`: links from "Reset password". Only the SHA-256 of
//! the token is stored; a link is valid for 60 minutes and only once.

use rusqlite::{Connection, OptionalExtension as _};

use crate::db;

/// Validity of a link (60 minutes).
pub const VALID_MINUTES: u32 = 60;

/// Creates a link for `user_id` and discards older unused ones – only the
/// most recently requested one is valid.
pub fn insert(conn: &Connection, user_id: &str, token_hash: &[u8; 32]) -> anyhow::Result<String> {
    conn.execute(
        "DELETE FROM password_resets WHERE user_id = ?1 AND used_at IS NULL",
        [user_id],
    )?;
    let id = db::new_id()?;
    conn.execute(
        &format!(
            "INSERT INTO password_resets (id, user_id, token_hash, expires_at) \
             VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+{VALID_MINUTES} minutes'))"
        ),
        (&id, user_id, token_hash.as_slice()),
    )?;
    Ok(id)
}

/// What a link (still) does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lookup {
    /// Unknown token – a guess or a discarded link.
    Unknown,
    /// Expired, already used or the account is locked.
    Spent,
    /// Valid for this user.
    Valid { user_id: String },
}

/// Checks a link without consuming it.
pub fn lookup(conn: &Connection, token_hash: &[u8; 32]) -> rusqlite::Result<Lookup> {
    let row: Option<(String, bool)> = conn
        .query_row(
            "SELECT r.user_id, \
                    r.used_at IS NULL \
                    AND r.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                    AND u.status = 'active' \
             FROM password_resets r JOIN users u ON u.id = r.user_id \
             WHERE r.token_hash = ?1",
            [token_hash.as_slice()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(match row {
        None => Lookup::Unknown,
        Some((_, false)) => Lookup::Spent,
        Some((user_id, true)) => Lookup::Valid { user_id },
    })
}

/// Consumes the link if it is still valid (atomic: two concurrent requests
/// set a password only once); returns the user.
pub fn redeem(conn: &Connection, token_hash: &[u8; 32]) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "UPDATE password_resets SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE token_hash = ?1 AND used_at IS NULL \
           AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
           AND user_id IN (SELECT id FROM users WHERE status = 'active') \
         RETURNING user_id",
        [token_hash.as_slice()],
        |row| row.get(0),
    )
    .optional()
}

/// Discards the user's unused links (after the reset and on locking). A used one stays until it expires so that it counts as spent and
/// not as a guess.
pub fn discard(conn: &Connection, user_id: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM password_resets WHERE user_id = ?1 AND used_at IS NULL",
        [user_id],
    )
}

/// Deletes expired links (job `session_cleanup`).
pub fn delete_expired(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM password_resets WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        [],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::users::{
        Role,
        tests::{add, conn},
    };

    #[test]
    fn only_the_latest_link_works_and_only_once() {
        let conn = conn();
        let id = add(&conn, "max", "max@example.com", Role::User);
        insert(&conn, &id, &[1; 32]).unwrap();
        insert(&conn, &id, &[2; 32]).unwrap();
        // The older one is discarded.
        assert_eq!(lookup(&conn, &[1; 32]).unwrap(), Lookup::Unknown);
        assert_eq!(
            lookup(&conn, &[2; 32]).unwrap(),
            Lookup::Valid {
                user_id: id.clone()
            }
        );
        assert_eq!(redeem(&conn, &[2; 32]).unwrap(), Some(id.clone()));
        assert_eq!(redeem(&conn, &[2; 32]).unwrap(), None);
        assert_eq!(lookup(&conn, &[2; 32]).unwrap(), Lookup::Spent);
        assert_eq!(lookup(&conn, &[3; 32]).unwrap(), Lookup::Unknown);
    }

    #[test]
    fn expired_and_locked_links_do_not_work() {
        let conn = conn();
        let id = add(&conn, "max", "max@example.com", Role::User);
        insert(&conn, &id, &[1; 32]).unwrap();
        conn.execute(
            "UPDATE password_resets SET expires_at = '2000-01-01T00:00:00.000Z'",
            [],
        )
        .unwrap();
        assert_eq!(lookup(&conn, &[1; 32]).unwrap(), Lookup::Spent);
        assert_eq!(redeem(&conn, &[1; 32]).unwrap(), None);
        assert_eq!(delete_expired(&conn).unwrap(), 1);
        assert_eq!(lookup(&conn, &[1; 32]).unwrap(), Lookup::Unknown);

        insert(&conn, &id, &[2; 32]).unwrap();
        conn.execute("UPDATE users SET status = 'locked'", [])
            .unwrap();
        assert_eq!(lookup(&conn, &[2; 32]).unwrap(), Lookup::Spent);
        assert_eq!(redeem(&conn, &[2; 32]).unwrap(), None);
        assert_eq!(discard(&conn, &id).unwrap(), 1);
    }

    #[test]
    fn link_is_valid_for_sixty_minutes() {
        let conn = conn();
        let id = add(&conn, "max", "max@example.com", Role::User);
        insert(&conn, &id, &[1; 32]).unwrap();
        let minutes: f64 = conn
            .query_row(
                "SELECT (julianday(expires_at) - julianday(created_at)) * 1440 FROM password_resets",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!((minutes - 60.0).abs() < 0.01, "{minutes}");
    }
}
