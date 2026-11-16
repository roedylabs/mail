//! Addresses of app accounts and sending accounts (`auth::email`), the
//! username suggested from them, sign-in names and the addresses and links
//! of the organisation in system mails.

#![no_main]

use libfuzzer_sys::fuzz_target;
use roedy_mail_server::{
    auth::{email, username},
    db::repo::users,
    mailer::templates,
};

/// Special characters that would separate recipients in `To` or `Reply-To`.
const SPECIALS: &str = "<>()[]\\,;:\"";

fuzz_target!(|input: &str| {
    if email::is_valid(input) {
        assert!(input.len() <= email::MAX_LEN);
        let (local, domain) = input.split_once('@').expect("one @");
        assert!(!local.is_empty() && !domain.contains('@'));
        assert!(
            !input
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || SPECIALS.contains(c)),
            "{input:?}"
        );
    }
    // Every suggestion is a username the profile accepts.
    let name = username::from_email(input);
    assert!(username::is_valid(&name), "{input:?} -> {name:?}");
    // Normalizing twice is the same lookup (sign-in lockout).
    let login = users::normalize_login(input);
    assert_eq!(users::normalize_login(&login), login, "{input:?}");
    if templates::is_address(input) {
        assert!(
            !input
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || c == '?')
        );
    }
    if templates::is_link(input) {
        assert!(!input.chars().any(|c| c.is_whitespace() || c.is_control()));
    }
});
