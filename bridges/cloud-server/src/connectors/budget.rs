//! The per-account budget for connector tool executions.
//!
//! Every tool call the broker is about to run is charged to the owning
//! account through the shared account-action limiter (in Redis when the
//! server has it), at most `KORDI_CONNECTOR_CALLS_PER_HOUR` (default 600)
//! per hour. A call over budget is refused with `connector_budget_exceeded`
//! and audited.

use std::sync::Arc;
use std::time::Duration;

use crate::auth::rate_limit::{CloudRateLimitConfig, CloudRateLimiter, RateLimitDecision};

pub const CALLS_PER_HOUR_ENV: &str = "KORDI_CONNECTOR_CALLS_PER_HOUR";
pub const DEFAULT_CALLS_PER_HOUR: u32 = 600;
const MAX_CALLS_PER_HOUR: u32 = 100_000;
const ACTION: &str = "connector-call";
const WINDOW: Duration = Duration::from_secs(60 * 60);

/// Parses `KORDI_CONNECTOR_CALLS_PER_HOUR`, accepting 1 to 100000 and
/// falling back to 600.
pub fn calls_per_hour_from(value: Option<&str>) -> u32 {
    value
        .and_then(|raw| raw.trim().parse::<u32>().ok())
        .filter(|calls| (1..=MAX_CALLS_PER_HOUR).contains(calls))
        .unwrap_or(DEFAULT_CALLS_PER_HOUR)
}

#[derive(Clone)]
pub struct CallBudget {
    limiter: Arc<CloudRateLimiter>,
    per_hour: u32,
}

impl std::fmt::Debug for CallBudget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CallBudget")
            .field("per_hour", &self.per_hour)
            .finish_non_exhaustive()
    }
}

impl CallBudget {
    /// An in-process budget of `per_hour` calls. The server swaps in its
    /// shared limiter with [`Self::with_limiter`].
    pub fn new(per_hour: u32) -> Self {
        Self {
            limiter: Arc::new(CloudRateLimiter::memory(CloudRateLimitConfig::production())),
            per_hour,
        }
    }

    pub fn from_env() -> Self {
        Self::new(calls_per_hour_from(
            std::env::var(CALLS_PER_HOUR_ENV).ok().as_deref(),
        ))
    }

    pub fn with_limiter(mut self, limiter: Arc<CloudRateLimiter>) -> Self {
        self.limiter = limiter;
        self
    }

    pub fn per_hour(&self) -> u32 {
        self.per_hour
    }

    /// Charges one call to `account_id`. False when the hour's budget is
    /// already spent; nothing is charged then.
    pub async fn charge(&self, account_id: &str) -> bool {
        matches!(
            self.limiter
                .observe_account_action(ACTION, account_id, self.per_hour, WINDOW)
                .await,
            RateLimitDecision::Allowed
        )
    }
}
