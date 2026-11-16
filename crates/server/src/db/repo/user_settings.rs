//! Table `user_settings`: settings per user as JSON with a version.
//! Validation and completion are handled by `crate::settings`.

use rusqlite::{Connection, OptionalExtension as _};

/// Stored document and its version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub json: String,
    pub version: i64,
}

pub fn get(conn: &Connection, user_id: &str) -> rusqlite::Result<Option<Row>> {
    conn.query_row(
        "SELECT json, version FROM user_settings WHERE user_id = ?1",
        [user_id],
        |row| {
            Ok(Row {
                json: row.get(0)?,
                version: row.get(1)?,
            })
        },
    )
    .optional()
}

/// Stores `json` as the successor of `version` (0 = no row yet) and returns
/// the new version; `None` if another one has taken effect in the meantime.
pub fn save(
    conn: &Connection,
    user_id: &str,
    json: &str,
    version: i64,
) -> rusqlite::Result<Option<i64>> {
    let next = version + 1;
    let saved = if version == 0 {
        conn.execute(
            "INSERT INTO user_settings (user_id, json, version) VALUES (?1, ?2, ?3) \
             ON CONFLICT (user_id) DO NOTHING",
            (user_id, json, next),
        )?
    } else {
        conn.execute(
            "UPDATE user_settings SET json = ?2, version = ?3, \
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
             WHERE user_id = ?1 AND version = ?4",
            (user_id, json, next, version),
        )?
    };
    Ok((saved == 1).then_some(next))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::users::{
        Role,
        tests::{add, conn},
    };

    #[test]
    fn versions_follow_each_other() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        assert_eq!(get(&conn, &max).unwrap(), None);
        // Without a row only version 0 is valid.
        assert_eq!(save(&conn, &max, r#"{"a":1}"#, 1).unwrap(), None);
        assert_eq!(save(&conn, &max, r#"{"a":1}"#, 0).unwrap(), Some(1));
        assert_eq!(save(&conn, &max, r#"{"a":2}"#, 0).unwrap(), None);
        assert_eq!(save(&conn, &max, r#"{"a":2}"#, 1).unwrap(), Some(2));
        // Whoever still knows version 1 is too late.
        assert_eq!(save(&conn, &max, r#"{"a":3}"#, 1).unwrap(), None);
        assert_eq!(
            get(&conn, &max).unwrap(),
            Some(Row {
                json: r#"{"a":2}"#.into(),
                version: 2
            })
        );
    }

    #[test]
    fn removed_with_the_user() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        save(&conn, &max, "{}", 0).unwrap();
        conn.execute("DELETE FROM users WHERE id = ?1", [&max])
            .unwrap();
        assert_eq!(get(&conn, &max).unwrap(), None);
    }
}
