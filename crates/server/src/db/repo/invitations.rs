//! Table `invitations`: open invitations. Stored are the SHA-256 of the token
//! for lookups and the token encrypted for "Copy link". Revoking and
//! accepting delete the row; an expired one stays until it is revoked, resent
//! or renewed.

use rusqlite::{Connection, OptionalExtension as _};

use crate::db::repo::users::Role;

/// Validity from creation, the last send or the renewal (7 days).
pub const VALID_DAYS: u32 = 7;
/// Purpose for the token's AAD; the row is the invitation's ID.
pub const TOKEN_PURPOSE: &str = "invitations.token";
/// Purpose for the AAD of the secret from the "Multi-factor" step.
pub const TOTP_PURPOSE: &str = "invitations.totp";
/// "Request new invitation" notifies at most this often per invitation.
const REQUEST_EVERY: &str = "-24 hours";

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/// An open invitation as the user list shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invitation {
    pub id: String,
    pub email: String,
    /// Name from the form ("Last name, First name"), only for a single address.
    pub name: Option<String>,
    pub role: Role,
    pub invited_by: Option<String>,
    /// Display name of the inviter; `None` if their account is deleted.
    pub inviter: Option<String>,
    pub created_at: String,
    pub expires_at: String,
    /// Last successful send; `None` = "Not sent".
    pub mail_sent_at: Option<String>,
    pub expired: bool,
}

/// Fields of a new invitation; [`insert`] sets the timestamps.
pub struct NewInvitation<'a> {
    pub id: &'a str,
    pub email: &'a str,
    pub name: Option<&'a str>,
    pub role: Role,
    pub token_hash: &'a [u8; 32],
    /// Token, encrypted with [`TOKEN_PURPOSE`] and `id`.
    pub token_enc: &'a [u8],
    pub invited_by: &'a str,
}

const COLUMNS: &str = "i.id, i.email, i.name, i.role, i.invited_by, u.display_name, \
                       i.created_at, i.expires_at, i.mail_sent_at, \
                       i.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const FROM: &str = "FROM invitations i LEFT JOIN users u ON u.id = i.invited_by";

fn invitation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Invitation> {
    let role: String = row.get(3)?;
    Ok(Invitation {
        id: row.get(0)?,
        email: row.get(1)?,
        name: row.get(2)?,
        role: Role::parse(&role).unwrap_or(Role::User),
        invited_by: row.get(4)?,
        inviter: row.get(5)?,
        created_at: row.get(6)?,
        expires_at: row.get(7)?,
        mail_sent_at: row.get(8)?,
        expired: row.get(9)?,
    })
}

/// Creates an invitation (valid for seven days, not sent yet). If the address
/// is already invited, the call fails on the uniqueness constraint
/// (`rusqlite::ErrorCode::ConstraintViolation`).
pub fn insert(conn: &Connection, new: &NewInvitation<'_>) -> rusqlite::Result<Invitation> {
    conn.execute(
        &format!(
            "INSERT INTO invitations (id, email, name, role, token_hash, token_enc, invited_by, \
                                      expires_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', \
                                                          '+{VALID_DAYS} days'))"
        ),
        (
            new.id,
            new.email.trim(),
            new.name.map(str::trim),
            new.role.as_str(),
            new.token_hash.as_slice(),
            new.token_enc,
            new.invited_by,
        ),
    )?;
    get(conn, new.id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// All open invitations, oldest first.
pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Invitation>> {
    conn.prepare(&format!(
        "SELECT {COLUMNS} {FROM} ORDER BY i.created_at, i.rowid"
    ))?
    .query_map([], invitation)?
    .collect()
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<Invitation>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} {FROM} WHERE i.id = ?1"),
        [id],
        invitation,
    )
    .optional()
}

/// Invitation for the link with the secret from the "Multi-factor" step, if
/// one has been created already.
pub struct Found {
    pub invitation: Invitation,
    pub totp_secret_enc: Option<Vec<u8>>,
}

pub fn by_token(conn: &Connection, token_hash: &[u8; 32]) -> rusqlite::Result<Option<Found>> {
    conn.query_row(
        &format!("SELECT {COLUMNS}, i.totp_secret_enc {FROM} WHERE i.token_hash = ?1"),
        [token_hash.as_slice()],
        |row| {
            Ok(Found {
                invitation: invitation(row)?,
                totp_secret_enc: row.get(10)?,
            })
        },
    )
    .optional()
}

/// The encrypted token for "Copy link" and "Resend".
pub fn token_enc(conn: &Connection, id: &str) -> rusqlite::Result<Option<Vec<u8>>> {
    conn.query_row(
        "SELECT token_enc FROM invitations WHERE id = ?1",
        [id],
        |row| row.get(0),
    )
    .optional()
}

/// Expiry when sending or renewing now – for the mail before [`mark_sent`]
/// stores it (both name the same date), or for [`renew`].
pub fn next_expiry(conn: &Connection) -> rusqlite::Result<String> {
    conn.query_row(
        &format!("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+{VALID_DAYS} days')"),
        [],
        |row| row.get(0),
    )
}

/// `?2` becomes the inviter if they are an active administrator; otherwise
/// the previous one stays.
const INVITED_BY: &str = "invited_by = coalesce((SELECT id FROM users WHERE id = ?2 \
                                                 AND role = 'admin' AND status = 'active'), \
                                                invited_by)";

/// Records a successful send: new expiry, and the sender counts as the
/// inviter – only if they are still an active administrator (sending takes
/// time; if they were locked, removed or lost the role meanwhile, the
/// previous one stays). `false` if the invitation is gone by now.
pub fn mark_sent(
    conn: &Connection,
    id: &str,
    by: &str,
    expires_at: &str,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        &format!(
            "UPDATE invitations SET mail_sent_at = {NOW}, expires_at = ?3, {INVITED_BY} \
             WHERE id = ?1"
        ),
        (id, by, expires_at),
    )?;
    Ok(n == 1)
}

/// "Renew": new expiry without a mail, the same link; `mail_sent_at` stays.
/// `by` becomes the inviter as with [`mark_sent`]. `false` if the invitation
/// is gone.
pub fn renew(conn: &Connection, id: &str, by: &str, expires_at: &str) -> rusqlite::Result<bool> {
    let n = conn.execute(
        &format!("UPDATE invitations SET expires_at = ?3, {INVITED_BY} WHERE id = ?1"),
        (id, by, expires_at),
    )?;
    Ok(n == 1)
}

pub fn set_role(conn: &Connection, id: &str, role: Role) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE invitations SET role = ?2 WHERE id = ?1",
        (id, role.as_str()),
    )?;
    Ok(n == 1)
}

/// Revokes the invitation, or deletes it after acceptance.
pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    Ok(conn.execute("DELETE FROM invitations WHERE id = ?1", [id])? == 1)
}

/// Whether `email` is in an open invitation (ignoring case).
pub fn exists_for(conn: &Connection, email: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM invitations WHERE email = ?1)",
        [email.trim()],
        |row| row.get(0),
    )
}

/// Stores the secret of the "Multi-factor" step (replacing an earlier one);
/// only while the invitation is valid.
pub fn set_totp(conn: &Connection, id: &str, secret_enc: &[u8]) -> rusqlite::Result<bool> {
    let n = conn.execute(
        &format!(
            "UPDATE invitations SET totp_secret_enc = ?2 WHERE id = ?1 AND expires_at > {NOW}"
        ),
        (id, secret_enc),
    )?;
    Ok(n == 1)
}

/// Records "Request new invitation"; `false` if the last request was less
/// than 24 hours ago (then nobody is notified again).
pub fn request(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    let n = conn.execute(
        &format!(
            "UPDATE invitations SET requested_at = {NOW} \
             WHERE id = ?1 AND (requested_at IS NULL \
                                OR requested_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?2))"
        ),
        (id, REQUEST_EVERY),
    )?;
    Ok(n == 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::users::{
        Role,
        tests::{add, conn},
    };

    fn new<'a>(id: &'a str, email: &'a str, hash: &'a [u8; 32], by: &'a str) -> NewInvitation<'a> {
        NewInvitation {
            id,
            email,
            name: Some(" Schulz, Jonas "),
            role: Role::User,
            token_hash: hash,
            token_enc: b"sealed",
            invited_by: by,
        }
    }

    #[test]
    fn stores_open_invitations() {
        let conn = conn();
        let anna = add(&conn, "anna", "anna@example.com", Role::Admin);
        let created = insert(&conn, &new("i1", " Jonas@Example.com ", &[1; 32], &anna)).unwrap();
        assert_eq!(created.email, "Jonas@Example.com");
        assert_eq!(created.name.as_deref(), Some("Schulz, Jonas"));
        assert_eq!(created.inviter.as_deref(), Some("Max Mustermann"));
        assert_eq!(created.mail_sent_at, None);
        assert!(!created.expired);
        assert!(created.expires_at > created.created_at);

        // One invitation per address, ignoring case.
        let err = insert(&conn, &new("i2", "jonas@example.COM", &[2; 32], &anna)).unwrap_err();
        assert_eq!(
            err.sqlite_error_code(),
            Some(rusqlite::ErrorCode::ConstraintViolation)
        );
        assert!(exists_for(&conn, " JONAS@example.com").unwrap());
        assert!(!exists_for(&conn, "eva@example.com").unwrap());

        let found = by_token(&conn, &[1; 32]).unwrap().unwrap();
        assert_eq!(found.invitation, created);
        assert_eq!(found.totp_secret_enc, None);
        assert!(by_token(&conn, &[9; 32]).unwrap().is_none());
        assert_eq!(token_enc(&conn, "i1").unwrap().unwrap(), b"sealed");
        assert_eq!(list(&conn).unwrap(), [created]);
    }

    #[test]
    fn sending_renews_and_names_the_sender() {
        let conn = conn();
        let anna = add(&conn, "anna", "anna@example.com", Role::Admin);
        let lukas = add(&conn, "lukas", "lukas@example.com", Role::Admin);
        insert(&conn, &new("i1", "jonas@example.com", &[1; 32], &anna)).unwrap();
        conn.execute(
            "UPDATE invitations SET expires_at = '2000-01-01T00:00:00.000Z'",
            [],
        )
        .unwrap();
        assert!(get(&conn, "i1").unwrap().unwrap().expired);
        // Expired: no "Multi-factor" step any more.
        assert!(!set_totp(&conn, "i1", b"x").unwrap());

        let until = next_expiry(&conn).unwrap();
        // Someone who is no longer an active administrator does not become the inviter.
        let eva = add(&conn, "eva", "eva@example.com", Role::User);
        assert!(mark_sent(&conn, "i1", &eva, &until).unwrap());
        assert_eq!(
            get(&conn, "i1").unwrap().unwrap().invited_by.as_deref(),
            Some(anna.as_str())
        );
        assert!(mark_sent(&conn, "i1", "deleted", &until).unwrap());
        assert!(mark_sent(&conn, "i1", &lukas, &until).unwrap());
        let sent = get(&conn, "i1").unwrap().unwrap();
        assert!(!sent.expired);
        assert_eq!(sent.expires_at, until);
        assert!(sent.mail_sent_at.is_some());
        assert_eq!(sent.invited_by.as_deref(), Some(lukas.as_str()));
        assert!(set_totp(&conn, "i1", b"secret").unwrap());
        let found = by_token(&conn, &[1; 32]).unwrap().unwrap();
        assert_eq!(found.totp_secret_enc.as_deref(), Some(&b"secret"[..]));

        assert!(set_role(&conn, "i1", Role::Admin).unwrap());
        assert_eq!(get(&conn, "i1").unwrap().unwrap().role, Role::Admin);
        // Deleted inviter: no name.
        conn.execute("DELETE FROM users WHERE id = ?1", [&lukas])
            .unwrap();
        let orphan = get(&conn, "i1").unwrap().unwrap();
        assert_eq!((orphan.invited_by, orphan.inviter), (None, None));

        assert!(delete(&conn, "i1").unwrap());
        assert!(!delete(&conn, "i1").unwrap());
        assert!(!mark_sent(&conn, "i1", &anna, &until).unwrap());
    }

    #[test]
    fn renewing_keeps_the_link_and_the_last_mail() {
        let conn = conn();
        let anna = add(&conn, "anna", "anna@example.com", Role::Admin);
        let lukas = add(&conn, "lukas", "lukas@example.com", Role::Admin);
        insert(&conn, &new("i1", "jonas@example.com", &[1; 32], &anna)).unwrap();
        let until = next_expiry(&conn).unwrap();
        assert!(mark_sent(&conn, "i1", &anna, &until).unwrap());
        conn.execute(
            "UPDATE invitations SET expires_at = '2000-01-01T00:00:00.000Z'",
            [],
        )
        .unwrap();
        let before = get(&conn, "i1").unwrap().unwrap();
        assert!(before.expired);

        let until = next_expiry(&conn).unwrap();
        // Someone who is no longer an active administrator does not become the inviter.
        let eva = add(&conn, "eva", "eva@example.com", Role::User);
        assert!(renew(&conn, "i1", &eva, &until).unwrap());
        assert_eq!(
            get(&conn, "i1").unwrap().unwrap().invited_by.as_deref(),
            Some(anna.as_str())
        );
        assert!(renew(&conn, "i1", &lukas, &until).unwrap());
        let renewed = get(&conn, "i1").unwrap().unwrap();
        assert!(!renewed.expired);
        assert_eq!(renewed.expires_at, until);
        assert_eq!(renewed.mail_sent_at, before.mail_sent_at);
        assert_eq!(renewed.invited_by.as_deref(), Some(lukas.as_str()));
        assert_eq!(token_enc(&conn, "i1").unwrap().unwrap(), b"sealed");
        assert!(by_token(&conn, &[1; 32]).unwrap().is_some());

        assert!(!renew(&conn, "missing", &lukas, &until).unwrap());
    }

    #[test]
    fn requests_once_a_day() {
        let conn = conn();
        let anna = add(&conn, "anna", "anna@example.com", Role::Admin);
        insert(&conn, &new("i1", "jonas@example.com", &[1; 32], &anna)).unwrap();
        assert!(request(&conn, "i1").unwrap());
        assert!(!request(&conn, "i1").unwrap());
        conn.execute(
            "UPDATE invitations SET requested_at = '2000-01-01T00:00:00.000Z'",
            [],
        )
        .unwrap();
        assert!(request(&conn, "i1").unwrap());
        assert!(!request(&conn, "missing").unwrap());
    }
}
