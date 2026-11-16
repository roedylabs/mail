//! Schema migrations. Each migration runs exactly once and is recorded in
//! `schema_migrations`; applied migrations are never changed.

use anyhow::{Context as _, bail};
use rusqlite::{Connection, TransactionBehavior};

pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
}

/// All migrations, ascending and without gaps from 1.
pub const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "init",
    sql: include_str!("migrations/0001_init.sql"),
}];

/// Applies all pending migrations and returns the schema version.
pub fn run(conn: &mut Connection) -> anyhow::Result<i64> {
    run_with(conn, MIGRATIONS)
}

fn run_with(conn: &mut Connection, migrations: &[Migration]) -> anyhow::Result<i64> {
    // IMMEDIATE locks out writers at once: if the server and `migrate` run at the
    // same time, the second process waits and then finds nothing left to do.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = current_version(&tx)?;
    let latest = migrations.last().map_or(0, |m| m.version);
    if current > latest {
        bail!(
            "The database schema (version {current}) is newer than this program version \
             (version {latest}). Please use the newer version of Roedy Mail."
        );
    }
    let mut applied = Vec::new();
    for m in migrations.iter().filter(|m| m.version > current) {
        tx.execute_batch(m.sql)
            .with_context(|| format!("Migration {:04} ({}) failed", m.version, m.name))?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name) VALUES (?1, ?2)",
            (m.version, m.name),
        )?;
        applied.push(m);
    }
    tx.commit()?;
    for m in applied {
        tracing::info!(version = m.version, name = m.name, "migration applied");
    }
    Ok(current.max(latest))
}

/// Schema version of this program.
pub fn latest_version() -> i64 {
    MIGRATIONS.last().map_or(0, |m| m.version)
}

/// Current schema version; 0 for an empty database.
pub fn current_version(conn: &Connection) -> rusqlite::Result<i64> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_schema \
         WHERE type = 'table' AND name = 'schema_migrations')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(0);
    }
    conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table_names(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
            .unwrap();
        stmt.query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    fn latest() -> i64 {
        MIGRATIONS.last().unwrap().version
    }

    /// The existing migrations with different SQL, followed by `next`.
    fn followed_by(sql: &'static str, next: Migration) -> Vec<Migration> {
        MIGRATIONS
            .iter()
            .map(|m| Migration {
                version: m.version,
                name: m.name,
                sql,
            })
            .chain([next])
            .collect()
    }

    #[test]
    fn versions_are_contiguous_from_one() {
        for (i, m) in MIGRATIONS.iter().enumerate() {
            assert_eq!(m.version, i64::try_from(i).unwrap() + 1, "{}", m.name);
        }
    }

    #[test]
    fn applies_schema_once() {
        let mut conn = Connection::open_in_memory().unwrap();
        assert_eq!(current_version(&conn).unwrap(), 0);

        let latest = latest();
        assert_eq!(run(&mut conn).unwrap(), latest);
        assert_eq!(
            table_names(&conn),
            [
                "app_settings",
                "assets",
                "audit_log",
                "email_changes",
                "invitations",
                "known_devices",
                "mail_accounts",
                "notification_deliveries",
                "notifications",
                "password_resets",
                "push_subscriptions",
                "recovery_codes",
                "schema_migrations",
                "server_policy",
                "servers",
                "sessions",
                "tag_links",
                "tags",
                "totp_devices",
                "update_state",
                "user_settings",
                "users"
            ]
        );

        // A second run changes nothing.
        assert_eq!(run(&mut conn).unwrap(), latest);
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, latest);
    }

    #[test]
    fn applies_only_pending_migrations() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        let next = followed_by(
            "SELECT raise(ABORT, 'must not run again')",
            Migration {
                version: latest() + 1,
                name: "new",
                sql: "CREATE TABLE new_table (id INTEGER PRIMARY KEY) STRICT;",
            },
        );
        assert_eq!(run_with(&mut conn, &next).unwrap(), latest() + 1);
        assert!(table_names(&conn).contains(&"new_table".to_owned()));
    }

    #[test]
    fn failed_migration_rolls_back() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        let next = followed_by(
            "",
            Migration {
                version: latest() + 1,
                name: "broken",
                sql: "CREATE TABLE half (id INTEGER); SELECT * FROM missing;",
            },
        );
        let err = run_with(&mut conn, &next).unwrap_err();
        let expected = format!("Migration {:04} (broken)", latest() + 1);
        assert!(format!("{err:#}").contains(&expected), "{err:#}");
        assert_eq!(current_version(&conn).unwrap(), latest());
        assert!(!table_names(&conn).contains(&"half".to_owned()));
    }

    #[test]
    fn refuses_newer_schema() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO schema_migrations (version, name) VALUES (99, 'future')",
            [],
        )
        .unwrap();
        let err = run(&mut conn).unwrap_err();
        assert!(err.to_string().contains("version 99"), "{err}");
    }
}
