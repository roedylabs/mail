//! Connection to the mail servers: diagnosis
//! ([`probe`]), registration of the OAuth client ([`dcr`]), encryption
//! of secrets ([`crypto`]), checking mail accounts via their JMAP session
//! ([`account`]), protection against requests to internal networks
//! ([`outbound`]), requests to the token endpoint ([`oauth`]) and the token broker
//! ([`token`]).

pub mod account;
pub mod crypto;
pub mod dcr;
pub mod oauth;
pub mod outbound;
pub mod probe;
pub mod token;

use std::time::Duration;

use anyhow::Context as _;
// As in the JMAP client: credentials only to the same origin.
use roedy_jmap::same_origin;
use serde::{Deserialize, de::DeserializeOwned};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TIMEOUT: Duration = Duration::from_secs(10);

/// HTTP client for requests to mail servers. Follows no redirects –
/// where they are allowed, the caller follows them itself so that credentials
/// never go to another address.
pub fn http_client() -> anyhow::Result<reqwest::Client> {
    client_builder().build().context("HTTP client not created")
}

fn client_builder() -> reqwest::ClientBuilder {
    // With `rustls-no-provider` reqwest brings no cryptography; ring
    // applies to the whole process. If a provider is already set, it stays.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .user_agent(concat!("Roedy-Mail/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
}

/// Reads at most 256 KiB as JSON ([`roedy_jmap::read_json`]); diagnosis
/// and DCR do not need the reason.
async fn read_json<T: DeserializeOwned>(response: reqwest::Response) -> Option<T> {
    roedy_jmap::read_json(response).await.ok()
}

#[derive(Deserialize)]
struct ErrorResponse {
    error: String,
}

/// Error code of an OAuth response (`{"error": …}`, RFC 6749 and RFC 7591);
/// only what looks like a code, so that nothing arbitrary gets into the log.
async fn oauth_error(response: reqwest::Response) -> Option<String> {
    read_json::<ErrorResponse>(response)
        .await
        .map(|e| e.error)
        .filter(|code| {
            !code.is_empty()
                && code.len() <= 64
                && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
        })
}
