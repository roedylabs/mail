//! Locks per key: whatever runs under the same key runs one after another –
//! for example email address changes per user or the token refresh
//! per mail account. An entry lives only as long as someone holds
//! it or waits for it (after a cancelled wait, until the next release).

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, PoisonError},
};

use tokio::sync::OwnedMutexGuard;

#[derive(Debug, Default)]
pub struct KeyedLocks(Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>);

impl KeyedLocks {
    /// Waits until nobody else holds the lock for `key`.
    pub async fn lock(self: &Arc<Self>, key: &str) -> KeyedLock {
        let entry = self
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(key.to_owned())
            .or_default()
            .clone();
        KeyedLock {
            locks: self.clone(),
            guard: Some(entry.lock_owned().await),
        }
    }
}

/// Held lock; can be moved into a separate task.
pub struct KeyedLock {
    locks: Arc<KeyedLocks>,
    guard: Option<OwnedMutexGuard<()>>,
}

impl Drop for KeyedLock {
    fn drop(&mut self) {
        drop(self.guard.take());
        let mut map = self.locks.0.lock().unwrap_or_else(PoisonError::into_inner);
        // Holders and waiters keep the entry alive; if only the table holds
        // it, nobody needs it – not even after a cancelled wait under another
        // key.
        map.retain(|_, entry| Arc::strong_count(entry) > 1);
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn locks_run_one_after_another_per_key() {
        let locks = Arc::new(KeyedLocks::default());
        let first = locks.lock("max").await;
        // Another key does not wait.
        drop(locks.lock("eva").await);
        let waiting = {
            let locks = locks.clone();
            tokio::spawn(async move {
                let _second = locks.lock("max").await;
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!waiting.is_finished());
        drop(first);
        waiting.await.unwrap();
        // Afterwards the table is empty.
        assert!(locks.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancelled_waiters_leave_no_entry() {
        let locks = Arc::new(KeyedLocks::default());
        let first = locks.lock("max").await;
        let waiting = {
            let locks = locks.clone();
            tokio::spawn(async move {
                let _second = locks.lock("max").await;
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        // Released while someone waits; then the waiter is cancelled.
        drop(first);
        waiting.abort();
        assert!(waiting.await.unwrap_err().is_cancelled());
        assert_eq!(locks.0.lock().unwrap().len(), 1);
        // The next release removes the entry.
        drop(locks.lock("eva").await);
        assert!(locks.0.lock().unwrap().is_empty());
    }
}
