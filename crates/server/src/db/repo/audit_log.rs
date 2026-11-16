//! Table `audit_log`: admin and security actions, shown under
//! Administration › Audit log (`api::audit`). Each task records its own
//! actions, in the same transaction as the change; the texts for each key
//! live in `api::audit::texts`.

use std::net::IpAddr;

use rusqlite::{Connection, Row as SqlRow};
use serde_json::Value;

use crate::{
    auth::session::{AuthUser, Client},
    db::repo::{app_settings, users::Profile},
};

/// Key of the retention setting in `app_settings`.
const KEEP_KEY: &str = "audit_keep_days";
/// Selectable retention periods in days (`AUDIT_KEEP`).
pub const KEEP_CHOICES: [u32; 3] = [30, 90, 365];
/// Default like `aKeep`.
pub const KEEP_DEFAULT: u32 = 90;

/// Retention in days; an unknown value in the database counts as the
/// default, so that never more is deleted than someone chose.
pub fn keep_days(conn: &Connection) -> anyhow::Result<u32> {
    Ok(app_settings::get::<Value>(conn, KEEP_KEY)?
        .and_then(|days| u32::try_from(days.as_u64()?).ok())
        .filter(|days| KEEP_CHOICES.contains(days))
        .unwrap_or(KEEP_DEFAULT))
}

/// Sets the retention; `days` is one of the [`KEEP_CHOICES`].
pub fn set_keep_days(conn: &Connection, days: u32) -> anyhow::Result<()> {
    app_settings::set(conn, KEEP_KEY, &days)
}

/// Categories of the audit log (the filter of the audit log page).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    /// Sign-ins
    Login,
    /// Users
    Users,
    /// Settings
    Settings,
    /// System
    System,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Login => "login",
            Self::Users => "users",
            Self::Settings => "settings",
            Self::System => "system",
        }
    }

    /// All categories in display order.
    pub const ALL: [Self; 4] = [Self::Login, Self::Users, Self::Settings, Self::System];

    /// Name as in the table and in the filter `cat`.
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.as_str() == value)
    }
}

/// An entry. `action` is a stable key (`auth.login`, `users.lock` …) that
/// `api::audit::texts` turns into text.
#[derive(Debug, Clone)]
pub struct Entry {
    pub category: Category,
    pub action: &'static str,
    pub actor_id: Option<String>,
    pub actor_name: Option<String>,
    pub target: Option<String>,
    pub ip: Option<IpAddr>,
    /// Place of the client IP from GeoIP.
    pub place: Option<String>,
    pub details: Option<Value>,
}

impl Entry {
    pub fn new(category: Category, action: &'static str) -> Self {
        Self {
            category,
            action,
            actor_id: None,
            actor_name: None,
            target: None,
            ip: None,
            place: None,
            details: None,
        }
    }

    pub fn actor(mut self, user: &AuthUser) -> Self {
        self.actor_id = Some(user.id.clone());
        self.actor_name = Some(user.display_name.clone());
        self
    }

    /// Actor without a session (failed sign-in, links from mails) or with the
    /// state from the database (deleting the account).
    pub fn actor_profile(mut self, user: &Profile) -> Self {
        self.actor_id = Some(user.id.clone());
        self.actor_name = Some(user.display_name.clone());
        self
    }

    pub fn target(mut self, target: impl Into<String>) -> Self {
        self.target = Some(target.into());
        self
    }

    pub fn ip(mut self, ip: IpAddr) -> Self {
        self.ip = Some(ip);
        self
    }

    /// Client IP and place of a sign-in.
    pub fn client(mut self, client: &Client<'_>) -> Self {
        self.ip = client.ip;
        self.place = client.place.map(str::to_owned);
        self
    }

    /// Further details as JSON – never passwords, tokens or codes.
    pub fn details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

pub fn insert(conn: &Connection, entry: &Entry) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO audit_log (category, action, actor_id, actor_name, target, ip, place, \
                                details) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        (
            entry.category.as_str(),
            entry.action,
            &entry.actor_id,
            &entry.actor_name,
            &entry.target,
            entry.ip.map(|ip| ip.to_string()),
            &entry.place,
            entry.details.as_ref().map(Value::to_string),
        ),
    )?;
    Ok(())
}

/// An entry for reading.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub id: i64,
    /// UTC like `2026-11-05T09:26:00.000Z`.
    pub at: String,
    pub category: Category,
    pub action: String,
    pub actor_name: Option<String>,
    pub ip: Option<String>,
    pub place: Option<String>,
    pub details: Option<Value>,
}

impl Row {
    fn from_sql(row: &SqlRow<'_>) -> rusqlite::Result<Option<Self>> {
        let category: String = row.get(2)?;
        let Some(category) = Category::parse(&category) else {
            return Ok(None);
        };
        let details: Option<String> = row.get(7)?;
        Ok(Some(Self {
            id: row.get(0)?,
            at: row.get(1)?,
            category,
            action: row.get(3)?,
            actor_name: row.get(4)?,
            ip: row.get(5)?,
            place: row.get(6)?,
            details: details.and_then(|text| serde_json::from_str(&text).ok()),
        }))
    }
}

/// Time range of a query, both in UTC in the format of [`Row::at`].
#[derive(Debug, Default, Clone)]
pub struct Range {
    /// From this point in time (inclusive).
    pub from: Option<String>,
    /// Before this point in time.
    pub to: Option<String>,
}

/// Columns and condition of all queries: retention in `?1`, range in `?2`, `?3`.
const COLUMNS: &str = "id, at, category, action, actor_name, ip, place, details";
const WITHIN: &str = "at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?1) \
                      AND (?2 IS NULL OR at >= ?2) AND (?3 IS NULL OR at < ?3)";

/// Walks the entries of the last `keep_days` days in the range `range`,
/// newest first, and calls `visit` for each: for search and export, which
/// work on the finished texts in Rust (`api::audit`). Without a search,
/// [`page`] and [`counts`] suffice, which barely occupy the shared
/// connection.
pub fn scan(
    conn: &Connection,
    keep_days: u32,
    range: &Range,
    mut visit: impl FnMut(Row),
) -> rusqlite::Result<()> {
    let mut statement = conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM audit_log WHERE {WITHIN} ORDER BY id DESC"
    ))?;
    let mut rows = statement.query((format!("-{keep_days} days"), &range.from, &range.to))?;
    while let Some(row) = rows.next()? {
        if let Some(row) = Row::from_sql(row)? {
            visit(row);
        }
    }
    Ok(())
}

/// At most `limit` entries as with [`scan`], only from `category` (all when
/// absent) and older than `before`.
pub fn page(
    conn: &Connection,
    keep_days: u32,
    range: &Range,
    category: Option<Category>,
    before: Option<i64>,
    limit: usize,
) -> rusqlite::Result<Vec<Row>> {
    let mut statement = conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM audit_log WHERE {WITHIN} \
         AND (?4 IS NULL OR category = ?4) AND (?5 IS NULL OR id < ?5) \
         ORDER BY id DESC LIMIT ?6"
    ))?;
    let rows = statement.query_map(
        (
            format!("-{keep_days} days"),
            &range.from,
            &range.to,
            category.map(Category::as_str),
            before,
            i64::try_from(limit).unwrap_or(i64::MAX),
        ),
        Row::from_sql,
    )?;
    rows.filter_map(Result::transpose).collect()
}

/// Entries per category as with [`scan`].
pub fn counts(
    conn: &Connection,
    keep_days: u32,
    range: &Range,
) -> rusqlite::Result<Vec<(Category, u64)>> {
    let mut statement = conn.prepare_cached(&format!(
        "SELECT category, count(*) FROM audit_log WHERE {WITHIN} GROUP BY category"
    ))?;
    let rows = statement.query_map(
        (format!("-{keep_days} days"), &range.from, &range.to),
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
    )?;
    rows.filter_map(|row| match row {
        Ok((name, n)) => Category::parse(&name).map(|category| Ok((category, n.unsigned_abs()))),
        Err(error) => Some(Err(error)),
    })
    .collect()
}

/// Deletes what is older than `days` days; returns the number of deleted
/// entries (job `audit_retention`).
pub fn delete_old(conn: &Connection, days: u32) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM audit_log WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?1)",
        [format!("-{days} days")],
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
    fn records_entry_and_keeps_name_after_user_is_deleted() {
        let conn = conn();
        let id = add(&conn, "max", "max@example.com", Role::Admin);
        let actor = AuthUser {
            id: id.clone(),
            username: "max".into(),
            email: "max@example.com".into(),
            display_name: "Max Mustermann".into(),
            role: Role::Admin,
            session_id: "s".into(),
        };
        let entry = Entry::new(Category::Users, "users.lock")
            .actor(&actor)
            .target("01J0000000000000000000000")
            .ip("203.0.113.7".parse().unwrap())
            .details(serde_json::json!({ "reason": "test" }));
        insert(&conn, &entry).unwrap();
        insert(&conn, &Entry::new(Category::System, "system.start")).unwrap();

        conn.execute("DELETE FROM users WHERE id = ?1", [&id])
            .unwrap();
        let row: (
            String,
            String,
            Option<String>,
            String,
            String,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT category, action, actor_id, actor_name, target, ip, details \
                 FROM audit_log ORDER BY id LIMIT 1",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            row,
            (
                "users".into(),
                "users.lock".into(),
                None,
                "Max Mustermann".into(),
                "01J0000000000000000000000".into(),
                "203.0.113.7".into(),
                r#"{"reason":"test"}"#.into(),
            )
        );
    }

    #[test]
    fn category_names_match_schema() {
        let conn = conn();
        for category in Category::ALL {
            insert(&conn, &Entry::new(category, "test")).unwrap();
            assert_eq!(Category::parse(category.as_str()), Some(category));
        }
        assert_eq!(Category::parse("Sign-in"), None);
    }

    /// Sets `at` of an entry to `days` days ago.
    fn age(conn: &Connection, action: &str, days: u32) {
        conn.execute(
            "UPDATE audit_log SET at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?1) \
             WHERE action = ?2",
            (format!("-{days} days"), action),
        )
        .unwrap();
    }

    fn actions(conn: &Connection, keep_days: u32, range: &Range) -> Vec<String> {
        let mut seen = Vec::new();
        scan(conn, keep_days, range, |row| seen.push(row.action)).unwrap();
        seen
    }

    #[test]
    fn scan_lists_newest_first_within_retention_and_range() {
        let conn = conn();
        for action in ["old", "middle", "new"] {
            insert(&conn, &Entry::new(Category::System, action)).unwrap();
        }
        age(&conn, "old", 100);
        age(&conn, "middle", 10);

        assert_eq!(
            actions(&conn, 90, &Range::default()),
            ["new", "middle"],
            "older than the retention no longer counts, even before the cleanup"
        );
        assert_eq!(
            actions(&conn, 365, &Range::default()),
            ["new", "middle", "old"]
        );

        let at = |days: i64| {
            let at = jiff::Timestamp::now() - jiff::SignedDuration::from_hours(days * 24);
            at.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
        };
        let until_yesterday = Range {
            from: None,
            to: Some(at(1)),
        };
        assert_eq!(actions(&conn, 365, &until_yesterday), ["middle", "old"]);
        let since_last_month = Range {
            from: Some(at(30)),
            to: None,
        };
        assert_eq!(actions(&conn, 365, &since_last_month), ["new", "middle"]);
    }

    #[test]
    fn page_filters_by_category_and_cursor_and_counts_ignore_both() {
        let conn = conn();
        for (category, action) in [
            (Category::Login, "a"),
            (Category::Users, "b"),
            (Category::Login, "c"),
            (Category::Login, "d"),
        ] {
            insert(&conn, &Entry::new(category, action)).unwrap();
        }
        insert(&conn, &Entry::new(Category::System, "old")).unwrap();
        age(&conn, "old", 100);
        let range = Range::default();
        let names = |category, before, limit| -> Vec<String> {
            page(&conn, 90, &range, category, before, limit)
                .unwrap()
                .into_iter()
                .map(|row| row.action)
                .collect()
        };
        assert_eq!(names(None, None, 10), ["d", "c", "b", "a"]);
        assert_eq!(names(Some(Category::Login), None, 2), ["d", "c"]);
        let c = page(&conn, 90, &range, Some(Category::Login), None, 2).unwrap()[1].id;
        assert_eq!(names(Some(Category::Login), Some(c), 2), ["a"]);

        let mut counted = counts(&conn, 90, &range).unwrap();
        counted.sort_by_key(|(category, _)| category.as_str());
        assert_eq!(
            counted,
            [(Category::Login, 3), (Category::Users, 1)],
            "the expired row does not count"
        );
    }

    #[test]
    fn keep_days_default_and_unknown_values() {
        let conn = conn();
        assert_eq!(keep_days(&conn).unwrap(), 90);
        set_keep_days(&conn, 365).unwrap();
        assert_eq!(keep_days(&conn).unwrap(), 365);
        set_keep_days(&conn, 1).unwrap();
        assert_eq!(
            keep_days(&conn).unwrap(),
            90,
            "an unknown value deletes nothing"
        );
        app_settings::set(&conn, KEEP_KEY, &"30").unwrap();
        assert_eq!(keep_days(&conn).unwrap(), 90, "also another type");
        app_settings::set(&conn, KEEP_KEY, &-30).unwrap();
        assert_eq!(keep_days(&conn).unwrap(), 90, "also a negative value");
    }

    #[test]
    fn delete_old_removes_only_what_is_older() {
        let conn = conn();
        for action in ["old", "new"] {
            insert(&conn, &Entry::new(Category::Login, action)).unwrap();
        }
        age(&conn, "old", 31);
        assert_eq!(delete_old(&conn, 90).unwrap(), 0);
        assert_eq!(delete_old(&conn, 30).unwrap(), 1);
        assert_eq!(actions(&conn, 365, &Range::default()), ["new"]);
    }
}
