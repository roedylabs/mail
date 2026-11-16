//! Passwords: Argon2id with m = 19 MiB, t = 2, p = 1,
//! at most two hashes at a time, and the password policy of the web app.

use std::{sync::Arc, time::Duration};

use anyhow::{Context as _, anyhow};
/// Argon2 cost; can be lowered for tests with [`Hasher::with_params`].
pub use argon2::Params;
use argon2::{
    Argon2,
    password_hash::{Error as HashError, PasswordHasher as _, PasswordVerifier as _, phc},
};
use tokio::sync::{OnceCell, Semaphore};

use crate::random;

/// Concurrent hashes; each takes 19 MiB.
const MAX_CONCURRENT: usize = 2;
/// How long a request waits for a free slot, then [`Busy`].
const QUEUE_TIMEOUT: Duration = Duration::from_secs(10);

/// All slots are taken; the API answers with 503 `busy`.
#[derive(Debug)]
pub struct Busy;

impl std::fmt::Display for Busy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("too many concurrent password checks")
    }
}

impl std::error::Error for Busy {}

/// Rules of the password policy; the keys are the same IDs the web app uses
/// and appear as such in error responses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rule {
    /// At least 10 characters.
    Len,
    /// Upper and lower case letters.
    Case,
    /// Digit or special character.
    Num,
}

impl Rule {
    pub fn id(self) -> &'static str {
        match self {
            Self::Len => "len",
            Self::Case => "case",
            Self::Num => "num",
        }
    }
}

/// Violated rules in the order the web app lists them; empty = password allowed.
/// Counts and compares exactly like the check in the browser: length in UTF-16
/// units (`String.length`), upper- and lowercase letters by the Unicode
/// `Uppercase`/`Lowercase` properties (`\p{Uppercase}`/`\p{Lowercase}` in JavaScript).
pub fn violations(password: &str) -> Vec<Rule> {
    let is_lower = char::is_lowercase;
    let is_upper = char::is_uppercase;
    let mut rules = Vec::new();
    if password.encode_utf16().count() < 10 {
        rules.push(Rule::Len);
    }
    if !(password.chars().any(is_lower) && password.chars().any(is_upper)) {
        rules.push(Rule::Case);
    }
    if !password.chars().any(|c| !is_lower(c) && !is_upper(c)) {
        rules.push(Rule::Num);
    }
    rules
}

/// Hashes and verifies passwords outside the async workers; the semaphore
/// limits memory and CPU when many sign-ins arrive at once.
pub struct Hasher {
    params: Params,
    permits: Arc<Semaphore>,
    /// Hash of a random password for unknown users, so that the response
    /// does not reveal whether the account exists.
    dummy: OnceCell<String>,
}

impl Default for Hasher {
    fn default() -> Self {
        Self::with_params(Params::DEFAULT)
    }
}

impl Hasher {
    /// For tests with lower cost; the server uses [`Hasher::default`].
    pub fn with_params(params: Params) -> Self {
        Self {
            params,
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT)),
            dummy: OnceCell::new(),
        }
    }

    /// PHC string (`$argon2id$v=19$m=19456,t=2,p=1$…`) with a random salt.
    pub async fn hash(&self, password: &str) -> anyhow::Result<String> {
        let password = password.to_owned();
        let argon = Argon2::from(self.params.clone());
        self.run(move || {
            argon
                .hash_password(password.as_bytes())
                .map(|hash| hash.to_string())
                .map_err(|e| anyhow!("password not hashable: {e}"))
        })
        .await
    }

    /// Checks `password` against `hash`. Without a hash (unknown user) it
    /// checks against a placeholder and returns `false` – as expensive
    /// as a wrong password.
    pub async fn verify(&self, password: &str, hash: Option<&str>) -> anyhow::Result<bool> {
        let (hash, known) = match hash {
            Some(hash) => (hash.to_owned(), true),
            None => (self.dummy_hash().await?.clone(), false),
        };
        let password = password.to_owned();
        let matches = self
            .run(move || {
                match Argon2::default().verify_password(password.as_bytes(), hash.as_str()) {
                    Ok(()) => Ok(true),
                    Err(HashError::PasswordInvalid) => Ok(false),
                    Err(e) => Err(anyhow!("invalid password hash: {e}")),
                }
            })
            .await?;
        Ok(matches && known)
    }

    /// Whether `hash` was created with other parameters; then rehash after a
    /// successful sign-in.
    pub fn is_outdated(&self, hash: &str) -> bool {
        let Ok(parsed) = phc::PasswordHash::new(hash) else {
            return true;
        };
        let current = (
            self.params.m_cost(),
            self.params.t_cost(),
            self.params.p_cost(),
        );
        parsed.algorithm.as_str() != "argon2id"
            || !Params::try_from(&parsed)
                .is_ok_and(|p| (p.m_cost(), p.t_cost(), p.p_cost()) == current)
    }

    /// Creates the placeholder hash in advance (at start) so that even the first
    /// check of an unknown user does not take longer than that of a
    /// known one.
    pub async fn prepare(&self) -> anyhow::Result<()> {
        self.dummy_hash().await.map(|_| ())
    }

    async fn dummy_hash(&self) -> anyhow::Result<&String> {
        self.dummy
            .get_or_try_init(|| async {
                let random = random::bytes::<16>()?;
                self.hash(&format!("{random:02x?}")).await
            })
            .await
    }

    async fn run<T: Send + 'static>(
        &self,
        f: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
    ) -> anyhow::Result<T> {
        let permit = tokio::time::timeout(QUEUE_TIMEOUT, self.permits.clone().acquire_owned())
            .await
            .map_err(|_| Busy)?
            .context("semaphore closed")?;
        // The permit belongs to the hash task: if the request is cancelled,
        // `spawn_blocking` keeps computing – and holds the slot until the end.
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            f()
        })
        .await
        .context("hash task aborted")?
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Low cost so that tests stay fast.
    pub(crate) fn fast() -> Hasher {
        Hasher::with_params(Params::new(64, 1, 1, None).unwrap())
    }

    #[test]
    fn policy_matches_web_app_rules() {
        assert_eq!(violations("Summer2026!"), []);
        assert_eq!(violations("Öxa-Üby-Äzü-ß"), []);
        // Spaces and other non-letters count as special characters.
        assert_eq!(violations("Long weekend"), []);
        // Letters of any script count by their Unicode case, like in the browser.
        assert_eq!(violations("Élégantété"), [Rule::Num]);
        assert_eq!(violations("Привет мир"), []);
        assert_eq!(violations("Élégant Days"), []);
        assert_eq!(violations("Short1!"), [Rule::Len]);
        assert_eq!(violations("summer2026!"), [Rule::Case]);
        assert_eq!(violations("SUMMERTIME2026"), [Rule::Case]);
        assert_eq!(violations("Summertimes"), [Rule::Num]);
        assert_eq!(violations("ÄÖÜäöüßabc"), [Rule::Num]);
        assert_eq!(violations(""), [Rule::Len, Rule::Case, Rule::Num]);
        // Length like String.length: an emoji counts twice.
        assert_eq!(violations("Ab😀😀😀😀"), []);
        assert_eq!(violations("Ab😀😀😀"), [Rule::Len]);
        let ids: Vec<_> = [Rule::Len, Rule::Case, Rule::Num].map(Rule::id).into();
        assert_eq!(ids, ["len", "case", "num"]);
    }

    #[tokio::test]
    async fn default_uses_plan_parameters() {
        let hasher = Hasher::default();
        let hash = hasher.hash("Summer2026!").await.unwrap();
        assert!(
            hash.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"),
            "{hash}"
        );
        assert!(hasher.verify("Summer2026!", Some(&hash)).await.unwrap());
        assert!(!hasher.is_outdated(&hash));
        assert!(fast().is_outdated(&hash));
    }

    #[tokio::test]
    async fn verifies_and_rejects() {
        let hasher = fast();
        let hash = hasher.hash("Summer2026!").await.unwrap();
        let other = hasher.hash("Summer2026!").await.unwrap();
        assert_ne!(hash, other, "salt must be random");
        assert!(hasher.verify("Summer2026!", Some(&hash)).await.unwrap());
        assert!(!hasher.verify("summer2026!", Some(&hash)).await.unwrap());
        assert!(!hasher.verify("Summer2026!", None).await.unwrap());
        assert!(hasher.verify("x", Some("not-a-hash")).await.is_err());
        assert!(hasher.is_outdated("not-a-hash"));
    }

    #[tokio::test]
    async fn waits_for_free_permit() {
        let hasher = Arc::new(fast());
        let held = hasher.permits.clone().acquire_many_owned(2).await.unwrap();
        let task = tokio::spawn({
            let hasher = hasher.clone();
            async move { hasher.hash("Summer2026!").await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!task.is_finished(), "must not hash without a free slot");
        drop(held);
        assert!(task.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn cancelled_request_keeps_permit_until_hash_is_done() {
        // Expensive enough that the hash is still running after the cancel.
        let hasher = Arc::new(Hasher::with_params(
            Params::new(64 * 1024, 3, 1, None).unwrap(),
        ));
        let task = tokio::spawn({
            let hasher = hasher.clone();
            async move { hasher.hash("Summer2026!").await }
        });
        while hasher.permits.available_permits() == MAX_CONCURRENT {
            tokio::task::yield_now().await;
        }
        task.abort();
        let _ = task.await;
        assert_eq!(
            hasher.permits.available_permits(),
            MAX_CONCURRENT - 1,
            "running hash must keep its slot"
        );
        let _all = hasher.permits.clone().acquire_many_owned(2).await.unwrap();
    }

    #[tokio::test]
    async fn prepare_creates_dummy_once() {
        let hasher = fast();
        hasher.prepare().await.unwrap();
        let first = hasher.dummy.get().cloned().unwrap();
        hasher.prepare().await.unwrap();
        assert_eq!(hasher.dummy.get(), Some(&first));
    }

    #[tokio::test(start_paused = true)]
    async fn busy_after_queue_timeout() {
        let hasher = fast();
        let _held = hasher.permits.clone().acquire_many_owned(2).await.unwrap();
        let err = hasher.hash("Summer2026!").await.unwrap_err();
        assert!(err.is::<Busy>(), "{err:#}");
    }
}
