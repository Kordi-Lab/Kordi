//! Counting for every named budget. A bucket is one budget for one subject
//! (an account, a client address, or an identifier such as an email), so no
//! two budgets ever share a counter.
//!
//! The memory backend keeps a sliding window of timestamps. The Redis backend
//! keeps a fixed-window counter (`<prefix>:<namespace>:<action>:<subject>`)
//! whose INCR and `EXPIRE NX` run in one MULTI/EXEC, so a counter can never
//! outlive its window. Redis errors fall open, like every other Redis check.

use super::*;

/// The kind of subject a bucket counts. It is part of the key, so an account
/// ID can never collide with an address or an email.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Namespace {
    Account,
    Address,
    Identifier,
}

impl Namespace {
    fn as_str(self) -> &'static str {
        match self {
            Self::Account => "acct",
            Self::Address => "addr",
            Self::Identifier => "id",
        }
    }
}

fn memory_key(namespace: Namespace, action: &str, subject: &str) -> String {
    format!("{}:{action}:{subject}", namespace.as_str())
}

fn redis_key(store: &RedisStore, namespace: Namespace, action: &str, subject: &str) -> String {
    format!(
        "{}:{}:{action}:{subject}",
        store.key_prefix,
        namespace.as_str()
    )
}

fn remaining_window(window: Duration, oldest: Instant, now: Instant) -> Duration {
    window
        .checked_sub(now.duration_since(oldest))
        .unwrap_or(window)
}

impl CloudRateLimiter {
    /// Records one hit against `limit` for `subject`. Returns `Limited`
    /// without recording when the budget is already spent. An operator
    /// override from [`super::BUDGETS_ENV`] replaces the built-in budget, and
    /// a budget switched off always allows.
    pub(super) async fn observe_bucket(
        &self,
        namespace: Namespace,
        limit: AccountActionLimit,
        subject: &str,
    ) -> RateLimitDecision {
        match self.overrides.apply(limit) {
            Some(limit) => self.observe_bucket_exact(namespace, limit, subject).await,
            None => RateLimitDecision::Allowed,
        }
    }

    /// Like [`Self::observe_bucket`] for a budget the caller already resolved
    /// against the overrides (and, for addresses, scaled).
    pub(super) async fn observe_bucket_exact(
        &self,
        namespace: Namespace,
        limit: AccountActionLimit,
        subject: &str,
    ) -> RateLimitDecision {
        match &self.backend {
            Backend::Memory(store) => observe_memory(store, namespace, limit, subject),
            Backend::Redis(store) => observe_redis(store, namespace, limit, subject).await,
        }
    }

    /// Whether `limit` is already spent for `subject`, without recording.
    pub(super) async fn peek_bucket(
        &self,
        namespace: Namespace,
        limit: AccountActionLimit,
        subject: &str,
    ) -> RateLimitDecision {
        let Some(limit) = self.overrides.apply(limit) else {
            return RateLimitDecision::Allowed;
        };
        match &self.backend {
            Backend::Memory(store) => peek_memory(store, namespace, limit, subject),
            Backend::Redis(store) => peek_redis(store, namespace, limit, subject).await,
        }
    }
}

fn observe_memory(
    store: &MemoryStore,
    namespace: Namespace,
    limit: AccountActionLimit,
    subject: &str,
) -> RateLimitDecision {
    let mut buckets = store.buckets.lock().expect("rate limiter poisoned");
    let entry = buckets
        .entry(memory_key(namespace, limit.action, subject))
        .or_default();
    let now = Instant::now();
    let window_start = now.checked_sub(limit.window).unwrap_or(now);
    while entry.front().is_some_and(|front| *front < window_start) {
        entry.pop_front();
    }
    if entry.len() as u32 >= limit.limit {
        let oldest = entry.front().copied().unwrap_or(now);
        return RateLimitDecision::Limited {
            retry_after: remaining_window(limit.window, oldest, now),
        };
    }
    entry.push_back(now);
    RateLimitDecision::Allowed
}

fn peek_memory(
    store: &MemoryStore,
    namespace: Namespace,
    limit: AccountActionLimit,
    subject: &str,
) -> RateLimitDecision {
    let mut buckets = store.buckets.lock().expect("rate limiter poisoned");
    let Some(entry) = buckets.get_mut(&memory_key(namespace, limit.action, subject)) else {
        return RateLimitDecision::Allowed;
    };
    let now = Instant::now();
    let window_start = now.checked_sub(limit.window).unwrap_or(now);
    while entry.front().is_some_and(|front| *front < window_start) {
        entry.pop_front();
    }
    if (entry.len() as u32) < limit.limit {
        return RateLimitDecision::Allowed;
    }
    let oldest = entry.front().copied().unwrap_or(now);
    RateLimitDecision::Limited {
        retry_after: remaining_window(limit.window, oldest, now),
    }
}

async fn limited_by_ttl(
    conn: &mut ConnectionManager,
    key: &str,
    window: Duration,
) -> RateLimitDecision {
    let pttl_ms: i64 = conn.pttl(key).await.unwrap_or(0);
    RateLimitDecision::Limited {
        retry_after: if pttl_ms > 0 {
            Duration::from_millis(pttl_ms as u64)
        } else {
            window
        },
    }
}

async fn observe_redis(
    store: &RedisStore,
    namespace: Namespace,
    limit: AccountActionLimit,
    subject: &str,
) -> RateLimitDecision {
    let mut conn = store.conn.clone();
    let key = redis_key(store, namespace, limit.action, subject);
    let window_secs = limit.window.as_secs().max(1) as i64;
    let (count,): (i64,) = match redis::pipe()
        .atomic()
        .incr(&key, 1)
        .cmd("EXPIRE")
        .arg(&key)
        .arg(window_secs)
        .arg("NX")
        .ignore()
        .query_async(&mut conn)
        .await
    {
        Ok(value) => value,
        Err(err) => {
            eprintln!("[rate_limit] redis INCR/EXPIRE {key}: {err}");
            return RateLimitDecision::Allowed;
        }
    };
    if count > i64::from(limit.limit) {
        return limited_by_ttl(&mut conn, &key, limit.window).await;
    }
    RateLimitDecision::Allowed
}

async fn peek_redis(
    store: &RedisStore,
    namespace: Namespace,
    limit: AccountActionLimit,
    subject: &str,
) -> RateLimitDecision {
    let mut conn = store.conn.clone();
    let key = redis_key(store, namespace, limit.action, subject);
    let count: Option<i64> = match conn.get(&key).await {
        Ok(value) => value,
        Err(err) => {
            eprintln!("[rate_limit] redis GET {key}: {err}");
            return RateLimitDecision::Allowed;
        }
    };
    if count.unwrap_or(0) < i64::from(limit.limit) {
        return RateLimitDecision::Allowed;
    }
    limited_by_ttl(&mut conn, &key, limit.window).await
}
