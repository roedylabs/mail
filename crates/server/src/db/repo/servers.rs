//! Tables `servers` and `server_policy`: the mail server registry
//! (Administration › Mail servers), plus the pending DCR registrations in
//! `app_settings`. Input is validated by `api::servers`; this module only
//! reads and writes.

use std::{collections::HashMap, time::Duration};

use anyhow::Context as _;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OptionalExtension as _, Row};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::app_settings;
use crate::broker::probe::{Report, Status};

/// Purpose for the AAD of the encrypted client secret (`broker::crypto`).
pub const SECRET_PURPOSE: &str = "servers.oauth_client_secret";
/// Purpose for the secret of a pending registration; the row is the client
/// ID.
pub const PENDING_SECRET_PURPOSE: &str = "servers.pending_client_secret";
/// Key of the pending registrations in `app_settings`.
const REGISTRATIONS: &str = "server_registrations";
/// How long a registration waits for its server – the dialog saves right
/// afterwards, the setup only at the end, which can take a while. If it
/// expired before that, the server would get the client ID without a secret;
/// the deadline only clears away abandoned ones.
const REGISTRATION_TTL: Duration = Duration::from_secs(30 * 24 * 3600);
/// At most this many pending registrations; the oldest is dropped.
const MAX_REGISTRATIONS: usize = 20;

/// A row of `servers`. The client secret is stored only encrypted in the
/// database and never leaves the backend; here only whether there is one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Server {
    pub id: String,
    pub label: String,
    /// Scheme, host and port, e.g. `https://mail.example.com`.
    pub base_url: String,
    pub domains: Vec<String>,
    pub client_id: Option<String>,
    pub has_secret: bool,
    pub reach: Status,
    pub cors: Status,
    pub oauth: Status,
    pub tested_at: Option<String>,
}

/// Validated fields for [`insert`] and [`update`].
pub struct Fields<'a> {
    pub label: &'a str,
    pub base_url: &'a str,
    pub domains: &'a [String],
    pub client_id: Option<&'a str>,
}

/// What happens to the encrypted client secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretChange {
    Keep,
    Clear,
    /// New value from `broker::crypto::SecretKey::seal`.
    Set(Vec<u8>),
}

const COLUMNS: &str = "id, label, base_url, domains_json, oauth_client_id, \
     oauth_client_secret_enc IS NOT NULL, reach, cors, oauth, tested_at";

fn from_row(row: &Row<'_>) -> rusqlite::Result<(Server, String)> {
    let status = |i| {
        row.get::<_, String>(i)
            .map(|value| Status::parse(&value).unwrap_or(Status::Unk))
    };
    Ok((
        Server {
            id: row.get(0)?,
            label: row.get(1)?,
            base_url: row.get(2)?,
            domains: Vec::new(),
            client_id: row.get(4)?,
            has_secret: row.get(5)?,
            reach: status(6)?,
            cors: status(7)?,
            oauth: status(8)?,
            tested_at: row.get(9)?,
        },
        row.get(3)?,
    ))
}

fn with_domains((mut server, json): (Server, String)) -> anyhow::Result<Server> {
    server.domains = serde_json::from_str(&json)
        .with_context(|| format!("servers.domains_json of {} is invalid", server.id))?;
    Ok(server)
}

/// All servers in the order they were created (ULIDs).
pub fn list(conn: &Connection) -> anyhow::Result<Vec<Server>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM servers ORDER BY id"))?;
    let rows = stmt.query_map([], from_row)?;
    rows.map(|row| with_domains(row?)).collect()
}

pub fn get(conn: &Connection, id: &str) -> anyhow::Result<Option<Server>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM servers WHERE id = ?1"),
        [id],
        from_row,
    )
    .optional()?
    .map(with_domains)
    .transpose()
}

/// Server with the origin `base_url`.
pub fn find_by_base_url(conn: &Connection, base_url: &str) -> anyhow::Result<Option<Server>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM servers WHERE base_url = ?1"),
        [base_url],
        from_row,
    )
    .optional()?
    .map(with_domains)
    .transpose()
}

/// IDs of the servers per origin (linked mail accounts).
pub fn ids_by_base_url(conn: &Connection) -> rusqlite::Result<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT base_url, id FROM servers")?;
    stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect()
}

/// Encrypted client secret of the server (code exchange, refresh and
/// revocation in the backend), only while the server still has the address
/// and client the caller read with it: an administrator may have changed
/// both since, and a secret must never go to an address or client it was
/// not entered for. One query, so the check cannot race with [`update`].
pub fn client_secret(
    conn: &Connection,
    id: &str,
    base_url: &str,
    client_id: &str,
) -> rusqlite::Result<Option<Vec<u8>>> {
    conn.query_row(
        "SELECT oauth_client_secret_enc FROM servers \
         WHERE id = ?1 AND base_url = ?2 AND oauth_client_id = ?3",
        (id, base_url, client_id),
        |row| row.get(0),
    )
    .optional()
    .map(Option::flatten)
}

/// Creates a server with the ID `id` (`db::new_id`; encrypting the secret
/// needs it beforehand).
pub fn insert(
    conn: &Connection,
    id: &str,
    fields: &Fields<'_>,
    secret: Option<&[u8]>,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO servers (id, label, base_url, domains_json, oauth_client_id, \
         oauth_client_secret_enc) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        (
            id,
            fields.label,
            fields.base_url,
            serde_json::to_string(fields.domains)?,
            fields.client_id,
            secret,
        ),
    )
    .context("server not created")?;
    Ok(())
}

/// Writes all fields; with `reset` the last diagnosis no longer applies
/// (address or client changed). `false` if the server does not exist.
pub fn update(
    conn: &Connection,
    id: &str,
    fields: &Fields<'_>,
    secret: &SecretChange,
    reset: bool,
) -> anyhow::Result<bool> {
    let (mode, value) = match secret {
        SecretChange::Keep => (0, None),
        SecretChange::Clear => (1, None),
        SecretChange::Set(value) => (2, Some(value.as_slice())),
    };
    let changed = conn
        .execute(
            "UPDATE servers SET label = ?2, base_url = ?3, domains_json = ?4, \
             oauth_client_id = ?5, \
             oauth_client_secret_enc = CASE ?6 WHEN 0 THEN oauth_client_secret_enc \
                                               WHEN 1 THEN NULL ELSE ?7 END, \
             reach = CASE WHEN ?8 THEN 'unk' ELSE reach END, \
             cors = CASE WHEN ?8 THEN 'unk' ELSE cors END, \
             oauth = CASE WHEN ?8 THEN 'unk' ELSE oauth END, \
             tested_at = CASE WHEN ?8 THEN NULL ELSE tested_at END \
             WHERE id = ?1",
            (
                id,
                fields.label,
                fields.base_url,
                serde_json::to_string(fields.domains)?,
                fields.client_id,
                mode,
                value,
                reset,
            ),
        )
        .context("server not updated")?;
    Ok(changed == 1)
}

/// `false` if the server does not exist.
pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    Ok(conn.execute("DELETE FROM servers WHERE id = ?1", [id])? == 1)
}

/// Stores the result of a diagnosis – only if address and client ID are
/// still the ones tested. If someone changed the server in the meantime, the
/// result would apply to the old state; then `false`.
pub fn record_test(
    conn: &Connection,
    id: &str,
    base_url: &str,
    client_id: Option<&str>,
    report: &Report,
) -> rusqlite::Result<bool> {
    let changed = conn.execute(
        "UPDATE servers SET reach = ?4, cors = ?5, oauth = ?6, \
         tested_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE id = ?1 AND base_url = ?2 AND oauth_client_id IS ?3",
        (
            id,
            base_url,
            client_id,
            report.reach.as_str(),
            report.cors.as_str(),
            report.oauth.as_str(),
        ),
    )?;
    Ok(changed == 1)
}

/// Servers whose last test is older than `age` or that were never tested
/// (job `server_probe`).
pub fn due_for_test(conn: &Connection, age: Duration) -> anyhow::Result<Vec<Server>> {
    let modifier = format!("-{} seconds", age.as_secs());
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM servers \
         WHERE tested_at IS NULL OR tested_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?1) \
         ORDER BY id"
    ))?;
    let rows = stmt
        .query_map([modifier], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter().map(with_domains).collect()
}

/// Base URLs of all servers (for `connect-src` of the CSP).
pub fn base_urls(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT base_url FROM servers ORDER BY base_url")?;
    stmt.query_map([], |row| row.get(0))?.collect()
}

/// Policy "Allow custom server URLs" (off by default).
pub fn allow_custom_servers(conn: &Connection) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT allow_custom_servers FROM server_policy WHERE id = 1",
        [],
        |row| row.get(0),
    )
}

/// `true` if the value changed.
pub fn set_allow_custom_servers(conn: &Connection, allow: bool) -> rusqlite::Result<bool> {
    let changed = conn.execute(
        "UPDATE server_policy SET allow_custom_servers = ?1, \
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE id = 1 AND allow_custom_servers <> ?1",
        [allow],
    )?;
    Ok(changed == 1)
}

/// A client registered via DCR until "Add"/"Save" or
/// `setup/complete` assigns it to a server: the registration runs before
/// saving, but the secret must never reach the browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingRegistration {
    /// Origin of the mail server.
    pub base_url: String,
    pub client_id: String,
    /// Redirect URI the client is valid for.
    pub redirect_uri: String,
    /// Secret, encrypted with [`PENDING_SECRET_PURPOSE`] and the client ID
    /// (`broker::crypto`); Base64 in JSON.
    #[serde(serialize_with = "to_base64", deserialize_with = "from_base64")]
    pub sealed_secret: Vec<u8>,
    /// Time of the registration in Unix seconds.
    pub registered_at: i64,
}

fn to_base64<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&STANDARD.encode(bytes))
}

fn from_base64<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
    let text = String::deserialize(deserializer)?;
    STANDARD.decode(text).map_err(serde::de::Error::custom)
}

/// Pending registrations still valid at `now` (Unix seconds), and whether
/// expired ones were dropped. An unreadable list counts as empty (and
/// expired) so that it does not block saving servers.
fn registrations(conn: &Connection, now: i64) -> anyhow::Result<(Vec<PendingRegistration>, bool)> {
    let ttl = i64::try_from(REGISTRATION_TTL.as_secs())?;
    let Some(value) = app_settings::get::<serde_json::Value>(conn, REGISTRATIONS)? else {
        return Ok((Vec::new(), false));
    };
    let mut list: Vec<PendingRegistration> = match serde_json::from_value(value) {
        Ok(list) => list,
        Err(error) => {
            tracing::warn!("app_settings.{REGISTRATIONS} unreadable, discarded: {error}");
            return Ok((Vec::new(), true));
        }
    };
    let before = list.len();
    list.retain(|r| r.registered_at <= now && now - r.registered_at < ttl);
    let pruned = list.len() != before;
    Ok((list, pruned))
}

fn save_registrations(conn: &Connection, list: &[PendingRegistration]) -> anyhow::Result<()> {
    if list.is_empty() {
        app_settings::delete(conn, REGISTRATIONS)?;
        Ok(())
    } else {
        app_settings::set(conn, REGISTRATIONS, &list)
    }
}

/// Remembers a registration; it replaces an older one for the same client,
/// expired ones are dropped.
pub fn remember_registration(
    conn: &Connection,
    registration: PendingRegistration,
    now: i64,
) -> anyhow::Result<()> {
    let (mut list, _) = registrations(conn, now)?;
    list.retain(|r| r.client_id != registration.client_id || r.base_url != registration.base_url);
    list.push(registration);
    let excess = list.len().saturating_sub(MAX_REGISTRATIONS);
    list.drain(..excess);
    save_registrations(conn, &list)
}

/// The pending registration of the client `client_id` on `base_url`.
pub fn find_registration(
    conn: &Connection,
    base_url: &str,
    client_id: &str,
    now: i64,
) -> anyhow::Result<Option<PendingRegistration>> {
    Ok(registrations(conn, now)?
        .0
        .into_iter()
        .find(|r| r.base_url == base_url && r.client_id == client_id))
}

/// Like [`find_registration`], but removes it (and expired ones): a server
/// has taken over the client. Writes only if something changes.
pub fn take_registration(
    conn: &Connection,
    base_url: &str,
    client_id: &str,
    now: i64,
) -> anyhow::Result<Option<PendingRegistration>> {
    let (mut list, pruned) = registrations(conn, now)?;
    let found = list
        .iter()
        .position(|r| r.base_url == base_url && r.client_id == client_id)
        .map(|index| list.remove(index));
    if found.is_some() || pruned {
        save_registrations(conn, &list)?;
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::users::tests::conn;

    fn registration(client_id: &str, registered_at: i64) -> PendingRegistration {
        PendingRegistration {
            base_url: "https://mail.s1.test".into(),
            client_id: client_id.into(),
            redirect_uri: "https://app.example.com/oauth/callback".into(),
            sealed_secret: vec![1, 2, 255],
            registered_at,
        }
    }

    #[test]
    fn pending_registrations_expire_and_are_taken_once() {
        let conn = conn();
        let now = 1_800_000_000;
        assert_eq!(
            find_registration(&conn, "https://mail.s1.test", "a", now).unwrap(),
            None
        );
        remember_registration(&conn, registration("a", now - 10), now).unwrap();
        remember_registration(&conn, registration("b", now), now).unwrap();
        assert_eq!(
            find_registration(&conn, "https://mail.s1.test", "a", now).unwrap(),
            Some(registration("a", now - 10))
        );
        // Only for the same server.
        assert_eq!(
            find_registration(&conn, "https://mail.s2.test", "a", now).unwrap(),
            None
        );
        // Expired after 30 days.
        assert!(
            find_registration(&conn, "https://mail.s1.test", "a", now + 29 * 86_400)
                .unwrap()
                .is_some()
        );
        assert_eq!(
            find_registration(&conn, "https://mail.s1.test", "a", now + 30 * 86_400).unwrap(),
            None
        );
        assert_eq!(
            take_registration(&conn, "https://mail.s1.test", "a", now).unwrap(),
            Some(registration("a", now - 10))
        );
        assert_eq!(
            take_registration(&conn, "https://mail.s1.test", "a", now).unwrap(),
            None
        );
        assert!(
            find_registration(&conn, "https://mail.s1.test", "b", now)
                .unwrap()
                .is_some()
        );
        // The last one removes the key.
        take_registration(&conn, "https://mail.s1.test", "b", now).unwrap();
        assert_eq!(
            app_settings::get::<serde_json::Value>(&conn, REGISTRATIONS).unwrap(),
            None
        );

        // At most 20; the same client ID replaces the older one.
        for i in 0..25 {
            remember_registration(&conn, registration(&format!("c{i}"), now), now).unwrap();
        }
        remember_registration(&conn, registration("c24", now + 1), now + 1).unwrap();
        let (list, _) = registrations(&conn, now + 1).unwrap();
        assert_eq!(list.len(), MAX_REGISTRATIONS);
        assert_eq!(list[0].client_id, "c5");
        assert_eq!(list.last().unwrap().registered_at, now + 1);

        // An unreadable list blocks nothing and is replaced on the next
        // write.
        app_settings::set(&conn, REGISTRATIONS, &serde_json::json!({ "broken": 1 })).unwrap();
        assert_eq!(
            take_registration(&conn, "https://mail.s1.test", "c5", now).unwrap(),
            None
        );
        assert_eq!(
            app_settings::get::<serde_json::Value>(&conn, REGISTRATIONS).unwrap(),
            None
        );
        app_settings::set(&conn, REGISTRATIONS, &serde_json::json!("broken")).unwrap();
        remember_registration(&conn, registration("d", now), now).unwrap();
        assert!(
            find_registration(&conn, "https://mail.s1.test", "d", now)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn the_client_secret_only_for_the_address_and_client_it_was_read_with() {
        let conn = conn();
        let fields = Fields {
            label: "Mail",
            base_url: "https://mail.s1.test",
            domains: &[],
            client_id: Some("roedy"),
        };
        insert(&conn, "s1", &fields, Some(&[7, 8, 9])).unwrap();
        let secret = |base_url: &str, client_id: &str| {
            client_secret(&conn, "s1", base_url, client_id).unwrap()
        };
        assert_eq!(secret("https://mail.s1.test", "roedy"), Some(vec![7, 8, 9]));
        assert_eq!(secret("https://mail.s2.test", "roedy"), None);
        assert_eq!(secret("https://mail.s1.test", "other"), None);
        assert_eq!(
            client_secret(&conn, "s2", "https://mail.s1.test", "roedy").unwrap(),
            None
        );
    }
}
