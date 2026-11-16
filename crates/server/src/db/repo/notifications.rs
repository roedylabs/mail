//! Table `notifications`: in-app notifications. `events` decides what goes
//! in; reading, marking and removing happen via the API
//! (`api::notifications`), cleanup via the job `notification_cleanup`.
//!
//! Team and system are visible only to administrators: whoever is demoted
//! keeps the entries but sees them again only as an administrator.

use rusqlite::Connection;
use serde_json::Value;

use crate::db;

/// Retention: notifications are kept for 90 days, …
pub const KEEP_DAYS: u32 = 90;
/// … and at most the newest 200 per user remain; the API returns as many.
pub const MAX_PER_USER: usize = 200;

/// A stored notification.
#[derive(Debug, Clone, PartialEq)]
pub struct Notification {
    pub id: String,
    pub topic: String,
    pub kind: String,
    pub params: Value,
    pub created_at: String,
    pub read_at: Option<String>,
}

pub fn insert(
    conn: &Connection,
    user_id: &str,
    topic: &str,
    kind: &str,
    params: &Value,
) -> anyhow::Result<String> {
    let id = db::new_id()?;
    conn.execute(
        "INSERT INTO notifications (id, user_id, topic, kind, params) VALUES (?1, ?2, ?3, ?4, ?5)",
        (&id, user_id, topic, kind, params.to_string()),
    )?;
    Ok(id)
}

/// Active administrators except `except` (the actor): recipients of the team
/// events.
pub fn admin_recipients(conn: &Connection, except: Option<&str>) -> rusqlite::Result<Vec<String>> {
    conn.prepare(
        "SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND id IS NOT ?1 \
         ORDER BY id",
    )?
    .query_map([except], |row| row.get(0))?
    .collect()
}

/// Recipients of a news item: all active users.
pub fn active_recipients(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    conn.prepare("SELECT id FROM users WHERE status = 'active' ORDER BY id")?
        .query_map([], |row| row.get(0))?
        .collect()
}

/// Condition for the entries that `?2` (administrator yes/no) may see.
const VISIBLE: &str = "(?2 OR topic NOT IN ('team', 'system'))";

const COLUMNS: &str = "id, topic, kind, params, created_at, read_at";

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Notification> {
    let params: String = row.get(3)?;
    Ok(Notification {
        id: row.get(0)?,
        topic: row.get(1)?,
        kind: row.get(2)?,
        params: serde_json::from_str(&params).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e))
        })?,
        created_at: row.get(4)?,
        read_at: row.get(5)?,
    })
}

/// All notifications of the user, newest first.
pub fn list(conn: &Connection, user_id: &str) -> anyhow::Result<Vec<Notification>> {
    let rows = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM notifications WHERE user_id = ?1 \
             ORDER BY created_at DESC, rowid DESC"
        ))?
        .query_map([user_id], read_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The newest `limit` notifications the user may see (notification bell).
pub fn visible(
    conn: &Connection,
    user_id: &str,
    admin: bool,
    limit: usize,
) -> anyhow::Result<Vec<Notification>> {
    let rows = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM notifications WHERE user_id = ?1 AND {VISIBLE} \
             ORDER BY created_at DESC, rowid DESC LIMIT ?3"
        ))?
        .query_map((user_id, admin, sql_count(limit)), read_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Number of unread ones among the newest `limit` the user may see – as many
/// as [`visible`] returns, so that the bell also shows them and can mark them
/// as read.
pub fn unread(
    conn: &Connection,
    user_id: &str,
    admin: bool,
    limit: usize,
) -> rusqlite::Result<usize> {
    let count: i64 = conn.query_row(
        &format!(
            "SELECT count(*) FROM (SELECT read_at FROM notifications \
             WHERE user_id = ?1 AND {VISIBLE} ORDER BY created_at DESC, rowid DESC LIMIT ?3) \
             WHERE read_at IS NULL"
        ),
        (user_id, admin, sql_count(limit)),
        |row| row.get(0),
    )?;
    Ok(usize::try_from(count).unwrap_or_default())
}

/// Count for SQLite (signed integers).
fn sql_count(n: usize) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

/// Marks unread ones as read: those with the IDs `ids`, all without IDs;
/// returns the number changed. Foreign and unknown IDs do not count.
pub fn mark_read(
    conn: &Connection,
    user_id: &str,
    admin: bool,
    ids: Option<&[String]>,
) -> anyhow::Result<usize> {
    let ids = ids.map(serde_json::to_string).transpose()?;
    Ok(conn.execute(
        &format!(
            "UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
             WHERE user_id = ?1 AND {VISIBLE} AND read_at IS NULL \
             AND (?3 IS NULL OR id IN (SELECT value FROM json_each(?3)))"
        ),
        (user_id, admin, ids),
    )?)
}

/// Removes a notification; `false` if it does not exist (any more) for the
/// user.
pub fn delete(conn: &Connection, user_id: &str, admin: bool, id: &str) -> rusqlite::Result<bool> {
    Ok(conn.execute(
        &format!("DELETE FROM notifications WHERE user_id = ?1 AND {VISIBLE} AND id = ?3"),
        (user_id, admin, id),
    )? > 0)
}

/// Retention: deletes notifications older than `days` days and, per user,
/// all visible ones after the newest `keep`; returns the count. Team and
/// system entries of a user without administrator rights do not count – while
/// hidden they must not push out visible ones – and end only by age.
pub fn delete_old(conn: &Connection, days: u32, keep: usize) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM notifications \
         WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?1) \
         OR rowid IN (SELECT rowid FROM ( \
             SELECT n.rowid AS rowid, row_number() OVER ( \
                 PARTITION BY n.user_id ORDER BY n.created_at DESC, n.rowid DESC) AS k \
             FROM notifications AS n JOIN users AS u ON u.id = n.user_id \
             WHERE u.role = 'admin' OR n.topic NOT IN ('team', 'system')) \
         WHERE k > ?2)",
        (format!("-{days} days"), sql_count(keep)),
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::db::repo::users::{
        Role,
        tests::{add, conn},
    };

    #[test]
    fn stores_kind_and_params() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        let params = json!({ "device": "Firefox on Linux" });
        let id = insert(&conn, &max, "security", "security.login", &params).unwrap();
        let listed = list(&conn, &max).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id);
        assert_eq!(listed[0].kind, "security.login");
        assert_eq!(listed[0].params, params);
        assert_eq!(listed[0].read_at, None);
        assert!(
            insert(&conn, &max, "unknown", "x", &json!({})).is_err(),
            "unknown topics are rejected"
        );
    }

    #[test]
    fn team_and_system_only_for_admins() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        let team = insert(&conn, &max, "team", "team.user_locked", &json!({})).unwrap();
        let system = insert(&conn, &max, "system", "system.backup_failed", &json!({})).unwrap();
        let own = insert(&conn, &max, "account", "account.profile", &json!({})).unwrap();
        let ids = |list: Vec<Notification>| list.into_iter().map(|n| n.id).collect::<Vec<_>>();
        assert_eq!(
            ids(visible(&conn, &max, false, 10).unwrap()),
            std::slice::from_ref(&own)
        );
        assert_eq!(
            ids(visible(&conn, &max, true, 10).unwrap()),
            [own.clone(), system.clone(), team.clone()]
        );
        assert_eq!(ids(visible(&conn, &max, true, 2).unwrap()), [own, system]);
        assert_eq!(unread(&conn, &max, false, 10).unwrap(), 1);
        assert_eq!(unread(&conn, &max, true, 10).unwrap(), 3);
        // What the user does not see, they can neither mark nor remove.
        assert_eq!(mark_read(&conn, &max, false, None).unwrap(), 1);
        assert_eq!(unread(&conn, &max, true, 10).unwrap(), 2);
        assert!(!delete(&conn, &max, false, &team).unwrap());
        assert!(delete(&conn, &max, true, &team).unwrap());
        assert!(
            !delete(&conn, &max, true, &team).unwrap(),
            "already removed"
        );
    }

    #[test]
    fn unread_counts_only_what_the_bell_lists() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        for _ in 0..3 {
            insert(&conn, &max, "news", "news.welcome", &json!({})).unwrap();
        }
        let newest: Vec<String> = visible(&conn, &max, false, 2)
            .unwrap()
            .into_iter()
            .map(|n| n.id)
            .collect();
        assert_eq!(unread(&conn, &max, false, 2).unwrap(), 2);
        mark_read(&conn, &max, false, Some(&newest)).unwrap();
        assert_eq!(
            unread(&conn, &max, false, 2).unwrap(),
            0,
            "the oldest is missing from the list"
        );
        assert_eq!(unread(&conn, &max, false, 10).unwrap(), 1);
    }

    #[test]
    fn hidden_team_entries_do_not_push_out_visible_ones() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        let anna = add(&conn, "anna", "anna@example.com", Role::Admin);
        for user in [&max, &anna] {
            insert(&conn, user, "news", "news.welcome", &json!({})).unwrap();
            for _ in 0..3 {
                insert(&conn, user, "team", "team.user_locked", &json!({})).unwrap();
            }
        }
        // Max sees only the news item, which stays; Anna sees all four and
        // keeps the newest two.
        assert_eq!(delete_old(&conn, 90, 2).unwrap(), 2);
        assert_eq!(list(&conn, &max).unwrap().len(), 4);
        let kept: Vec<String> = list(&conn, &anna)
            .unwrap()
            .into_iter()
            .map(|n| n.topic)
            .collect();
        assert_eq!(kept, ["team", "team"]);
    }

    #[test]
    fn marks_the_given_ids_once() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        let anna = add(&conn, "anna", "anna@example.com", Role::User);
        let a = insert(&conn, &max, "news", "news.welcome", &json!({})).unwrap();
        let b = insert(&conn, &max, "news", "news.welcome", &json!({})).unwrap();
        let foreign = insert(&conn, &anna, "news", "news.welcome", &json!({})).unwrap();
        let both = [a.clone(), foreign.clone(), "unknown".to_owned()];
        assert_eq!(mark_read(&conn, &max, false, Some(&both)).unwrap(), 1);
        assert_eq!(
            mark_read(&conn, &max, false, Some(&both)).unwrap(),
            0,
            "already read"
        );
        assert_eq!(mark_read(&conn, &max, false, Some(&[])).unwrap(), 0);
        let listed = list(&conn, &max).unwrap();
        let read = |id: &str| {
            listed
                .iter()
                .find(|n| n.id == id)
                .unwrap()
                .read_at
                .is_some()
        };
        assert!(read(&a) && !read(&b));
        assert_eq!(
            unread(&conn, &anna, false, 10).unwrap(),
            1,
            "foreign ones stay"
        );
        assert!(!delete(&conn, &max, true, &foreign).unwrap());
    }

    #[test]
    fn keeps_recent_and_at_most_keep_per_user() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        let anna = add(&conn, "anna", "anna@example.com", Role::User);
        let old = insert(&conn, &anna, "news", "news.welcome", &json!({})).unwrap();
        conn.execute(
            "UPDATE notifications SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-91 days') \
             WHERE id = ?1",
            [&old],
        )
        .unwrap();
        for _ in 0..4 {
            insert(&conn, &max, "news", "news.welcome", &json!({})).unwrap();
        }
        let newest: Vec<String> = list(&conn, &max).unwrap()[..3]
            .iter()
            .map(|n| n.id.clone())
            .collect();
        insert(&conn, &anna, "news", "news.welcome", &json!({})).unwrap();
        assert_eq!(delete_old(&conn, 90, 3).unwrap(), 2);
        let kept: Vec<String> = list(&conn, &max)
            .unwrap()
            .into_iter()
            .map(|n| n.id)
            .collect();
        assert_eq!(kept, newest);
        assert_eq!(list(&conn, &anna).unwrap().len(), 1);
        assert_eq!(delete_old(&conn, 90, 3).unwrap(), 0);
    }

    #[test]
    fn admins_except_the_actor() {
        let conn = conn();
        let anna = add(&conn, "anna", "anna@example.com", Role::Admin);
        let lukas = add(&conn, "lukas", "lukas@example.com", Role::Admin);
        let mia = add(&conn, "mia", "mia@example.com", Role::Admin);
        add(&conn, "max", "max@example.com", Role::User);
        conn.execute("UPDATE users SET status = 'locked' WHERE id = ?1", [&mia])
            .unwrap();
        let mut both = vec![anna.clone(), lukas.clone()];
        both.sort();
        assert_eq!(admin_recipients(&conn, None).unwrap(), both);
        assert_eq!(admin_recipients(&conn, Some(&anna)).unwrap(), [lukas]);
    }
}
