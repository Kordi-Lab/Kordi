//! Per-account budgets for authenticated actions, such as starting a provider
//! login. The memory backend keeps a sliding window; the Redis backend uses the
//! same fixed-window counter as the per-IP limit and also falls open on Redis
//! errors.

use super::*;

/// A per-account budget for one authenticated action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AccountActionLimit {
    pub action: &'static str,
    pub limit: u32,
    pub window: Duration,
}

/// Message sends through the chat API. Five sends per second sustained for a
/// minute is far above interactive use and bounds automated floods.
pub const MESSAGE_SEND_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "message-send",
    limit: 300,
    window: Duration::from_secs(60),
};

/// Contact additions and contact requests, which share one budget.
pub const CONTACT_ADD_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "contact-add",
    limit: 100,
    window: Duration::from_secs(60 * 60),
};

/// Cloud agent run claims made by a requester.
pub const AGENT_RUN_CLAIM_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "agent-run-claim",
    limit: 120,
    window: Duration::from_secs(60),
};

impl CloudRateLimiter {
    /// Records one action against `limit` for `account_id`.
    pub async fn observe_account_limit(
        &self,
        limit: AccountActionLimit,
        account_id: &str,
    ) -> RateLimitDecision {
        self.observe_account_action(limit.action, account_id, limit.limit, limit.window)
            .await
    }

    /// Records one `action` for `account_id`, allowing at most `limit` actions
    /// per `window`. Returns `Limited` without recording when the budget is
    /// already spent.
    pub async fn observe_account_action(
        &self,
        action: &str,
        account_id: &str,
        limit: u32,
        window: Duration,
    ) -> RateLimitDecision {
        match &self.backend {
            Backend::Memory(store) => {
                observe_account_action_memory(store, action, account_id, limit, window)
            }
            Backend::Redis(store) => {
                observe_account_action_redis(store, action, account_id, limit, window).await
            }
        }
    }
}

fn observe_account_action_memory(
    store: &MemoryStore,
    action: &str,
    account_id: &str,
    limit: u32,
    window: Duration,
) -> RateLimitDecision {
    let mut buckets = store
        .per_account_action
        .lock()
        .expect("rate limiter poisoned");
    let entry = buckets.entry(format!("{action}:{account_id}")).or_default();
    let now = Instant::now();
    let window_start = now.checked_sub(window).unwrap_or(now);
    while entry.front().is_some_and(|front| *front < window_start) {
        entry.pop_front();
    }
    if entry.len() as u32 >= limit {
        let oldest = entry.front().copied().unwrap_or(now);
        let retry_after = window
            .checked_sub(now.duration_since(oldest))
            .unwrap_or(window);
        return RateLimitDecision::Limited { retry_after };
    }
    entry.push_back(now);
    RateLimitDecision::Allowed
}

async fn observe_account_action_redis(
    store: &RedisStore,
    action: &str,
    account_id: &str,
    limit: u32,
    window: Duration,
) -> RateLimitDecision {
    let mut conn = store.conn.clone();
    let redis_key = format!("{}:acct:{action}:{account_id}", store.key_prefix);
    let window_secs = window.as_secs().max(1) as i64;
    let count: i64 = match conn.incr(&redis_key, 1).await {
        Ok(value) => value,
        Err(err) => {
            eprintln!("[rate_limit] redis INCR {redis_key}: {err}");
            return RateLimitDecision::Allowed;
        }
    };
    if count == 1 {
        if let Err(err) = conn.expire::<_, ()>(&redis_key, window_secs).await {
            eprintln!("[rate_limit] redis EXPIRE {redis_key}: {err}");
        }
    }
    if count > limit as i64 {
        let pttl_ms: i64 = conn.pttl(&redis_key).await.unwrap_or(window_secs * 1000);
        let retry_after = if pttl_ms > 0 {
            Duration::from_millis(pttl_ms as u64)
        } else {
            window
        };
        return RateLimitDecision::Limited { retry_after };
    }
    RateLimitDecision::Allowed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn account_actions_are_budgeted_per_account_and_action() {
        let limiter = CloudRateLimiter::memory(CloudRateLimitConfig::default());
        let window = Duration::from_millis(200);
        for _ in 0..2 {
            assert_eq!(
                limiter
                    .observe_account_action("login", "acct_a", 2, window)
                    .await,
                RateLimitDecision::Allowed
            );
        }
        assert!(matches!(
            limiter
                .observe_account_action("login", "acct_a", 2, window)
                .await,
            RateLimitDecision::Limited { .. }
        ));
        assert_eq!(
            limiter
                .observe_account_action("login", "acct_b", 2, window)
                .await,
            RateLimitDecision::Allowed
        );
        assert_eq!(
            limiter
                .observe_account_action("other", "acct_a", 2, window)
                .await,
            RateLimitDecision::Allowed
        );
        tokio::time::sleep(Duration::from_millis(220)).await;
        assert_eq!(
            limiter
                .observe_account_action("login", "acct_a", 2, window)
                .await,
            RateLimitDecision::Allowed
        );
    }

    #[test]
    fn product_action_limits_are_generous_and_separate() {
        let per_hour = |limit: AccountActionLimit| {
            f64::from(limit.limit) * 3600.0 / limit.window.as_secs_f64()
        };
        assert!(per_hour(MESSAGE_SEND_LIMIT) >= 18_000.0);
        assert!(per_hour(CONTACT_ADD_LIMIT) >= 100.0);
        assert!(per_hour(AGENT_RUN_CLAIM_LIMIT) >= 7_200.0);
        assert_ne!(MESSAGE_SEND_LIMIT.action, CONTACT_ADD_LIMIT.action);
        assert_ne!(CONTACT_ADD_LIMIT.action, AGENT_RUN_CLAIM_LIMIT.action);
        assert_ne!(MESSAGE_SEND_LIMIT.action, AGENT_RUN_CLAIM_LIMIT.action);
    }

    #[tokio::test]
    async fn account_limits_stop_at_their_budget() {
        let limiter = CloudRateLimiter::memory(CloudRateLimitConfig::default());
        for _ in 0..CONTACT_ADD_LIMIT.limit {
            assert_eq!(
                limiter
                    .observe_account_limit(CONTACT_ADD_LIMIT, "acct_contacts")
                    .await,
                RateLimitDecision::Allowed
            );
        }
        assert!(matches!(
            limiter
                .observe_account_limit(CONTACT_ADD_LIMIT, "acct_contacts")
                .await,
            RateLimitDecision::Limited { .. }
        ));
        assert_eq!(
            limiter
                .observe_account_limit(MESSAGE_SEND_LIMIT, "acct_contacts")
                .await,
            RateLimitDecision::Allowed
        );
    }
}
