//! Table `mail_accounts`: users' mail accounts.
//! `api::mail_accounts` checks the input; this module only reads and writes.
//! Tokens appear here only encrypted and only when writing.

use std::{collections::HashMap, time::Duration};

use anyhow::Context as _;
use rusqlite::{Connection, OptionalExtension as _, Row};

/// Number of colours an account can have.
pub const COLORS: i64 = 6;

/// Purposes for the AAD of the encrypted tokens (`broker::crypto`):
/// `secret_enc` and `access_token_enc`.
pub const SECRET_PURPOSE: &str = "mail_accounts.secret";
pub const ACCESS_PURPOSE: &str = "mail_accounts.access_token";

/// Sign-in kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthKind {
    /// Sign-in at the mail server (refresh token).
    Oauth,
    /// The user's access token.
    Token,
}

impl AuthKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Oauth => "oauth",
            Self::Token => "token",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "oauth" => Some(Self::Oauth),
            "token" => Some(Self::Token),
            _ => None,
        }
    }
}

/// A row from `mail_accounts` without tokens and session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailAccount {
    pub id: String,
    pub user_id: String,
    /// Origin of the mail server.
    pub base_url: String,
    pub email: String,
    pub account_id: String,
    pub username: String,
    pub auth_kind: AuthKind,
    /// `ok` or `needs_reauth`.
    pub state: String,
    pub color: i64,
    pub last_check_at: Option<String>,
    pub quota_used: Option<i64>,
    pub quota_total: Option<i64>,
    pub created_at: String,
}

/// A new account for [`insert`]; the tokens come from
/// `broker::crypto::SecretKey::seal` with the account's ID.
pub struct NewAccount<'a> {
    pub id: &'a str,
    pub user_id: &'a str,
    pub base_url: &'a str,
    pub email: &'a str,
    pub account_id: &'a str,
    pub username: &'a str,
    pub auth_kind: AuthKind,
    pub client_id: Option<&'a str>,
    pub secret_enc: &'a [u8],
    pub access_token_enc: Option<&'a [u8]>,
    /// Validity of the access token in seconds from now.
    pub expires_in: Option<u32>,
    pub session_json: &'a str,
    pub color: i64,
}

const COLUMNS: &str = "id, user_id, base_url, email, account_id, username, auth_kind, state, \
     color, last_check_at, quota_used, quota_total, created_at";

fn from_row(row: &Row<'_>) -> rusqlite::Result<MailAccount> {
    let kind: String = row.get(6)?;
    Ok(MailAccount {
        id: row.get(0)?,
        user_id: row.get(1)?,
        base_url: row.get(2)?,
        email: row.get(3)?,
        account_id: row.get(4)?,
        username: row.get(5)?,
        auth_kind: AuthKind::parse(&kind).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                6,
                rusqlite::types::Type::Text,
                format!("unknown sign-in kind {kind}").into(),
            )
        })?,
        state: row.get(7)?,
        color: row.get(8)?,
        last_check_at: row.get(9)?,
        quota_used: row.get(10)?,
        quota_total: row.get(11)?,
        created_at: row.get(12)?,
    })
}

/// A user's accounts in the order they were created.
pub fn list(conn: &Connection, user_id: &str) -> rusqlite::Result<Vec<MailAccount>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM mail_accounts WHERE user_id = ?1 ORDER BY id"
    ))?;
    stmt.query_map([user_id], from_row)?.collect()
}

pub fn get(conn: &Connection, user_id: &str, id: &str) -> rusqlite::Result<Option<MailAccount>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM mail_accounts WHERE id = ?1 AND user_id = ?2"),
        (id, user_id),
        from_row,
    )
    .optional()
}

/// A user's account with the server and account ID of the session (duplicate).
pub fn find(
    conn: &Connection,
    user_id: &str,
    base_url: &str,
    account_id: &str,
) -> rusqlite::Result<Option<MailAccount>> {
    conn.query_row(
        &format!(
            "SELECT {COLUMNS} FROM mail_accounts \
             WHERE user_id = ?1 AND base_url = ?2 AND account_id = ?3"
        ),
        (user_id, base_url, account_id),
        from_row,
    )
    .optional()
}

pub fn insert(conn: &Connection, account: &NewAccount<'_>) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO mail_accounts (id, user_id, base_url, email, account_id, username, \
         auth_kind, client_id, secret_enc, access_token_enc, access_expires_at, \
         session_json, color) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, \
         CASE WHEN ?11 IS NULL THEN NULL \
              ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ?11 || ' seconds') END, \
         ?12, ?13)",
        (
            account.id,
            account.user_id,
            account.base_url,
            account.email,
            account.account_id,
            account.username,
            account.auth_kind.as_str(),
            account.client_id,
            account.secret_enc,
            account.access_token_enc,
            account.expires_in,
            account.session_json,
            account.color,
        ),
    )
    .context("mail account not created")?;
    Ok(())
}

/// Tokens and session of an account for the token broker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credentials {
    pub account: MailAccount,
    /// `oauth`: client the tokens were issued for.
    pub client_id: Option<String>,
    /// Refresh token or access token, encrypted.
    pub secret_enc: Vec<u8>,
    pub access_token_enc: Option<Vec<u8>>,
    /// RFC 3339 in UTC.
    pub access_expires_at: Option<String>,
    pub session_json: String,
    /// When the browser last fetched a token (RFC 3339 in UTC).
    pub token_used_at: Option<String>,
}

/// Account with tokens; with `user_id` only an account of this user.
pub fn credentials(
    conn: &Connection,
    id: &str,
    user_id: Option<&str>,
) -> rusqlite::Result<Option<Credentials>> {
    conn.query_row(
        &format!(
            "SELECT {COLUMNS}, client_id, secret_enc, access_token_enc, access_expires_at, \
             session_json, token_used_at FROM mail_accounts \
             WHERE id = ?1 AND (?2 IS NULL OR user_id = ?2)"
        ),
        (id, user_id),
        |row| {
            Ok(Credentials {
                account: from_row(row)?,
                client_id: row.get(13)?,
                secret_enc: row.get(14)?,
                access_token_enc: row.get(15)?,
                access_expires_at: row.get(16)?,
                session_json: row.get(17)?,
                token_used_at: row.get(18)?,
            })
        },
    )
    .optional()
}

/// The browser just fetched an access token (active account).
pub fn touch_token_used(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE mail_accounts SET token_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

/// Tokens after a refresh, encrypted with the account's ID.
pub struct Refreshed<'a> {
    pub access_token_enc: &'a [u8],
    /// New refresh token (rotation); `None` keeps the previous one.
    pub secret_enc: Option<&'a [u8]>,
    /// Validity of the access token in seconds from now.
    pub expires_in: Option<u32>,
}

/// Stores access and refresh token in one step – only if the account still
/// has the refresh token `used`: the user may have signed it in again or
/// removed it meanwhile. `None` if not stored, otherwise the new expiry of
/// the access token.
pub fn store_refresh(
    conn: &Connection,
    id: &str,
    used: &[u8],
    refreshed: &Refreshed<'_>,
) -> rusqlite::Result<Option<Option<String>>> {
    conn.query_row(
        "UPDATE mail_accounts SET access_token_enc = ?3, \
         secret_enc = COALESCE(?4, secret_enc), \
         access_expires_at = CASE WHEN ?5 IS NULL THEN NULL \
              ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ?5 || ' seconds') END \
         WHERE id = ?1 AND secret_enc = ?2 AND state = 'ok' \
         RETURNING access_expires_at",
        (
            id,
            used,
            refreshed.access_token_enc,
            refreshed.secret_enc,
            refreshed.expires_in,
        ),
        |row| row.get(0),
    )
    .optional()
}

/// The refresh with `used` failed for good: "Sign-in required", the access
/// token is no longer valid. `false` if the account has other tokens by now
/// or is removed.
pub fn mark_needs_reauth(conn: &Connection, id: &str, used: &[u8]) -> rusqlite::Result<bool> {
    Ok(conn.execute(
        "UPDATE mail_accounts SET state = 'needs_reauth', access_token_enc = NULL, \
         access_expires_at = NULL WHERE id = ?1 AND secret_enc = ?2",
        (id, used),
    )? == 1)
}

/// New tokens after "Sign in again" ([`NewAccount`] without account details).
pub struct Reauth<'a> {
    pub client_id: Option<&'a str>,
    pub secret_enc: &'a [u8],
    pub access_token_enc: Option<&'a [u8]>,
    pub expires_in: Option<u32>,
    pub session_json: &'a str,
}

/// Replaces the tokens of one of the user's accounts; it is valid again afterwards.
pub fn reauth(
    conn: &Connection,
    user_id: &str,
    id: &str,
    reauth: &Reauth<'_>,
) -> rusqlite::Result<bool> {
    Ok(conn.execute(
        "UPDATE mail_accounts SET client_id = ?3, secret_enc = ?4, access_token_enc = ?5, \
         access_expires_at = CASE WHEN ?6 IS NULL THEN NULL \
              ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ?6 || ' seconds') END, \
         session_json = ?7, state = 'ok' \
         WHERE id = ?1 AND user_id = ?2",
        (
            id,
            user_id,
            reauth.client_id,
            reauth.secret_enc,
            reauth.access_token_enc,
            reauth.expires_in,
            reauth.session_json,
        ),
    )? == 1)
}

/// Active accounts signed in at the mail server whose access token expires
/// in less than `margin` (or is missing): the browser fetched a token within
/// `active`, the account is still valid and its user is active – locked users
/// get no tokens anyway.
pub fn due_for_refresh(
    conn: &Connection,
    active: Duration,
    margin: Duration,
) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM mail_accounts \
         WHERE auth_kind = 'oauth' AND state = 'ok' \
           AND user_id IN (SELECT id FROM users WHERE status = 'active') \
           AND token_used_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ?1 || ' seconds') \
           AND (access_expires_at IS NULL \
                OR access_expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ?2 || ' seconds')) \
         ORDER BY access_expires_at",
    )?;
    let secs = |d: Duration| i64::try_from(d.as_secs()).unwrap_or(i64::MAX);
    stmt.query_map((secs(active), secs(margin)), |row| row.get(0))?
        .collect()
}

/// New colour of one of the user's accounts (index below [`COLORS`], checked
/// by the caller); `None` if the user has none with that ID.
pub fn set_color(
    conn: &Connection,
    user_id: &str,
    id: &str,
    color: i64,
) -> rusqlite::Result<Option<MailAccount>> {
    conn.query_row(
        &format!(
            "UPDATE mail_accounts SET color = ?3 WHERE id = ?1 AND user_id = ?2 \
             RETURNING {COLUMNS}"
        ),
        (id, user_id, color),
        from_row,
    )
    .optional()
}

/// Result of "Check connection" and job `quota_check`: storage in bytes,
/// used and limit (`None` without a limit), and `last_check_at` now; `None`
/// if the account has been removed meanwhile.
pub fn store_check(
    conn: &Connection,
    user_id: &str,
    id: &str,
    quota: Option<(u64, u64)>,
) -> rusqlite::Result<Option<MailAccount>> {
    let bytes = |value: u64| i64::try_from(value).unwrap_or(i64::MAX);
    let (used, total) = quota
        .map(|(used, total)| (bytes(used), bytes(total)))
        .unzip();
    conn.query_row(
        &format!(
            "UPDATE mail_accounts SET quota_used = ?3, quota_total = ?4, \
             last_check_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
             WHERE id = ?1 AND user_id = ?2 RETURNING {COLUMNS}"
        ),
        (id, user_id, used, total),
        from_row,
    )
    .optional()
}

/// Accounts the job `quota_check` checks: signed in, the user
/// active, the job's last attempt longer than `every` ago or none yet; the
/// ones not tried for the longest first.
pub fn due_for_quota_check(
    conn: &Connection,
    every: Duration,
) -> rusqlite::Result<Vec<MailAccount>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM mail_accounts \
         WHERE state = 'ok' \
           AND user_id IN (SELECT id FROM users WHERE status = 'active') \
           AND (quota_job_at IS NULL \
                OR quota_job_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ?1 || ' seconds')) \
         ORDER BY quota_job_at IS NOT NULL, quota_job_at, id"
    ))?;
    let secs = i64::try_from(every.as_secs()).unwrap_or(i64::MAX);
    stmt.query_map([secs], from_row)?.collect()
}

/// Records an attempt of the job `quota_check`, also a failed one.
pub fn mark_quota_job(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE mail_accounts SET quota_job_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

/// Sets or clears the "Storage almost full" alert; `true` if something
/// changed – so when setting, if it has to be reported anew.
pub fn set_quota_alert(conn: &Connection, id: &str, alert: bool) -> rusqlite::Result<bool> {
    let sql = if alert {
        "UPDATE mail_accounts SET quota_alert_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE id = ?1 AND quota_alert_at IS NULL"
    } else {
        "UPDATE mail_accounts SET quota_alert_at = NULL \
         WHERE id = ?1 AND quota_alert_at IS NOT NULL"
    };
    Ok(conn.execute(sql, [id])? == 1)
}

/// Removes one of the user's accounts; `false` if the user has none with that ID.
pub fn delete(conn: &Connection, user_id: &str, id: &str) -> rusqlite::Result<bool> {
    Ok(conn.execute(
        "DELETE FROM mail_accounts WHERE id = ?1 AND user_id = ?2",
        (id, user_id),
    )? == 1)
}

/// Whether the user has an account with the ID.
pub fn exists(conn: &Connection, user_id: &str, id: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM mail_accounts WHERE id = ?1 AND user_id = ?2)",
        (id, user_id),
        |row| row.get(0),
    )
}

/// Accounts of all users per origin (linked accounts of the registry).
pub fn count_by_base_url(conn: &Connection) -> rusqlite::Result<HashMap<String, i64>> {
    let mut stmt =
        conn.prepare("SELECT base_url, COUNT(*) FROM mail_accounts GROUP BY base_url")?;
    stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect()
}

/// Accounts of all users with the origin `base_url`.
pub fn count_for(conn: &Connection, base_url: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM mail_accounts WHERE base_url = ?1",
        [base_url],
        |row| row.get(0),
    )
}

/// First colour none of the user's accounts has, otherwise the first.
pub fn free_color(accounts: &[MailAccount]) -> i64 {
    (0..COLORS)
        .find(|color| accounts.iter().all(|account| account.color != *color))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{
        self,
        repo::users::{self, NewUser, Role},
    };

    fn user(conn: &Connection, name: &str) -> String {
        users::insert(
            conn,
            &NewUser {
                username: name,
                email: &format!("{name}@example.com"),
                display_name: name,
                role: Role::User,
                password_hash: "$argon2id$test",
            },
        )
        .unwrap()
    }

    fn account<'a>(id: &'a str, user_id: &'a str, account_id: &'a str) -> NewAccount<'a> {
        NewAccount {
            id,
            user_id,
            base_url: "https://mail.example.com",
            email: "max@example.com",
            account_id,
            username: "max@example.com",
            auth_kind: AuthKind::Oauth,
            client_id: Some("client"),
            secret_enc: b"sealed",
            access_token_enc: Some(b"sealed"),
            expires_in: Some(3600),
            session_json: "{}",
            color: 0,
        }
    }

    #[test]
    fn stores_accounts_per_user() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = db::open(tmp.path()).unwrap();
        let max = user(&conn, "max");
        let eva = user(&conn, "eva");
        insert(&conn, &account("A1", &max, "a")).unwrap();
        // Another user may connect the same mailbox too.
        insert(&conn, &account("A2", &eva, "a")).unwrap();
        assert!(insert(&conn, &account("A3", &max, "a")).is_err());

        let listed = list(&conn, &max).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].state, "ok");
        assert_eq!(listed[0].auth_kind, AuthKind::Oauth);
        assert_eq!(
            find(&conn, &max, "https://mail.example.com", "a")
                .unwrap()
                .map(|a| a.id),
            Some("A1".into())
        );
        assert!(exists(&conn, &max, "A1").unwrap());
        assert_eq!(
            get(&conn, &max, "A1").unwrap().unwrap().email,
            "max@example.com"
        );
        assert_eq!(get(&conn, &max, "A2").unwrap(), None);
        assert_eq!(count_for(&conn, "https://mail.example.com").unwrap(), 2);
        assert!(!exists(&conn, &max, "A2").unwrap());
        assert_eq!(
            count_by_base_url(&conn).unwrap()["https://mail.example.com"],
            2
        );
        let expires: String = conn
            .query_row(
                "SELECT access_expires_at FROM mail_accounts WHERE id = 'A1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(expires.ends_with('Z'), "{expires}");

        // A token account has no client and no access token.
        let mut token = account("A4", &max, "b");
        token.auth_kind = AuthKind::Token;
        assert!(insert(&conn, &token).is_err());
        token.client_id = None;
        token.access_token_enc = None;
        token.expires_in = None;
        insert(&conn, &token).unwrap();

        assert!(!delete(&conn, &eva, "A1").unwrap());
        assert!(delete(&conn, &max, "A1").unwrap());
        users::delete(&conn, &eva).unwrap();
        assert!(list(&conn, &eva).unwrap().is_empty());
    }

    #[test]
    fn refresh_replaces_only_the_tokens_it_used() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = db::open(tmp.path()).unwrap();
        let max = user(&conn, "max");
        insert(&conn, &account("A1", &max, "a")).unwrap();
        let hour = Duration::from_secs(3600);
        let soon = Duration::from_secs(600);
        // Never fetched: not active.
        assert!(due_for_refresh(&conn, hour, soon).unwrap().is_empty());
        touch_token_used(&conn, "A1").unwrap();
        assert!(due_for_refresh(&conn, hour, soon).unwrap().is_empty());
        assert_eq!(
            due_for_refresh(&conn, hour, Duration::from_secs(7200)).unwrap(),
            ["A1"]
        );

        let refreshed = Refreshed {
            access_token_enc: b"new",
            secret_enc: Some(b"rotated"),
            expires_in: Some(60),
        };
        // A refresh token other than the stored one: nothing.
        assert_eq!(
            store_refresh(&conn, "A1", b"old", &refreshed).unwrap(),
            None
        );
        let expires = store_refresh(&conn, "A1", b"sealed", &refreshed)
            .unwrap()
            .flatten()
            .unwrap();
        assert!(expires.ends_with('Z'), "{expires}");
        let creds = credentials(&conn, "A1", Some(&max)).unwrap().unwrap();
        assert_eq!(creds.secret_enc, b"rotated");
        assert_eq!(creds.access_token_enc.as_deref(), Some(&b"new"[..]));
        assert_eq!(creds.access_expires_at, Some(expires));
        assert_eq!(due_for_refresh(&conn, hour, soon).unwrap(), ["A1"]);
        // The job does not renew locked users.
        conn.execute("UPDATE users SET status = 'locked' WHERE id = ?1", [&max])
            .unwrap();
        assert!(due_for_refresh(&conn, hour, soon).unwrap().is_empty());
        conn.execute("UPDATE users SET status = 'active' WHERE id = ?1", [&max])
            .unwrap();
        // Without a new refresh token the previous one stays.
        let kept = Refreshed {
            secret_enc: None,
            ..refreshed
        };
        assert!(
            store_refresh(&conn, "A1", b"rotated", &kept)
                .unwrap()
                .is_some()
        );
        assert!(credentials(&conn, "A1", Some("eva")).unwrap().is_none());

        assert!(!mark_needs_reauth(&conn, "A1", b"sealed").unwrap());
        assert!(mark_needs_reauth(&conn, "A1", b"rotated").unwrap());
        let creds = credentials(&conn, "A1", None).unwrap().unwrap();
        assert_eq!(creds.account.state, "needs_reauth");
        assert_eq!(creds.access_token_enc, None);
        assert!(due_for_refresh(&conn, hour, soon).unwrap().is_empty());
        // After "Sign-in required" no refresh stores anything.
        assert_eq!(store_refresh(&conn, "A1", b"rotated", &kept).unwrap(), None);

        assert!(
            reauth(
                &conn,
                &max,
                "A1",
                &Reauth {
                    client_id: Some("client"),
                    secret_enc: b"fresh",
                    access_token_enc: Some(b"access"),
                    expires_in: Some(3600),
                    session_json: "{}",
                },
            )
            .unwrap()
        );
        assert_eq!(get(&conn, &max, "A1").unwrap().unwrap().state, "ok");
        assert!(
            !reauth(
                &conn,
                "eva",
                "A1",
                &Reauth {
                    client_id: Some("client"),
                    secret_enc: b"x",
                    access_token_enc: None,
                    expires_in: None,
                    session_json: "{}",
                },
            )
            .unwrap()
        );
    }

    #[test]
    fn stores_color_and_check() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = db::open(tmp.path()).unwrap();
        let max = user(&conn, "max");
        let eva = user(&conn, "eva");
        insert(&conn, &account("A1", &max, "a")).unwrap();

        assert_eq!(set_color(&conn, &eva, "A1", 3).unwrap(), None);
        assert_eq!(set_color(&conn, &max, "A1", 3).unwrap().unwrap().color, 3);
        assert_eq!(store_check(&conn, &eva, "A1", Some((1, 2))).unwrap(), None);

        let checked = store_check(&conn, &max, "A1", Some((2048, 104_857_600)))
            .unwrap()
            .unwrap();
        assert_eq!(
            (checked.quota_used, checked.quota_total),
            (Some(2048), Some(104_857_600))
        );
        assert!(checked.last_check_at.unwrap().ends_with('Z'));
        // Without a limit no old value remains.
        let unlimited = store_check(&conn, &max, "A1", None).unwrap().unwrap();
        assert_eq!((unlimited.quota_used, unlimited.quota_total), (None, None));
        assert_eq!(unlimited.color, 3);
    }

    #[test]
    fn quota_job_checks_each_account_once_a_day() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = db::open(tmp.path()).unwrap();
        let max = user(&conn, "max");
        let eva = user(&conn, "eva");
        let jonas = user(&conn, "jonas");
        insert(&conn, &account("A1", &max, "a")).unwrap();
        insert(&conn, &account("A2", &eva, "a")).unwrap();
        insert(&conn, &account("A3", &jonas, "a")).unwrap();
        insert(&conn, &account("A4", &max, "b")).unwrap();
        // The job skips "Sign-in required" and locked users.
        conn.execute(
            "UPDATE mail_accounts SET state = 'needs_reauth' WHERE id = 'A2'",
            [],
        )
        .unwrap();
        conn.execute("UPDATE users SET status = 'locked' WHERE id = ?1", [&jonas])
            .unwrap();
        let day = Duration::from_secs(24 * 60 * 60);
        let due = |conn: &Connection| -> Vec<String> {
            due_for_quota_check(conn, day)
                .unwrap()
                .into_iter()
                .map(|account| account.id)
                .collect()
        };
        assert_eq!(due(&conn), ["A1", "A4"]);

        // An attempt counts even if it failed; again after a day.
        mark_quota_job(&conn, "A1").unwrap();
        assert_eq!(due(&conn), ["A4"]);
        conn.execute(
            "UPDATE mail_accounts SET quota_job_at = '2026-01-01T00:00:00.000Z' WHERE id = 'A1'",
            [],
        )
        .unwrap();
        mark_quota_job(&conn, "A4").unwrap();
        assert_eq!(due(&conn), ["A1"]);

        // Reported once until the storage is below the threshold again.
        assert!(set_quota_alert(&conn, "A1", true).unwrap());
        assert!(!set_quota_alert(&conn, "A1", true).unwrap());
        assert!(set_quota_alert(&conn, "A1", false).unwrap());
        assert!(!set_quota_alert(&conn, "A1", false).unwrap());
        assert!(set_quota_alert(&conn, "A1", true).unwrap());
    }

    #[test]
    fn picks_the_first_free_color() {
        let with = |colors: &[i64]| {
            let accounts: Vec<MailAccount> = colors
                .iter()
                .map(|color| MailAccount {
                    id: String::new(),
                    user_id: String::new(),
                    base_url: String::new(),
                    email: String::new(),
                    account_id: String::new(),
                    username: String::new(),
                    auth_kind: AuthKind::Token,
                    state: "ok".into(),
                    color: *color,
                    last_check_at: None,
                    quota_used: None,
                    quota_total: None,
                    created_at: String::new(),
                })
                .collect();
            free_color(&accounts)
        };
        assert_eq!(with(&[]), 0);
        assert_eq!(with(&[0, 2]), 1);
        assert_eq!(with(&[0, 1, 2, 3, 4, 5]), 0);
    }
}
