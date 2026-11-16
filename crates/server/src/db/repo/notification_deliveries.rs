//! Table `notification_deliveries`: notifications that still have to be
//! delivered by email or Web Push. `events` writes them in the event's
//! transaction; the job `notification_mailer` takes them out
//! once the digest is due or the quiet hours end, and so does the job
//! `push_sender` (security immediately, otherwise outside the quiet hours).

use rusqlite::Connection;
use serde_json::Value;

use crate::db::{
    self,
    repo::users::{self, Profile},
};

/// Channel of a delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Mail,
    Push,
}

impl Channel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Mail => "mail",
            Self::Push => "push",
        }
    }
}

/// A pending delivery.
#[derive(Debug, Clone, PartialEq)]
pub struct Pending {
    pub id: String,
    pub topic: String,
    pub kind: String,
    pub params: Value,
    /// Entry in the notification bell, if any (push uses it as `tag`).
    pub notification_id: Option<String>,
    pub created_at: String,
    /// Failed attempts so far.
    pub attempts: u32,
}

/// Recipient with pending deliveries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Owner {
    pub profile: Profile,
    pub active: bool,
}

/// Queues a notification for delivery over `channel`; `notification_id` is
/// its entry in the notification bell, if any. The table accepts security
/// only for push.
pub fn insert(
    conn: &Connection,
    user_id: &str,
    channel: Channel,
    topic: &str,
    kind: &str,
    params: &Value,
    notification_id: Option<&str>,
) -> anyhow::Result<String> {
    let id = db::new_id()?;
    conn.execute(
        "INSERT INTO notification_deliveries \
         (id, user_id, channel, topic, kind, params, notification_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        (
            &id,
            user_id,
            channel.as_str(),
            topic,
            kind,
            params.to_string(),
            notification_id,
        ),
    )?;
    Ok(id)
}

/// Recipients with deliveries over `channel` that may be attempted at `now`
/// (RFC 3339).
pub fn owners(conn: &Connection, channel: Channel, now: &str) -> rusqlite::Result<Vec<Owner>> {
    conn.prepare(
        "SELECT u.id, u.username, u.email, u.display_name, u.role, u.status FROM users AS u \
         WHERE u.id IN (SELECT user_id FROM notification_deliveries \
             WHERE channel = ?1 AND (retry_at IS NULL \
                 OR retry_at <= strftime('%Y-%m-%dT%H:%M:%fZ', ?2))) \
         ORDER BY u.id",
    )?
    .query_map((channel.as_str(), now), |row| {
        let (profile, active) = users::profile(row)?;
        Ok(Owner { profile, active })
    })?
    .collect()
}

/// Deliveries of a recipient over `channel` that may be attempted at `now`
/// (RFC 3339), oldest first.
pub fn pending(
    conn: &Connection,
    channel: Channel,
    user_id: &str,
    now: &str,
) -> anyhow::Result<Vec<Pending>> {
    let rows = conn
        .prepare(
            "SELECT id, topic, kind, params, notification_id, created_at, attempts \
             FROM notification_deliveries \
             WHERE channel = ?1 AND user_id = ?2 \
             AND (retry_at IS NULL OR retry_at <= strftime('%Y-%m-%dT%H:%M:%fZ', ?3)) \
             ORDER BY created_at, rowid",
        )?
        .query_map((channel.as_str(), user_id, now), |row| {
            let params: String = row.get(3)?;
            Ok(Pending {
                id: row.get(0)?,
                topic: row.get(1)?,
                kind: row.get(2)?,
                params: serde_json::from_str(&params).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                notification_id: row.get(4)?,
                created_at: row.get(5)?,
                attempts: row.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Removes deliveries (delivered or discarded); returns the count.
pub fn delete(conn: &Connection, ids: &[String]) -> anyhow::Result<usize> {
    if ids.is_empty() {
        return Ok(0);
    }
    Ok(conn.execute(
        "DELETE FROM notification_deliveries WHERE id IN (SELECT value FROM json_each(?1))",
        [serde_json::to_string(ids)?],
    )?)
}

/// Records a failed attempt: the next one at `retry_at` (RFC 3339) at the
/// earliest. Whatever reaches `max_attempts` with it is dropped; returns the
/// number of discarded ones.
pub fn failed(
    conn: &Connection,
    ids: &[String],
    retry_at: &str,
    max_attempts: u32,
) -> anyhow::Result<usize> {
    let ids = serde_json::to_string(ids)?;
    conn.execute(
        "UPDATE notification_deliveries \
         SET attempts = attempts + 1, retry_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?2) \
         WHERE id IN (SELECT value FROM json_each(?1))",
        (&ids, retry_at),
    )?;
    Ok(conn.execute(
        "DELETE FROM notification_deliveries \
         WHERE id IN (SELECT value FROM json_each(?1)) AND attempts >= ?2",
        (&ids, max_attempts),
    )?)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::db::repo::users::{
        Role,
        tests::{add, conn},
    };

    const NOW: &str = "2999-01-01T00:00:00Z";

    #[test]
    fn pending_oldest_first_with_owner() {
        let conn = conn();
        let user = add(&conn, "max", "max@example.com", Role::User);
        let a = insert(
            &conn,
            &user,
            Channel::Mail,
            "news",
            "news.welcome",
            &json!({}),
            None,
        )
        .unwrap();
        let b = insert(
            &conn,
            &user,
            Channel::Mail,
            "account",
            "account.profile",
            &json!({"what": "name"}),
            Some("n1"),
        )
        .unwrap();
        let owners = owners(&conn, Channel::Mail, NOW).unwrap();
        assert_eq!(owners.len(), 1);
        assert_eq!(owners[0].profile.email, "max@example.com");
        assert!(owners[0].active);
        let listed = pending(&conn, Channel::Mail, &user, NOW).unwrap();
        let ids: Vec<_> = listed.iter().map(|p| p.id.clone()).collect();
        assert_eq!(ids, [a.clone(), b]);
        assert_eq!(listed[1].params, json!({"what": "name"}));
        assert_eq!(listed[1].notification_id.as_deref(), Some("n1"));
        assert!(
            pending(&conn, Channel::Push, &user, NOW)
                .unwrap()
                .is_empty()
        );
        assert_eq!(delete(&conn, &[a]).unwrap(), 1);
        assert_eq!(pending(&conn, Channel::Mail, &user, NOW).unwrap().len(), 1);
    }

    #[test]
    fn failed_waits_and_gives_up() {
        let conn = conn();
        let user = add(&conn, "max", "max@example.com", Role::User);
        let id = insert(
            &conn,
            &user,
            Channel::Mail,
            "news",
            "news.welcome",
            &json!({}),
            None,
        )
        .unwrap();
        let ids = [id];
        let later = "2026-11-04T08:00:00Z";
        assert_eq!(failed(&conn, &ids, later, 3).unwrap(), 0);
        let before = "2026-11-04T07:59:59.999Z";
        assert!(owners(&conn, Channel::Mail, before).unwrap().is_empty());
        assert!(
            pending(&conn, Channel::Mail, &user, before)
                .unwrap()
                .is_empty()
        );
        let listed = pending(&conn, Channel::Mail, &user, later).unwrap();
        assert_eq!(listed[0].attempts, 1);
        assert_eq!(failed(&conn, &ids, later, 3).unwrap(), 0);
        assert_eq!(failed(&conn, &ids, later, 3).unwrap(), 1);
        assert!(
            pending(&conn, Channel::Mail, &user, NOW)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn security_only_for_push() {
        let conn = conn();
        let user = add(&conn, "max", "max@example.com", Role::User);
        let params = json!({});
        assert!(
            insert(
                &conn,
                &user,
                Channel::Mail,
                "security",
                "security.login",
                &params,
                None
            )
            .is_err()
        );
        insert(
            &conn,
            &user,
            Channel::Push,
            "security",
            "security.login",
            &params,
            None,
        )
        .unwrap();
        assert_eq!(pending(&conn, Channel::Push, &user, NOW).unwrap().len(), 1);
    }
}
