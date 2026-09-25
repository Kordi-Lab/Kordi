//! Per-account budgets for authenticated actions, such as starting a provider
//! login. The memory backend keeps a sliding window; the Redis backend uses the
//! same fixed-window counter as the per-IP limit and also falls open on Redis
//! errors.

use super::*;

impl CloudRateLimiter {
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
}
