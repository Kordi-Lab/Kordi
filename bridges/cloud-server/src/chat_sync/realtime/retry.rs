//! Timing helpers shared by the socket's session and durable-read schedules.

use std::time::Duration;

use rand::Rng;

/// How long a socket keeps running while every database check fails before
/// it closes. Shorter outages no longer turn into reconnect storms.
pub(crate) const FAILURE_GRACE: Duration = Duration::from_secs(120);
const RETRY_FIRST: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(30);

/// `interval` scaled by a random factor in [0.8, 1.2], so sockets opened
/// together do not query together.
pub(crate) fn jittered(interval: Duration) -> Duration {
    interval.mul_f64(rand::thread_rng().gen_range(0.8..=1.2))
}

/// A random delay in [0, `within`].
pub(crate) fn spread(within: Duration) -> Duration {
    within.mul_f64(rand::thread_rng().gen_range(0.0..=1.0))
}

/// Exponential retry delays (1 s, 2 s, 4 s, ... capped at 30 s), jittered.
#[derive(Debug, Default)]
pub(crate) struct Backoff {
    failures: u32,
}

impl Backoff {
    pub(crate) fn next_delay(&mut self) -> Duration {
        let base = RETRY_FIRST
            .saturating_mul(1 << self.failures.min(5))
            .min(RETRY_MAX);
        self.failures = self.failures.saturating_add(1);
        jittered(base)
    }
}
