//! JMAP session (RFC 8620, 2): capabilities, primary accounts, `apiUrl` and
//! the other URLs.

use std::collections::HashMap;

use serde::Deserialize;

/// The session fields the client needs.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub capabilities: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub primary_accounts: HashMap<String, String>,
    #[serde(default)]
    pub username: String,
    pub api_url: String,
    /// Templates for download, upload and push (RFC 8620, 2); required by the
    /// RFC, optional here so that sending works without them.
    #[serde(default)]
    pub download_url: Option<String>,
    #[serde(default)]
    pub upload_url: Option<String>,
    #[serde(default)]
    pub event_source_url: Option<String>,
    #[serde(default)]
    pub state: String,
}

impl Session {
    pub fn has(&self, capability: &str) -> bool {
        self.capabilities.contains_key(capability)
    }

    /// Primary account for a capability, if the server offers it.
    pub fn primary_account(&self, capability: &str) -> Option<&str> {
        if !self.has(capability) {
            return None;
        }
        self.primary_accounts.get(capability).map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{CORE, MAIL, SUBMISSION};

    #[test]
    fn primary_accounts_need_the_capability() {
        let session: Session = serde_json::from_value(json!({
            "capabilities": { CORE: {}, MAIL: {} },
            "accounts": { "a": {} },
            "primaryAccounts": { MAIL: "a", SUBMISSION: "a" },
            "username": "noreply@example.com",
            "apiUrl": "https://mail.example.com/jmap/",
            "state": "1",
        }))
        .unwrap();
        assert!(session.has(CORE));
        assert_eq!(session.primary_account(MAIL), Some("a"));
        // Without the capability the account does not count.
        assert_eq!(session.primary_account(SUBMISSION), None);
    }

    #[test]
    fn anonymous_session_has_no_accounts() {
        let session: Session = serde_json::from_value(json!({
            "capabilities": { CORE: {} },
            "apiUrl": "/jmap/",
        }))
        .unwrap();
        assert_eq!(session.primary_account(CORE), None);
        assert_eq!(session.username, "");
    }
}
