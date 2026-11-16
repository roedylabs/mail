//! Which mail account a token belongs to: the
//! token's JMAP session names the signed-in account – not the
//! address entered, because on the mail server's sign-in page another
//! account can be chosen. With it the API checks duplicates (`dup`) and, on
//! signing in again, that it is the same account.

use roedy_jmap::{Auth, Client, Error, Session, Storage};
use url::Url;

use super::same_origin;
use crate::auth::email;

const MAIL: &str = "urn:ietf:params:jmap:mail";

/// The signed-in account according to the session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    /// Primary account for mail (`primaryAccounts`).
    pub account_id: String,
    /// `username` of the session.
    pub username: String,
    /// Address of the account, lower case.
    pub email: String,
    /// The session as the server returned it.
    pub session: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckError {
    /// Request to the server failed or session unusable.
    Jmap(Error),
    /// No mail account in the session.
    NoMail,
    /// `downloadUrl`, `uploadUrl` or `eventSourceUrl` is missing or lies on
    /// another origin; the app's CSP would not let the browser go
    /// there.
    SessionUrl,
    /// Neither `username` nor the identities name an address.
    NoAddress,
}

impl CheckError {
    /// Stable key for log and API.
    pub fn reason(&self) -> &'static str {
        match self {
            Self::Jmap(error) => error.reason(),
            Self::NoMail => "no_mail",
            Self::SessionUrl => "session_url_mismatch",
            Self::NoAddress => "no_address",
        }
    }

    /// The server rejected the token (401 or 403).
    pub fn is_rejected(&self) -> bool {
        matches!(self, Self::Jmap(Error::AuthFailed | Error::Forbidden))
    }
}

/// Fetches the session with `token` (Bearer) and reads the account from it.
/// `hint` is the address entered: it applies if the account has it
/// and `username` is not an address.
pub async fn check(
    http: &reqwest::Client,
    base_url: &Url,
    token: &str,
    hint: &str,
) -> Result<Account, CheckError> {
    let client = Client::connect(http, base_url, Auth::Bearer(token.to_owned()))
        .await
        .map_err(CheckError::Jmap)?;
    let session = client.session();
    let account_id = session
        .primary_account(MAIL)
        .filter(|id| !id.is_empty())
        .ok_or(CheckError::NoMail)?
        .to_owned();
    if !urls_on_origin(session, base_url) {
        return Err(CheckError::SessionUrl);
    }
    let username = session.username.clone();
    let email = address(&client, hint).await?;
    Ok(Account {
        account_id,
        username,
        email,
        session: client.into_session_json(),
    })
}

/// Storage of a connected account with the access token: session and
/// `Quota/get` ("Check connection" and the job `quota_check`).
pub async fn storage(
    http: &reqwest::Client,
    base_url: &Url,
    access_token: String,
) -> Result<Option<Storage>, Error> {
    Client::connect(http, base_url, Auth::Bearer(access_token))
        .await?
        .storage()
        .await
}

/// The session's URLs (the client already checks `apiUrl`) lie on
/// the server's origin.
fn urls_on_origin(session: &Session, base_url: &Url) -> bool {
    [
        &session.download_url,
        &session.upload_url,
        &session.event_source_url,
    ]
    .into_iter()
    .all(|url| {
        url.as_deref()
            .is_some_and(|url| !url.is_empty() && same_origin(base_url, url).is_some())
    })
}

/// `username` if it is an address (usually with Stalwart); otherwise the
/// one entered if an identity of the account has it, otherwise the first
/// identity with an address.
async fn address(client: &Client, hint: &str) -> Result<String, CheckError> {
    let username = client.session().username.trim();
    if email::is_valid(username) {
        return Ok(username.to_lowercase());
    }
    // Without sending (no identities) only `no_address` remains; other
    // errors (network, 401, 429) count as for the session.
    let identities = match client.identities().await {
        Ok(identities) => identities,
        Err(Error::Unsupported(_)) => Vec::new(),
        Err(error) => return Err(CheckError::Jmap(error)),
    };
    let hint = hint.trim().to_lowercase();
    let mut addresses = identities
        .into_iter()
        .filter(|identity| !identity.is_wildcard())
        .map(|identity| identity.email.trim().to_lowercase())
        .filter(|address| email::is_valid(address));
    let first = addresses.next().ok_or(CheckError::NoAddress)?;
    if first == hint || addresses.any(|address| address == hint) {
        Ok(hint)
    } else {
        Ok(first)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn session(download: &str) -> Session {
        serde_json::from_value(json!({
            "capabilities": {},
            "apiUrl": "/jmap/",
            "downloadUrl": download,
            "uploadUrl": "https://mail.example.com/jmap/upload/{accountId}/",
            "eventSourceUrl": "/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}",
        }))
        .unwrap()
    }

    #[test]
    fn session_urls_stay_on_the_origin() {
        let base = Url::parse("https://mail.example.com").unwrap();
        let good = "/jmap/download/{accountId}/{blobId}/{name}?accept={type}";
        assert!(urls_on_origin(&session(good), &base));
        assert!(!urls_on_origin(
            &session("https://cdn.example.com/{blobId}"),
            &base
        ));
        assert!(!urls_on_origin(&session(""), &base));
        let mut missing = session(good);
        missing.event_source_url = None;
        assert!(!urls_on_origin(&missing, &base));
    }
}
