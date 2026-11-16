//! Table `email_changes`: a change of one's own email address until it is
//! confirmed. One row per link with the SHA-256 of the token; the new address
//! applies only after confirmation.
//!
//! A link is first only reserved ([`reserve`]); it becomes valid once both
//! mails are sent ([`release`]). Releasing deletes the user's other
//! unconfirmed links – so only the last one sent is valid. The open change
//! ([`open`]) stays even after the link expires, until it is confirmed,
//! discarded or replaced (the UI shows "Confirmation pending" with "Resend
//! link").

use rusqlite::{Connection, OptionalExtension as _};

use crate::db::{
    self,
    repo::{invitations, users},
};

/// Validity of a link (24 hours).
pub const VALID_HOURS: u32 = 24;

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/// Whether `email` is taken for a change by `user_id`: it belongs
/// to another user, whatever their status, or is in an open invitation,
/// compared ignoring case.
pub fn taken(conn: &Connection, email: &str, user_id: &str) -> rusqlite::Result<bool> {
    Ok(users::email_taken(conn, email, user_id, false)? || invitations::exists_for(conn, email)?)
}

/// Whether a sent, unconfirmed and unexpired link names `email` as a user's
/// new address – then it cannot be invited (invitations check open changes
/// the other way round). Reserved links do not count; [`taken`]
/// checks their confirmation anyway.
pub fn pending_for(conn: &Connection, email: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        &format!(
            "SELECT EXISTS (SELECT 1 FROM email_changes WHERE new_email = ?1 \
                            AND sent_at IS NOT NULL AND confirmed_at IS NULL \
                            AND expires_at > {NOW})"
        ),
        [email.trim()],
        |row| row.get(0),
    )
}

/// Reserves a new link (not valid yet) and returns its ID. Leftover reserved
/// links of the user (say after a restart during sending) are dropped.
pub fn reserve(
    conn: &Connection,
    user_id: &str,
    new_email: &str,
    token_hash: &[u8; 32],
) -> anyhow::Result<String> {
    conn.execute(
        "DELETE FROM email_changes WHERE user_id = ?1 AND sent_at IS NULL",
        [user_id],
    )?;
    let id = db::new_id()?;
    conn.execute(
        &format!(
            "INSERT INTO email_changes (id, user_id, token_hash, new_email, expires_at) \
             VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+{VALID_HOURS} hours'))"
        ),
        (&id, user_id, token_hash.as_slice(), new_email),
    )?;
    Ok(id)
}

/// Releases a reserved link after sending: older unconfirmed links of the
/// user become invalid, the 24 hours count from now. `false` if the link has
/// been discarded in the meantime.
pub fn release(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    let user_id: Option<String> = conn
        .query_row(
            "SELECT user_id FROM email_changes WHERE id = ?1 AND sent_at IS NULL",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(user_id) = user_id else {
        return Ok(false);
    };
    conn.execute(
        "DELETE FROM email_changes WHERE user_id = ?1 AND id <> ?2 AND confirmed_at IS NULL",
        (&user_id, id),
    )?;
    conn.execute(
        &format!(
            "UPDATE email_changes SET sent_at = {NOW}, created_at = {NOW}, \
             expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+{VALID_HOURS} hours') \
             WHERE id = ?1"
        ),
        [id],
    )?;
    Ok(true)
}

/// Deletes a reserved link (one of the mails failed).
pub fn cancel(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM email_changes WHERE id = ?1 AND sent_at IS NULL",
        [id],
    )?;
    Ok(())
}

/// A user's open change: the last sent, unconfirmed link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Open {
    pub id: String,
    pub new_email: String,
    pub expires_at: String,
}

pub fn open(conn: &Connection, user_id: &str) -> rusqlite::Result<Option<Open>> {
    conn.query_row(
        "SELECT id, new_email, expires_at FROM email_changes \
         WHERE user_id = ?1 AND sent_at IS NOT NULL AND confirmed_at IS NULL \
         ORDER BY sent_at DESC LIMIT 1",
        [user_id],
        |row| {
            Ok(Open {
                id: row.get(0)?,
                new_email: row.get(1)?,
                expires_at: row.get(2)?,
            })
        },
    )
    .optional()
}

/// Discards all unconfirmed links of the user, reserved ones too: "Discard
/// change", resetting or changing the password, "Sign out all others" and
/// locking the user. Returns the count.
pub fn discard(conn: &Connection, user_id: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM email_changes WHERE user_id = ?1 AND confirmed_at IS NULL",
        [user_id],
    )
}

/// State of a link for the page "Confirm email address".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// Confirms when the button is clicked.
    Valid,
    /// Already confirmed (until the link expires).
    Confirmed,
    /// Expired, replaced, discarded, the account locked or the address taken
    /// in the meantime.
    Invalid,
}

/// A known link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub id: String,
    pub user_id: String,
    pub new_email: String,
    pub state: State,
}

/// Shared validity check of `check`, `confirm` and `previous_link_valid`:
/// last sent link, 24 hours, user active, address not taken. `None` for an
/// unknown token (also discarded and replaced links, whose row is deleted).
pub fn lookup(conn: &Connection, token_hash: &[u8; 32]) -> rusqlite::Result<Option<Link>> {
    find(conn, "c.token_hash = ?1", token_hash.as_slice())
}

/// Like [`lookup`] for the open change `id`.
pub fn lookup_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<Link>> {
    find(conn, "c.id = ?1", id)
}

fn find(
    conn: &Connection,
    filter: &str,
    value: impl rusqlite::ToSql,
) -> rusqlite::Result<Option<Link>> {
    let row = conn
        .query_row(
            &format!(
                "SELECT c.id, c.user_id, c.new_email, c.sent_at IS NOT NULL, \
                        c.confirmed_at IS NOT NULL, c.expires_at > {NOW}, u.status = 'active' \
                 FROM email_changes c JOIN users u ON u.id = c.user_id WHERE {filter}"
            ),
            [value],
            |row| {
                Ok((
                    Link {
                        id: row.get(0)?,
                        user_id: row.get(1)?,
                        new_email: row.get(2)?,
                        state: State::Invalid,
                    },
                    [
                        row.get::<_, bool>(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ],
                ))
            },
        )
        .optional()?;
    let Some((mut link, [sent, confirmed, unexpired, active])) = row else {
        return Ok(None);
    };
    link.state = if !unexpired {
        State::Invalid
    } else if confirmed {
        State::Confirmed
    } else if sent && active && !taken(conn, &link.new_email, &link.user_id)? {
        State::Valid
    } else {
        State::Invalid
    };
    Ok(Some(link))
}

/// Marks the link as confirmed; the caller sets the user's address in the
/// same transaction.
pub fn confirm(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    let n = conn.execute(
        &format!(
            "UPDATE email_changes SET confirmed_at = {NOW} \
             WHERE id = ?1 AND sent_at IS NOT NULL AND confirmed_at IS NULL"
        ),
        [id],
    )?;
    Ok(n == 1)
}

/// Cleans up (job `session_cleanup`): confirmed links after they expire
/// (until then they show "Already confirmed") and reserved ones whose
/// sending has not finished for an hour. Open changes stay until the person
/// discards or replaces them.
pub fn delete_stale(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute(
        &format!(
            "DELETE FROM email_changes \
             WHERE (confirmed_at IS NOT NULL AND expires_at <= {NOW}) \
                OR (sent_at IS NULL AND created_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour'))"
        ),
        [],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::users::{
        Role,
        tests::{add, conn},
    };

    fn state(conn: &Connection, hash: u8) -> Option<State> {
        lookup(conn, &[hash; 32]).unwrap().map(|link| link.state)
    }

    #[test]
    fn reserved_links_only_work_once_released() {
        let conn = conn();
        let id = add(&conn, "max", "max@example.com", Role::User);
        let first = reserve(&conn, &id, "new@example.com", &[1; 32]).unwrap();
        assert_eq!(state(&conn, 1), Some(State::Invalid));
        assert_eq!(open(&conn, &id).unwrap(), None);
        assert!(release(&conn, &first).unwrap());
        assert_eq!(state(&conn, 1), Some(State::Valid));
        assert_eq!(
            open(&conn, &id).unwrap().unwrap().new_email,
            "new@example.com"
        );

        // Resend: the new link is reserved, the old one stays valid …
        let second = reserve(&conn, &id, "new@example.com", &[2; 32]).unwrap();
        assert_eq!(state(&conn, 1), Some(State::Valid));
        assert_eq!(state(&conn, 2), Some(State::Invalid));
        // … until the new one is released.
        assert!(release(&conn, &second).unwrap());
        assert_eq!(state(&conn, 1), None);
        assert_eq!(state(&conn, 2), Some(State::Valid));

        // Failed sending: the reserved link is dropped, the previous one stays.
        let third = reserve(&conn, &id, "new@example.com", &[3; 32]).unwrap();
        cancel(&conn, &third).unwrap();
        assert_eq!(state(&conn, 3), None);
        assert_eq!(state(&conn, 2), Some(State::Valid));
        assert!(!release(&conn, &third).unwrap());
    }

    #[test]
    fn confirmed_links_say_so_until_they_expire() {
        let conn = conn();
        let id = add(&conn, "max", "max@example.com", Role::User);
        let link = reserve(&conn, &id, "new@example.com", &[1; 32]).unwrap();
        release(&conn, &link).unwrap();
        assert!(confirm(&conn, &link).unwrap());
        assert!(!confirm(&conn, &link).unwrap());
        assert_eq!(state(&conn, 1), Some(State::Confirmed));
        assert_eq!(open(&conn, &id).unwrap(), None);
        // Discarding only affects open links.
        assert_eq!(discard(&conn, &id).unwrap(), 0);
        conn.execute(
            "UPDATE email_changes SET expires_at = '2000-01-01T00:00:00.000Z'",
            [],
        )
        .unwrap();
        assert_eq!(state(&conn, 1), Some(State::Invalid));
        assert_eq!(delete_stale(&conn).unwrap(), 1);
        assert_eq!(state(&conn, 1), None);
    }

    #[test]
    fn invalid_when_expired_locked_or_taken() {
        let conn = conn();
        let id = add(&conn, "max", "max@example.com", Role::User);
        let link = reserve(&conn, &id, "New@Example.com", &[1; 32]).unwrap();
        release(&conn, &link).unwrap();

        conn.execute("UPDATE users SET status = 'locked' WHERE id = ?1", [&id])
            .unwrap();
        assert_eq!(state(&conn, 1), Some(State::Invalid));
        conn.execute("UPDATE users SET status = 'active' WHERE id = ?1", [&id])
            .unwrap();
        assert_eq!(state(&conn, 1), Some(State::Valid));

        // Taken in the meantime, also by a locked account and ignoring
        // case.
        let other = add(&conn, "new", "new@example.com", Role::User);
        conn.execute("UPDATE users SET status = 'locked' WHERE id = ?1", [&other])
            .unwrap();
        assert_eq!(state(&conn, 1), Some(State::Invalid));
        assert!(taken(&conn, "NEW@example.com", &id).unwrap());
        assert!(!taken(&conn, "new@example.com", &other).unwrap());
        conn.execute("DELETE FROM users WHERE id = ?1", [&other])
            .unwrap();

        // Expired: invalid, but the change stays open.
        conn.execute(
            "UPDATE email_changes SET expires_at = '2000-01-01T00:00:00.000Z'",
            [],
        )
        .unwrap();
        assert_eq!(state(&conn, 1), Some(State::Invalid));
        assert_eq!(
            lookup_id(&conn, &link).unwrap().unwrap().state,
            State::Invalid
        );
        assert!(open(&conn, &id).unwrap().is_some());
        assert_eq!(delete_stale(&conn).unwrap(), 0);
        assert_eq!(discard(&conn, &id).unwrap(), 1);
        assert_eq!(open(&conn, &id).unwrap(), None);
    }

    #[test]
    fn invitations_and_changes_exclude_each_other() {
        let conn = conn();
        let id = add(&conn, "max", "max@example.com", Role::User);
        let anna = add(&conn, "anna", "anna@example.com", Role::Admin);
        let link = reserve(&conn, &id, "New@Example.com", &[1; 32]).unwrap();
        // Reserved does not count, sent does.
        assert!(!pending_for(&conn, "new@example.com").unwrap());
        release(&conn, &link).unwrap();
        assert!(pending_for(&conn, " NEW@example.com").unwrap());
        assert!(!pending_for(&conn, "max@example.com").unwrap());

        // If the address is now in an invitation, the link is not valid.
        invitations::insert(
            &conn,
            &invitations::NewInvitation {
                id: "i1",
                email: "new@example.com",
                name: None,
                role: Role::User,
                token_hash: &[9; 32],
                token_enc: b"x",
                invited_by: &anna,
            },
        )
        .unwrap();
        assert!(taken(&conn, "NEW@example.com", &id).unwrap());
        assert_eq!(state(&conn, 1), Some(State::Invalid));

        // Once confirmed or expired, the address is free again.
        conn.execute(
            "UPDATE email_changes SET expires_at = '2000-01-01T00:00:00.000Z'",
            [],
        )
        .unwrap();
        assert!(!pending_for(&conn, "new@example.com").unwrap());
    }

    #[test]
    fn stale_reservations_are_cleaned_up() {
        let conn = conn();
        let id = add(&conn, "max", "max@example.com", Role::User);
        reserve(&conn, &id, "new@example.com", &[1; 32]).unwrap();
        assert_eq!(delete_stale(&conn).unwrap(), 0);
        conn.execute(
            "UPDATE email_changes SET created_at = '2000-01-01T00:00:00.000Z'",
            [],
        )
        .unwrap();
        assert_eq!(delete_stale(&conn).unwrap(), 1);
        // A new reservation clears an old one anyway.
        reserve(&conn, &id, "new@example.com", &[2; 32]).unwrap();
        reserve(&conn, &id, "new@example.com", &[3; 32]).unwrap();
        assert_eq!(state(&conn, 2), None);
    }
}
