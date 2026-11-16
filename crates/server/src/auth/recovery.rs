//! Recovery codes: ten codes per user,
//! each valid once – eight characters from
//! `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (without I, O, 0, 1), shown as
//! `XXXX-XXXX`.
//!
//! Only SHA-256 over user ID and code is stored. A code has
//! 40 bits; it could be computed from a stolen database – but it
//! only replaces the app's code, the sign-in still requires the
//! password (Argon2id). Online, the sign-in rate limits apply.

use rusqlite::Connection;
use sha2::{Digest as _, Sha256};

use crate::{db::repo::recovery_codes, random};

/// Codes per set.
pub const COUNT: usize = 10;
const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LEN: usize = 8;

/// Result of [`redeem`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Redeem {
    /// Redeemed; `remaining` codes are still unused.
    Accepted {
        remaining: u32,
    },
    /// Already redeemed – like an already used TOTP code it does not count
    /// towards the rate limit.
    Used,
    Invalid,
}

/// Input without hyphen and whitespace, in upper case (like the sign-in
/// page); `None` if it does not have eight letters or digits.
pub fn normalize(input: &str) -> Option<String> {
    let code: String = input
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_uppercase())
        .collect();
    let only_separators = input
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c.is_whitespace());
    (code.len() == LEN && only_separators).then_some(code)
}

fn hash(user_id: &str, code: &str) -> [u8; 32] {
    Sha256::new()
        .chain_update(user_id.as_bytes())
        .chain_update(b"\0")
        .chain_update(code.as_bytes())
        .finalize()
        .into()
}

fn generate_one() -> anyhow::Result<String> {
    // 32 characters: every byte yields one, evenly distributed,
    // from its lower five bits.
    let bytes = random::bytes::<LEN>()?;
    let mut code = String::with_capacity(LEN + 1);
    for (i, b) in bytes.iter().enumerate() {
        if i == LEN / 2 {
            code.push('-');
        }
        code.push(char::from(ALPHABET[usize::from(b & 31)]));
    }
    Ok(code)
}

/// Creates a new set and replaces the previous one (in the caller's
/// transaction). The codes exist only in this return value (shown
/// "once").
pub fn replace(conn: &Connection, user_id: &str) -> anyhow::Result<Vec<String>> {
    let mut codes = Vec::with_capacity(COUNT);
    while codes.len() < COUNT {
        let code = generate_one()?;
        if !codes.contains(&code) {
            codes.push(code);
        }
    }
    let hashes: Vec<[u8; 32]> = codes
        .iter()
        .map(|code| hash(user_id, &code.replace('-', "")))
        .collect();
    recovery_codes::replace(conn, user_id, &hashes)?;
    Ok(codes)
}

/// Redeems a code (in one `UPDATE`, so only once even with concurrent
/// requests).
pub fn redeem(conn: &Connection, user_id: &str, input: &str) -> anyhow::Result<Redeem> {
    let Some(code) = normalize(input) else {
        return Ok(Redeem::Invalid);
    };
    let hash = hash(user_id, &code);
    Ok(match recovery_codes::redeem(conn, user_id, &hash)? {
        Some(true) => Redeem::Accepted {
            remaining: recovery_codes::summary(conn, user_id)?.map_or(0, |s| s.unused),
        },
        Some(false) => Redeem::Used,
        None => Redeem::Invalid,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::users::{
        Role,
        tests::{add, conn},
    };

    #[test]
    fn codes_have_display_format() {
        for _ in 0..50 {
            let code = generate_one().unwrap();
            let (a, b) = code.split_once('-').unwrap();
            assert_eq!((a.len(), b.len()), (4, 4), "{code}");
            assert!(
                code.bytes()
                    .filter(|&c| c != b'-')
                    .all(|c| ALPHABET.contains(&c)),
                "{code}"
            );
        }
    }

    #[test]
    fn normalizes_like_the_login_page() {
        assert_eq!(normalize("abcd-efgh").as_deref(), Some("ABCDEFGH"));
        assert_eq!(normalize(" ABCD EFGH ").as_deref(), Some("ABCDEFGH"));
        assert_eq!(normalize("ABCDEFGH").as_deref(), Some("ABCDEFGH"));
        for bad in ["", "ABCD-EFG", "ABCD-EFGHJ", "ABCD_EFGH", "ÄBCD-EFGH"] {
            assert_eq!(normalize(bad), None, "{bad}");
        }
    }

    #[test]
    fn redeems_each_code_once() {
        let conn = conn();
        let user = add(&conn, "max", "max@example.com", Role::User);
        let other = add(&conn, "eva", "eva@example.com", Role::User);
        let codes = replace(&conn, &user).unwrap();
        assert_eq!(codes.len(), COUNT);
        let mut unique = codes.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), COUNT);

        let lower = codes[0].to_lowercase();
        assert_eq!(
            redeem(&conn, &user, &lower).unwrap(),
            Redeem::Accepted { remaining: 9 }
        );
        assert_eq!(redeem(&conn, &user, &codes[0]).unwrap(), Redeem::Used);
        assert_eq!(redeem(&conn, &other, &codes[1]).unwrap(), Redeem::Invalid);
        assert_eq!(redeem(&conn, &user, "ZZZZ-ZZZZ").unwrap(), Redeem::Invalid);
        assert_eq!(redeem(&conn, &user, "short").unwrap(), Redeem::Invalid);

        // A new set invalidates the old codes.
        let fresh = replace(&conn, &user).unwrap();
        assert_eq!(redeem(&conn, &user, &codes[1]).unwrap(), Redeem::Invalid);
        assert_eq!(
            redeem(&conn, &user, &fresh[9]).unwrap(),
            Redeem::Accepted { remaining: 9 }
        );
    }

    #[test]
    fn stores_only_hashes() {
        let conn = conn();
        let user = add(&conn, "max", "max@example.com", Role::User);
        let codes = replace(&conn, &user).unwrap();
        let stored: Vec<Vec<u8>> = conn
            .prepare("SELECT code_hash FROM recovery_codes")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(stored.len(), COUNT);
        let plain = codes[0].replace('-', "");
        assert!(
            stored
                .iter()
                .all(|h| h.len() == 32 && h != plain.as_bytes())
        );
        assert!(stored.contains(&hash(&user, &plain).to_vec()));
    }
}
