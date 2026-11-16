//! Headers of system mails (`roedy_jmap::Client::send`): names and subjects
//! come from settings and user input, but a line break in them must never
//! start a header of its own.

#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use roedy_jmap::{Identity, Message, fuzzing};
use serde_json::Value;

#[derive(Arbitrary, Debug)]
struct Input<'a> {
    identity_name: String,
    from_name: Option<&'a str>,
    subject: &'a str,
    to: &'a str,
    reply_to: Option<&'a str>,
}

fuzz_target!(|input: Input<'_>| {
    let identity = Identity {
        id: "i1".into(),
        name: input.identity_name,
        email: "noreply@example.com".into(),
    };
    let message = Message {
        to: input.to,
        from_name: input.from_name,
        reply_to: input.reply_to,
        subject: input.subject,
        text: "text",
        html: "<p>html</p>",
        sent_at: "2026-10-24T13:57:00Z",
    };
    let draft = fuzzing::draft(identity, &message);
    let one_line = |value: &Value| {
        let text = value.as_str().expect("text");
        assert!(!text.chars().any(char::is_control), "{text:?}");
        assert_eq!(text.trim(), text);
    };
    one_line(&draft["subject"]);
    for field in ["from", "to", "replyTo"] {
        for address in draft[field].as_array().into_iter().flatten() {
            if !address["name"].is_null() {
                one_line(&address["name"]);
                assert_ne!(address["name"], "");
            }
        }
    }
});
