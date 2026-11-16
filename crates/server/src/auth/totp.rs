//! Authenticator apps: TOTP per RFC 6238
//! with SHA-1, six digits and 30 s per time step – what every
//! authenticator app supports. One step before or after is still valid
//! (clock skew, RFC 6238, 5.2).
//!
//! Every code is valid only once: per device the last accepted
//! time step is in `totp_devices.last_step`, checked and set in one
//! `UPDATE` (see [`totp_devices::accept`]). Of two concurrent
//! requests with the same code only one gets through; the other gets
//! [`Check::Used`].

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::anyhow;
use rusqlite::Connection;
use totp_rs::{Algorithm, Builder, Totp};

use crate::{
    broker::crypto::SecretKey,
    db::repo::totp_devices,
    i18n, random,
    settings::{self, Language},
};

/// Purpose for the secret's AAD; the row is the device ID.
pub const SECRET_PURPOSE: &str = "totp_devices.secret";
/// 160 bits, as RFC 4226 (4) recommends.
pub const SECRET_BYTES: usize = 20;
/// Seconds per time step.
const STEP: u64 = 30;
/// Digits per code.
pub const DIGITS: usize = 6;

/// Result of a check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Check {
    /// Accepted (ID and name of the device).
    Accepted {
        device_id: String,
        name: String,
    },
    /// The code matches, but its time step was already accepted
    /// (`code_used`). It reveals nothing guessable and does not count towards the rate limit.
    Used,
    Invalid,
}

/// Whether `code` has the form of a code (six digits); otherwise it need not
/// be checked.
pub fn is_well_formed(code: &str) -> bool {
    code.len() == DIGITS && code.bytes().all(|b| b.is_ascii_digit())
}

/// Input without whitespace (apps often show codes as "123 456").
pub fn compact(code: &str) -> String {
    code.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Seconds since 1970 for the check.
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// New secret from the system's random source.
pub fn generate_secret() -> anyhow::Result<[u8; SECRET_BYTES]> {
    random::bytes::<SECRET_BYTES>()
}

fn totp(secret: &[u8], issuer: Option<&str>, account: &str) -> anyhow::Result<Totp> {
    // A colon separates issuer and account in the label; it is not allowed
    // in either.
    Builder::new()
        .with_algorithm(Algorithm::SHA1)
        .with_digits(DIGITS as u8)
        .with_skew(0)
        .with_step_duration(STEP)
        .with_secret(secret.to_vec())
        .with_issuer(issuer.map(|issuer| issuer.replace(':', " ")))
        .with_account_name(account.replace(':', " "))
        .build()
        .map_err(|e| anyhow!("TOTP cannot be set up: {e}"))
}

/// Secret in Base32 (without padding) for typing and the address
/// `otpauth://totp/…` for the QR code.
pub fn enrollment(secret: &[u8], issuer: &str, account: &str) -> anyhow::Result<(String, String)> {
    let totp = totp(secret, Some(issuer), account)?;
    let url = totp
        .to_url()
        .map_err(|e| anyhow!("otpauth address cannot be created: {e}"))?;
    Ok((totp.secret().to_base32(), url))
}

/// Time step that `code` matches: the most recent of the current one, the
/// one before and the one after.
pub fn matching_step(secret: &[u8], code: &str, now: u64) -> anyhow::Result<Option<u64>> {
    if !is_well_formed(code) {
        return Ok(None);
    }
    let totp = totp(secret, None, "")?;
    let current = now / STEP;
    Ok([current + 1, current, current.saturating_sub(1)]
        .into_iter()
        .find(|&step| totp.check(code, step * STEP) == Some(step)))
}

/// Checks `code` against all confirmed devices of the user and accepts it
/// on the first match (sets `last_step` and `last_used_at`).
pub fn check(
    conn: &Connection,
    secrets: &SecretKey,
    user_id: &str,
    code: &str,
    now: u64,
) -> anyhow::Result<Check> {
    let mut used = false;
    for device in totp_devices::confirmed_secrets(conn, user_id)? {
        let secret = secrets.open(SECRET_PURPOSE, &device.id, &device.secret_enc)?;
        let Some(step) = matching_step(&secret, code, now)? else {
            continue;
        };
        if totp_devices::accept(conn, &device.id, step)? {
            return Ok(Check::Accepted {
                device_id: device.id,
                name: device.name,
            });
        }
        used = true;
    }
    Ok(if used { Check::Used } else { Check::Invalid })
}

/// Result of [`confirm`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Confirm {
    /// Confirmed under `name`; `first` if it is the user's first
    /// device.
    Done {
        name: String,
        first: bool,
    },
    Invalid,
    /// No started (unconfirmed) setup with this ID.
    NotFound,
}

/// Name when none is given: "Authenticator app", from the second device with
/// a number – the first one not yet taken, so that after removal no two have
/// the same name. Stored in the user's language at creation; a later
/// language change does not rename existing devices.
pub fn default_name(existing: &[String], lang: Language) -> String {
    let base = i18n::t(lang, "totp.default_name");
    let name = |n: usize| match n {
        0 => base.to_owned(),
        n => format!("{base} {}", n + 1),
    };
    (existing.len()..)
        .map(name)
        .find(|candidate| !existing.contains(candidate))
        .expect("infinitely many candidates")
}

/// Confirms a started setup with a code from the new app, in
/// the caller's transaction (together with the recovery codes
/// of the first device). Here too the code is valid only once: it is stored as
/// the device's `last_step` and cannot be used for sign-in
/// again afterwards.
pub fn confirm(
    conn: &Connection,
    secrets: &SecretKey,
    user_id: &str,
    device_id: &str,
    name: Option<&str>,
    code: &str,
    now: u64,
) -> anyhow::Result<Confirm> {
    let Some(sealed) = totp_devices::pending_secret(conn, user_id, device_id)? else {
        return Ok(Confirm::NotFound);
    };
    let secret = secrets.open(SECRET_PURPOSE, device_id, &sealed)?;
    let Some(step) = matching_step(&secret, code, now)? else {
        return Ok(Confirm::Invalid);
    };
    let existing: Vec<String> = totp_devices::list(conn, user_id)?
        .into_iter()
        .map(|device| device.name)
        .collect();
    let name = match name {
        Some(name) => name.to_owned(),
        None => default_name(&existing, settings::lang_of(conn, user_id)?),
    };
    if !totp_devices::confirm(conn, device_id, &name, step)? {
        return Ok(Confirm::NotFound);
    }
    Ok(Confirm::Done {
        name,
        first: existing.is_empty(),
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// RFC 6238, appendix B: secret "12345678901234567890" (SHA-1).
    const RFC_SECRET: &[u8] = b"12345678901234567890";

    /// Code for `secret` at time `time` (for tests).
    pub(crate) fn code_at(secret: &[u8], time: u64) -> String {
        totp(secret, None, "").unwrap().generate(time).to_string()
    }

    #[test]
    fn matches_rfc_test_vectors() {
        // The last six digits of the eight-digit values from appendix B.
        for (time, code) in [
            (59, "287082"),
            (1_111_111_109, "081804"),
            (1_234_567_890, "005924"),
            (2_000_000_000, "279037"),
        ] {
            assert_eq!(code_at(RFC_SECRET, time), code, "{time}");
            assert_eq!(
                matching_step(RFC_SECRET, code, time).unwrap(),
                Some(time / STEP)
            );
        }
    }

    #[test]
    fn accepts_one_step_of_skew() {
        let now = 1_700_000_000;
        let step = now / STEP;
        for offset in [-1i64, 0, 1] {
            let time = (now as i64 + offset * STEP as i64) as u64;
            let code = code_at(RFC_SECRET, time);
            assert_eq!(
                matching_step(RFC_SECRET, &code, now).unwrap(),
                Some((step as i64 + offset) as u64)
            );
        }
        for offset in [-2i64, 2] {
            let code = code_at(RFC_SECRET, (now as i64 + offset * STEP as i64) as u64);
            assert_eq!(matching_step(RFC_SECRET, &code, now).unwrap(), None);
        }
    }

    #[test]
    fn rejects_malformed_codes() {
        for code in ["", "12345", "1234567", "12 456", "12345a", "١٢٣٤٥٦"] {
            assert!(!is_well_formed(code), "{code}");
            assert_eq!(matching_step(RFC_SECRET, code, 59).unwrap(), None);
        }
        assert!(is_well_formed("012345"));
    }

    #[test]
    fn default_names_are_numbered_without_duplicates() {
        let names = |list: &[&str]| list.iter().map(|n| (*n).to_owned()).collect::<Vec<_>>();
        let en = Language::English;
        assert_eq!(default_name(&[], en), "Authenticator app");
        assert_eq!(default_name(&names(&["Phone"]), en), "Authenticator app 2");
        assert_eq!(
            default_name(&names(&["Authenticator app", "Authenticator app 2"]), en),
            "Authenticator app 3"
        );
        // After removing the first one, no duplicate names.
        assert_eq!(
            default_name(&names(&["Authenticator app 2"]), en),
            "Authenticator app 3"
        );
        let de = Language::German;
        let german = i18n::t(de, "totp.default_name");
        assert_ne!(german, "Authenticator app");
        assert_eq!(default_name(&[], de), german);
        assert_eq!(default_name(&names(&["Phone"]), de), format!("{german} 2"));
    }

    #[test]
    fn enrollment_shows_secret_and_uri() {
        let (base32, uri) = enrollment(RFC_SECRET, "Roedy Mail", "max:test@example.com").unwrap();
        assert_eq!(base32, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
        assert!(uri.starts_with("otpauth://totp/Roedy%20Mail:max%20test%40example.com?"));
        assert!(
            uri.contains("secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"),
            "{uri}"
        );
        assert!(uri.contains("issuer=Roedy%20Mail"), "{uri}");
        assert_eq!(generate_secret().unwrap().len(), SECRET_BYTES);
        assert_ne!(generate_secret().unwrap(), generate_secret().unwrap());
    }
}
