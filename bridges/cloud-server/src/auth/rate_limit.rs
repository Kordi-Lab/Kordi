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
//! * **Per-email lockout**: failures are counted per email *and* client
//!   address (`crl:email:client:<ip>:<email>:fail`) with TTL =
//!   `per_email_lockout`; once that reaches `per_email_failure_limit` a
//!   lockout key (`crl:email:client:<ip>:<email>:lock`) blocks that client
//!   only. A second, higher ceiling counts failures for the email across all
//!   clients (`crl:email:all:<email>:fail` / `crl:email:all:<email>:lock`)
//!   so distributed guessing is still bounded. Failures from one client
//!   therefore cannot lock the owner out from their own address.
//!   `clear_email_failures` after a successful login deletes that client's
//!   keys; the email-wide counter expires on its own.
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

mod account_actions;

pub use account_actions::{
    AccountActionLimit, AGENT_RUN_CLAIM_LIMIT, CONTACT_ADD_LIMIT, MESSAGE_SEND_LIMIT,
};

#[derive(Debug, Clone, Copy)]
pub struct CloudRateLimitConfig {
    pub per_ip_limit: u32,
    pub per_ip_window: Duration,
    /// Failed logins allowed for one email from one client address.
    pub per_email_failure_limit: u32,
    pub per_email_lockout: Duration,
    /// Failed logins allowed for one email across every client address.
    pub per_email_global_failure_limit: u32,
}

impl CloudRateLimitConfig {
    pub const fn production() -> Self {
        Self {
            per_ip_limit: 10,
            per_ip_window: Duration::from_secs(60),
            per_email_failure_limit: 5,
            per_email_lockout: Duration::from_secs(15 * 60),
            per_email_global_failure_limit: 50,
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

/// Counter scopes for one login email: the email from a single client
/// address, and the email across all clients. Unknown client addresses share
/// one scope, like [`CloudRateLimiter::observe_ip`].
struct EmailLockoutKeys {
    client: String,
    global: String,
}

impl EmailLockoutKeys {
    fn new(email: &str, client: Option<IpAddr>) -> Self {
        let client = client.unwrap_or(IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
        Self {
            client: format!("client:{client}:{email}"),
            global: format!("all:{email}"),
        }
    }
}

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
    per_account_action: Mutex<HashMap<String, VecDeque<Instant>>>,
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
                per_account_action: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Redis-backed rate limiter. `url` follows the standard
    /// `redis://[:password@]host:port/db` form. Uses an auto-reconnecting
    /// `ConnectionManager` so transient network blips don't surface as
    /// hard auth failures to clients (the caller still wraps each Redis
    /// call in error handling and falls open on errors — see below).
    pub async fn redis(url: &str, config: CloudRateLimitConfig) -> Result<Self, RateLimiterError> {
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

    /// Read whether `email` is currently locked for `client`, either by that
    /// client's own failures or by the email-wide ceiling. Does not record an
    /// attempt — call `record_email_failure` after an actual failure.
    pub async fn check_email_lockout(
        &self,
        email: &str,
        client: Option<IpAddr>,
    ) -> RateLimitDecision {
        let keys = EmailLockoutKeys::new(email, client);
        match &self.backend {
            Backend::Memory(store) => self.check_email_lockout_memory(store, &keys),
            Backend::Redis(store) => self.check_email_lockout_redis(store, &keys).await,
        }
    }

    /// Record a failed login. Once the failures for this email from `client`
    /// reach `per_email_failure_limit`, that client is locked out of the email
    /// for `per_email_lockout`; once failures from all clients reach
    /// `per_email_global_failure_limit`, every client is.
    pub async fn record_email_failure(&self, email: &str, client: Option<IpAddr>) {
        let keys = EmailLockoutKeys::new(email, client);
        match &self.backend {
            Backend::Memory(store) => self.record_email_failure_memory(store, &keys),
            Backend::Redis(store) => self.record_email_failure_redis(store, &keys).await,
        }
    }

    /// Clear this client's failure history after a successful login.
    pub async fn clear_email_failures(&self, email: &str, client: Option<IpAddr>) {
        let keys = EmailLockoutKeys::new(email, client);
        match &self.backend {
            Backend::Memory(store) => self.clear_email_failures_memory(store, &keys),
            Backend::Redis(store) => self.clear_email_failures_redis(store, &keys).await,
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
        keys: &EmailLockoutKeys,
    ) -> RateLimitDecision {
        let buckets = store.per_email.lock().expect("rate limiter poisoned");
        let now = Instant::now();
        let retry_after = [&keys.client, &keys.global]
            .into_iter()
            .filter_map(|key| buckets.get(key.as_str())?.locked_until)
            .filter(|until| now < *until)
            .map(|until| until.duration_since(now))
            .max();
        match retry_after {
            Some(retry_after) => RateLimitDecision::Limited { retry_after },
            None => RateLimitDecision::Allowed,
        }
    }

    fn record_email_failure_memory(&self, store: &MemoryStore, keys: &EmailLockoutKeys) {
        let mut buckets = store.per_email.lock().expect("rate limiter poisoned");
        let now = Instant::now();
        for (key, limit) in [
            (&keys.client, self.config.per_email_failure_limit),
            (&keys.global, self.config.per_email_global_failure_limit),
        ] {
            let entry = buckets
                .entry(key.clone())
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
            if entry.attempts >= limit {
                entry.locked_until = Some(now + self.config.per_email_lockout);
            }
        }
    }

    fn clear_email_failures_memory(&self, store: &MemoryStore, keys: &EmailLockoutKeys) {
        let mut buckets = store.per_email.lock().expect("rate limiter poisoned");
        buckets.remove(&keys.client);
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
        keys: &EmailLockoutKeys,
    ) -> RateLimitDecision {
        let mut conn = store.conn.clone();
        let mut retry_after = None;
        for scope in [&keys.client, &keys.global] {
            let lock_key = format!("{}:email:{scope}:lock", store.key_prefix);
            let pttl_ms: i64 = match conn.pttl(&lock_key).await {
                Ok(value) => value,
                Err(err) => {
                    eprintln!("[rate_limit] redis PTTL {lock_key}: {err}");
                    return RateLimitDecision::Allowed;
                }
            };
            if pttl_ms > 0 {
                retry_after = retry_after.max(Some(Duration::from_millis(pttl_ms as u64)));
            }
        }
        match retry_after {
            Some(retry_after) => RateLimitDecision::Limited { retry_after },
            None => RateLimitDecision::Allowed,
        }
    }

    async fn record_email_failure_redis(&self, store: &RedisStore, keys: &EmailLockoutKeys) {
        let mut conn = store.conn.clone();
        let lockout_secs = self.config.per_email_lockout.as_secs().max(1) as i64;
        for (scope, limit) in [
            (&keys.client, self.config.per_email_failure_limit),
            (&keys.global, self.config.per_email_global_failure_limit),
        ] {
            let fail_key = format!("{}:email:{scope}:fail", store.key_prefix);
            let lock_key = format!("{}:email:{scope}:lock", store.key_prefix);
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
            if count >= limit as i64 {
                if let Err(err) = conn
                    .set_ex::<_, _, ()>(&lock_key, "1", lockout_secs as u64)
                    .await
                {
                    eprintln!("[rate_limit] redis SETEX {lock_key}: {err}");
                }
            }
        }
    }

    async fn clear_email_failures_redis(&self, store: &RedisStore, keys: &EmailLockoutKeys) {
        let mut conn = store.conn.clone();
        let fail_key = format!("{}:email:{}:fail", store.key_prefix, keys.client);
        let lock_key = format!("{}:email:{}:lock", store.key_prefix, keys.client);
        if let Err(err) = conn.del::<_, ()>(&[fail_key, lock_key]).await {
            eprintln!("[rate_limit] redis DEL email keys: {err}");
        }
    }

    #[cfg(test)]
    pub fn reset_for_tests(&self) {
        if let Backend::Memory(store) = &self.backend {
            store.per_ip.lock().expect("poisoned").clear();
            store.per_email.lock().expect("poisoned").clear();
            store.per_account_action.lock().expect("poisoned").clear();
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
            per_email_global_failure_limit: 7,
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

    fn client(last: u8) -> Option<IpAddr> {
        Some(IpAddr::V4(Ipv4Addr::new(203, 0, 113, last)))
    }

    #[tokio::test]
    async fn email_failures_lock_out_then_clear_on_success() {
        let limiter = CloudRateLimiter::memory(fast_config());
        for _ in 0..3 {
            limiter
                .record_email_failure("alice@example.com", client(1))
                .await;
        }
        assert!(matches!(
            limiter
                .check_email_lockout("alice@example.com", client(1))
                .await,
            RateLimitDecision::Limited { .. }
        ));

        limiter
            .clear_email_failures("alice@example.com", client(1))
            .await;
        assert_eq!(
            limiter
                .check_email_lockout("alice@example.com", client(1))
                .await,
            RateLimitDecision::Allowed
        );
    }

    #[tokio::test]
    async fn email_lockout_expires_after_window() {
        let limiter = CloudRateLimiter::memory(fast_config());
        for _ in 0..3 {
            limiter
                .record_email_failure("bob@example.com", client(1))
                .await;
        }
        tokio::time::sleep(Duration::from_millis(220)).await;
        assert_eq!(
            limiter
                .check_email_lockout("bob@example.com", client(1))
                .await,
            RateLimitDecision::Allowed
        );
    }

    #[tokio::test]
    async fn one_client_failures_do_not_lock_out_other_clients() {
        let limiter = CloudRateLimiter::memory(fast_config());
        for _ in 0..3 {
            limiter
                .record_email_failure("owner@example.com", client(1))
                .await;
        }
        assert!(matches!(
            limiter
                .check_email_lockout("owner@example.com", client(1))
                .await,
            RateLimitDecision::Limited { .. }
        ));
        assert_eq!(
            limiter
                .check_email_lockout("owner@example.com", client(2))
                .await,
            RateLimitDecision::Allowed,
            "the owner's own address keeps its budget"
        );
        assert_eq!(
            limiter
                .check_email_lockout("other@example.com", client(1))
                .await,
            RateLimitDecision::Allowed
        );
    }

    #[tokio::test]
    async fn email_wide_ceiling_bounds_distributed_failures() {
        let limiter = CloudRateLimiter::memory(fast_config());
        // Seven failures spread over clients 1..=7 stay below the per-client
        // limit but reach the email-wide ceiling.
        for last in 1..=7 {
            assert_eq!(
                limiter
                    .check_email_lockout("target@example.com", client(last))
                    .await,
                RateLimitDecision::Allowed
            );
            limiter
                .record_email_failure("target@example.com", client(last))
                .await;
        }
        assert!(matches!(
            limiter
                .check_email_lockout("target@example.com", client(99))
                .await,
            RateLimitDecision::Limited { .. }
        ));
        limiter
            .clear_email_failures("target@example.com", client(99))
            .await;
        assert!(
            matches!(
                limiter
                    .check_email_lockout("target@example.com", client(99))
                    .await,
                RateLimitDecision::Limited { .. }
            ),
            "a success does not reset the email-wide ceiling"
        );
        tokio::time::sleep(Duration::from_millis(220)).await;
        assert_eq!(
            limiter
                .check_email_lockout("target@example.com", client(99))
                .await,
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
