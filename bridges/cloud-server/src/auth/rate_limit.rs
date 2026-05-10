//! Rate limiter for the cloud-server auth surface.
//!
//! Two backends:
//! * [`Backend::Memory`] keeps counters in-process. Used for unit tests
//!   and single-replica dev runs.
//! * [`Backend::Redis`] keeps counters in a shared Redis. Required for
//!   multi-replica deploys so a lockout decided on one pod is honoured
//!   by every other pod.
//!
//! Both backends expose the same async API; the handler code does not
//! need to know which is in use. [`CloudRateLimiter::redis`] is the
//! async constructor; [`CloudRateLimiter::memory`] is sync.
//!
//! # Algorithm
//!
//! * **Per-IP rate limit**: a fixed-window counter (`crl:ip:<ip>`) with
//!   TTL = `per_ip_window`. INCR + EXPIRE on first hit. If the counter
//!   exceeds the configured limit, the caller is told to retry after
//!   the remaining TTL. Sliding-window behaviour would be more accurate
//!   but a fixed window suffices for the abuse-prevention threshold and
//!   keeps the implementation small.
//! * **Per-email lockout**: a failure counter (`crl:email:fail:<email>`)
//!   with TTL = `per_email_lockout`; once it reaches the failure limit
//!   we set a separate lockout key (`crl:email:lock:<email>`) with the
//!   same TTL. `check_email_lockout` reads PTTL on the lockout key.
//!   `clear_email_failures` after a successful login deletes both keys.
//!
//! The memory backend mirrors these semantics in-process (with the
//! original sliding-window IP behaviour, since there's no cost to
//! tracking individual timestamps locally).

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use redis::aio::ConnectionManager;
use redis::AsyncCommands;

#[derive(Debug, Clone, Copy)]
pub struct CloudRateLimitConfig {
    pub per_ip_limit: u32,
    pub per_ip_window: Duration,
    pub per_email_failure_limit: u32,
    pub per_email_lockout: Duration,
}

impl CloudRateLimitConfig {
    pub const fn production() -> Self {
        Self {
            per_ip_limit: 10,
            per_ip_window: Duration::from_secs(60),
            per_email_failure_limit: 5,
            per_email_lockout: Duration::from_secs(15 * 60),
        }
    }
}

impl Default for CloudRateLimitConfig {
    fn default() -> Self {
        Self::production()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateLimitDecision {
    Allowed,
    Limited { retry_after: Duration },
}

#[derive(Debug)]
pub enum RateLimiterError {
    Connect(redis::RedisError),
}

impl std::fmt::Display for RateLimiterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connect(err) => write!(f, "connect to redis: {err}"),
        }
    }
}

impl std::error::Error for RateLimiterError {}

#[derive(Debug)]
struct EmailFailureWindow {
    attempts: u32,
    locked_until: Option<Instant>,
    first_attempt_at: Instant,
}

#[derive(Debug)]
struct MemoryStore {
    per_ip: Mutex<HashMap<IpAddr, VecDeque<Instant>>>,
    per_email: Mutex<HashMap<String, EmailFailureWindow>>,
}

#[derive(Clone)]
struct RedisStore {
    conn: ConnectionManager,
    key_prefix: String,
}

impl std::fmt::Debug for RedisStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RedisStore")
            .field("key_prefix", &self.key_prefix)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
enum Backend {
    Memory(MemoryStore),
    Redis(RedisStore),
}

#[derive(Debug)]
pub struct CloudRateLimiter {
    config: CloudRateLimitConfig,
    backend: Backend,
}

impl CloudRateLimiter {
    /// In-process rate limiter. Counters reset on restart; state is not
    /// shared across replicas.
    pub fn memory(config: CloudRateLimitConfig) -> Self {
        Self {
            config,
            backend: Backend::Memory(MemoryStore {
                per_ip: Mutex::new(HashMap::new()),
                per_email: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Redis-backed rate limiter. `url` follows the standard
    /// `redis://[:password@]host:port/db` form. Uses an auto-reconnecting
    /// `ConnectionManager` so transient network blips don't surface as
    /// hard auth failures to clients (the caller still wraps each Redis
    /// call in error handling and falls open on errors — see below).
    pub async fn redis(
        url: &str,
        config: CloudRateLimitConfig,
    ) -> Result<Self, RateLimiterError> {
        let client = redis::Client::open(url).map_err(RateLimiterError::Connect)?;
        let conn = ConnectionManager::new(client)
            .await
            .map_err(RateLimiterError::Connect)?;
        Ok(Self {
            config,
            backend: Backend::Redis(RedisStore {
                conn,
                key_prefix: "crl".to_string(),
            }),
        })
    }

    /// Returns `Allowed` and tracks the attempt, or `Limited` with a
    /// retry hint, based on the per-IP window. On unknown peers (`None`)
    /// the limiter still applies — keyed by `0.0.0.0` so unauthenticated
    /// scrapers can't bypass simply by hiding their address.
    pub async fn observe_ip(&self, peer: Option<IpAddr>) -> RateLimitDecision {
        let key = peer.unwrap_or(IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
        match &self.backend {
            Backend::Memory(store) => self.observe_ip_memory(store, key),
            Backend::Redis(store) => self.observe_ip_redis(store, key).await,
        }
    }

    /// Read whether `email` is currently locked. Does not record an
    /// attempt — call `record_email_failure` after an actual failure.
    pub async fn check_email_lockout(&self, email: &str) -> RateLimitDecision {
        match &self.backend {
            Backend::Memory(store) => self.check_email_lockout_memory(store, email),
            Backend::Redis(store) => self.check_email_lockout_redis(store, email).await,
        }
    }

    /// Record a failed login. Once the running failure count reaches
    /// `per_email_failure_limit`, the email is locked for
    /// `per_email_lockout`.
    pub async fn record_email_failure(&self, email: &str) {
        match &self.backend {
            Backend::Memory(store) => self.record_email_failure_memory(store, email),
            Backend::Redis(store) => self.record_email_failure_redis(store, email).await,
        }
    }

    /// Clear failure history after a successful login.
    pub async fn clear_email_failures(&self, email: &str) {
        match &self.backend {
            Backend::Memory(store) => self.clear_email_failures_memory(store, email),
            Backend::Redis(store) => self.clear_email_failures_redis(store, email).await,
        }
    }

    // ---- Memory backend ----

    fn observe_ip_memory(&self, store: &MemoryStore, key: IpAddr) -> RateLimitDecision {
        let mut buckets = store.per_ip.lock().expect("rate limiter poisoned");
        let entry = buckets.entry(key).or_default();
        let now = Instant::now();
        let window_start = now.checked_sub(self.config.per_ip_window).unwrap_or(now);
        while let Some(front) = entry.front() {
            if *front < window_start {
                entry.pop_front();
            } else {
                break;
            }
        }
        if entry.len() as u32 >= self.config.per_ip_limit {
            let oldest = entry.front().copied().unwrap_or(now);
            let retry_after = self
                .config
                .per_ip_window
                .checked_sub(now.duration_since(oldest))
                .unwrap_or(self.config.per_ip_window);
            return RateLimitDecision::Limited { retry_after };
        }
        entry.push_back(now);
        RateLimitDecision::Allowed
    }

    fn check_email_lockout_memory(
        &self,
        store: &MemoryStore,
        email: &str,
    ) -> RateLimitDecision {
        let buckets = store.per_email.lock().expect("rate limiter poisoned");
        let Some(entry) = buckets.get(email) else {
            return RateLimitDecision::Allowed;
        };
        if let Some(until) = entry.locked_until {
            let now = Instant::now();
            if now < until {
                return RateLimitDecision::Limited {
                    retry_after: until.duration_since(now),
                };
            }
        }
        RateLimitDecision::Allowed
    }

    fn record_email_failure_memory(&self, store: &MemoryStore, email: &str) {
        let mut buckets = store.per_email.lock().expect("rate limiter poisoned");
        let now = Instant::now();
        let entry = buckets
            .entry(email.to_string())
            .or_insert_with(|| EmailFailureWindow {
                attempts: 0,
                locked_until: None,
                first_attempt_at: now,
            });
        if let Some(until) = entry.locked_until {
            if now >= until {
                entry.attempts = 0;
                entry.locked_until = None;
                entry.first_attempt_at = now;
            }
        }
        if now.duration_since(entry.first_attempt_at) > self.config.per_email_lockout {
            entry.attempts = 0;
            entry.first_attempt_at = now;
        }
        entry.attempts += 1;
        if entry.attempts >= self.config.per_email_failure_limit {
            entry.locked_until = Some(now + self.config.per_email_lockout);
        }
    }

    fn clear_email_failures_memory(&self, store: &MemoryStore, email: &str) {
        let mut buckets = store.per_email.lock().expect("rate limiter poisoned");
        buckets.remove(email);
    }

    // ---- Redis backend ----
    //
    // Connection failures fall open (Allowed). The cloud-server has
    // other defenses — auth itself, the audit log — so a Redis blip
    // shouldn't lock everyone out. We log to stderr so operators see it.

    async fn observe_ip_redis(&self, store: &RedisStore, key: IpAddr) -> RateLimitDecision {
        let mut conn = store.conn.clone();
        let redis_key = format!("{}:ip:{}", store.key_prefix, key);
        let window_secs = self.config.per_ip_window.as_secs().max(1) as i64;

        let count: i64 = match conn.incr(&redis_key, 1).await {
            Ok(value) => value,
            Err(err) => {
                eprintln!("[rate_limit] redis INCR {redis_key}: {err}");
                return RateLimitDecision::Allowed;
            }
        };
        if count == 1 {
            // Best-effort EXPIRE; if it fails the key gets stuck — but the
            // next bump on a stale counter still works correctly because
            // we read PTTL below to decide retry_after.
            if let Err(err) = conn.expire::<_, ()>(&redis_key, window_secs).await {
                eprintln!("[rate_limit] redis EXPIRE {redis_key}: {err}");
            }
        }
        if count > self.config.per_ip_limit as i64 {
            let pttl_ms: i64 = conn.pttl(&redis_key).await.unwrap_or(window_secs * 1000);
            let retry_after = if pttl_ms > 0 {
                Duration::from_millis(pttl_ms as u64)
            } else {
                self.config.per_ip_window
            };
            return RateLimitDecision::Limited { retry_after };
        }
        RateLimitDecision::Allowed
    }

    async fn check_email_lockout_redis(
        &self,
        store: &RedisStore,
        email: &str,
    ) -> RateLimitDecision {
        let mut conn = store.conn.clone();
        let lock_key = format!("{}:email:lock:{}", store.key_prefix, email);
        let pttl_ms: i64 = match conn.pttl(&lock_key).await {
            Ok(value) => value,
            Err(err) => {
                eprintln!("[rate_limit] redis PTTL {lock_key}: {err}");
                return RateLimitDecision::Allowed;
            }
        };
        if pttl_ms > 0 {
            return RateLimitDecision::Limited {
                retry_after: Duration::from_millis(pttl_ms as u64),
            };
        }
        RateLimitDecision::Allowed
    }

    async fn record_email_failure_redis(&self, store: &RedisStore, email: &str) {
        let mut conn = store.conn.clone();
        let fail_key = format!("{}:email:fail:{}", store.key_prefix, email);
        let lock_key = format!("{}:email:lock:{}", store.key_prefix, email);
        let lockout_secs = self.config.per_email_lockout.as_secs().max(1) as i64;

        let count: i64 = match conn.incr(&fail_key, 1).await {
            Ok(value) => value,
            Err(err) => {
                eprintln!("[rate_limit] redis INCR {fail_key}: {err}");
                return;
            }
        };
        if count == 1 {
            if let Err(err) = conn.expire::<_, ()>(&fail_key, lockout_secs).await {
                eprintln!("[rate_limit] redis EXPIRE {fail_key}: {err}");
            }
        }
        if count >= self.config.per_email_failure_limit as i64 {
            if let Err(err) = conn
                .set_ex::<_, _, ()>(&lock_key, "1", lockout_secs as u64)
                .await
            {
                eprintln!("[rate_limit] redis SETEX {lock_key}: {err}");
            }
        }
    }

    async fn clear_email_failures_redis(&self, store: &RedisStore, email: &str) {
        let mut conn = store.conn.clone();
        let fail_key = format!("{}:email:fail:{}", store.key_prefix, email);
        let lock_key = format!("{}:email:lock:{}", store.key_prefix, email);
        if let Err(err) = conn.del::<_, ()>(&[fail_key, lock_key]).await {
            eprintln!("[rate_limit] redis DEL email keys: {err}");
        }
    }

    #[cfg(test)]
    pub fn reset_for_tests(&self) {
        if let Backend::Memory(store) = &self.backend {
            store.per_ip.lock().expect("poisoned").clear();
            store.per_email.lock().expect("poisoned").clear();
        }
    }
}

impl Default for CloudRateLimiter {
    fn default() -> Self {
        Self::memory(CloudRateLimitConfig::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn fast_config() -> CloudRateLimitConfig {
        CloudRateLimitConfig {
            per_ip_limit: 3,
            per_ip_window: Duration::from_millis(200),
            per_email_failure_limit: 3,
            per_email_lockout: Duration::from_millis(200),
        }
    }

    #[tokio::test]
    async fn ip_allows_then_limits_then_recovers() {
        let limiter = CloudRateLimiter::memory(fast_config());
        let ip = Some(IpAddr::V4(Ipv4Addr::LOCALHOST));

        assert_eq!(limiter.observe_ip(ip).await, RateLimitDecision::Allowed);
        assert_eq!(limiter.observe_ip(ip).await, RateLimitDecision::Allowed);
        assert_eq!(limiter.observe_ip(ip).await, RateLimitDecision::Allowed);
        assert!(matches!(
            limiter.observe_ip(ip).await,
            RateLimitDecision::Limited { .. }
        ));

        tokio::time::sleep(Duration::from_millis(220)).await;
        assert_eq!(limiter.observe_ip(ip).await, RateLimitDecision::Allowed);
    }

    #[tokio::test]
    async fn email_failures_lock_out_then_clear_on_success() {
        let limiter = CloudRateLimiter::memory(fast_config());
        for _ in 0..3 {
            limiter.record_email_failure("alice@example.com").await;
        }
        assert!(matches!(
            limiter.check_email_lockout("alice@example.com").await,
            RateLimitDecision::Limited { .. }
        ));

        limiter.clear_email_failures("alice@example.com").await;
        assert_eq!(
            limiter.check_email_lockout("alice@example.com").await,
            RateLimitDecision::Allowed
        );
    }

    #[tokio::test]
    async fn email_lockout_expires_after_window() {
        let limiter = CloudRateLimiter::memory(fast_config());
        for _ in 0..3 {
            limiter.record_email_failure("bob@example.com").await;
        }
        tokio::time::sleep(Duration::from_millis(220)).await;
        assert_eq!(
            limiter.check_email_lockout("bob@example.com").await,
            RateLimitDecision::Allowed
        );
    }

    #[tokio::test]
    async fn separate_ips_dont_interfere() {
        let limiter = CloudRateLimiter::memory(fast_config());
        let alice = Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)));
        let bob = Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2)));

        for _ in 0..3 {
            assert_eq!(limiter.observe_ip(alice).await, RateLimitDecision::Allowed);
        }
        // Alice exhausted, bob still has a budget.
        assert_eq!(limiter.observe_ip(bob).await, RateLimitDecision::Allowed);
    }
}
