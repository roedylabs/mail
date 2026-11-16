//! Setup token for the initial setup.
//!
//! As long as no administrator exists, the server writes the token to the log
//! on every start; `roedy-mail setup-token` shows it again. The token is stored
//! in plain text in `app_settings` because it must be displayable again –
//! whoever can read the database is the operator anyway. The setup
//! API checks it with [`matches`] (lockout after failed attempts in
//! `api::setup`); `setup/complete` deletes it with [`delete`].

use anyhow::Context as _;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::{
    db::repo::{app_settings, users},
    random,
};

const KEY: &str = "setup_token";

/// 32 characters without the easily confused 0, 1, I and O. 32 divides 256, so
/// `byte % 32` is uniformly distributed; 12 characters give 60 bits.
const ALPHABET: &[u8; 32] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const GROUPS: usize = 3;
const GROUP_LEN: usize = 4;

#[derive(Serialize, Deserialize)]
struct Stored {
    token: String,
}

/// Generates a new token in the format `XXXX-XXXX-XXXX`.
pub fn generate() -> anyhow::Result<String> {
    let bytes = random::bytes::<{ GROUPS * GROUP_LEN }>()?;
    let groups: Vec<String> = bytes
        .chunks(GROUP_LEN)
        .map(|chunk| {
            chunk
                .iter()
                .map(|b| char::from(ALPHABET[usize::from(b % 32)]))
                .collect()
        })
        .collect();
    Ok(groups.join("-"))
}

/// Returns the setup token while the setup is pending and creates it on the
/// first call. `None` once an administrator exists.
pub fn ensure(conn: &Connection) -> anyhow::Result<Option<String>> {
    if users::admin_exists(conn)? {
        return Ok(None);
    }
    if let Some(stored) = app_settings::get::<Stored>(conn, KEY)? {
        return Ok(Some(stored.token));
    }
    // If two processes start at the same time, the first entry wins.
    app_settings::insert_if_absent(conn, KEY, &Stored { token: generate()? })?;
    let stored = app_settings::get::<Stored>(conn, KEY)?.context("setup token missing")?;
    Ok(Some(stored.token))
}

/// The token while the setup is pending; unlike [`ensure`], it creates none.
/// Also `None` if an administrator exists.
pub fn current(conn: &Connection) -> anyhow::Result<Option<String>> {
    if users::admin_exists(conn)? {
        return Ok(None);
    }
    Ok(app_settings::get::<Stored>(conn, KEY)?.map(|stored| stored.token))
}

/// Removes the token (completion of the setup).
pub fn delete(conn: &Connection) -> rusqlite::Result<bool> {
    app_settings::delete(conn, KEY)
}

/// Whether the input is the token – ignoring case, hyphens and whitespace,
/// like the input field of the setup (`XXXX-XXXX-XXXX`). The SHA-256 values are
/// compared so that the running time reveals nothing about matching
/// prefixes.
pub fn matches(token: &str, input: &str) -> bool {
    let canonical = |value: &str| -> String {
        value
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-')
            .map(|c| c.to_ascii_uppercase())
            .collect()
    };
    let expected = Sha256::digest(canonical(token).as_bytes());
    let given = Sha256::digest(canonical(input).as_bytes());
    expected == given
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn is_well_formed(token: &str) -> bool {
        let groups: Vec<&str> = token.split('-').collect();
        groups.len() == GROUPS
            && groups
                .iter()
                .all(|g| g.len() == GROUP_LEN && g.bytes().all(|b| ALPHABET.contains(&b)))
    }

    #[test]
    fn generates_well_formed_distinct_tokens() {
        let tokens: Vec<String> = (0..100).map(|_| generate().unwrap()).collect();
        for token in &tokens {
            assert!(is_well_formed(token), "{token}");
        }
        let mut unique = tokens.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), tokens.len());
    }

    #[test]
    fn ensure_creates_token_once() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();

        let first = ensure(&conn).unwrap().unwrap();
        assert!(is_well_formed(&first), "{first}");
        assert_eq!(ensure(&conn).unwrap().as_deref(), Some(first.as_str()));
    }

    #[test]
    fn no_token_once_an_admin_exists() {
        use crate::db::repo::users::{Role, tests::add};

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        ensure(&conn).unwrap().unwrap();
        add(&conn, "eva", "eva@example.com", Role::User);
        assert!(ensure(&conn).unwrap().is_some(), "user without admin role");
        add(&conn, "max", "max@example.com", Role::Admin);
        assert_eq!(ensure(&conn).unwrap(), None);
    }

    #[test]
    fn matches_like_the_input_field() {
        assert!(matches("ABCD-EFGH-JKLM", "ABCD-EFGH-JKLM"));
        assert!(matches("ABCD-EFGH-JKLM", " abcd efgh-jklm\n"));
        assert!(matches("ABCD-EFGH-JKLM", "ABCDEFGHJKLM"));
        assert!(!matches("ABCD-EFGH-JKLM", "ABCD-EFGH-JKLN"));
        assert!(!matches("ABCD-EFGH-JKLM", "ABCD-EFGH"));
        assert!(!matches("ABCD-EFGH-JKLM", ""));
    }

    #[test]
    fn current_never_creates_and_ends_with_admin_or_delete() {
        use crate::db::repo::users::{Role, tests::add};

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        assert_eq!(current(&conn).unwrap(), None);
        let token = ensure(&conn).unwrap();
        assert_eq!(current(&conn).unwrap(), token);
        assert!(delete(&conn).unwrap());
        assert_eq!(current(&conn).unwrap(), None);

        let token = ensure(&conn).unwrap();
        assert_eq!(current(&conn).unwrap(), token);
        add(&conn, "max", "max@example.com", Role::Admin);
        assert_eq!(current(&conn).unwrap(), None);
    }

    #[test]
    fn ensure_keeps_token_across_reopen() {
        let tmp = tempfile::tempdir().unwrap();
        let first = ensure(&crate::db::open(tmp.path()).unwrap()).unwrap();
        let second = ensure(&crate::db::open(tmp.path()).unwrap()).unwrap();
        assert!(first.is_some());
        assert_eq!(first, second);
    }
}
