//! Email addresses of app accounts and sending accounts: the same check as
//! the web app (`/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/`), plus at most 254
//! characters (RFC 5321), no control characters and no invisible
//! format characters (`api::me::is_invisible`): an address with
//! a direction change (U+202E) or zero width would look like someone else's
//! in the user list, directory and audit log.

use crate::api::me::is_invisible;

/// Maximum length of an address (RFC 5321, 4.5.3.1.3 minus `<>`).
pub const MAX_LEN: usize = 254;

/// Special characters from RFC 5322 › 3.2.3 (without `@` and `.`): they have
/// no place in an address without quotes, and in `To` or
/// `Reply-To` they would separate recipients (`max@example.com>,<postmaster`).
const SPECIALS: &str = "<>()[]\\,;:\"";

/// Exactly one `@`, no whitespace before or after, in the part after it a dot
/// with at least one character before and two after.
pub fn is_valid(email: &str) -> bool {
    if email.len() > MAX_LEN
        || email
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || is_invisible(c) || SPECIALS.contains(c))
    {
        return false;
    }
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    // Like `[^\s@]+\.[^\s@]{2,}`: any dot with something before it and
    // at least two characters after it.
    let dotted = domain
        .char_indices()
        .any(|(i, c)| c == '.' && i > 0 && domain[i + 1..].chars().count() >= 2);
    !local.is_empty() && !domain.contains('@') && dotted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_web_app_pattern() {
        for good in [
            "max@example.com",
            "max.miller+test@mail.example.com",
            "m@b.test",
            "max@b.c.test",
            "zoë@exämple.test",
            "x@a.b.test",
        ] {
            assert!(is_valid(good), "{good}");
        }
        for bad in [
            "",
            "max",
            "max@",
            "@example.com",
            "max@example",
            "max@example.c",
            "max@.test",
            "max@@example.com",
            "max@ex@ample.test",
            "max @example.com",
            "max@example.com>,<postmaster",
            "max,eva@example.com",
            "max;eva@example.com",
            "\"max\"@example.com",
            "max(x)@example.com",
            "max@[127.0.0.1].test",
            "max\\@example.com",
            "max:eva@example.com",
            "max@example.com\n",
            "ma\u{7}x@example.com",
            "max\u{202E}ed.leipsieb@evil.example",
            "ma\u{200B}x@example.com",
            "max@example.com\u{FEFF}",
        ] {
            assert!(!is_valid(bad), "{bad:?}");
        }
        assert!(!is_valid(&format!("{}@example.com", "m".repeat(250))));
    }
}
