//! Usernames (`PATCH auth/me`): `^[a-z0-9][a-z0-9._-]{1,31}$`.
//! Setup and invitation do not ask for one; the first suggestion comes from
//! the email address and can be changed in the profile.

pub const MAX_LEN: usize = 32;
const MIN_LEN: usize = 2;
/// Fallback when nothing usable is left of the address.
const FALLBACK: &str = "user";

pub fn is_valid(name: &str) -> bool {
    let bytes = name.as_bytes();
    (MIN_LEN..=MAX_LEN).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

/// Suggestion from the local part of the address: lower case, umlauts transcribed,
/// other characters removed, at most 32 characters. Whether it is free is checked by
/// `db::repo::users::unique_username`.
pub fn from_email(email: &str) -> String {
    let local = email
        .trim()
        .rsplit_once('@')
        .map_or(email.trim(), |(l, _)| l);
    let mut name = String::new();
    for c in local.chars().flat_map(char::to_lowercase) {
        match c {
            'a'..='z' | '0'..='9' | '.' | '_' | '-' => name.push(c),
            'ä' => name.push_str("ae"),
            'ö' => name.push_str("oe"),
            'ü' => name.push_str("ue"),
            'ß' => name.push_str("ss"),
            '+' => break, // subaddress (max+news@…) is not part of the name
            _ => {}
        }
    }
    let name = name.trim_start_matches(['.', '_', '-']);
    let name = &name[..name.len().min(MAX_LEN)];
    if is_valid(name) {
        name.to_owned()
    } else {
        FALLBACK.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_format() {
        for ok in ["max", "m1", "0x", "max.miller", "a_b-c", &"a".repeat(32)] {
            assert!(is_valid(ok), "{ok}");
        }
        for bad in [
            "",
            "m",
            "Max",
            ".max",
            "-max",
            "max@a",
            "mäx",
            "max miller",
            &"a".repeat(33),
        ] {
            assert!(!is_valid(bad), "{bad}");
        }
    }

    #[test]
    fn derives_from_email() {
        for (email, name) in [
            ("Max.Miller@example.com", "max.miller"),
            (" jörg.weiß@example.com", "joerg.weiss"),
            ("max+news@example.com", "max"),
            ("_max@example.com", "max"),
            ("x@example.com", "user"),
            ("@@example.com", "user"),
            ("李@example.com", "user"),
            ("no-at", "no-at"),
        ] {
            assert_eq!(from_email(email), name, "{email}");
        }
        let long = format!("{}@example.com", "m".repeat(40));
        assert_eq!(from_email(&long), "m".repeat(MAX_LEN));
    }
}
