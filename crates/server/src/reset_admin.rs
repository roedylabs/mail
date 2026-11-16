//! `roedy-mail reset-admin`: restores an administrator's access,
//! e.g. after a lost password and a lost authenticator app. Sets a new random
//! password, removes authenticator apps and recovery codes, ends all sessions
//! and unlocks the account. Whoever can run the command has access to the
//! container and the database anyway.

use anyhow::{bail, ensure};
use rusqlite::Connection;
use serde_json::json;

use crate::{
    auth::password,
    db::repo::{
        self,
        audit_log::{self, Category, Entry},
        recovery_codes, sessions, totp_devices,
        users::{self, Credentials},
    },
    random,
};

/// Characters of the new password, without easily confused ones (I, l, O, 0, 1).
const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
/// Four groups of five characters with hyphens: 23 characters, about 117 bits.
const GROUPS: usize = 4;
const GROUP_LEN: usize = 5;

/// What `reset-admin` did (for the output). No `Debug`: it contains the new
/// password.
pub struct Reset {
    pub display_name: String,
    pub email: String,
    pub password: String,
    pub devices: usize,
    pub sessions: usize,
    pub unlocked: bool,
}

/// New password that satisfies the policy (the hyphen is the special
/// character).
pub fn generate_password() -> anyhow::Result<String> {
    loop {
        let mut password = String::with_capacity(GROUPS * (GROUP_LEN + 1));
        let mut chars = 0;
        while chars < GROUPS * GROUP_LEN {
            for b in random::bytes::<32>()? {
                // Only bytes below a multiple of the length: uniformly distributed.
                let limit = 256 - 256 % ALPHABET.len();
                if usize::from(b) >= limit || chars == GROUPS * GROUP_LEN {
                    continue;
                }
                if chars > 0 && chars % GROUP_LEN == 0 {
                    password.push('-');
                }
                password.push(char::from(ALPHABET[usize::from(b) % ALPHABET.len()]));
                chars += 1;
            }
        }
        if password::violations(&password).is_empty() {
            return Ok(password);
        }
    }
}

/// Selects the administrator: without `login` the only one, otherwise the one
/// with this email address or username.
pub fn select(conn: &Connection, login: Option<&str>) -> anyhow::Result<Credentials> {
    let admins = users::admins(conn)?;
    ensure!(
        !admins.is_empty(),
        "There is no administrator yet – the initial setup is not complete \
         (setup token: `roedy-mail setup-token`)."
    );
    let Some(login) = login else {
        if let [admin] = admins.as_slice() {
            return Ok(admin.clone());
        }
        let list: Vec<&str> = admins.iter().map(|a| a.user.email.as_str()).collect();
        bail!(
            "There are several administrators ({}); please choose one with \
             --user <email address or username>.",
            list.join(", ")
        );
    };
    match users::find_for_login(conn, login)? {
        Some(found) if admins.iter().any(|a| a.user.id == found.user.id) => Ok(found),
        Some(_) => bail!("\"{login}\" is not an administrator."),
        None => bail!("No user \"{login}\"."),
    }
}

/// Resets the access in one transaction; `password_hash` is the hash of
/// `password` (Argon2id, computed beforehand).
pub fn reset(
    conn: &mut Connection,
    admin: &Credentials,
    password: String,
    password_hash: &str,
) -> anyhow::Result<Reset> {
    let tx = conn.transaction()?;
    let id = &admin.user.id;
    users::set_password(&tx, id, password_hash)?;
    let devices = totp_devices::list(&tx, id)?.len();
    totp_devices::delete_all(&tx, id)?;
    recovery_codes::delete_all(&tx, id)?;
    let sessions = sessions::delete_for_user(&tx, id, None)?;
    // Like "reset password": open links from mails are no longer valid.
    repo::discard_links(&tx, id)?;
    let unlocked = users::unlock(&tx, id)?;
    let mut entry = Entry::new(Category::System, "auth.reset_admin")
        .target(id)
        .details(json!({
            "user": admin.user.display_name,
            "email": admin.user.email,
            "devices": devices,
            "sessions": sessions,
            "unlocked": unlocked,
        }));
    // Like the initial setup: the actor is the system.
    entry.actor_name = Some("System".into());
    audit_log::insert(&tx, &entry)?;
    tx.commit()?;
    Ok(Reset {
        display_name: admin.user.display_name.clone(),
        email: admin.user.email.clone(),
        password,
        devices,
        sessions,
        unlocked,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        auth::{
            recovery,
            session::{self, Client},
        },
        db::repo::{
            email_changes, password_resets,
            users::{
                Role,
                tests::{add, conn},
            },
        },
    };

    #[test]
    fn passwords_follow_policy() {
        for _ in 0..50 {
            let password = generate_password().unwrap();
            assert_eq!(
                password.len(),
                GROUPS * GROUP_LEN + GROUPS - 1,
                "{password}"
            );
            assert_eq!(password.matches('-').count(), GROUPS - 1);
            assert!(password::violations(&password).is_empty(), "{password}");
            assert!(
                password.bytes().all(|b| b == b'-' || ALPHABET.contains(&b)),
                "{password}"
            );
        }
        assert_ne!(generate_password().unwrap(), generate_password().unwrap());
    }

    #[test]
    fn selects_the_only_or_named_admin() {
        let conn = conn();
        assert!(
            select(&conn, None)
                .unwrap_err()
                .to_string()
                .contains("setup-token")
        );
        let max = add(&conn, "max", "max@example.com", Role::Admin);
        add(&conn, "eva", "eva@example.com", Role::User);
        assert_eq!(select(&conn, None).unwrap().user.id, max);
        let anna = add(&conn, "anna", "anna@example.com", Role::Admin);
        let err = select(&conn, None).unwrap_err().to_string();
        assert!(err.contains("max@example.com, anna@example.com"), "{err}");
        assert_eq!(
            select(&conn, Some("ANNA@example.com")).unwrap().user.id,
            anna
        );
        assert_eq!(select(&conn, Some("max")).unwrap().user.id, max);
        assert!(
            select(&conn, Some("eva"))
                .unwrap_err()
                .to_string()
                .contains("not an administrator")
        );
        assert!(
            select(&conn, Some("moritz"))
                .unwrap_err()
                .to_string()
                .contains("No user")
        );
    }

    #[test]
    fn reset_removes_factors_and_sessions() {
        let mut conn = conn();
        let max = add(&conn, "max", "max@example.com", Role::Admin);
        // Open links from mails (such as a change made by an attacker).
        let change = email_changes::reserve(&conn, &max, "stranger@example.com", &[1; 32]).unwrap();
        email_changes::release(&conn, &change).unwrap();
        password_resets::insert(&conn, &max, &[2; 32]).unwrap();
        totp_devices::insert_pending(&conn, "t1", &max, b"x").unwrap();
        totp_devices::confirm(&conn, "t1", "Phone", 1).unwrap();
        recovery::replace(&conn, &max).unwrap();
        session::start(&conn, &max, &Client::default(), true).unwrap();
        session::start(&conn, &max, &Client::default(), false).unwrap();
        conn.execute("UPDATE users SET status = 'locked' WHERE id = ?1", [&max])
            .unwrap();

        let admin = select(&conn, None).unwrap();
        let reset = reset(&mut conn, &admin, "New-Password-1".into(), "$argon2id$new").unwrap();
        assert_eq!(
            (reset.devices, reset.sessions, reset.unlocked),
            (1, 2, true)
        );
        let after = users::credentials_by_id(&conn, &max).unwrap().unwrap();
        assert_eq!(after.password_hash, "$argon2id$new");
        assert!(after.active);
        assert!(!totp_devices::has_confirmed(&conn, &max).unwrap());
        assert_eq!(recovery_codes::summary(&conn, &max).unwrap(), None);
        assert_eq!(email_changes::open(&conn, &max).unwrap(), None);
        assert_eq!(
            password_resets::lookup(&conn, &[2; 32]).unwrap(),
            password_resets::Lookup::Unknown
        );
        let (action, actor, details): (String, Option<String>, String) = conn
            .query_row(
                "SELECT action, actor_name, details FROM audit_log",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(action, "auth.reset_admin");
        assert_eq!(actor.as_deref(), Some("System"));
        assert!(!details.contains("New-Password"), "{details}");
    }
}
