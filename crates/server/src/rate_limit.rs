//! In-memory rate limits.
//!
//! Counting happens per rule ([`Policy`]) and key: an IP address (IPv6 per
//! /64, see [`crate::client_ip::ClientIp::network`]), a user or one counter
//! for everyone. Two kinds of rules:
//!
//! - [`Policy::rate`]: `burst` events at once, then one per
//!   `period / burst` (GCRA, "Generic Cell Rate Algorithm") – for requests
//!   like "resend mail".
//! - [`Policy::lockout`]: after `failures` failed attempts within `window`
//!   (from the first one) a lock of `lock`, then the full allowance again –
//!   for checks like "5 failed attempts → 30 s lock" (setup token).
//!
//! [`RateLimiter::acquire`] reserves an attempt before the check – even with
//! many concurrent requests, never more get through than the rule allows. If
//! the result does not count (success, or an already used TOTP code that
//! gives nothing away), [`RateLimiter::refund`] returns the attempt. The
//! counters are lost on a restart; with one process per instance that is
//! acceptable.

use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

/// After this many calls, expired counters are removed.
const SWEEP_EVERY: u32 = 1024;

/// A rule; the name separates the counters of different rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    pub name: &'static str,
    pub limit: Limit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Limit {
    Rate {
        burst: u32,
        period: Duration,
    },
    Lockout {
        failures: u32,
        window: Duration,
        lock: Duration,
    },
}

impl Policy {
    /// `burst` events at once, all of them again after `period`.
    pub const fn rate(name: &'static str, burst: u32, period: Duration) -> Self {
        Self {
            name,
            limit: Limit::Rate { burst, period },
        }
    }

    /// Locked for `lock` after `failures` attempts within `window`.
    pub const fn lockout(
        name: &'static str,
        failures: u32,
        window: Duration,
        lock: Duration,
    ) -> Self {
        Self {
            name,
            limit: Limit::Lockout {
                failures,
                window,
                lock,
            },
        }
    }
}

/// What is counted.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Key {
    Ip(IpAddr),
    User(String),
    /// A mail server (origin), e.g. to protect against its Fail2Ban.
    Server(String),
    /// One counter for everyone (e.g. setup token).
    Global,
}

/// Limit reached; another attempt is allowed after `retry_after`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limited {
    pub retry_after: Duration,
}

#[derive(Debug, Clone, Copy)]
enum State {
    /// Theoretical time of the next event (GCRA).
    Rate { next: Instant },
    /// Attempts in the window until `window_end`; locked until `locked_until`.
    /// The window is kept alongside the lock, so that a refunded attempt that
    /// had caused the lock does not extend it.
    Lockout {
        count: u32,
        window_end: Instant,
        locked_until: Option<Instant>,
    },
}

impl State {
    /// From when the state equals a missing one (after a lock the full
    /// allowance applies again).
    fn expires(self) -> Instant {
        match self {
            Self::Rate { next } => next,
            Self::Lockout {
                window_end,
                locked_until,
                ..
            } => locked_until.unwrap_or(window_end),
        }
    }
}

/// GCRA: next event (not before `now`), leeway and interval. An event is
/// allowed as long as `next` does not exceed the leeway.
fn gcra(
    burst: u32,
    period: Duration,
    next: Option<Instant>,
    now: Instant,
) -> (Instant, Instant, Duration) {
    let interval = period / burst.max(1);
    let next = next.map_or(now, |next| next.max(now));
    // Leeway: this far the counter may run ahead of the present.
    (next, now + period.saturating_sub(interval), interval)
}

#[derive(Default)]
pub struct RateLimiter {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    states: HashMap<(&'static str, Key), State>,
    calls: u32,
}

impl RateLimiter {
    /// Reserves an attempt if the rule allows it.
    pub fn acquire(&self, policy: &Policy, key: Key) -> Result<(), Limited> {
        self.acquire_at(policy, key, Instant::now())
    }

    /// Returns a reserved attempt that does not count.
    pub fn refund(&self, policy: &Policy, key: &Key) {
        self.refund_at(policy, key, Instant::now());
    }

    /// Like [`Self::acquire`], but for checks that take longer (such as a
    /// request to a mail server): the [`Reservation`] returns the attempt if
    /// it ends without [`Reservation::count`] – even if the request is
    /// aborted before.
    pub fn reserve<'a>(&'a self, policy: &'a Policy, key: Key) -> Result<Reservation<'a>, Limited> {
        self.acquire(policy, key.clone())?;
        Ok(Reservation {
            limiter: self,
            policy,
            key: Some(key),
        })
    }

    /// Counts an event that has already happened, even beyond the limit – for
    /// limits that only check with [`Self::remaining`] beforehand instead of
    /// reserving (correct passwords). With [`Policy::rate`] the next
    /// allowed time moves on by one interval, so a burst beyond the limit
    /// locks the following events correspondingly longer; with
    /// [`Policy::lockout`] like [`Self::acquire`], a lock stays.
    pub fn charge(&self, policy: &Policy, key: Key) {
        self.charge_at(policy, key, Instant::now());
    }

    fn charge_at(&self, policy: &Policy, key: Key, now: Instant) {
        let Limit::Rate { burst, period } = policy.limit else {
            let _locked = self.acquire_at(policy, key, now);
            return;
        };
        let mut inner = self.lock();
        let slot = (policy.name, key);
        let next = match inner.states.get(&slot).filter(|s| s.expires() > now) {
            Some(&State::Rate { next }) => Some(next),
            _ => None,
        };
        let (next, _, interval) = gcra(burst, period, next, now);
        inner.states.insert(
            slot,
            State::Rate {
                next: next + interval,
            },
        );
    }

    /// Resets the counter (e.g. after a successful setup).
    pub fn reset(&self, policy: &Policy, key: &Key) {
        self.lock().states.remove(&(policy.name, key.clone()));
    }

    /// How many attempts the rule still allows now (pending reservations
    /// count), e.g. for "3 attempts left"; [`Limited`] as long as none is
    /// allowed.
    pub fn remaining(&self, policy: &Policy, key: &Key) -> Result<u32, Limited> {
        self.remaining_at(policy, key, Instant::now())
    }

    fn remaining_at(&self, policy: &Policy, key: &Key, now: Instant) -> Result<u32, Limited> {
        let inner = self.lock();
        let current = inner
            .states
            .get(&(policy.name, key.clone()))
            .filter(|s| s.expires() > now)
            .copied();
        match (policy.limit, current) {
            (
                Limit::Lockout { .. },
                Some(State::Lockout {
                    locked_until: Some(until),
                    ..
                }),
            ) => Err(Limited {
                retry_after: until - now,
            }),
            (Limit::Lockout { failures, .. }, Some(State::Lockout { count, .. })) => {
                Ok(failures.max(1).saturating_sub(count))
            }
            (Limit::Rate { burst, period }, current) => {
                let next = match current {
                    Some(State::Rate { next }) => Some(next),
                    _ => None,
                };
                // Every attempt moves `next` on by one interval.
                let (next, allowed_until, interval) = gcra(burst, period, next, now);
                if next > allowed_until {
                    return Err(Limited {
                        retry_after: next - allowed_until,
                    });
                }
                let steps = (allowed_until - next).as_nanos() / interval.as_nanos().max(1);
                Ok(u32::try_from(steps + 1).map_or(burst, |n| n.min(burst.max(1))))
            }
            (Limit::Lockout { failures, .. }, _) => Ok(failures.max(1)),
        }
    }

    fn acquire_at(&self, policy: &Policy, key: Key, now: Instant) -> Result<(), Limited> {
        let mut inner = self.lock();
        inner.calls = inner.calls.wrapping_add(1);
        if inner.calls.is_multiple_of(SWEEP_EVERY) {
            inner.states.retain(|_, state| state.expires() > now);
        }
        let slot = (policy.name, key);
        let current = inner
            .states
            .get(&slot)
            .filter(|s| s.expires() > now)
            .copied();
        let next = match policy.limit {
            Limit::Rate { burst, period } => {
                let next = match current {
                    Some(State::Rate { next }) => Some(next),
                    _ => None,
                };
                let (next, allowed_until, interval) = gcra(burst, period, next, now);
                if next > allowed_until {
                    return Err(Limited {
                        retry_after: next - allowed_until,
                    });
                }
                State::Rate {
                    next: next + interval,
                }
            }
            Limit::Lockout {
                failures,
                window,
                lock,
            } => {
                // The window starts with the first attempt; later ones do
                // not extend it.
                let (count, window_end) = match current {
                    Some(State::Lockout {
                        locked_until: Some(until),
                        ..
                    }) => {
                        return Err(Limited {
                            retry_after: until - now,
                        });
                    }
                    Some(State::Lockout {
                        count, window_end, ..
                    }) => (count + 1, window_end),
                    _ => (1, now + window),
                };
                State::Lockout {
                    count,
                    window_end,
                    locked_until: (count >= failures.max(1)).then_some(now + lock),
                }
            }
        };
        inner.states.insert(slot, next);
        Ok(())
    }

    fn refund_at(&self, policy: &Policy, key: &Key, now: Instant) {
        let mut inner = self.lock();
        let slot = (policy.name, key.clone());
        let Some(state) = inner.states.get(&slot).copied() else {
            return;
        };
        let refunded = match (policy.limit, state) {
            (Limit::Rate { burst, period }, State::Rate { next }) => {
                let next = next.checked_sub(period / burst.max(1)).unwrap_or(now);
                (next > now).then_some(State::Rate { next })
            }
            (
                Limit::Lockout { .. },
                State::Lockout {
                    count, window_end, ..
                },
            ) => {
                // A lock caused by exactly this attempt is lifted; the window
                // stays as it was (if it has expired, the counter counts as
                // empty).
                (count > 1).then_some(State::Lockout {
                    count: count - 1,
                    window_end,
                    locked_until: None,
                })
            }
            _ => None,
        };
        match refunded {
            Some(state) => inner.states.insert(slot, state),
            None => inner.states.remove(&slot),
        };
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic under the lock only leaves counters behind; carry on.
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lock().states.len()
    }
}

/// A reserved attempt from [`RateLimiter::reserve`].
pub struct Reservation<'a> {
    limiter: &'a RateLimiter,
    policy: &'a Policy,
    /// `None` as soon as the attempt counts.
    key: Option<Key>,
}

impl Reservation<'_> {
    /// The attempt counts (e.g. a rejected password).
    pub fn count(mut self) {
        self.key = None;
    }
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            self.limiter.refund(self.policy, &key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reservation_refunds_unless_counted() {
        let limiter = RateLimiter::default();
        let policy = Policy::lockout(
            "reserve",
            2,
            Duration::from_secs(60),
            Duration::from_secs(60),
        );
        // Not counted (also aborted): any number of times.
        for _ in 0..5 {
            drop(limiter.reserve(&policy, Key::Global).unwrap());
        }
        limiter.reserve(&policy, Key::Global).unwrap().count();
        limiter.reserve(&policy, Key::Global).unwrap().count();
        assert!(limiter.reserve(&policy, Key::Global).is_err());
    }

    const FIVE_PER_MINUTE: Policy = Policy::rate("test", 5, Duration::from_secs(60));
    const SETUP: Policy = Policy::lockout(
        "lockout",
        5,
        Duration::from_secs(600),
        Duration::from_secs(30),
    );

    fn user() -> Key {
        Key::User("max".into())
    }

    /// A single user with wrong tokens does not lock the mail server for
    /// everyone, not even over hours.
    #[test]
    fn one_user_does_not_lock_a_mail_server() {
        use crate::api::mail_accounts::{
            REJECTED_HOUR_LIMIT, REJECTED_LIMIT, REJECTED_SERVER_LIMIT,
        };
        let limiter = RateLimiter::default();
        let t0 = Instant::now();
        let user = || Key::User("max".into());
        let server = || Key::Server("https://mail.example.com".into());
        let open = |policy, key: &Key, now| {
            limiter
                .remaining_at(policy, key, now)
                .is_ok_and(|left| left > 0)
        };
        let mut rejected = 0;
        for second in (0..6 * 60 * 60).step_by(10) {
            let now = t0 + secs(second);
            if !open(&REJECTED_LIMIT, &user(), now) || !open(&REJECTED_HOUR_LIMIT, &user(), now) {
                continue;
            }
            assert!(
                open(&REJECTED_SERVER_LIMIT, &server(), now),
                "locked after {rejected} rejections"
            );
            limiter.acquire_at(&REJECTED_LIMIT, user(), now).unwrap();
            limiter
                .acquire_at(&REJECTED_HOUR_LIMIT, user(), now)
                .unwrap();
            limiter
                .acquire_at(&REJECTED_SERVER_LIMIT, server(), now)
                .unwrap();
            rejected += 1;
        }
        assert!(rejected >= 50, "{rejected}");
    }

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn rate_allows_burst_then_one_per_interval() {
        let limiter = RateLimiter::default();
        let t0 = Instant::now();
        for _ in 0..5 {
            limiter.acquire_at(&FIVE_PER_MINUTE, user(), t0).unwrap();
        }
        let err = limiter
            .acquire_at(&FIVE_PER_MINUTE, user(), t0)
            .unwrap_err();
        assert_eq!(err.retry_after, secs(12));
        // Other keys and rules count separately.
        limiter
            .acquire_at(&FIVE_PER_MINUTE, Key::Ip("192.0.2.1".parse().unwrap()), t0)
            .unwrap();
        let other = Policy::rate("other", 5, secs(60));
        limiter.acquire_at(&other, user(), t0).unwrap();

        let t1 = t0 + secs(12);
        limiter.acquire_at(&FIVE_PER_MINUTE, user(), t1).unwrap();
        assert!(limiter.acquire_at(&FIVE_PER_MINUTE, user(), t1).is_err());
        // After the full period the whole allowance again.
        let t2 = t1 + secs(60);
        for _ in 0..5 {
            limiter.acquire_at(&FIVE_PER_MINUTE, user(), t2).unwrap();
        }
    }

    #[test]
    fn refund_returns_attempts_that_do_not_count() {
        let limiter = RateLimiter::default();
        let t0 = Instant::now();
        // Ten successful attempts: each one is refunded.
        for _ in 0..10 {
            limiter.acquire_at(&FIVE_PER_MINUTE, user(), t0).unwrap();
            limiter.refund_at(&FIVE_PER_MINUTE, &user(), t0);
        }
        assert_eq!(limiter.len(), 0);
        for _ in 0..5 {
            limiter.acquire_at(&FIVE_PER_MINUTE, user(), t0).unwrap();
        }
        assert!(limiter.acquire_at(&FIVE_PER_MINUTE, user(), t0).is_err());
        limiter.reset(&FIVE_PER_MINUTE, &user());
        limiter.acquire_at(&FIVE_PER_MINUTE, user(), t0).unwrap();
    }

    #[test]
    fn concurrent_attempts_never_exceed_the_limit() {
        // All reserve before any result is known (500 parallel logins): only
        // as many get through as the rule allows.
        let limiter = RateLimiter::default();
        let t0 = Instant::now();
        let passed = (0..500)
            .filter(|_| limiter.acquire_at(&FIVE_PER_MINUTE, user(), t0).is_ok())
            .count();
        assert_eq!(passed, 5);
        let passed = (0..500)
            .filter(|_| limiter.acquire_at(&SETUP, user(), t0).is_ok())
            .count();
        assert_eq!(passed, 5);
    }

    #[test]
    fn lockout_after_failures_then_full_allowance() {
        let limiter = RateLimiter::default();
        let t0 = Instant::now();
        for _ in 0..5 {
            limiter.acquire_at(&SETUP, Key::Global, t0).unwrap();
        }
        let err = limiter
            .acquire_at(&SETUP, Key::Global, t0 + secs(10))
            .unwrap_err();
        assert_eq!(err.retry_after, secs(20));
        // After the lock five attempts again, not just one.
        let t1 = t0 + secs(30);
        for _ in 0..5 {
            limiter.acquire_at(&SETUP, Key::Global, t1).unwrap();
        }
        assert!(limiter.acquire_at(&SETUP, Key::Global, t1).is_err());
    }

    #[test]
    fn lockout_forgets_refunds_and_old_failures() {
        let limiter = RateLimiter::default();
        let t0 = Instant::now();
        for _ in 0..4 {
            limiter.acquire_at(&SETUP, Key::Global, t0).unwrap();
        }
        // The fifth attempt is a success and does not count.
        limiter.acquire_at(&SETUP, Key::Global, t0).unwrap();
        limiter.refund_at(&SETUP, &Key::Global, t0);
        limiter.acquire_at(&SETUP, Key::Global, t0).unwrap();
        assert!(limiter.acquire_at(&SETUP, Key::Global, t0).is_err());

        // Four failures, then ten quiet minutes: the window starts over.
        let limiter = RateLimiter::default();
        for _ in 0..4 {
            limiter.acquire_at(&SETUP, Key::Global, t0).unwrap();
        }
        let later = t0 + secs(601);
        for _ in 0..5 {
            limiter.acquire_at(&SETUP, Key::Global, later).unwrap();
        }
        assert!(limiter.acquire_at(&SETUP, Key::Global, later).is_err());
    }

    #[test]
    fn lockout_window_starts_with_the_first_failure() {
        // One failure, then successes (refunded) every five minutes: they do
        // not extend the window, after ten minutes the failure is gone.
        let limiter = RateLimiter::default();
        let t0 = Instant::now();
        limiter.acquire_at(&SETUP, Key::Global, t0).unwrap();
        for minute in [5, 9] {
            let at = t0 + secs(minute * 60);
            limiter.acquire_at(&SETUP, Key::Global, at).unwrap();
            limiter.refund_at(&SETUP, &Key::Global, at);
        }
        let later = t0 + secs(601);
        for _ in 0..5 {
            limiter.acquire_at(&SETUP, Key::Global, later).unwrap();
        }
        assert!(limiter.acquire_at(&SETUP, Key::Global, later).is_err());
    }

    #[test]
    fn refunding_the_locking_attempt_keeps_the_window() {
        // Four failures, then correct tokens (each reserved, locking the
        // window, then refunded): after ten minutes the failures are still
        // forgotten.
        let limiter = RateLimiter::default();
        let t0 = Instant::now();
        for _ in 0..4 {
            limiter.acquire_at(&SETUP, Key::Global, t0).unwrap();
        }
        for minute in [3, 6, 9] {
            let at = t0 + secs(minute * 60);
            limiter.acquire_at(&SETUP, Key::Global, at).unwrap();
            limiter.refund_at(&SETUP, &Key::Global, at);
            assert_eq!(limiter.remaining_at(&SETUP, &Key::Global, at), Ok(1));
        }
        assert_eq!(
            limiter.remaining_at(&SETUP, &Key::Global, t0 + secs(601)),
            Ok(5)
        );
    }

    #[test]
    fn remaining_counts_down_to_the_lock() {
        let limiter = RateLimiter::default();
        let t0 = Instant::now();
        assert_eq!(limiter.remaining_at(&SETUP, &Key::Global, t0), Ok(5));
        for left in (1..5).rev() {
            limiter.acquire_at(&SETUP, Key::Global, t0).unwrap();
            assert_eq!(limiter.remaining_at(&SETUP, &Key::Global, t0), Ok(left));
        }
        limiter.acquire_at(&SETUP, Key::Global, t0).unwrap();
        assert_eq!(
            limiter.remaining_at(&SETUP, &Key::Global, t0 + secs(10)),
            Err(Limited {
                retry_after: secs(20)
            })
        );
        assert_eq!(
            limiter.remaining_at(&SETUP, &Key::Global, t0 + secs(30)),
            Ok(5)
        );

        // Rate: as many as `acquire` would still let through.
        assert_eq!(limiter.remaining_at(&FIVE_PER_MINUTE, &user(), t0), Ok(5));
        for left in (0..5).rev() {
            limiter.acquire_at(&FIVE_PER_MINUTE, user(), t0).unwrap();
            if left > 0 {
                assert_eq!(
                    limiter.remaining_at(&FIVE_PER_MINUTE, &user(), t0),
                    Ok(left)
                );
            }
        }
        assert_eq!(
            limiter.remaining_at(&FIVE_PER_MINUTE, &user(), t0),
            Err(Limited {
                retry_after: secs(12)
            })
        );
        assert_eq!(
            limiter.remaining_at(&FIVE_PER_MINUTE, &user(), t0 + secs(24)),
            Ok(2)
        );
    }

    #[test]
    fn charge_counts_beyond_the_limit() {
        // Two at once, then one per 5 s.
        let two = Policy::rate("two", 2, secs(10));
        let limiter = RateLimiter::default();
        let t0 = Instant::now();
        assert_eq!(limiter.remaining_at(&two, &Key::Global, t0), Ok(2));
        limiter.charge_at(&two, Key::Global, t0);
        assert_eq!(limiter.remaining_at(&two, &Key::Global, t0), Ok(1));
        // Four events, two beyond the limit: only after three intervals is
        // another one allowed.
        for _ in 0..3 {
            limiter.charge_at(&two, Key::Global, t0);
        }
        let err = limiter.remaining_at(&two, &Key::Global, t0).unwrap_err();
        assert_eq!(err.retry_after, secs(15));
        assert_eq!(
            limiter.remaining_at(&two, &Key::Global, t0 + secs(15)),
            Ok(1)
        );
        // Lockouts count like `acquire`.
        let limiter = RateLimiter::default();
        for _ in 0..6 {
            limiter.charge_at(&SETUP, Key::Global, t0);
        }
        assert!(limiter.remaining_at(&SETUP, &Key::Global, t0).is_err());
    }

    #[test]
    fn single_attempt_rate_locks_for_period() {
        let once = Policy::rate("once", 1, secs(30));
        let limiter = RateLimiter::default();
        let t0 = Instant::now();
        limiter.acquire_at(&once, Key::Global, t0).unwrap();
        let err = limiter.acquire_at(&once, Key::Global, t0).unwrap_err();
        assert_eq!(err.retry_after, secs(30));
    }

    #[test]
    fn sweeps_expired_counters() {
        let limiter = RateLimiter::default();
        let t0 = Instant::now();
        for i in 0..100u8 {
            let rate = Key::Ip(IpAddr::from([192, 0, 2, i]));
            let lockout = Key::Ip(IpAddr::from([198, 51, 100, i]));
            limiter.acquire_at(&FIVE_PER_MINUTE, rate, t0).unwrap();
            limiter.acquire_at(&SETUP, lockout, t0).unwrap();
        }
        assert_eq!(limiter.len(), 200);
        let later = t0 + secs(601);
        for _ in 0..SWEEP_EVERY {
            limiter
                .acquire_at(&FIVE_PER_MINUTE, user(), later)
                .unwrap_or(());
        }
        assert_eq!(limiter.len(), 1);
    }
}
