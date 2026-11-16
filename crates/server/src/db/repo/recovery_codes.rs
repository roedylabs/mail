//! Table `recovery_codes`: recovery codes. Generation and verification are
//! handled by `auth::recovery`.

use rusqlite::{Connection, OptionalExtension as _};

/// State for Account › Security ("10 of 10 unused", "Created … ago").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    pub total: u32,
    pub unused: u32,
    pub created_at: String,
}

/// Replaces all codes of the user with `hashes`. Callers run this inside
/// their transaction (together with the device and the audit log).
pub fn replace(conn: &Connection, user_id: &str, hashes: &[[u8; 32]]) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM recovery_codes WHERE user_id = ?1", [user_id])?;
    let mut insert =
        conn.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?1, ?2)")?;
    for hash in hashes {
        insert.execute((user_id, hash.as_slice()))?;
    }
    Ok(())
}

/// Redeems the code with `hash`: `Some(true)` redeemed, `Some(false)` already
/// used, `None` unknown.
pub fn redeem(conn: &Connection, user_id: &str, hash: &[u8; 32]) -> rusqlite::Result<Option<bool>> {
    let n = conn.execute(
        "UPDATE recovery_codes SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE user_id = ?1 AND code_hash = ?2 AND used_at IS NULL",
        (user_id, hash.as_slice()),
    )?;
    if n == 1 {
        return Ok(Some(true));
    }
    let known = conn
        .query_row(
            "SELECT 1 FROM recovery_codes WHERE user_id = ?1 AND code_hash = ?2",
            (user_id, hash.as_slice()),
            |_| Ok(()),
        )
        .optional()?;
    Ok(known.map(|()| false))
}

/// `None` if the user has no codes.
pub fn summary(conn: &Connection, user_id: &str) -> rusqlite::Result<Option<Summary>> {
    conn.query_row(
        "SELECT COUNT(*), COUNT(*) FILTER (WHERE used_at IS NULL), MIN(created_at) \
         FROM recovery_codes WHERE user_id = ?1",
        [user_id],
        |row| {
            let created_at: Option<String> = row.get(2)?;
            Ok(created_at.map(|created_at| -> rusqlite::Result<Summary> {
                Ok(Summary {
                    total: row.get(0)?,
                    unused: row.get(1)?,
                    created_at,
                })
            }))
        },
    )?
    .transpose()
}

pub fn delete_all(conn: &Connection, user_id: &str) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM recovery_codes WHERE user_id = ?1", [user_id])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::users::{
        Role,
        tests::{add, conn},
    };

    #[test]
    fn summary_counts_unused_codes() {
        let conn = conn();
        let user = add(&conn, "max", "max@example.com", Role::User);
        assert_eq!(summary(&conn, &user).unwrap(), None);
        replace(&conn, &user, &[[1; 32], [2; 32], [3; 32]]).unwrap();
        assert_eq!(redeem(&conn, &user, &[2; 32]).unwrap(), Some(true));
        assert_eq!(redeem(&conn, &user, &[2; 32]).unwrap(), Some(false));
        assert_eq!(redeem(&conn, &user, &[9; 32]).unwrap(), None);
        let s = summary(&conn, &user).unwrap().unwrap();
        assert_eq!((s.total, s.unused), (3, 2));
        assert_eq!(delete_all(&conn, &user).unwrap(), 3);
        assert_eq!(summary(&conn, &user).unwrap(), None);
    }
}
