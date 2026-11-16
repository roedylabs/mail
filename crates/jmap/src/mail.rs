//! Sending a mail (RFC 8621): read identity and mailboxes, then in one
//! request `Email/set` (draft) and `EmailSubmission/set`, which refers to the
//! just created draft via `#m`. After sending, the server files it in
//! "Sent" (`onSuccessUpdateEmail`) or deletes it (`onSuccessDestroyEmail`).

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::{CORE, Client, Error, MAIL, Request, SUBMISSION, error::one_line};

const USING: &[&str] = &[CORE, MAIL, SUBMISSION];
/// Creation IDs in the send request.
const EMAIL: &str = "m";
const SUBMIT: &str = "s";

/// Sender identity of the account (RFC 8621, 6).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Identity {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub email: String,
}

impl Identity {
    /// `*@example.com` allows every address of the domain (RFC 8621, 6) but
    /// is not one itself; it is no use as a sender.
    pub fn is_wildcard(&self) -> bool {
        self.email.starts_with("*@")
    }
}

/// The configured identity or, without one, the first; placeholders
/// (`*@…`) are never senders.
fn pick_identity(identities: Vec<Identity>, id: Option<&str>) -> Option<Identity> {
    identities
        .into_iter()
        .filter(|identity| !identity.is_wildcard())
        .find(|identity| id.is_none_or(|id| identity.id == id))
}

/// Account, identity and mailboxes for sending.
#[derive(Debug, Clone)]
pub struct Outbox {
    pub account_id: String,
    pub identity: Identity,
    drafts: String,
    sent: Option<String>,
}

/// A mail with a text and an HTML part (`multipart/alternative`).
#[derive(Debug, Clone, Copy)]
pub struct Message<'a> {
    pub to: &'a str,
    /// Display name instead of the identity's.
    pub from_name: Option<&'a str>,
    pub reply_to: Option<&'a str>,
    pub subject: &'a str,
    pub text: &'a str,
    pub html: &'a str,
    /// Header `Date` as RFC 3339 (`2026-10-24T13:57:00Z`).
    pub sent_at: &'a str,
}

/// Result of sending.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sent {
    pub email_id: String,
    /// `false` if the server sent the mail but did not file or delete it as
    /// requested (the draft then stayed).
    pub filed: bool,
}

#[derive(Deserialize)]
struct List<T> {
    list: Vec<T>,
}

#[derive(Deserialize)]
struct Mailbox {
    id: String,
    role: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetResponse {
    created: Option<HashMap<String, Value>>,
    not_created: Option<HashMap<String, SetError>>,
    not_updated: Option<HashMap<String, SetError>>,
    not_destroyed: Option<HashMap<String, SetError>>,
}

#[derive(Deserialize)]
struct SetError {
    #[serde(rename = "type")]
    kind: String,
    description: Option<String>,
}

impl SetResponse {
    /// The created entry `key` or its [`SetError`].
    fn created(&self, key: &str) -> Result<&Value, Error> {
        if let Some(error) = self.not_created.as_ref().and_then(|errors| errors.get(key)) {
            return Err(Error::not_created(
                &error.kind,
                error.description.as_deref(),
            ));
        }
        self.created
            .as_ref()
            .and_then(|created| created.get(key))
            .ok_or(Error::InvalidResponse)
    }

    fn failed(&self) -> bool {
        let any = |errors: &Option<HashMap<String, SetError>>| {
            errors.as_ref().is_some_and(|errors| !errors.is_empty())
        };
        any(&self.not_updated) || any(&self.not_destroyed)
    }
}

impl Client {
    fn account(&self) -> Result<String, Error> {
        let session = self.session();
        let mail = session
            .primary_account(MAIL)
            .ok_or(Error::Unsupported(MAIL))?;
        let submission = session
            .primary_account(SUBMISSION)
            .ok_or(Error::Unsupported(SUBMISSION))?;
        // The draft must be in the account that sends it.
        if mail != submission {
            return Err(Error::Unsupported(SUBMISSION));
        }
        Ok(mail.to_owned())
    }

    /// Sender identities of the account.
    pub async fn identities(&self) -> Result<Vec<Identity>, Error> {
        let account_id = self.account()?;
        let mut request = Request::new(USING);
        let call = request.call(
            "Identity/get",
            json!({ "accountId": account_id, "ids": null }),
        );
        let response = self.call(&request).await?;
        Ok(response.get::<List<Identity>>(&call, "Identity/get")?.list)
    }

    /// Reads identity and mailboxes in one request. Without `identity_id` the
    /// account's first identity that is not a placeholder applies.
    pub async fn outbox(&self, identity_id: Option<&str>) -> Result<Outbox, Error> {
        let account_id = self.account()?;
        let mut request = Request::new(USING);
        let identities = request.call(
            "Identity/get",
            json!({ "accountId": account_id, "ids": null }),
        );
        let mailboxes = request.call(
            "Mailbox/get",
            json!({ "accountId": account_id, "ids": null, "properties": ["id", "role"] }),
        );
        let response = self.call(&request).await?;
        let identities = response.get::<List<Identity>>(&identities, "Identity/get")?;
        let identity = pick_identity(identities.list, identity_id).ok_or(Error::NoIdentity)?;
        let mailboxes = response
            .get::<List<Mailbox>>(&mailboxes, "Mailbox/get")?
            .list;
        let role = |role: &str| {
            mailboxes
                .iter()
                .find(|mailbox| mailbox.role.as_deref() == Some(role))
                .map(|mailbox| mailbox.id.clone())
        };
        Ok(Outbox {
            account_id,
            identity,
            drafts: role("drafts").ok_or(Error::NoMailbox("drafts"))?,
            sent: role("sent"),
        })
    }

    /// Creates the mail as a draft and sends it. With `keep_sent` it ends up in
    /// "Sent" afterwards, otherwise it is deleted. If the server rejects the
    /// submission, the client deletes the draft again (as far as possible).
    pub async fn send(
        &self,
        outbox: &Outbox,
        message: &Message<'_>,
        keep_sent: bool,
    ) -> Result<Sent, Error> {
        let sent_mailbox = match (&outbox.sent, keep_sent) {
            (Some(sent), true) => Some(sent),
            (None, true) => return Err(Error::NoMailbox("sent")),
            (_, false) => None,
        };
        let mut request = Request::new(USING);
        let create = request.call(
            "Email/set",
            json!({
                "accountId": outbox.account_id,
                "create": { EMAIL: email(outbox, message) },
            }),
        );
        let mut submission = Map::new();
        submission.insert("accountId".into(), json!(outbox.account_id));
        submission.insert(
            "create".into(),
            json!({ SUBMIT: { "identityId": outbox.identity.id, "emailId": format!("#{EMAIL}") } }),
        );
        let after = format!("#{SUBMIT}");
        match sent_mailbox {
            Some(sent) => submission.insert(
                "onSuccessUpdateEmail".into(),
                json!({ after: {
                    format!("mailboxIds/{}", outbox.drafts): null,
                    format!("mailboxIds/{sent}"): true,
                    "keywords/$draft": null,
                } }),
            ),
            None => submission.insert("onSuccessDestroyEmail".into(), json!([after])),
        };
        let submit = request.call("EmailSubmission/set", Value::Object(submission));

        let response = self.call(&request).await?;
        let email_id = response
            .get::<SetResponse>(&create, "Email/set")?
            .created(EMAIL)?
            .get("id")
            .and_then(Value::as_str)
            .ok_or(Error::InvalidResponse)?
            .to_owned();
        let submitted = response
            .get::<SetResponse>(&submit, "EmailSubmission/set")
            .and_then(|set| set.created(SUBMIT).map(drop));
        if let Err(error) = submitted {
            // Only if the server definitely rejected the submission; with an
            // unreadable response the mail may already be on its way.
            if matches!(error, Error::Method(_) | Error::NotCreated { .. }) {
                self.discard(outbox, &email_id).await;
            }
            return Err(error);
        }
        // The implicit `Email/set` (RFC 8621, 7.5) only concerns filing.
        let filed = response
            .get::<SetResponse>(&submit, "Email/set")
            .is_ok_and(|set| !set.failed());
        Ok(Sent { email_id, filed })
    }

    /// Deletes an unsent draft; errors have no consequences.
    async fn discard(&self, outbox: &Outbox, email_id: &str) {
        let mut request = Request::new(USING);
        request.call(
            "Email/set",
            json!({ "accountId": outbox.account_id, "destroy": [email_id] }),
        );
        let _ = self.call(&request).await;
    }
}

/// The `Email` object to create (RFC 8621, 4.6).
fn email(outbox: &Outbox, message: &Message<'_>) -> Value {
    let from_name = message.from_name.unwrap_or(&outbox.identity.name);
    let mut email = json!({
        "mailboxIds": { outbox.drafts.as_str(): true },
        "keywords": { "$draft": true, "$seen": true },
        "from": [address(Some(from_name), &outbox.identity.email)],
        "to": [address(None, message.to)],
        "subject": header_text(message.subject),
        "sentAt": message.sent_at,
        // Auto-generated (RFC 3834): no out-of-office replies back.
        "header:Auto-Submitted:asText": "auto-generated",
        "bodyStructure": {
            "type": "multipart/alternative",
            "subParts": [
                { "partId": "text", "type": "text/plain" },
                { "partId": "html", "type": "text/html" },
            ],
        },
        "bodyValues": {
            "text": { "value": message.text },
            "html": { "value": message.html },
        },
    });
    if let Some(reply_to) = message.reply_to {
        email["replyTo"] = json!([address(None, reply_to)]);
    }
    email
}

fn address(name: Option<&str>, email: &str) -> Value {
    let name = name.map(header_text).filter(|name| !name.is_empty());
    json!({ "name": name, "email": email })
}

/// Text for a header: without line breaks and other control characters.
fn header_text(text: &str) -> String {
    one_line(text, usize::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outbox(sent: Option<&str>) -> Outbox {
        Outbox {
            account_id: "a".into(),
            identity: Identity {
                id: "i1".into(),
                name: "Example Ltd".into(),
                email: "noreply@example.com".into(),
            },
            drafts: "d".into(),
            sent: sent.map(Into::into),
        }
    }

    fn message() -> Message<'static> {
        Message {
            to: "jonas.schulz@example.com",
            from_name: None,
            reply_to: None,
            subject: "Invitation to\r\nRoedy Mail",
            text: "Hello",
            html: "<p>Hello</p>",
            sent_at: "2026-10-24T13:57:00Z",
        }
    }

    #[test]
    fn email_is_a_draft_with_both_parts() {
        let email = email(&outbox(Some("s")), &message());
        assert_eq!(
            email,
            json!({
                "mailboxIds": { "d": true },
                "keywords": { "$draft": true, "$seen": true },
                "from": [{ "name": "Example Ltd", "email": "noreply@example.com" }],
                "to": [{ "name": null, "email": "jonas.schulz@example.com" }],
                "subject": "Invitation to  Roedy Mail",
                "sentAt": "2026-10-24T13:57:00Z",
                "header:Auto-Submitted:asText": "auto-generated",
                "bodyStructure": {
                    "type": "multipart/alternative",
                    "subParts": [
                        { "partId": "text", "type": "text/plain" },
                        { "partId": "html", "type": "text/html" },
                    ],
                },
                "bodyValues": {
                    "text": { "value": "Hello" },
                    "html": { "value": "<p>Hello</p>" },
                },
            })
        );
    }

    #[test]
    fn sender_name_and_reply_to() {
        let message = Message {
            from_name: Some("Support\nTeam"),
            reply_to: Some("support@example.com"),
            ..message()
        };
        let email = email(&outbox(None), &message);
        assert_eq!(
            email["from"],
            json!([{ "name": "Support Team", "email": "noreply@example.com" }])
        );
        assert_eq!(
            email["replyTo"],
            json!([{ "name": null, "email": "support@example.com" }])
        );
        // An empty name is dropped.
        let message = Message {
            from_name: Some(" "),
            ..message
        };
        assert_eq!(email_from_name(&message), Value::Null);
    }

    fn email_from_name(message: &Message<'_>) -> Value {
        email(&outbox(None), message)["from"][0]["name"].clone()
    }

    #[test]
    fn wildcards_are_no_sender() {
        let identity = |id: &str, email: &str| Identity {
            id: id.into(),
            name: String::new(),
            email: email.into(),
        };
        let list = || {
            vec![
                identity("w", "*@example.com"),
                identity("i1", "noreply@example.com"),
                identity("i2", "support@example.com"),
            ]
        };
        assert_eq!(pick_identity(list(), None).unwrap().id, "i1");
        assert_eq!(pick_identity(list(), Some("i2")).unwrap().id, "i2");
        assert_eq!(pick_identity(list(), Some("w")), None);
        assert_eq!(pick_identity(list(), Some("x")), None);
    }

    #[test]
    fn set_errors() {
        let set: SetResponse = serde_json::from_value(json!({
            "created": { "m": { "id": "e1" } },
            "notCreated": { "s": { "type": "forbiddenToSend", "description": "No." } },
        }))
        .unwrap();
        assert_eq!(set.created("m").unwrap()["id"], "e1");
        assert_eq!(
            set.created("s"),
            Err(Error::NotCreated {
                kind: "forbiddenToSend".into(),
                description: Some("No.".into()),
            })
        );
        assert_eq!(set.created("x"), Err(Error::InvalidResponse));
        assert!(!set.failed());
        let set: SetResponse =
            serde_json::from_value(json!({ "notUpdated": { "e1": { "type": "notFound" } } }))
                .unwrap();
        assert!(set.failed());
        let set: SetResponse =
            serde_json::from_value(json!({ "updated": { "e1": null }, "notUpdated": null }))
                .unwrap();
        assert!(!set.failed());
    }
}
