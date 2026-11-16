//! Table `app_settings`: instance settings as JSON per key.

use anyhow::Context as _;
use rusqlite::{Connection, OptionalExtension as _};
use serde::{Serialize, de::DeserializeOwned};

/// Public address from the setup when `ROEDY_PUBLIC_URL` is missing;
/// JSON text like `"https://mail.example.com/"`.
pub const PUBLIC_URL: &str = "public_url";
/// Sending account for system mails (`mailer::system_mail`).
pub const SYSTEM_MAIL: &str = "system_mail";
/// VAPID keys for web push, encrypted (`push::vapid`).
pub const VAPID: &str = "vapid";

pub fn get<T: DeserializeOwned>(conn: &Connection, key: &str) -> anyhow::Result<Option<T>> {
    let json: Option<String> = conn
        .query_row(
            "SELECT json FROM app_settings WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()?;
    json.map(|json| serde_json::from_str(&json))
        .transpose()
        .with_context(|| format!("app_settings.{key} is not valid JSON"))
}

/// Inserts the value if the key is missing. `true` if it is new.
pub fn insert_if_absent<T: Serialize>(
    conn: &Connection,
    key: &str,
    value: &T,
) -> anyhow::Result<bool> {
    let json = serde_json::to_string(value)?;
    let inserted = conn.execute(
        "INSERT INTO app_settings (key, json) VALUES (?1, ?2) ON CONFLICT (key) DO NOTHING",
        (key, json),
    )?;
    Ok(inserted == 1)
}

/// Inserts or replaces the value.
pub fn set<T: Serialize>(conn: &Connection, key: &str, value: &T) -> anyhow::Result<()> {
    let json = serde_json::to_string(value)?;
    conn.execute(
        "INSERT INTO app_settings (key, json) VALUES (?1, ?2) \
         ON CONFLICT (key) DO UPDATE SET json = excluded.json, \
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        (key, json),
    )?;
    Ok(())
}

/// Removes the key. `true` if it existed.
pub fn delete(conn: &Connection, key: &str) -> rusqlite::Result<bool> {
    conn.execute("DELETE FROM app_settings WHERE key = ?1", [key])
        .map(|deleted| deleted == 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    #[test]
    fn insert_if_absent_keeps_first_value() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();

        assert_eq!(get::<String>(&conn, "k").unwrap(), None);
        assert!(insert_if_absent(&conn, "k", &"first").unwrap());
        assert!(!insert_if_absent(&conn, "k", &"second").unwrap());
        assert_eq!(get::<String>(&conn, "k").unwrap().as_deref(), Some("first"));
    }

    #[test]
    fn set_replaces_and_delete_removes() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();

        set(&conn, "k", &"first").unwrap();
        set(&conn, "k", &"second").unwrap();
        assert_eq!(
            get::<String>(&conn, "k").unwrap().as_deref(),
            Some("second")
        );
        assert!(delete(&conn, "k").unwrap());
        assert!(!delete(&conn, "k").unwrap());
        assert_eq!(get::<String>(&conn, "k").unwrap(), None);
    }
}
