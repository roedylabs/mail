//! Authenticator app and recovery codes of the initial setup, before the
//! administrator exists.
//!
//! `setup/totp` creates a pending enrollment: a new secret and ten recovery
//! codes, sealed together (purpose [`PURPOSE`], the row is the enrollment's
//! ID) in `app_settings` next to the setup token. A new call replaces it.
//! `setup/totp/verify` confirms it with a code from the app and keeps the
//! code's time step; `setup/complete` turns it into the administrator's
//! first authenticator app and recovery codes and deletes it together with
//! the setup token.

use anyhow::Context as _;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::{broker::crypto::SecretKey, db, db::repo::app_settings};

/// Purpose for the AAD of the sealed secret and codes.
pub const PURPOSE: &str = "setup.totp";
const KEY: &str = "setup_totp";

/// The pending enrollment as stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pending {
    /// New for every enrollment; the row of the sealed value.
    pub id: String,
    /// Address the app was set up for (the account in the otpauth URI).
    pub email: String,
    /// [`Content`], sealed, in Base64.
    sealed: String,
    /// Time step of the last accepted code; `None` until confirmed.
    pub step: Option<u64>,
}

/// What [`Pending`] keeps sealed.
#[derive(Serialize, Deserialize)]
struct Content {
    /// The secret in Base64.
    secret: String,
    codes: Vec<String>,
}

/// Secret and recovery codes of a [`Pending`] enrollment.
pub struct Opened {
    pub secret: Vec<u8>,
    pub codes: Vec<String>,
}

impl Pending {
    /// New, unconfirmed enrollment for `email`.
    pub fn new(
        secrets: &SecretKey,
        email: &str,
        secret: &[u8],
        codes: Vec<String>,
    ) -> anyhow::Result<Self> {
        let id = db::new_id()?;
        let content = serde_json::to_vec(&Content {
            secret: STANDARD.encode(secret),
            codes,
        })?;
        let sealed = STANDARD.encode(secrets.seal(PURPOSE, &id, &content)?);
        Ok(Self {
            id,
            email: email.to_owned(),
            sealed,
            step: None,
        })
    }

    pub fn open(&self, secrets: &SecretKey) -> anyhow::Result<Opened> {
        let sealed = STANDARD
            .decode(&self.sealed)
            .context("app_settings.setup_totp: not Base64")?;
        let content: Content = serde_json::from_slice(&secrets.open(PURPOSE, &self.id, &sealed)?)
            .context("app_settings.setup_totp: unreadable")?;
        Ok(Opened {
            secret: STANDARD
                .decode(content.secret)
                .context("app_settings.setup_totp: secret not Base64")?,
            codes: content.codes,
        })
    }
}

/// The pending enrollment, if there is one.
pub fn get(conn: &Connection) -> anyhow::Result<Option<Pending>> {
    app_settings::get(conn, KEY)
}

/// Stores `pending` in place of any earlier enrollment.
pub fn replace(conn: &Connection, pending: &Pending) -> anyhow::Result<()> {
    app_settings::set(conn, KEY, pending)
}

/// Result of [`confirm`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confirm {
    Done,
    /// The time step is not newer than the last accepted one (`code_used`).
    Used,
    /// The enrollment has been replaced or deleted in the meantime.
    Gone,
}

/// Marks the enrollment `id` as confirmed with a code of time step `step`
/// (in the caller's transaction). Like the devices' `last_step`, every time
/// step counts only once.
pub fn confirm(conn: &Connection, id: &str, step: u64) -> anyhow::Result<Confirm> {
    let Some(mut pending) = get(conn)?.filter(|pending| pending.id == id) else {
        return Ok(Confirm::Gone);
    };
    if pending.step.is_some_and(|last| step <= last) {
        return Ok(Confirm::Used);
    }
    pending.step = Some(step);
    replace(conn, &pending)?;
    Ok(Confirm::Done)
}

/// Removes the enrollment (completion of the setup).
pub fn delete(conn: &Connection) -> rusqlite::Result<bool> {
    app_settings::delete(conn, KEY)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{auth::recovery, db::migrations};

    fn conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    fn pending(secrets: &SecretKey) -> (Pending, Vec<String>) {
        let codes = recovery::generate().unwrap();
        let pending = Pending::new(
            secrets,
            "max@example.com",
            b"0123456789abcdefghij",
            codes.clone(),
        )
        .unwrap();
        (pending, codes)
    }

    #[test]
    fn keeps_secret_and_codes_sealed() {
        let conn = conn();
        let secrets = SecretKey::random().unwrap();
        let (pending, codes) = pending(&secrets);
        replace(&conn, &pending).unwrap();

        let stored = get(&conn).unwrap().unwrap();
        assert_eq!(stored, pending);
        assert_eq!(stored.step, None);
        let opened = stored.open(&secrets).unwrap();
        assert_eq!(opened.secret, b"0123456789abcdefghij");
        assert_eq!(opened.codes, codes);

        let json: String = conn
            .query_row(
                "SELECT json FROM app_settings WHERE key = 'setup_totp'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        for plain in [
            "0123456789abcdefghij".to_owned(),
            STANDARD.encode(b"0123456789abcdefghij"),
        ] {
            assert!(!json.contains(&plain), "{json}");
        }
        for code in &codes {
            assert!(!json.contains(code.as_str()), "{code} in {json}");
        }
        // Bound to the enrollment and the key.
        let moved = Pending {
            id: db::new_id().unwrap(),
            ..stored.clone()
        };
        assert!(moved.open(&secrets).is_err());
        assert!(stored.open(&SecretKey::random().unwrap()).is_err());
    }

    #[test]
    fn a_new_enrollment_replaces_the_old_one() {
        let conn = conn();
        let secrets = SecretKey::random().unwrap();
        let (first, _) = pending(&secrets);
        replace(&conn, &first).unwrap();
        assert_eq!(confirm(&conn, &first.id, 100).unwrap(), Confirm::Done);

        let (second, _) = pending(&secrets);
        assert_ne!(first.id, second.id);
        replace(&conn, &second).unwrap();
        assert_eq!(get(&conn).unwrap(), Some(second.clone()));
        assert_eq!(confirm(&conn, &first.id, 101).unwrap(), Confirm::Gone);

        assert!(delete(&conn).unwrap());
        assert_eq!(get(&conn).unwrap(), None);
        assert_eq!(confirm(&conn, &second.id, 101).unwrap(), Confirm::Gone);
    }

    #[test]
    fn every_time_step_confirms_once() {
        let conn = conn();
        let secrets = SecretKey::random().unwrap();
        let (pending, _) = pending(&secrets);
        replace(&conn, &pending).unwrap();
        assert_eq!(confirm(&conn, &pending.id, 100).unwrap(), Confirm::Done);
        assert_eq!(get(&conn).unwrap().unwrap().step, Some(100));
        for step in [100, 99] {
            assert_eq!(confirm(&conn, &pending.id, step).unwrap(), Confirm::Used);
        }
        assert_eq!(confirm(&conn, &pending.id, 101).unwrap(), Confirm::Done);
        assert_eq!(get(&conn).unwrap().unwrap().step, Some(101));
    }
}
