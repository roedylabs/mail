//! Table `push_subscriptions`: browsers that receive Web Push. A
//! subscription belongs to the session in which the browser registered it;
//! when the session ends, it goes with it (foreign key). The same endpoint
//! moves to the most recently registered session.

use rusqlite::{Connection, OptionalExtension as _};

use crate::db;

/// Maximum per user; beyond that the oldest are dropped.
pub const MAX_PER_USER: usize = 20;

/// A subscription with everything delivery needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subscription {
    pub id: String,
    pub session_id: String,
    pub endpoint: String,
    /// Public key of the browser (P-256, uncompressed, 65 bytes).
    pub p256dh: Vec<u8>,
    /// Authentication secret (16 bytes).
    pub auth: Vec<u8>,
    pub created_at: String,
    pub expires_at: Option<String>,
    /// User agent of the session (for the device name).
    pub user_agent: Option<String>,
}

/// What the browser reports.
#[derive(Debug, Clone, Copy)]
pub struct New<'a> {
    pub endpoint: &'a str,
    pub p256dh: &'a [u8],
    pub auth: &'a [u8],
    pub expires_at: Option<&'a str>,
}

/// Only registrations of live sessions: `session_cleanup` deletes expired ones
/// only on the hour.
const COLUMNS: &str = "p.id, p.session_id, p.endpoint, p.p256dh, p.auth, p.created_at, \
     p.expires_at, s.user_agent \
     FROM push_subscriptions AS p JOIN sessions AS s ON s.id = p.session_id \
     AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

fn subscription(row: &rusqlite::Row<'_>) -> rusqlite::Result<Subscription> {
    Ok(Subscription {
        id: row.get(0)?,
        session_id: row.get(1)?,
        endpoint: row.get(2)?,
        p256dh: row.get(3)?,
        auth: row.get(4)?,
        created_at: row.get(5)?,
        expires_at: row.get(6)?,
        user_agent: row.get(7)?,
    })
}

/// Registers the browser for `user_id` in `session_id` or updates it (same
/// endpoint: keys, session and person change, the ID stays). Beyond
/// [`MAX_PER_USER`] the oldest are dropped. Returns the ID and `true` for a
/// new one.
pub fn upsert(
    conn: &Connection,
    user_id: &str,
    session_id: &str,
    new: &New<'_>,
) -> anyhow::Result<(String, bool)> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM push_subscriptions WHERE endpoint = ?1",
            [new.endpoint],
            |row| row.get(0),
        )
        .optional()?;
    let created = existing.is_none();
    let id = match existing {
        Some(id) => {
            conn.execute(
                "UPDATE push_subscriptions SET user_id = ?2, session_id = ?3, p256dh = ?4, \
                 auth = ?5, expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?6) WHERE id = ?1",
                (
                    &id,
                    user_id,
                    session_id,
                    new.p256dh,
                    new.auth,
                    new.expires_at,
                ),
            )?;
            id
        }
        None => {
            let id = db::new_id()?;
            conn.execute(
                "INSERT INTO push_subscriptions \
                 (id, user_id, session_id, endpoint, p256dh, auth, expires_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ', ?7))",
                (
                    &id,
                    user_id,
                    session_id,
                    new.endpoint,
                    new.p256dh,
                    new.auth,
                    new.expires_at,
                ),
            )?;
            id
        }
    };
    conn.execute(
        "DELETE FROM push_subscriptions WHERE user_id = ?1 AND id NOT IN \
         (SELECT id FROM push_subscriptions WHERE user_id = ?1 \
          ORDER BY created_at DESC, rowid DESC LIMIT ?2)",
        (user_id, MAX_PER_USER as i64),
    )?;
    Ok((id, created))
}

/// All subscriptions of `user_id`, oldest first.
pub fn of_user(conn: &Connection, user_id: &str) -> rusqlite::Result<Vec<Subscription>> {
    conn.prepare(&format!(
        "SELECT {COLUMNS} WHERE p.user_id = ?1 ORDER BY p.created_at, p.rowid"
    ))?
    .query_map([user_id], subscription)?
    .collect()
}

/// Whether `user_id` has registered at least one browser.
pub fn any(conn: &Connection, user_id: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id = ?1)",
        [user_id],
        |row| row.get(0),
    )
}

/// Subscriptions of the session `session_id` of `user_id` ("this device").
pub fn of_session(
    conn: &Connection,
    user_id: &str,
    session_id: &str,
) -> rusqlite::Result<Vec<Subscription>> {
    conn.prepare(&format!(
        "SELECT {COLUMNS} WHERE p.user_id = ?1 AND p.session_id = ?2 ORDER BY p.created_at, p.rowid"
    ))?
    .query_map([user_id, session_id], subscription)?
    .collect()
}

/// A subscription of `user_id`.
pub fn get(conn: &Connection, user_id: &str, id: &str) -> rusqlite::Result<Option<Subscription>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} WHERE p.user_id = ?1 AND p.id = ?2"),
        [user_id, id],
        subscription,
    )
    .optional()
}

/// Removes a subscription of `user_id`; `true` if it existed.
pub fn delete(conn: &Connection, user_id: &str, id: &str) -> rusqlite::Result<bool> {
    conn.execute(
        "DELETE FROM push_subscriptions WHERE user_id = ?1 AND id = ?2",
        [user_id, id],
    )
    .map(|deleted| deleted == 1)
}

/// Removes subscriptions the push service no longer knows.
pub fn delete_gone(conn: &Connection, ids: &[String]) -> anyhow::Result<usize> {
    if ids.is_empty() {
        return Ok(0);
    }
    Ok(conn.execute(
        "DELETE FROM push_subscriptions WHERE id IN (SELECT value FROM json_each(?1))",
        [serde_json::to_string(ids)?],
    )?)
}

/// Removes subscriptions whose `expirationTime` is before `now` (RFC 3339).
pub fn delete_expired(conn: &Connection, now: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM push_subscriptions \
         WHERE expires_at IS NOT NULL AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', ?1)",
        [now],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::users::{
        Role,
        tests::{add, conn},
    };

    fn session(conn: &Connection, user: &str, id: &str) {
        conn.execute(
            "INSERT INTO sessions (id, user_id, token_hash, user_agent, expires_at) \
             VALUES (?1, ?2, randomblob(32), 'Firefox', '2999-01-01T00:00:00Z')",
            [id, user],
        )
        .unwrap();
    }

    fn new(endpoint: &str) -> New<'_> {
        New {
            endpoint,
            p256dh: &[4; 65],
            auth: &[7; 16],
            expires_at: None,
        }
    }

    #[test]
    fn upsert_moves_the_endpoint_to_the_latest_session() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        let eva = add(&conn, "eva", "eva@example.com", Role::User);
        session(&conn, &max, "s1");
        session(&conn, &eva, "s2");
        let (id, created) = upsert(&conn, &max, "s1", &new("https://push.example.com/a")).unwrap();
        assert!(created);
        let (again, created) =
            upsert(&conn, &eva, "s2", &new("https://push.example.com/a")).unwrap();
        assert_eq!((again.as_str(), created), (id.as_str(), false));
        assert!(of_user(&conn, &max).unwrap().is_empty());
        let listed = of_user(&conn, &eva).unwrap();
        assert_eq!(listed[0].session_id, "s2");
        assert_eq!(listed[0].user_agent.as_deref(), Some("Firefox"));
        assert!(get(&conn, &max, &id).unwrap().is_none());
        assert!(!delete(&conn, &max, &id).unwrap());
        assert!(delete(&conn, &eva, &id).unwrap());
    }

    #[test]
    fn ends_with_the_session_and_keeps_the_newest() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        session(&conn, &max, "s1");
        for i in 0..=MAX_PER_USER {
            upsert(
                &conn,
                &max,
                "s1",
                &new(&format!("https://push.example.com/{i}")),
            )
            .unwrap();
        }
        let listed = of_user(&conn, &max).unwrap();
        assert_eq!(listed.len(), MAX_PER_USER);
        assert_eq!(listed[0].endpoint, "https://push.example.com/1");
        conn.execute("DELETE FROM sessions WHERE id = 's1'", [])
            .unwrap();
        assert!(of_user(&conn, &max).unwrap().is_empty());
    }

    #[test]
    fn expired_and_gone_are_removed() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        session(&conn, &max, "s1");
        let soon = New {
            expires_at: Some("2026-11-04T10:00:00Z"),
            ..new("https://push.example.com/a")
        };
        upsert(&conn, &max, "s1", &soon).unwrap();
        let (b, _) = upsert(&conn, &max, "s1", &new("https://push.example.com/b")).unwrap();
        assert_eq!(delete_expired(&conn, "2026-11-04T09:59:59Z").unwrap(), 0);
        assert_eq!(delete_expired(&conn, "2026-11-04T10:00:00Z").unwrap(), 1);
        assert_eq!(delete_gone(&conn, &[b]).unwrap(), 1);
        assert!(of_user(&conn, &max).unwrap().is_empty());
    }
}
