//! JMAP session and method responses from a mail server, decoded as the
//! backend's client does: the session (`/.well-known/jmap`) and the
//! responses to reading identities and mailboxes and to sending.

#![no_main]

use libfuzzer_sys::fuzz_target;
use roedy_jmap::{CORE, Error, MAIL, Response, SUBMISSION, Session, fuzzing, same_origin};
use url::Url;

fuzz_target!(|data: &[u8]| {
    if let Ok(session) = serde_json::from_slice::<Session>(data) {
        for capability in [CORE, MAIL, SUBMISSION] {
            if session.primary_account(capability).is_some() {
                assert!(session.has(capability));
            }
        }
        // Credentials only go to the origin of the session.
        let base = Url::parse("https://mail.example.com/.well-known/jmap").expect("valid");
        if let Some(api_url) = same_origin(&base, &session.api_url) {
            assert_eq!(api_url.origin(), base.origin());
        }
    }
    if let Ok(response) = serde_json::from_slice::<Response>(data) {
        for identity in [None, Some("i1")] {
            for error in fuzzing::read(&response, identity) {
                check(&error);
            }
        }
    }
});

/// What the server writes ends up in logs and API errors: one line, short,
/// error types only from a plain alphabet.
fn check(error: &Error) {
    let text = error.to_string();
    assert!(!text.chars().any(char::is_control), "{text:?}");
    let kind = match error {
        Error::Request(kind) | Error::Method(kind) => kind,
        Error::NotCreated { kind, description } => {
            if let Some(description) = description {
                assert!(!description.is_empty() && description.chars().count() <= 200);
                assert_eq!(description.trim(), description);
            }
            kind
        }
        _ => return,
    };
    assert!(
        kind == "unknown"
            || (!kind.is_empty()
                && kind.len() <= 64
                && kind
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b":._-".contains(&b))),
        "{kind:?}"
    );
}
