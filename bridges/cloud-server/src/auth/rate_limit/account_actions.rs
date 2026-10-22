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

/// Public shared-document reads (the page, the raw HTML view, and the JSON
/// read), keyed by client address. A page view costs two reads.
pub const DOCUMENT_PUBLIC_READ_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "document-public-read",
    limit: 120,
    window: Duration::from_secs(60),
};

/// Public shared-document reactions and comments, keyed by client address.
pub const DOCUMENT_PUBLIC_WRITE_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "document-public-write",
    limit: 30,
    window: Duration::from_secs(60),
};

/// Collaboration socket tickets for shared documents, per account.
pub const DOCUMENT_COLLAB_TICKET_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "document-collab-ticket",
    limit: 60,
    window: Duration::from_secs(60),
};

/// Contact additions and contact requests, which share one budget.
pub const CONTACT_ADD_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "contact-add",
    limit: 100,
    window: Duration::from_secs(60 * 60),
};

/// Requests for and guesses at codes that verify the signed-in account's
/// primary email. The code store separately allows one send per minute, five
/// per hour, and five guesses per code; this bounds the account as a whole.
pub const EMAIL_VERIFICATION_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "email-verification",
    limit: 10,
    window: Duration::from_secs(60 * 60),
};

/// Agent runs a requester starts. Every user-triggered path that queues an
/// agent run, now or on a schedule, charges this budget through
/// [`CloudRateLimiter::observe_agent_run`]: run claims, subsession messages
/// that run the agent, scheduled tasks started now, and new cloud scheduled
/// tasks.
pub const AGENT_RUN_CLAIM_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "agent-run-claim",
    limit: 120,
    window: Duration::from_secs(60),
};

impl CloudRateLimiter {
    /// Charges one agent run started by `account_id` against
    /// [`AGENT_RUN_CLAIM_LIMIT`]. Call it before queueing the run.
    pub async fn observe_agent_run(&self, account_id: &str) -> RateLimitDecision {
        self.observe_account_limit(AGENT_RUN_CLAIM_LIMIT, account_id)
            .await
    }

    /// Records one action against `limit` for `account_id`.
    pub async fn observe_account_limit(
        &self,
        limit: AccountActionLimit,
        account_id: &str,
    ) -> RateLimitDecision {
        self.observe_account_action(limit.action, account_id, limit.limit, limit.window)
            .await
    }

    /// Whether `limit` is already spent for `account_id`, without recording
    /// anything. Lets a caller charge only some outcomes yet still refuse
    /// every call once the budget is gone.
    pub async fn peek_account_limit(
        &self,
        limit: AccountActionLimit,
        account_id: &str,
    ) -> RateLimitDecision {
        let AccountActionLimit {
            action,
            limit,
            window,
        } = limit;
        match &self.backend {
            Backend::Memory(store) => {
                let mut buckets = store
                    .per_account_action
                    .lock()
                    .expect("rate limiter poisoned");
                let Some(entry) = buckets.get_mut(&format!("{action}:{account_id}")) else {
                    return RateLimitDecision::Allowed;
                };
                let now = Instant::now();
                let window_start = now.checked_sub(window).unwrap_or(now);
                while entry.front().is_some_and(|front| *front < window_start) {
                    entry.pop_front();
                }
                if (entry.len() as u32) < limit {
                    return RateLimitDecision::Allowed;
                }
                let oldest = entry.front().copied().unwrap_or(now);
                RateLimitDecision::Limited {
                    retry_after: window
                        .checked_sub(now.duration_since(oldest))
                        .unwrap_or(window),
                }
            }
            Backend::Redis(store) => {
                let mut conn = store.conn.clone();
                let redis_key = format!("{}:acct:{action}:{account_id}", store.key_prefix);
                let count: Option<i64> = match conn.get(&redis_key).await {
                    Ok(value) => value,
                    Err(err) => {
                        eprintln!("[rate_limit] redis GET {redis_key}: {err}");
                        return RateLimitDecision::Allowed;
                    }
                };
                if count.unwrap_or(0) < limit as i64 {
                    return RateLimitDecision::Allowed;
                }
                let pttl_ms: i64 = conn.pttl(&redis_key).await.unwrap_or(0);
                RateLimitDecision::Limited {
                    retry_after: if pttl_ms > 0 {
                        Duration::from_millis(pttl_ms as u64)
                    } else {
                        window
                    },
                }
            }
        }
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

    #[tokio::test]
    async fn peeking_reports_a_spent_budget_without_charging() {
        let limiter = CloudRateLimiter::memory(CloudRateLimitConfig::default());
        let limit = AccountActionLimit {
            action: "peek",
            limit: 2,
            window: Duration::from_secs(60),
        };
        for _ in 0..3 {
            assert_eq!(
                limiter.peek_account_limit(limit, "acct_peek").await,
                RateLimitDecision::Allowed
            );
        }
        for _ in 0..2 {
            limiter.observe_account_limit(limit, "acct_peek").await;
        }
        assert!(matches!(
            limiter.peek_account_limit(limit, "acct_peek").await,
            RateLimitDecision::Limited { .. }
        ));
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
        for limit in [MESSAGE_SEND_LIMIT, CONTACT_ADD_LIMIT, AGENT_RUN_CLAIM_LIMIT] {
            assert_ne!(EMAIL_VERIFICATION_LIMIT.action, limit.action);
        }
    }

    #[tokio::test]
    async fn email_verification_allows_a_full_code_cycle_then_stops() {
        let limiter = CloudRateLimiter::memory(CloudRateLimitConfig::default());
        // One send plus five guesses for one code must fit the hourly budget.
        const { assert!(EMAIL_VERIFICATION_LIMIT.limit >= 6) };
        assert_eq!(EMAIL_VERIFICATION_LIMIT.window, Duration::from_secs(3600));
        for _ in 0..EMAIL_VERIFICATION_LIMIT.limit {
            assert_eq!(
                limiter
                    .observe_account_limit(EMAIL_VERIFICATION_LIMIT, "acct_email")
                    .await,
                RateLimitDecision::Allowed
            );
        }
        assert!(matches!(
            limiter
                .observe_account_limit(EMAIL_VERIFICATION_LIMIT, "acct_email")
                .await,
            RateLimitDecision::Limited { .. }
        ));
        assert_eq!(
            limiter
                .observe_account_limit(EMAIL_VERIFICATION_LIMIT, "acct_other_email")
                .await,
            RateLimitDecision::Allowed
        );
    }

    #[tokio::test]
    async fn agent_runs_draw_from_the_agent_run_claim_budget() {
        let limiter = CloudRateLimiter::memory(CloudRateLimitConfig::default());
        for _ in 1..AGENT_RUN_CLAIM_LIMIT.limit {
            limiter
                .observe_account_limit(AGENT_RUN_CLAIM_LIMIT, "acct_runs")
                .await;
        }
        assert_eq!(
            limiter.observe_agent_run("acct_runs").await,
            RateLimitDecision::Allowed
        );
        assert!(matches!(
            limiter.observe_agent_run("acct_runs").await,
            RateLimitDecision::Limited { .. }
        ));
        assert!(matches!(
            limiter
                .observe_account_limit(AGENT_RUN_CLAIM_LIMIT, "acct_runs")
                .await,
            RateLimitDecision::Limited { .. }
        ));
        assert_eq!(
            limiter.observe_agent_run("acct_other_runs").await,
            RateLimitDecision::Allowed
        );
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
