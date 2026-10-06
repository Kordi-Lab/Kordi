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
//!   TTL = `per_ip_window`. INCR and `EXPIRE NX` run atomically on every
//!   hit. If the counter exceeds the configured limit, the caller is told
//!   to retry after the remaining TTL. Sliding-window behaviour would be
//!   more accurate but a fixed window suffices for the abuse-prevention
//!   threshold and keeps the implementation small.
//! * **Per-email lockout**: failures are counted per email *and* client
//!   address (`crl:email:client:<ip>:<email>:fail`) with TTL =
//!   `per_email_lockout`; once that reaches `per_email_failure_limit` a
//!   lockout key (`crl:email:client:<ip>:<email>:lock`) blocks that client.
//!   A second counter covers the email across all clients
//!   (`crl:email:all:<email>:fail` / `crl:email:all:<email>:lock`); once it
//!   reaches `per_email_global_failure_limit`, every client that has not
//!   signed in to that email recently is blocked, which bounds guessing
//!   spread over many addresses. A successful sign-in or signup marks the
//!   client as familiar for that email (`crl:email:client:<ip>:<email>:known`,
//!   TTL [`FAMILIAR_CLIENT_TTL`]) and clears its failures. Familiar clients
//!   keep their own per-client budget during an email-wide lock, so guesses
//!   from elsewhere cannot lock the owner out of an address they already use.
//!   The email-wide counter expires on its own.
//! * **Client keys**: IPv4 addresses (including IPv4-mapped IPv6) count on
//!   their own; other IPv6 addresses count by their /64 prefix, because one
//!   host usually controls a whole /64.
//!
//! The memory backend mirrors these semantics in-process (with the
//! original sliding-window IP behaviour, since there's no cost to
//! tracking individual timestamps locally).

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv6Addr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use redis::aio::ConnectionManager;
use redis::AsyncCommands;

mod account_actions;
mod email_lockout;

pub use account_actions::{
    AccountActionLimit, AGENT_RUN_CLAIM_LIMIT, CONTACT_ADD_LIMIT, EMAIL_VERIFICATION_LIMIT,
    MESSAGE_SEND_LIMIT,
};

#[derive(Debug, Clone, Copy)]
pub struct CloudRateLimitConfig {
    pub per_ip_limit: u32,
    pub per_ip_window: Duration,
    /// Failed logins allowed for one email from one client address.
    pub per_email_failure_limit: u32,
    pub per_email_lockout: Duration,
    /// Failed logins for one email across every client address after which
    /// only familiar clients may still try.
    pub per_email_global_failure_limit: u32,
}

/// How long a client that signed in to an email stays familiar for it. Matches
/// the default session lifetime.
pub const FAMILIAR_CLIENT_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// The in-process backend drops expired familiar clients once it holds this
/// many, so a long-running single replica does not grow without bound.
const MEMORY_FAMILIAR_CLIENT_PRUNE_THRESHOLD: usize = 10_000;

impl CloudRateLimitConfig {
    pub const fn production() -> Self {
        Self {
            per_ip_limit: 10,
            per_ip_window: Duration::from_secs(60),
            per_email_failure_limit: 5,
            per_email_lockout: Duration::from_secs(15 * 60),
            per_email_global_failure_limit: 10,
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

/// The address a client is counted under for rate limits and lockouts.
/// IPv4 and IPv4-mapped IPv6 addresses count on their own; other IPv6
/// addresses count by their /64 prefix. Unknown clients share `0.0.0.0`, so
/// hiding the address does not escape the limit.
pub fn rate_limit_client_key(client: Option<IpAddr>) -> IpAddr {
    match client.map(|address| address.to_canonical()) {
        Some(IpAddr::V6(address)) => {
            let mut octets = address.octets();
            octets[8..].fill(0);
            IpAddr::V6(Ipv6Addr::from(octets))
        }
        Some(address) => address,
        None => IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED),
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
    /// Client scopes that signed in successfully, with their expiry.
    familiar_clients: Mutex<HashMap<String, Instant>>,
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
                familiar_clients: Mutex::new(HashMap::new()),
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
        let key = rate_limit_client_key(peer);
        match &self.backend {
            Backend::Memory(store) => self.observe_ip_memory(store, key),
            Backend::Redis(store) => self.observe_ip_redis(store, key).await,
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

    // ---- Redis backend ----
    //
    // Connection failures fall open (Allowed). The cloud-server has
    // other defenses — auth itself, the audit log — so a Redis blip
    // shouldn't lock everyone out. We log to stderr so operators see it.

    async fn observe_ip_redis(&self, store: &RedisStore, key: IpAddr) -> RateLimitDecision {
        let mut conn = store.conn.clone();
        let redis_key = format!("{}:ip:{}", store.key_prefix, key);
        let window_secs = self.config.per_ip_window.as_secs().max(1) as i64;

        // INCR and EXPIRE NX run in one MULTI/EXEC, so the window counter can
        // never outlive its window, and a counter left without a TTL gets one.
        let (count,): (i64,) = match redis::pipe()
            .atomic()
            .incr(&redis_key, 1)
            .cmd("EXPIRE")
            .arg(&redis_key)
            .arg(window_secs)
            .arg("NX")
            .ignore()
            .query_async(&mut conn)
            .await
        {
            Ok(value) => value,
            Err(err) => {
                eprintln!("[rate_limit] redis INCR/EXPIRE {redis_key}: {err}");
                return RateLimitDecision::Allowed;
            }
        };
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

    #[cfg(test)]
    pub fn reset_for_tests(&self) {
        if let Backend::Memory(store) = &self.backend {
            store.per_ip.lock().expect("poisoned").clear();
            store.per_email.lock().expect("poisoned").clear();
            store.familiar_clients.lock().expect("poisoned").clear();
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
mod tests;
