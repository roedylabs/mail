//! VAPID (RFC 8292): the backend identifies itself to the push services with a
//! key pair of the instance (ECDSA P-256, ES256). The browser passes the public
//! key when subscribing (`applicationServerKey`); push services then only
//! accept messages with tokens of this key.
//!
//! Generated on first use, stored as PKCS#8 in `app_settings.vapid`, encrypted
//! with the instance key (purpose [`PURPOSE`]). That way it sits
//! in the same backup as the subscriptions; without `secret.key` it is, like
//! all secrets, unreadable and is never replaced (otherwise no subscription
//! would be valid any more).

use std::fmt;

use anyhow::{Context as _, anyhow};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use jiff::{SignedDuration, Timestamp};
use ring::{
    rand::SystemRandom,
    signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair as _},
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::json;
use url::Url;

use crate::{broker::crypto::SecretKey, db::repo::app_settings};

/// Purpose in the AAD.
pub const PURPOSE: &str = "app_settings.vapid";
/// Lifetime of a token; RFC 8292 › 2 allows at most 24 hours.
const TOKEN_LIFETIME: SignedDuration = SignedDuration::from_hours(12);
/// Header of the JWT: `{"typ":"JWT","alg":"ES256"}`.
const JWT_HEADER: &str = "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9";

#[derive(Debug, Serialize, Deserialize)]
struct Stored {
    /// PKCS#8, encrypted, Base64.
    key: String,
}

/// Key pair of the instance. `Debug` only shows the public key.
pub struct Vapid {
    key: EcdsaKeyPair,
    public: String,
}

impl fmt::Debug for Vapid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Vapid")
            .field("public", &self.public)
            .finish_non_exhaustive()
    }
}

impl Vapid {
    /// New key pair and its PKCS#8 for storage.
    pub fn generate() -> anyhow::Result<(Self, Vec<u8>)> {
        let pkcs8 =
            EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new())
                .map_err(|_| anyhow!("VAPID key not generated"))?;
        let pkcs8 = pkcs8.as_ref().to_vec();
        Ok((Self::from_pkcs8(&pkcs8)?, pkcs8))
    }

    pub fn from_pkcs8(pkcs8: &[u8]) -> anyhow::Result<Self> {
        let key = EcdsaKeyPair::from_pkcs8(
            &ECDSA_P256_SHA256_FIXED_SIGNING,
            pkcs8,
            &SystemRandom::new(),
        )
        .map_err(|e| anyhow!("VAPID key invalid: {e}"))?;
        let public = URL_SAFE_NO_PAD.encode(key.public_key().as_ref());
        Ok(Self { key, public })
    }

    /// Reads the key from `app_settings.vapid` or creates it.
    pub fn load_or_create(conn: &Connection, secrets: &SecretKey) -> anyhow::Result<Self> {
        if let Some(stored) = app_settings::get::<Stored>(conn, app_settings::VAPID)? {
            let sealed = STANDARD
                .decode(stored.key)
                .context("app_settings.vapid is not Base64")?;
            let pkcs8 = secrets
                .open(PURPOSE, app_settings::VAPID, &sealed)
                .context("VAPID key for web push not decrypted")?;
            return Self::from_pkcs8(&pkcs8);
        }
        let (vapid, pkcs8) = Self::generate()?;
        let stored = Stored {
            key: STANDARD.encode(secrets.seal(PURPOSE, app_settings::VAPID, &pkcs8)?),
        };
        // Never replace an existing one, not even one a second process has
        // just created.
        if !app_settings::insert_if_absent(conn, app_settings::VAPID, &stored)? {
            return Self::load_or_create(conn, secrets);
        }
        tracing::info!("VAPID key for web push generated");
        Ok(vapid)
    }

    /// Public key (uncompressed, Base64url without padding) for
    /// `pushManager.subscribe({ applicationServerKey })`.
    pub fn public_key(&self) -> &str {
        &self.public
    }

    /// Value of the `Authorization` header for a message to `endpoint`
    /// (RFC 8292 › 3): token for the origin of the push service, valid until
    /// `now` + 12 hours, with `subject` as contact (`sub`), if known.
    pub fn authorization(
        &self,
        endpoint: &Url,
        subject: Option<&str>,
        now: Timestamp,
    ) -> anyhow::Result<String> {
        let exp = now.checked_add(TOKEN_LIFETIME)?.as_second();
        let mut claims = json!({ "aud": endpoint.origin().ascii_serialization(), "exp": exp });
        if let Some(subject) = subject {
            claims["sub"] = subject.into();
        }
        let input = format!(
            "{JWT_HEADER}.{}",
            URL_SAFE_NO_PAD.encode(claims.to_string())
        );
        let signature = self
            .key
            .sign(&SystemRandom::new(), input.as_bytes())
            .map_err(|_| anyhow!("VAPID token not signed"))?;
        Ok(format!(
            "vapid t={input}.{}, k={}",
            URL_SAFE_NO_PAD.encode(signature.as_ref()),
            self.public
        ))
    }
}

#[cfg(test)]
mod tests {
    use ring::signature::{ECDSA_P256_SHA256_FIXED, UnparsedPublicKey};
    use serde_json::Value;

    use super::*;
    use crate::db::repo::users::tests::conn;

    #[test]
    fn header_is_es256() {
        assert_eq!(
            URL_SAFE_NO_PAD.decode(JWT_HEADER).unwrap(),
            br#"{"typ":"JWT","alg":"ES256"}"#
        );
    }

    #[test]
    fn token_is_signed_for_the_origin_of_the_endpoint() {
        let (vapid, _) = Vapid::generate().unwrap();
        let endpoint = Url::parse("https://push.example.com:8443/wpush/v2/abc?x=1").unwrap();
        let now: Timestamp = "2026-11-04T12:00:00Z".parse().unwrap();
        let header = vapid
            .authorization(&endpoint, Some("https://app.example.com"), now)
            .unwrap();
        let (token, key) = header
            .strip_prefix("vapid t=")
            .unwrap()
            .split_once(", k=")
            .unwrap();
        assert_eq!(key, vapid.public_key());
        let public = URL_SAFE_NO_PAD.decode(key).unwrap();
        assert_eq!((public.len(), public[0]), (65, 4));
        let (input, signature) = token.rsplit_once('.').unwrap();
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &public)
            .verify(
                input.as_bytes(),
                &URL_SAFE_NO_PAD.decode(signature).unwrap(),
            )
            .unwrap();
        let claims: Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(input.split_once('.').unwrap().1)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            claims,
            json!({
                "aud": "https://push.example.com:8443",
                "exp": now.as_second() + 12 * 3600,
                "sub": "https://app.example.com",
            })
        );
        let without = vapid.authorization(&endpoint, None, now).unwrap();
        let token = without.strip_prefix("vapid t=").unwrap();
        let claims = token.split('.').nth(1).unwrap();
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(claims).unwrap()).unwrap();
        assert!(claims.get("sub").is_none());
    }

    #[test]
    fn stored_encrypted_and_kept() {
        let conn = conn();
        let secrets = SecretKey::random().unwrap();
        let first = Vapid::load_or_create(&conn, &secrets).unwrap();
        let again = Vapid::load_or_create(&conn, &secrets).unwrap();
        assert_eq!(first.public_key(), again.public_key());
        let stored: Stored = app_settings::get(&conn, app_settings::VAPID)
            .unwrap()
            .unwrap();
        let sealed = STANDARD.decode(&stored.key).unwrap();
        assert!(Vapid::from_pkcs8(&sealed).is_err());
        // With a different instance key: error, no new key.
        let other = SecretKey::random().unwrap();
        assert!(Vapid::load_or_create(&conn, &other).is_err());
        let unchanged: Stored = app_settings::get(&conn, app_settings::VAPID)
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.key, stored.key);
        assert!(!format!("{first:?}").contains(&stored.key));
    }
}
