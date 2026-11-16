//! Table `users`: app accounts. Invited people stay in
//! `invitations` until they accept.

use anyhow::Context as _;
use rusqlite::{Connection, OptionalExtension as _};

use crate::{auth::username, db};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    User,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::User => "user",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "admin" => Some(Self::Admin),
            "user" => Some(Self::User),
            _ => None,
        }
    }
}

/// Fields of a new user; [`insert`] sets `id`, status and timestamps.
pub struct NewUser<'a> {
    pub username: &'a str,
    pub email: &'a str,
    pub display_name: &'a str,
    pub role: Role,
    /// PHC string from `auth::password::Hasher::hash`.
    pub password_hash: &'a str,
}

/// Creates an active user and returns its ID. If the username or email
/// address is taken, the call fails on the uniqueness constraint
/// (`rusqlite::ErrorCode::ConstraintViolation`).
pub fn insert(conn: &Connection, user: &NewUser<'_>) -> anyhow::Result<String> {
    anyhow::ensure!(
        username::is_valid(user.username),
        "invalid username \"{}\"",
        user.username
    );
    let id = db::new_id()?;
    conn.execute(
        "INSERT INTO users (id, username, email, display_name, role, password_hash) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        (
            &id,
            user.username,
            user.email.trim(),
            user.display_name.trim(),
            user.role.as_str(),
            user.password_hash,
        ),
    )
    .context("user not created")?;
    Ok(id)
}

/// Whether an administrator exists – then setup is complete, regardless of
/// the status (the last administrator cannot be locked).
pub fn admin_exists(conn: &Connection) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM users WHERE role = 'admin')",
        [],
        |row| row.get(0),
    )
}

/// User with what sign-in and checks need. `Debug` does not show the hash.
#[derive(Clone)]
pub struct Credentials {
    pub user: Profile,
    pub active: bool,
    /// PHC string of Argon2id.
    pub password_hash: String,
    pub password_changed_at: String,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("user", &self.user)
            .field("active", &self.active)
            .field("password_hash", &"***")
            .field("password_changed_at", &self.password_changed_at)
            .finish()
    }
}

/// Profile of a user; with a session it becomes `auth::AuthUser`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    pub id: String,
    pub username: String,
    pub email: String,
    pub display_name: String,
    pub role: Role,
}

const CREDENTIALS: &str = "SELECT id, username, email, display_name, role, status, password_hash, \
                                  password_changed_at FROM users";

/// Profile and status from the first six columns (`id, username, email,
/// display_name, role, status`) – shared by [`credentials`] and [`list`].
pub(crate) fn profile(row: &rusqlite::Row<'_>) -> rusqlite::Result<(Profile, bool)> {
    let role: String = row.get(4)?;
    let status: String = row.get(5)?;
    Ok((
        Profile {
            id: row.get(0)?,
            username: row.get(1)?,
            email: row.get(2)?,
            display_name: row.get(3)?,
            role: Role::parse(&role).unwrap_or(Role::User),
        },
        status == "active",
    ))
}

fn credentials(row: &rusqlite::Row<'_>) -> rusqlite::Result<Credentials> {
    let (user, active) = profile(row)?;
    Ok(Credentials {
        user,
        active,
        password_hash: row.get(6)?,
        password_changed_at: row.get(7)?,
    })
}

/// Sign-in input the way [`find_for_login`] searches for it: with `@` the
/// address in ASCII lowercase (like `COLLATE NOCASE`, which folds only
/// ASCII), otherwise the username in lowercase. Equal values mean "the same
/// lookup"; the sign-in lockout counts on that (`api::auth::login_key`).
pub fn normalize_login(login: &str) -> String {
    let login = login.trim();
    if login.contains('@') {
        login.to_ascii_lowercase()
    } else {
        login.to_lowercase()
    }
}

/// User for the sign-in input: with `@` the email address (case-insensitive),
/// otherwise the username (which cannot contain `@`). Locked users too, so
/// that the check takes equally long.
pub fn find_for_login(conn: &Connection, login: &str) -> rusqlite::Result<Option<Credentials>> {
    let login = normalize_login(login);
    let column = if login.contains('@') {
        "email"
    } else {
        "username"
    };
    conn.query_row(
        &format!("{CREDENTIALS} WHERE {column} = ?1"),
        [login],
        credentials,
    )
    .optional()
}

pub fn credentials_by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<Credentials>> {
    conn.query_row(&format!("{CREDENTIALS} WHERE id = ?1"), [id], credentials)
        .optional()
}

/// State of a user since a check of their password ([`since`]).
#[derive(Debug)]
pub enum Since {
    /// Active, password unchanged; with the current profile.
    Unchanged(Profile),
    /// The password was changed in the meantime.
    PasswordChanged,
    /// Locked or deleted.
    Inactive,
}

/// Whether the password is unchanged since `checked_at` (`password_changed_at`
/// at the check) and the account is active – for transactions that follow a
/// longer check.
pub fn since(conn: &Connection, id: &str, checked_at: &str) -> rusqlite::Result<Since> {
    Ok(match credentials_by_id(conn, id)? {
        Some(c) if !c.active => Since::Inactive,
        Some(c) if c.password_changed_at == checked_at => Since::Unchanged(c.user),
        Some(_) => Since::PasswordChanged,
        None => Since::Inactive,
    })
}

/// Replaces the hash after a sign-in with outdated parameters; the password
/// itself stays (no new `password_changed_at`). Only if the hash is still
/// `old` – a concurrently changed password wins.
pub fn rehash_password(
    conn: &Connection,
    id: &str,
    old: &str,
    new: &str,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE users SET password_hash = ?3 WHERE id = ?1 AND password_hash = ?2",
        (id, old, new),
    )?;
    Ok(n == 1)
}

/// Sets a new password; returns the time of the change.
pub fn set_password(conn: &Connection, id: &str, hash: &str) -> rusqlite::Result<String> {
    conn.query_row(
        "UPDATE users SET password_hash = ?2, \
                          password_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE id = ?1 RETURNING password_changed_at",
        (id, hash),
        |row| row.get(0),
    )
}

/// Active user with this email address (case-insensitive) for "Forgot
/// password"; locked users get no link.
pub fn find_active_by_email(conn: &Connection, email: &str) -> rusqlite::Result<Option<Profile>> {
    conn.query_row(
        &format!("{CREDENTIALS} WHERE email = ?1 AND status = 'active'"),
        [email.trim()],
        credentials,
    )
    .optional()
    .map(|found| found.map(|c| c.user))
}

/// Whether `email` belongs to a user other than `except` (case-insensitive);
/// with `only_active` only to active ones – `directory` shows those anyway.
pub fn email_taken(
    conn: &Connection,
    email: &str,
    except: &str,
    only_active: bool,
) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM users WHERE email = ?1 AND id <> ?2 \
                        AND (?3 = 0 OR status = 'active'))",
        (email.trim(), except, only_active),
        |row| row.get(0),
    )
}

/// Whether the username belongs to a user other than `except`.
pub fn username_taken(conn: &Connection, username: &str, except: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM users WHERE username = ?1 AND id <> ?2)",
        (username, except),
        |row| row.get(0),
    )
}

/// Changes display name and username (`None` = unchanged). If the username
/// has been taken in the meantime, the call fails on the uniqueness
/// constraint (`rusqlite::ErrorCode::ConstraintViolation`).
pub fn update_profile(
    conn: &Connection,
    id: &str,
    display_name: Option<&str>,
    username: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE users SET display_name = coalesce(?2, display_name), \
                          username = coalesce(?3, username) WHERE id = ?1",
        (id, display_name.map(str::trim), username),
    )?;
    Ok(())
}

/// Sets the confirmed new email address.
pub fn set_email(conn: &Connection, id: &str, email: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE users SET email = ?2 WHERE id = ?1",
        (id, email.trim()),
    )?;
    Ok(())
}

/// Administrators for `roedy-mail reset-admin`, oldest first.
pub fn admins(conn: &Connection) -> rusqlite::Result<Vec<Credentials>> {
    let mut stmt = conn.prepare(&format!(
        "{CREDENTIALS} WHERE role = 'admin' ORDER BY created_at, rowid"
    ))?;
    stmt.query_map([], credentials)?.collect()
}

/// Active administrators, e.g. as recipients of a system notice.
pub fn active_admins(conn: &Connection) -> rusqlite::Result<Vec<Profile>> {
    let mut stmt = conn.prepare(&format!(
        "{CREDENTIALS} WHERE role = 'admin' AND status = 'active' ORDER BY id"
    ))?;
    stmt.query_map([], credentials)?
        .map(|found| found.map(|c| c.user))
        .collect()
}

/// Whether `id` is an administrator and there is no other active one: then
/// nobody in the app can lock the account or reset multi-factor, only the
/// operator with `roedy-mail reset-admin`. Locked administrators and
/// invitations do not count.
pub fn sole_admin(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM users WHERE id = ?1 AND role = 'admin') \
            AND NOT EXISTS (SELECT 1 FROM users \
                            WHERE role = 'admin' AND status = 'active' AND id <> ?1)",
        [id],
        |row| row.get(0),
    )
}

/// Unlocks the user (`reset-admin`, Administration › Users); `true` if
/// they were locked.
pub fn unlock(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE users SET status = 'active' WHERE id = ?1 AND status <> 'active'",
        [id],
    )?;
    Ok(n == 1)
}

/// Locks the user; `true` if they were active. Their sessions stop being
/// valid immediately (`sessions::authenticate`); the caller deletes them.
pub fn lock(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE users SET status = 'locked' WHERE id = ?1 AND status = 'active'",
        [id],
    )?;
    Ok(n == 1)
}

/// New role; `true` if it changed.
pub fn set_role(conn: &Connection, id: &str, role: Role) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE users SET role = ?2 WHERE id = ?1 AND role <> ?2",
        (id, role.as_str()),
    )?;
    Ok(n == 1)
}

/// Removes the user with everything attached to them (`ON DELETE CASCADE`:
/// sessions, apps, codes, links, notifications); their name stays in the
/// audit log.
pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    Ok(conn.execute("DELETE FROM users WHERE id = ?1", [id])? == 1)
}

/// Entry of the list under Administration › Users.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub profile: Profile,
    pub active: bool,
    /// An authenticator app is confirmed (`uRows[].mfa`).
    pub mfa: bool,
    pub last_seen_at: Option<String>,
    pub created_at: String,
}

const LISTED: &str = "SELECT u.id, u.username, u.email, u.display_name, u.role, u.status, \
                              EXISTS (SELECT 1 FROM totp_devices t \
                                      WHERE t.user_id = u.id AND t.confirmed_at IS NOT NULL), \
                              u.last_seen_at, u.created_at \
                       FROM users u";

fn listed(row: &rusqlite::Row<'_>) -> rusqlite::Result<Listed> {
    let (profile, active) = profile(row)?;
    Ok(Listed {
        profile,
        active,
        mfa: row.get(6)?,
        last_seen_at: row.get(7)?,
        created_at: row.get(8)?,
    })
}

/// All users, oldest first (the page sorts on its own).
pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Listed>> {
    conn.prepare(&format!("{LISTED} ORDER BY u.created_at, u.rowid"))?
        .query_map([], listed)?
        .collect()
}

/// One entry as in [`list`].
pub fn get_listed(conn: &Connection, id: &str) -> rusqlite::Result<Option<Listed>> {
    conn.query_row(&format!("{LISTED} WHERE u.id = ?1"), [id], listed)
        .optional()
}

/// Name and address of all active users (`GET directory`), by name.
pub fn directory(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    conn.prepare(
        "SELECT display_name, email FROM users WHERE status = 'active' \
         ORDER BY display_name COLLATE NOCASE, email COLLATE NOCASE",
    )?
    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
    .collect()
}

/// Free username from the email address: the suggestion from
/// [`username::from_email`], with an appended number if needed (`max2`,
/// `max3` …).
pub fn unique_username(conn: &Connection, email: &str) -> rusqlite::Result<String> {
    let base = username::from_email(email);
    let taken = |name: &str| -> rusqlite::Result<bool> {
        conn.query_row(
            "SELECT 1 FROM users WHERE username = ?1",
            [name],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
    };
    if !taken(&base)? {
        return Ok(base);
    }
    for n in 2u32.. {
        let suffix = n.to_string();
        let keep = username::MAX_LEN - suffix.len();
        let candidate = format!("{}{suffix}", &base[..base.len().min(keep)]);
        if !taken(&candidate)? {
            return Ok(candidate);
        }
    }
    unreachable!("infinitely many candidates")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::db::migrations;

    pub(crate) fn conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    pub(crate) fn add(conn: &Connection, username: &str, email: &str, role: Role) -> String {
        insert(
            conn,
            &NewUser {
                username,
                email,
                display_name: "Max Mustermann",
                role,
                password_hash: "$argon2id$test",
            },
        )
        .unwrap()
    }

    #[test]
    fn since_compares_password_and_status() {
        let conn = conn();
        let id = add(&conn, "max", "max@example.com", Role::User);
        let checked = credentials_by_id(&conn, &id).unwrap().unwrap();
        let at = checked.password_changed_at;
        assert!(matches!(since(&conn, &id, &at).unwrap(), Since::Unchanged(p) if p.id == id));
        conn.execute("UPDATE users SET display_name = 'New' WHERE id = ?1", [&id])
            .unwrap();
        // The current profile, not the one at the check.
        assert!(
            matches!(since(&conn, &id, &at).unwrap(), Since::Unchanged(p) if p.display_name == "New")
        );
        // Explicitly later: `set_password` right after creation might fall
        // into the same millisecond.
        let changed = "2099-01-01T00:00:00.000Z";
        conn.execute(
            "UPDATE users SET password_changed_at = ?2 WHERE id = ?1",
            (&id, changed),
        )
        .unwrap();
        assert!(matches!(
            since(&conn, &id, &at).unwrap(),
            Since::PasswordChanged
        ));
        conn.execute("UPDATE users SET status = 'locked' WHERE id = ?1", [&id])
            .unwrap();
        assert!(matches!(
            since(&conn, &id, changed).unwrap(),
            Since::Inactive
        ));
        assert!(matches!(
            since(&conn, "missing", changed).unwrap(),
            Since::Inactive
        ));
    }

    #[test]
    fn email_is_unique_without_case() {
        let conn = conn();
        add(&conn, "max", "Max@Example.com", Role::User);
        let err = insert(
            &conn,
            &NewUser {
                username: "max2",
                email: " max@example.COM ",
                display_name: "Max",
                role: Role::User,
                password_hash: "x",
            },
        )
        .unwrap_err();
        let code = err
            .downcast_ref::<rusqlite::Error>()
            .and_then(rusqlite::Error::sqlite_error_code);
        assert_eq!(code, Some(rusqlite::ErrorCode::ConstraintViolation));
    }

    #[test]
    fn rejects_invalid_username() {
        let conn = conn();
        let err = insert(
            &conn,
            &NewUser {
                username: "Max",
                email: "max@example.com",
                display_name: "Max",
                role: Role::User,
                password_hash: "x",
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("username"), "{err}");
    }

    #[test]
    fn admin_exists_only_with_admin() {
        let conn = conn();
        assert!(!admin_exists(&conn).unwrap());
        add(&conn, "eva", "eva@example.com", Role::User);
        assert!(!admin_exists(&conn).unwrap());
        add(&conn, "max", "max@example.com", Role::Admin);
        assert!(admin_exists(&conn).unwrap());
    }

    #[test]
    fn unique_username_appends_number() {
        let conn = conn();
        assert_eq!(unique_username(&conn, "max@a.example.com").unwrap(), "max");
        add(&conn, "max", "max@a.example.com", Role::User);
        assert_eq!(unique_username(&conn, "Max@b.example.com").unwrap(), "max2");
        add(&conn, "max2", "max@b.example.com", Role::User);
        assert_eq!(unique_username(&conn, "max@c.example.com").unwrap(), "max3");

        let long = format!("{}@a.example.com", "m".repeat(40));
        let base = unique_username(&conn, &long).unwrap();
        assert_eq!(base.len(), username::MAX_LEN);
        add(&conn, &base, &long, Role::User);
        let next = unique_username(&conn, &format!("{}@b.example.com", "m".repeat(40))).unwrap();
        assert_eq!(next, format!("{}2", "m".repeat(username::MAX_LEN - 1)));
    }

    #[test]
    fn finds_users_by_email_or_username() {
        let conn = conn();
        let id = add(&conn, "max", "Max@Example.com", Role::Admin);
        for login in ["max@example.com", " MAX@EXAMPLE.COM ", "max", "Max "] {
            let found = find_for_login(&conn, login).unwrap().unwrap();
            assert_eq!(found.user.id, id, "{login}");
            assert!(found.active);
        }
        for login in ["", "moritz", "max@example", "max@example.com.x"] {
            assert!(find_for_login(&conn, login).unwrap().is_none(), "{login}");
        }
        assert_eq!(
            credentials_by_id(&conn, &id).unwrap().unwrap().user.email,
            "Max@Example.com"
        );
    }

    #[test]
    fn password_updates() {
        let conn = conn();
        let id = add(&conn, "max", "max@example.com", Role::Admin);
        let before = credentials_by_id(&conn, &id).unwrap().unwrap();
        assert!(!rehash_password(&conn, &id, "other", "new").unwrap());
        assert!(rehash_password(&conn, &id, "$argon2id$test", "new").unwrap());
        let rehashed = credentials_by_id(&conn, &id).unwrap().unwrap();
        assert_eq!(rehashed.password_hash, "new");
        assert_eq!(rehashed.password_changed_at, before.password_changed_at);

        conn.execute(
            "UPDATE users SET password_changed_at = '2000-01-01T00:00:00.000Z', \
                              status = 'locked' WHERE id = ?1",
            [&id],
        )
        .unwrap();
        let changed = set_password(&conn, &id, "newer").unwrap();
        assert!(changed.as_str() > "2000-01-01T00:00:00.000Z");
        assert_eq!(admins(&conn).unwrap().len(), 1);
        assert!(unlock(&conn, &id).unwrap());
        assert!(!unlock(&conn, &id).unwrap());
    }

    #[test]
    fn profile_and_email_updates() {
        let conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::User);
        let eva = add(&conn, "eva", "Eva@Example.com", Role::User);
        assert!(email_taken(&conn, "eva@example.com", &max, true).unwrap());
        assert!(!email_taken(&conn, "eva@example.com", &eva, false).unwrap());
        conn.execute("UPDATE users SET status = 'locked' WHERE id = ?1", [&eva])
            .unwrap();
        // Locked ones count only in the full check.
        assert!(!email_taken(&conn, "eva@example.com", &max, true).unwrap());
        assert!(email_taken(&conn, " EVA@example.com ", &max, false).unwrap());
        assert!(
            find_active_by_email(&conn, "eva@example.com")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            find_active_by_email(&conn, "MAX@example.com")
                .unwrap()
                .unwrap()
                .id,
            max
        );

        assert!(username_taken(&conn, "eva", &max).unwrap());
        assert!(!username_taken(&conn, "max", &max).unwrap());
        update_profile(&conn, &max, Some(" Max M. "), None).unwrap();
        update_profile(&conn, &max, None, Some("maxi")).unwrap();
        let err = update_profile(&conn, &max, None, Some("eva")).unwrap_err();
        assert_eq!(
            err.sqlite_error_code(),
            Some(rusqlite::ErrorCode::ConstraintViolation)
        );
        set_email(&conn, &max, "new@example.com").unwrap();
        let user = credentials_by_id(&conn, &max).unwrap().unwrap().user;
        assert_eq!(
            (
                user.display_name.as_str(),
                user.username.as_str(),
                user.email.as_str()
            ),
            ("Max M.", "maxi", "new@example.com")
        );
    }

    #[test]
    fn administration_changes() {
        let conn = conn();
        let anna = add(&conn, "anna", "anna@example.com", Role::Admin);
        let max = add(&conn, "max", "max@example.com", Role::User);
        let eva = add(&conn, "eva", "eva@example.com", Role::User);
        conn.execute(
            "INSERT INTO totp_devices (id, user_id, name, secret_enc, confirmed_at) \
             VALUES ('t1', ?1, 'Phone', x'00', '2026-10-24T12:00:00.000Z'), \
                    ('t2', ?2, NULL, x'00', NULL)",
            (&anna, &max),
        )
        .unwrap();

        assert!(set_role(&conn, &max, Role::Admin).unwrap());
        assert!(!set_role(&conn, &max, Role::Admin).unwrap());
        assert!(lock(&conn, &eva).unwrap());
        assert!(!lock(&conn, &eva).unwrap());

        let listed = list(&conn).unwrap();
        let row = |id: &str| listed.iter().find(|l| l.profile.id == id).unwrap();
        // Only a confirmed app counts.
        assert!(row(&anna).mfa);
        assert!(!row(&max).mfa);
        assert_eq!(row(&max).profile.role, Role::Admin);
        assert!(!row(&eva).active);
        assert_eq!(row(&eva).last_seen_at, None);

        // The directory shows only active ones.
        let names: Vec<String> = directory(&conn).unwrap().into_iter().map(|d| d.1).collect();
        assert_eq!(names, ["anna@example.com", "max@example.com"]);

        assert!(delete(&conn, &max).unwrap());
        assert!(!delete(&conn, &max).unwrap());
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM totp_devices", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 1, "apps go with the user");
    }

    #[test]
    fn sole_admin_counts_only_other_active_admins() {
        use crate::db::repo::invitations::{self, NewInvitation};

        let conn = conn();
        let anna = add(&conn, "anna", "anna@example.com", Role::Admin);
        let max = add(&conn, "max", "max@example.com", Role::User);
        // An invitation as administrator does not count.
        invitations::insert(
            &conn,
            &NewInvitation {
                id: "i1",
                email: "tim@example.com",
                name: None,
                role: Role::Admin,
                token_hash: &[1; 32],
                token_enc: b"sealed",
                invited_by: &anna,
            },
        )
        .unwrap();
        assert!(sole_admin(&conn, &anna).unwrap());
        assert!(!sole_admin(&conn, &max).unwrap(), "not an administrator");

        let lukas = add(&conn, "lukas", "lukas@example.com", Role::Admin);
        assert!(!sole_admin(&conn, &anna).unwrap());
        assert!(!sole_admin(&conn, &lukas).unwrap());
        assert!(lock(&conn, &lukas).unwrap());
        assert!(
            sole_admin(&conn, &anna).unwrap(),
            "locked ones do not count"
        );
        assert!(!sole_admin(&conn, &lukas).unwrap());
        assert!(!sole_admin(&conn, &max).unwrap());
        assert!(!sole_admin(&conn, "unknown").unwrap());
    }

    #[test]
    fn role_round_trips() {
        for role in [Role::Admin, Role::User] {
            assert_eq!(Role::parse(role.as_str()), Some(role));
        }
        assert_eq!(Role::parse("root"), None);
    }
}
