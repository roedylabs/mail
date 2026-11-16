//! Intermediate sign-in step: after the correct password
//! of an account with multi-factor there is no session yet, only a
//! short-lived intermediate state in memory. The browser keeps its
//! token in the cookie `__Host-roedy_mfa`; `auth/totp` and `auth/recovery`
//! complete the sign-in with it.
//!
//! To check a code, the intermediate step is taken out
//! ([`Challenges::claim`]): a concurrent request then does not find it
//! and cannot use up a second code. If the check ends without
//! sign-in (wrong code, rate limit), [`Claim`] puts it back when
//! dropped.
//!
//! After a restart the intermediate states are gone – the password then
//! has to be entered again.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

use axum::http::{HeaderMap, HeaderValue};

use super::session::{self, Token};

/// Cookie with the token of the intermediate step.
pub const COOKIE: &str = "__Host-roedy_mfa";
/// How long an intermediate step is valid.
pub const TTL: Duration = Duration::from_secs(5 * 60);

/// What is settled after the password.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Challenge {
    pub user_id: String,
    /// "Stay signed in" from the first step.
    pub remember: bool,
    /// If the password changes in the meantime, the intermediate step is invalid.
    pub password_changed_at: String,
}

#[derive(Default)]
struct Entries {
    open: HashMap<[u8; 32], (Challenge, Instant)>,
    /// Discard counter; [`Claim`] remembers its value when
    /// taken out. It is only read and incremented under the lock, so
    /// the order does not depend on clocks of different threads.
    discards: u64,
    /// Users whose intermediate steps were discarded: counter value
    /// and time (for cleanup). An intermediate step that is being checked
    /// does not come back afterwards.
    discarded: HashMap<String, (u64, Instant)>,
}

#[derive(Default)]
pub struct Challenges {
    inner: Mutex<Entries>,
}

impl Challenges {
    /// Creates an intermediate step; the result is the `Set-Cookie`.
    pub fn start(&self, challenge: Challenge) -> anyhow::Result<HeaderValue> {
        self.start_at(challenge, Instant::now())
    }

    fn start_at(&self, challenge: Challenge, now: Instant) -> anyhow::Result<HeaderValue> {
        let token = Token::generate()?;
        let mut inner = self.lock();
        inner.open.retain(|_, (_, expires)| *expires > now);
        inner.open.insert(token.hash(), (challenge, now + TTL));
        Ok(token.cookie_named(COOKIE, Some(TTL)))
    }

    /// Takes out the valid intermediate step for the request's cookie.
    pub fn claim(self: &Arc<Self>, headers: &HeaderMap) -> Option<Claim> {
        self.claim_at(headers, Instant::now())
    }

    fn claim_at(self: &Arc<Self>, headers: &HeaderMap, now: Instant) -> Option<Claim> {
        let hash = token_hash(headers)?;
        let mut inner = self.lock();
        let (challenge, expires) = inner
            .open
            .remove(&hash)
            .filter(|(_, expires)| *expires > now)?;
        let discards = inner.discards;
        drop(inner);
        Some(Claim {
            store: self.clone(),
            hash,
            entry: Some((challenge, expires)),
            discards,
        })
    }

    /// Discards all intermediate steps of the user (multi-factor
    /// reset, locked, removed): otherwise one would be valid again as soon as
    /// the person confirms a new app within the five minutes.
    pub fn discard_user(&self, user_id: &str) {
        self.discard_user_at(user_id, Instant::now());
    }

    fn discard_user_at(&self, user_id: &str, now: Instant) {
        let mut inner = self.lock();
        inner
            .open
            .retain(|_, (challenge, _)| challenge.user_id != user_id);
        // The note need not be older than an intermediate step:
        // whatever came back after that has expired anyway.
        inner.discarded.retain(|_, (_, at)| *at + TTL > now);
        inner.discards += 1;
        let discards = inner.discards;
        inner.discarded.insert(user_id.to_owned(), (discards, now));
    }

    fn lock(&self) -> MutexGuard<'_, Entries> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// An intermediate step that was taken out. Without [`Claim::consume`] it
/// comes back with its previous expiry when dropped.
pub struct Claim {
    store: Arc<Challenges>,
    hash: [u8; 32],
    entry: Option<(Challenge, Instant)>,
    /// Value of [`Entries::discards`] when taken out.
    discards: u64,
}

impl Claim {
    pub fn challenge(&self) -> &Challenge {
        &self.entry.as_ref().expect("present until consume").0
    }

    /// Ends the intermediate step (signed in or no longer valid).
    pub fn consume(mut self) -> Challenge {
        self.entry.take().expect("present until consume").0
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        if let Some(entry) = self.entry.take() {
            let mut inner = self.store.lock();
            let discarded = inner
                .discarded
                .get(&entry.0.user_id)
                .is_some_and(|(n, _)| *n > self.discards);
            if !discarded {
                inner.open.insert(self.hash, entry);
            }
        }
    }
}

fn token_hash(headers: &HeaderMap) -> Option<[u8; 32]> {
    session::named_cookie(headers, COOKIE)
        .and_then(Token::parse)
        .map(|token| token.hash())
}

/// `Set-Cookie` that deletes the intermediate step in the browser.
pub fn clear_cookie() -> HeaderValue {
    session::clear_named_cookie(COOKIE)
}

#[cfg(test)]
mod tests {
    use axum::http::header;

    use super::*;

    fn challenge() -> Challenge {
        Challenge {
            user_id: "u1".into(),
            remember: false,
            password_changed_at: "2026-10-24T10:00:00.000Z".into(),
        }
    }

    /// Request headers with the cookie from `Set-Cookie`.
    fn request_with(set_cookie: &HeaderValue) -> HeaderMap {
        let pair = set_cookie.to_str().unwrap().split(';').next().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_str(pair).unwrap());
        headers
    }

    #[test]
    fn cookie_has_host_prefix_and_short_lifetime() {
        let store = Challenges::default();
        let cookie = store.start(challenge()).unwrap();
        let text = cookie.to_str().unwrap();
        assert!(text.starts_with("__Host-roedy_mfa="), "{text}");
        assert!(text.ends_with("; Max-Age=300; Path=/; HttpOnly; Secure; SameSite=Lax"));
        assert_eq!(
            clear_cookie().to_str().unwrap(),
            "__Host-roedy_mfa=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax"
        );
    }

    #[test]
    fn claims_once_and_returns_unless_consumed() {
        let store = Arc::new(Challenges::default());
        let headers = request_with(&store.start(challenge()).unwrap());
        let claim = store.claim(&headers).unwrap();
        assert_eq!(claim.challenge(), &challenge());
        // During the check a second request finds nothing.
        assert!(store.claim(&headers).is_none());
        drop(claim);
        // Put back (wrong code): available again.
        let claim = store.claim(&headers).unwrap();
        assert_eq!(claim.consume(), challenge());
        assert!(store.claim(&headers).is_none());
        assert!(store.claim(&HeaderMap::new()).is_none());
    }

    #[test]
    fn expires_after_ttl() {
        let store = Arc::new(Challenges::default());
        let start = Instant::now();
        let headers = request_with(&store.start_at(challenge(), start).unwrap());
        drop(store.claim_at(&headers, start + TTL / 2).unwrap());
        assert!(store.claim_at(&headers, start + TTL).is_none());
        // Expired ones disappear on the next insert.
        let other = request_with(&store.start_at(challenge(), start).unwrap());
        store.start_at(challenge(), start + TTL).unwrap();
        assert!(store.claim_at(&other, start + TTL / 2).is_none());
        assert_eq!(store.lock().open.len(), 1);
    }

    #[test]
    fn discarding_a_user_also_covers_a_running_check() {
        let store = Arc::new(Challenges::default());
        let start = Instant::now();
        let first = request_with(&store.start_at(challenge(), start).unwrap());
        let second = request_with(&store.start_at(challenge(), start).unwrap());
        let other = Challenge {
            user_id: "u2".into(),
            ..challenge()
        };
        let third = request_with(&store.start_at(other, start).unwrap());
        // The first one is being checked when the app is reset.
        let running = store.claim_at(&first, start).unwrap();
        store.discard_user_at("u1", start);
        drop(running);
        assert!(store.claim_at(&first, start).is_none());
        assert!(store.claim_at(&second, start).is_none());
        assert!(store.claim_at(&third, start).is_some(), "others stay");
        // A later intermediate step of the same person is valid again.
        let later = start + Duration::from_secs(1);
        let fresh = request_with(&store.start_at(challenge(), later).unwrap());
        drop(store.claim_at(&fresh, later).unwrap());
        assert!(store.claim_at(&fresh, later).is_some());
    }
}
