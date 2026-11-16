//! Table `sessions`: app sessions. Time arithmetic happens in SQL
//! so that expiry and throttling match the stored UTC timestamps.

use rusqlite::{Connection, OptionalExtension as _, params_from_iter, types::Value};

use crate::{
    auth::session::{AuthUser, Client, IDLE},
    db::{self, repo::users::Role},
};

/// Write `last_seen_at` at most once per minute, not on every request
/// ("Last active" shows minutes anyway).
const TOUCH_AFTER: &str = "-60 seconds";
/// The user agent comes from the client; device detection needs no more.
pub const MAX_USER_AGENT: usize = 512;
/// At most this many sessions per user (a new one ends the least recently
/// used ones beyond that, see [`trim`]).
pub const MAX_PER_USER: u32 = 20;
/// All columns of a session, `user_id` second ([`put_back`]).
const STORED_COLUMNS: &str = "id, user_id, token_hash, user_agent, ip, place, persistent, app, \
                              created_at, last_seen_at, expires_at";

fn idle_modifier() -> String {
    format!("+{} seconds", IDLE.as_secs())
}

pub fn insert(
    conn: &Connection,
    user_id: &str,
    token_hash: &[u8; 32],
    client: &Client<'_>,
    persistent: bool,
) -> anyhow::Result<String> {
    let id = db::new_id()?;
    conn.execute(
        "INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, place, persistent, app, \
                               expires_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?9))",
        (
            &id,
            user_id,
            token_hash.as_slice(),
            client.user_agent.map(|ua| truncate(ua, MAX_USER_AGENT)),
            client.ip.map(|ip| ip.to_string()),
            client.place,
            persistent,
            client.app,
            idle_modifier(),
        ),
    )?;
    Ok(id)
}

/// Session for the token hash if it has not expired and its user is active.
/// Extends it (and `users.last_seen_at`) once the last activity is more than
/// a minute ago; then `touched` is set and the cookie is renewed. If only the
/// extension fails (say because another process is writing), the request
/// stays authenticated – it works the next time.
pub fn authenticate(
    conn: &Connection,
    token_hash: &[u8; 32],
) -> anyhow::Result<Option<Authenticated>> {
    let found = conn
        .query_row(
            "SELECT s.id, s.last_seen_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?2), \
                    u.id, u.username, u.email, u.display_name, u.role, s.persistent \
             FROM sessions s JOIN users u ON u.id = s.user_id \
             WHERE s.token_hash = ?1 \
               AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
               AND u.status = 'active'",
            (token_hash.as_slice(), TOUCH_AFTER),
            |row| {
                let role: String = row.get(6)?;
                Ok((
                    row.get::<_, bool>(1)?,
                    row.get::<_, bool>(7)?,
                    AuthUser {
                        session_id: row.get(0)?,
                        id: row.get(2)?,
                        username: row.get(3)?,
                        email: row.get(4)?,
                        display_name: row.get(5)?,
                        role: Role::parse(&role).unwrap_or(Role::User),
                    },
                ))
            },
        )
        .optional()?;
    let Some((stale, persistent, user)) = found else {
        return Ok(None);
    };
    let touched = stale
        && touch(conn, &user)
            .inspect_err(|error| tracing::warn!(%error, "session not extended"))
            .is_ok();
    Ok(Some(Authenticated {
        user,
        touched,
        persistent,
    }))
}

pub struct Authenticated {
    pub user: AuthUser,
    pub touched: bool,
    /// "Stay signed in": the renewed cookie keeps its kind.
    pub persistent: bool,
}

/// Session and user together, so that not just one of them takes effect.
fn touch(conn: &Connection, user: &AuthUser) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE sessions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                             expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?2) \
         WHERE id = ?1",
        (&user.session_id, idle_modifier()),
    )?;
    tx.execute(
        "UPDATE users SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
        [&user.id],
    )?;
    tx.commit()
}

/// At most `max` bytes, cut at a character boundary.
pub fn truncate(value: &str, max: usize) -> &str {
    if value.len() <= max {
        return value;
    }
    let end = (0..=max)
        .rev()
        .find(|&i| value.is_char_boundary(i))
        .unwrap_or(0);
    &value[..end]
}

/// A valid session for Account › Security › Devices.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub id: String,
    pub user_agent: Option<String>,
    pub ip: Option<String>,
    pub place: Option<String>,
    /// Reported as an installed app on sign-in.
    pub app: bool,
    pub created_at: String,
    pub last_seen_at: String,
}

/// Valid sessions of the user, most recently active first.
pub fn list(conn: &Connection, user_id: &str) -> rusqlite::Result<Vec<Listed>> {
    conn.prepare(
        "SELECT id, user_agent, ip, place, app, created_at, last_seen_at FROM sessions \
         WHERE user_id = ?1 AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         ORDER BY last_seen_at DESC, rowid DESC",
    )?
    .query_map([user_id], |row| {
        Ok(Listed {
            id: row.get(0)?,
            user_agent: row.get(1)?,
            ip: row.get(2)?,
            place: row.get(3)?,
            app: row.get(4)?,
            created_at: row.get(5)?,
            last_seen_at: row.get(6)?,
        })
    })?
    .collect()
}

/// Whether the session still exists and has not expired – for changes that
/// follow a longer check in a transaction (change password, "Sign out all
/// others"): if the session ended in the meantime, the change does not apply.
pub fn is_valid(conn: &Connection, user_id: &str, session_id: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sessions WHERE id = ?1 AND user_id = ?2 \
                        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        (session_id, user_id),
        |row| row.get(0),
    )
}

/// Ends the user's sessions beyond `max`, least recently used first (so
/// expired ones not yet cleaned up go before all valid ones); `newest` always
/// stays. Returns the number deleted. No audit log entry: the sign-in that
/// triggers it is already logged.
pub fn trim(conn: &Connection, user_id: &str, newest: &str, max: u32) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM sessions WHERE user_id = ?1 AND id <> ?2 AND id NOT IN ( \
           SELECT id FROM sessions WHERE user_id = ?1 AND id <> ?2 \
           ORDER BY last_seen_at DESC, rowid DESC LIMIT ?3)",
        (user_id, newest, max.saturating_sub(1)),
    )
}

/// Deletes expired sessions (job `session_cleanup`); valid ones stay.
pub fn delete_expired(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        [],
    )
}

/// Ends a session of the user; `false` if it does not exist (any more).
pub fn delete(conn: &Connection, user_id: &str, session_id: &str) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "DELETE FROM sessions WHERE id = ?1 AND user_id = ?2",
        (session_id, user_id),
    )?;
    Ok(n > 0)
}

/// Ends all sessions of the user except `keep` (e.g. locking, changing the
/// password, "Sign out all others"). Returns the number of still valid
/// ones: expired rows not yet cleaned up are deleted too but do not count as
/// a signed-in device.
pub fn delete_for_user(
    conn: &Connection,
    user_id: &str,
    keep: Option<&str>,
) -> rusqlite::Result<usize> {
    delete_counting_active(
        conn,
        "DELETE FROM sessions WHERE user_id = ?1 AND id IS NOT ?2 \
         RETURNING expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        (user_id, keep),
    )
}

/// Ends all sessions (restoring a backup); returns the number
/// of deleted rows.
pub fn delete_all(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM sessions", [])
}

/// Row of a session that survives restoring a backup. No
/// `Debug`: it contains the token hash and the IP address.
pub struct Stored(Vec<Value>);

pub fn stored(conn: &Connection, id: &str) -> rusqlite::Result<Option<Stored>> {
    conn.query_row(
        &format!("SELECT {STORED_COLUMNS} FROM sessions WHERE id = ?1"),
        [id],
        |row| {
            (0..row.as_ref().column_count())
                .map(|column| row.get(column))
                .collect::<rusqlite::Result<_>>()
                .map(Stored)
        },
    )
    .optional()
}

/// Recreates the session if its user is active here; `true` if it is valid.
pub fn put_back(conn: &Connection, session: &Stored) -> rusqlite::Result<bool> {
    let values: Vec<_> = (1..=session.0.len()).map(|n| format!("?{n}")).collect();
    let inserted = conn.execute(
        &format!(
            "INSERT INTO sessions ({STORED_COLUMNS}) SELECT {} \
             WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2 AND status = 'active')",
            values.join(", ")
        ),
        params_from_iter(&session.0),
    )?;
    Ok(inserted > 0)
}

/// Ends the sessions of all users without administrator rights (turning on
/// maintenance mode). Like [`delete_for_user`], returns the
/// number of still valid ones.
pub fn delete_for_non_admins(conn: &Connection) -> rusqlite::Result<usize> {
    delete_counting_active(
        conn,
        "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role <> 'admin') \
         RETURNING expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        [],
    )
}

fn delete_counting_active(
    conn: &Connection,
    delete: &str,
    params: impl rusqlite::Params,
) -> rusqlite::Result<usize> {
    let active = conn
        .prepare(delete)?
        .query_map(params, |row| row.get::<_, bool>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(active.into_iter().filter(|active| *active).count())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        auth::session::{self, Client},
        db::repo::users::tests::{add, conn},
    };

    fn token_hash(conn: &Connection, user: &str) -> ([u8; 32], String) {
        let started = session::start(conn, user, &Client::default(), true).unwrap();
        let hash: Vec<u8> = conn
            .query_row(
                "SELECT token_hash FROM sessions WHERE id = ?1",
                [&started.id],
                |r| r.get(0),
            )
            .unwrap();
        (hash.try_into().unwrap(), started.id)
    }

    fn set(conn: &Connection, sql: &str, id: &str) {
        conn.execute(sql, [id]).unwrap();
    }

    #[test]
    fn authenticates_active_sessions_only() {
        let conn = conn();
        let user = add(&conn, "max", "max@example.com", Role::Admin);
        let (hash, id) = token_hash(&conn, &user);

        let found = authenticate(&conn, &hash).unwrap().unwrap();
        assert_eq!(found.user.id, user);
        assert_eq!(found.user.session_id, id);
        assert_eq!(found.user.role, Role::Admin);
        assert!(!found.touched, "a fresh session needs no extension");
        assert!(authenticate(&conn, &[0; 32]).unwrap().is_none());

        set(
            &conn,
            "UPDATE users SET status = 'locked' WHERE id = ?1",
            &user,
        );
        assert!(authenticate(&conn, &hash).unwrap().is_none());
        set(
            &conn,
            "UPDATE users SET status = 'active' WHERE id = ?1",
            &user,
        );

        set(
            &conn,
            "UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1",
            &id,
        );
        assert!(authenticate(&conn, &hash).unwrap().is_none());
    }

    #[test]
    fn touch_extends_session_and_last_seen() {
        let conn = conn();
        let user = add(&conn, "max", "max@example.com", Role::User);
        let (hash, id) = token_hash(&conn, &user);
        set(
            &conn,
            "UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00.000Z', \
                                 expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour') \
             WHERE id = ?1",
            &id,
        );

        assert!(authenticate(&conn, &hash).unwrap().unwrap().touched);
        let (days, seen): (f64, Option<String>) = conn
            .query_row(
                "SELECT julianday(s.expires_at) - julianday('now'), u.last_seen_at \
                 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!((days - 30.0).abs() < 0.01, "{days}");
        assert!(seen.is_some());
        // Not again within a minute.
        assert!(!authenticate(&conn, &hash).unwrap().unwrap().touched);
    }

    #[test]
    fn deletes_single_and_all_but_one() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        let eva = add(&conn, "eva", "eva@example.com", Role::User);
        let (_, a) = token_hash(&conn, &max);
        let (_, b) = token_hash(&conn, &max);
        token_hash(&conn, &max);
        let (_, other) = token_hash(&conn, &eva);

        assert!(!delete(&conn, &eva, &a).unwrap(), "foreign session");
        assert!(delete(&conn, &max, &a).unwrap());
        assert!(!delete(&conn, &max, &a).unwrap());
        assert_eq!(delete_for_user(&conn, &max, Some(&b)).unwrap(), 1);
        // Expired but not yet cleaned up: deleted, not counted.
        let (_, expired) = token_hash(&conn, &max);
        set(
            &conn,
            "UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1",
            &expired,
        );
        assert_eq!(delete_for_user(&conn, &max, None).unwrap(), 1);
        let left: Vec<String> = conn
            .prepare("SELECT id FROM sessions ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(left, [other]);
    }

    #[test]
    fn user_agent_is_truncated() {
        let conn = conn();
        let user = add(&conn, "max", "max@example.com", Role::User);
        let long = format!("Mozilla/5.0 {}", "é".repeat(600));
        let client = Client {
            user_agent: Some(&long),
            ..Client::default()
        };
        let started = session::start(&conn, &user, &client, true).unwrap();
        let stored: String = conn
            .query_row(
                "SELECT user_agent FROM sessions WHERE id = ?1",
                [&started.id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(stored.len() <= MAX_USER_AGENT && stored.len() >= MAX_USER_AGENT - 1);
        assert!(long.starts_with(&stored));
        assert_eq!(truncate("short", 10), "short");
    }

    #[test]
    fn failed_touch_keeps_request_authenticated() {
        let conn = conn();
        let user = add(&conn, "max", "max@example.com", Role::User);
        let (hash, id) = token_hash(&conn, &user);
        set(
            &conn,
            "UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1",
            &id,
        );
        conn.execute_batch(
            "CREATE TRIGGER no_touch BEFORE UPDATE ON users \
             BEGIN SELECT raise(ABORT, 'blocked'); END;",
        )
        .unwrap();

        let found = authenticate(&conn, &hash).unwrap().unwrap();
        assert!(!found.touched);
        // The session stayed unchanged too (one transaction).
        let seen: String = conn
            .query_row(
                "SELECT last_seen_at FROM sessions WHERE id = ?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(seen, "2000-01-01T00:00:00.000Z");
    }

    #[test]
    fn lists_valid_sessions_and_cleans_up_expired() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        let eva = add(&conn, "eva", "eva@example.com", Role::User);
        let client = Client {
            user_agent: Some("Firefox"),
            ip: Some("198.51.100.56".parse().unwrap()),
            place: Some("Berlin"),
            app: true,
        };
        let a = session::start(&conn, &max, &client, true).unwrap().id;
        let (_, b) = token_hash(&conn, &max);
        let (_, expired) = token_hash(&conn, &max);
        let (_, other) = token_hash(&conn, &eva);
        set(
            &conn,
            "UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1",
            &expired,
        );
        set(
            &conn,
            "UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1",
            &a,
        );

        let listed = list(&conn, &max).unwrap();
        let apps: Vec<bool> = listed.iter().map(|s| s.app).collect();
        assert_eq!(apps, [false, true]);
        let ids: Vec<&str> = listed.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, [b.as_str(), a.as_str()], "most recently active first");
        assert_eq!(listed[1].place.as_deref(), Some("Berlin"));
        assert_eq!(listed[1].ip.as_deref(), Some("198.51.100.56"));
        assert_eq!(listed[1].user_agent.as_deref(), Some("Firefox"));
        assert!(is_valid(&conn, &max, &a).unwrap());
        assert!(!is_valid(&conn, &eva, &a).unwrap(), "foreign session");
        assert!(!is_valid(&conn, &max, &expired).unwrap());

        assert_eq!(delete_expired(&conn).unwrap(), 1);
        assert_eq!(delete_expired(&conn).unwrap(), 0);
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 3);
        assert!(is_valid(&conn, &eva, &other).unwrap());
    }

    #[test]
    fn non_admin_sessions_end_and_admins_stay() {
        let conn = conn();
        let admin = add(&conn, "anna", "anna@example.com", Role::Admin);
        let user = add(&conn, "max", "max@example.com", Role::User);
        let (_, kept) = token_hash(&conn, &admin);
        token_hash(&conn, &user);
        let (_, expired) = token_hash(&conn, &user);
        conn.execute(
            "UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1",
            [&expired],
        )
        .unwrap();

        assert_eq!(delete_for_non_admins(&conn).unwrap(), 1);
        let left: String = conn
            .query_row("SELECT id FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, kept);
    }

    #[test]
    fn new_session_ends_the_least_recently_used_beyond_the_limit() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        let kai = add(&conn, "kai", "kai@example.com", Role::User);
        let other = session::start(&conn, &kai, &Client::default(), true)
            .unwrap()
            .id;
        let ids: Vec<String> = (0..MAX_PER_USER)
            .map(|_| {
                session::start(&conn, &max, &Client::default(), true)
                    .unwrap()
                    .id
            })
            .collect();
        // The second was inactive the longest, the first was active just now.
        set(
            &conn,
            "UPDATE sessions SET last_seen_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1",
            &ids[1],
        );
        set(
            &conn,
            "UPDATE sessions SET last_seen_at = '2099-01-01T00:00:00.000Z' WHERE id = ?1",
            &ids[0],
        );
        let ids_of = |user: &str| -> Vec<String> {
            list(&conn, user)
                .unwrap()
                .into_iter()
                .map(|s| s.id)
                .collect()
        };
        assert_eq!(ids_of(&max).len(), 20);

        let newest = session::start(&conn, &max, &Client::default(), true)
            .unwrap()
            .id;
        let left = ids_of(&max);
        assert_eq!(left.len(), 20);
        assert!(!left.contains(&ids[1]), "the least recently used one ends");
        assert!(left.contains(&ids[0]) && left.contains(&newest));
        // Other users stay untouched.
        assert_eq!(ids_of(&kai), [other]);

        // The new one stays even if all others were active later.
        conn.execute(
            "UPDATE sessions SET last_seen_at = '2099-01-01T00:00:00.000Z'",
            [],
        )
        .unwrap();
        let newest = session::start(&conn, &max, &Client::default(), true)
            .unwrap()
            .id;
        let left = ids_of(&max);
        assert_eq!(left.len(), 20);
        assert!(left.contains(&newest));
    }

    #[test]
    fn deleting_user_removes_sessions() {
        let conn = conn();
        let user = add(&conn, "max", "max@example.com", Role::User);
        token_hash(&conn, &user);
        conn.execute("DELETE FROM users WHERE id = ?1", [&user])
            .unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }
}
