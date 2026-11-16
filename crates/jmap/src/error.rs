//! Client errors. [`Error::reason`] is a stable key for log and API. Whatever
//! the server writes (error types, descriptions) is truncated and free of
//! control characters; credentials never appear in it.

use std::fmt;

const MAX_KIND: usize = 64;
const MAX_DESCRIPTION: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// No connection (DNS, TCP, TLS, timeout) or an aborted response.
    Unreachable,
    /// 401: wrong user, password or token.
    AuthFailed,
    /// 403: signed in, but not authorized.
    Forbidden,
    /// 429: the server throttles requests from this address.
    Throttled,
    /// Redirect or `apiUrl` to another origin; no credentials go there.
    ForeignOrigin,
    /// Capability or primary account missing, e.g. `urn:ietf:params:jmap:submission`.
    Unsupported(&'static str),
    /// Request rejected (RFC 8620, 3.6.1), e.g. `limit`.
    Request(String),
    /// Method error (RFC 8620, 3.6.2), e.g. `accountNotFound`.
    Method(String),
    /// Object not created (`SetError`, RFC 8620, 5.3), e.g.
    /// `forbiddenToSend` (RFC 8621, 7.5).
    NotCreated {
        kind: String,
        description: Option<String>,
    },
    /// The chosen identity does not exist, or the account has none.
    NoIdentity,
    /// No mailbox with this role (`drafts`, `sent`).
    NoMailbox(&'static str),
    /// Unexpected HTTP status.
    Status(u16),
    /// Response unreadable, too large or incomplete.
    InvalidResponse,
}

impl Error {
    pub fn reason(&self) -> &'static str {
        match self {
            Self::Unreachable => "unreachable",
            Self::AuthFailed => "auth_failed",
            Self::Forbidden => "forbidden",
            Self::Throttled => "throttled",
            Self::ForeignOrigin => "foreign_origin",
            Self::Unsupported(_) => "unsupported",
            Self::Request(_) => "request_rejected",
            Self::Method(_) => "method_error",
            Self::NotCreated { .. } => "not_created",
            Self::NoIdentity => "no_identity",
            Self::NoMailbox(_) => "no_mailbox",
            Self::Status(_) => "http_status",
            Self::InvalidResponse => "invalid_response",
        }
    }

    pub(crate) fn not_created(kind: &str, description: Option<&str>) -> Self {
        Self::NotCreated {
            kind: kind_of(kind),
            description: description
                .map(|d| one_line(d, MAX_DESCRIPTION))
                .filter(|d| !d.is_empty()),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreachable => f.write_str("mail server unreachable"),
            Self::AuthFailed => f.write_str("sign-in to the mail server rejected"),
            Self::Forbidden => f.write_str("access denied"),
            Self::Throttled => f.write_str("mail server is throttling requests"),
            Self::ForeignOrigin => f.write_str("redirect to another address"),
            Self::Unsupported(capability) => write!(f, "{capability} missing"),
            Self::Request(kind) => write!(f, "request rejected ({kind})"),
            Self::Method(kind) => write!(f, "method error ({kind})"),
            Self::NotCreated { kind, description } => {
                write!(f, "not created ({kind})")?;
                if let Some(description) = description {
                    write!(f, ": {description}")?;
                }
                Ok(())
            }
            Self::NoIdentity => f.write_str("identity not found"),
            Self::NoMailbox(role) => write!(f, "mailbox with role \"{role}\" missing"),
            Self::Status(status) => write!(f, "unexpected status {status}"),
            Self::InvalidResponse => f.write_str("invalid response"),
        }
    }
}

impl std::error::Error for Error {}

/// Error type of the server, e.g. `forbiddenToSend` or
/// `urn:ietf:params:jmap:error:limit` (without prefix); otherwise `unknown`.
pub(crate) fn kind_of(kind: &str) -> String {
    let kind = kind
        .strip_prefix("urn:ietf:params:jmap:error:")
        .unwrap_or(kind);
    let valid = !kind.is_empty()
        && kind.len() <= MAX_KIND
        && kind
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'.' | b'_' | b'-'));
    if valid { kind } else { "unknown" }.to_owned()
}

/// Text on one line: control characters (line breaks too) become spaces,
/// at most `max` characters, no surrounding whitespace.
pub(crate) fn one_line(text: &str, max: usize) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(max)
        .collect::<String>()
        .trim()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_are_short_and_plain() {
        assert_eq!(kind_of("forbiddenToSend"), "forbiddenToSend");
        assert_eq!(kind_of("urn:ietf:params:jmap:error:limit"), "limit");
        assert_eq!(kind_of(""), "unknown");
        assert_eq!(kind_of("a b"), "unknown");
        assert_eq!(kind_of(&"x".repeat(65)), "unknown");
    }

    #[test]
    fn descriptions_lose_control_characters() {
        let error = Error::not_created("invalidEmail", Some(" line 1\nline 2 "));
        assert_eq!(
            error,
            Error::NotCreated {
                kind: "invalidEmail".into(),
                description: Some("line 1 line 2".into()),
            }
        );
        assert_eq!(
            error.to_string(),
            "not created (invalidEmail): line 1 line 2"
        );
        let long = Error::not_created("x", Some(&"ä".repeat(300)));
        let Error::NotCreated {
            description: Some(description),
            ..
        } = long
        else {
            panic!("description missing");
        };
        assert_eq!(description.chars().count(), MAX_DESCRIPTION);
        assert_eq!(
            Error::not_created("x", Some(" ")),
            Error::NotCreated {
                kind: "x".into(),
                description: None
            }
        );
    }
}
