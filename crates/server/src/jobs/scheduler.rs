//! In-process background jobs: every job runs
//! in its own task, first after `first`, then every `every`, each time
//! with up to 10 % jitter – so jobs of several instances do not run in
//! lockstep, and a restart shifts them slightly. A job with
//! `wake` also runs right away when someone wakes it (Web Push);
//! a wake during a run leads to another one. An error is written
//! to the log, the next run follows as scheduled; a panic ends the
//! process in release builds (`panic = "abort"`, the container restarts).
//! On shutdown
//! [`Scheduler::shutdown`] aborts running jobs; statements they
//! were handed to the database still run to completion there.

use std::{future::Future, pin::Pin, time::Duration};

use tokio::{sync::Notify, task::JoinSet, time::Instant};

use crate::random;

/// One run of a job.
pub type Run<S> = fn(S) -> Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send>>;

pub struct Job<S> {
    /// For the log, e.g. `session_cleanup`.
    pub name: &'static str,
    /// Delay before the first run after start.
    pub first: Duration,
    /// Interval between two runs (from the end of the previous one).
    pub every: Duration,
    pub run: Run<S>,
    /// Wakes the job early (e.g. [`crate::push::WAKE`]).
    pub wake: Option<&'static Notify>,
}

pub struct Scheduler {
    tasks: JoinSet<()>,
}

impl Scheduler {
    pub fn start<S: Clone + Send + 'static>(
        state: &S,
        jobs: impl IntoIterator<Item = Job<S>>,
    ) -> Self {
        let mut tasks = JoinSet::new();
        for job in jobs {
            tasks.spawn(repeat(state.clone(), job));
        }
        Self { tasks }
    }

    /// Aborts all jobs and waits until they have ended.
    pub async fn shutdown(mut self) {
        self.tasks.shutdown().await;
    }
}

async fn repeat<S: Clone + Send + 'static>(state: S, job: Job<S>) {
    pause(with_jitter(job.first), job.wake).await;
    loop {
        let started = Instant::now();
        match (job.run)(state.clone()).await {
            Ok(()) => tracing::debug!(job = job.name, took = ?started.elapsed(), "job ran"),
            Err(error) => tracing::warn!(job = job.name, "job failed: {error:#}"),
        }
        pause(with_jitter(job.every), job.wake).await;
    }
}

/// Waits `duration` or until `wake` wakes.
async fn pause(duration: Duration, wake: Option<&'static Notify>) {
    let sleep = tokio::time::sleep(duration);
    match wake {
        Some(wake) => tokio::select! {
            () = sleep => {}
            () = wake.notified() => {}
        },
        None => sleep.await,
    }
}

/// `base` plus up to 10 % at random.
fn with_jitter(base: Duration) -> Duration {
    let range = base.as_millis() / 10;
    let random = random::bytes::<8>().map_or(0, u64::from_le_bytes);
    let extra = match u64::try_from(range) {
        Ok(0) | Err(_) => 0,
        Ok(range) => random % range,
    };
    base + Duration::from_millis(extra)
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use super::*;

    type Counter = Arc<AtomicUsize>;

    fn count(counter: Counter) -> Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send>> {
        Box::pin(async move {
            // Even an error does not stop the job.
            if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                anyhow::bail!("first run fails");
            }
            Ok(())
        })
    }

    #[tokio::test(start_paused = true)]
    async fn runs_after_first_then_every_until_shutdown() {
        let counter = Counter::default();
        let scheduler = Scheduler::start(
            &counter,
            [Job {
                name: "test",
                first: Duration::from_secs(60),
                every: Duration::from_secs(3600),
                run: count,
                wake: None,
            }],
        );
        tokio::time::sleep(Duration::from_secs(59)).await;
        assert_eq!(counter.load(Ordering::SeqCst), 0);
        // First run after 60 s plus at most 6 s jitter.
        tokio::time::sleep(Duration::from_secs(8)).await;
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        // Further runs hourly plus at most 6 minutes.
        tokio::time::sleep(Duration::from_secs(3600 + 360 + 1)).await;
        assert_eq!(counter.load(Ordering::SeqCst), 2);

        scheduler.shutdown().await;
        tokio::time::sleep(Duration::from_secs(10 * 3600)).await;
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn wake_runs_the_job_early() {
        static WAKE: Notify = Notify::const_new();
        let counter = Counter::default();
        let scheduler = Scheduler::start(
            &counter,
            [Job {
                name: "test",
                first: Duration::from_secs(60),
                every: Duration::from_secs(3600),
                run: count,
                wake: Some(&WAKE),
            }],
        );
        tokio::time::sleep(Duration::from_secs(1)).await;
        WAKE.notify_one();
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        WAKE.notify_one();
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(counter.load(Ordering::SeqCst), 2);
        scheduler.shutdown().await;
    }

    #[test]
    fn jitter_stays_within_ten_percent() {
        for _ in 0..100 {
            let d = with_jitter(Duration::from_secs(100));
            assert!(
                d >= Duration::from_secs(100) && d < Duration::from_secs(110),
                "{d:?}"
            );
        }
        assert_eq!(with_jitter(Duration::ZERO), Duration::ZERO);
    }
}
