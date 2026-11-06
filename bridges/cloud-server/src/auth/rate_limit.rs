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
//! * **Named budgets**: every route charges its own budget for its own
//!   subject: the account for authenticated routes, the client address and
//!   the target identifier (such as an email) for unauthenticated ones. No
//!   two routes share a counter, so loading avatars and profiles never spends
//!   the budget for creating an invitation. See [`budgets`] for the routes
//!   and [`buckets`] for the counters (`crl:<acct|addr|id>:<budget>:<subject>`
//!   in Redis). Operators can replace any budget with [`BUDGETS_ENV`].
//! * **Refusals** name the exact wait in `Retry-After` and the JSON body; see
//!   [`rate_limited_response`].
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
//! * **Trusted networks**: clients inside an operator-configured range get
//!   every per-address limit multiplied; see [`TrustedNetworks`].
//!
//! The memory backend mirrors these semantics in-process, with sliding
//! windows since there is no cost to tracking individual timestamps locally.

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv6Addr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use redis::aio::ConnectionManager;
use redis::AsyncCommands;

mod account_actions;
mod buckets;
pub mod budgets;
mod email_lockout;
mod response;
mod trusted_networks;

pub use account_actions::{
    AccountActionLimit, ACCOUNT_SECURITY_CHANGE_LIMIT, ACCOUNT_SECURITY_PROOF_LIMIT,
    AGENT_RUN_CLAIM_LIMIT, BLOCK_CHANGE_LIMIT, CONTACT_ADD_LIMIT, DOCUMENT_COLLAB_TICKET_LIMIT,
    DOCUMENT_PUBLIC_READ_LIMIT, DOCUMENT_PUBLIC_WRITE_LIMIT, EMAIL_VERIFICATION_LIMIT,
    MESSAGE_SEND_LIMIT, REPORT_SUBMIT_LIMIT,
};
pub use budgets::{
    BudgetOverrides, APP_AUTHORIZE_ADDRESS_LIMIT, APP_INVITATION_CREATE_LIMIT,
    APP_TOKEN_ADDRESS_LIMIT, AVATAR_RENDER_ADDRESS_LIMIT, BUDGETS_ENV,
    GROUP_INVITATION_CREATE_LIMIT, GROUP_INVITATION_RESET_LIMIT, GROUP_LEAVE_LIMIT,
    INVITATION_ACCEPT_LIMIT, INVITATION_PAGE_CLAIM_ADDRESS_LIMIT, INVITATION_VIEW_ADDRESS_LIMIT,
    LOGIN_ADDRESS_LIMIT, LOGIN_EMAIL_LIMIT, MEMORY_IMPORT_EXTRACT_LIMIT, PROFILE_LOOKUP_LIMIT,
    SIGNUP_ADDRESS_LIMIT, SIGNUP_CODE_ADDRESS_LIMIT, SIGNUP_CODE_EMAIL_LIMIT, SIGNUP_EMAIL_LIMIT,
};
pub use response::{
    rate_limited_response, rate_limited_response_with, retry_after_seconds, RATE_LIMITED_CODE,
};
pub use trusted_networks::{TrustedNetworks, TRUSTED_MULTIPLIER_ENV, TRUSTED_NETWORKS_ENV};

#[derive(Debug, Clone, Copy)]
pub struct CloudRateLimitConfig {
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

/// The address a client is counted under for per-address budgets and lockouts.
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
    /// Every named budget's sliding window, keyed by namespace, budget, and
    /// subject.
    buckets: Mutex<HashMap<String, VecDeque<Instant>>>,
    per_email: Mutex<HashMap<String, EmailFailureWindow>>,
    /// Client scopes that signed in successfully, with their expiry.
    familiar_clients: Mutex<HashMap<String, Instant>>,
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
    trusted: TrustedNetworks,
    overrides: BudgetOverrides,
}

impl CloudRateLimiter {
    /// In-process rate limiter. Counters reset on restart; state is not
    /// shared across replicas.
    pub fn memory(config: CloudRateLimitConfig) -> Self {
        Self {
            config,
            trusted: TrustedNetworks::none(),
            overrides: BudgetOverrides::default(),
            backend: Backend::Memory(MemoryStore {
                buckets: Mutex::new(HashMap::new()),
                per_email: Mutex::new(HashMap::new()),
                familiar_clients: Mutex::new(HashMap::new()),
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
            trusted: TrustedNetworks::none(),
            overrides: BudgetOverrides::default(),
            backend: Backend::Redis(RedisStore {
                conn,
                key_prefix: "crl".to_string(),
            }),
        })
    }

    /// Multiplies per-address limits for clients inside `trusted`.
    pub fn with_trusted_networks(mut self, trusted: TrustedNetworks) -> Self {
        self.trusted = trusted;
        self
    }

    pub fn trusted_networks(&self) -> &TrustedNetworks {
        &self.trusted
    }

    /// A per-address budget for `client`, multiplied when it is trusted, for
    /// callers that count it under their own key. Prefer
    /// [`Self::observe_address_limit`], which also applies operator overrides
    /// before scaling.
    pub fn address_limit(
        &self,
        limit: AccountActionLimit,
        client: Option<IpAddr>,
    ) -> AccountActionLimit {
        self.trusted.scale_action(limit, client)
    }

    /// Readiness for hosted deployments that require shared rate limits.
    pub async fn is_ready(&self) -> bool {
        match &self.backend {
            Backend::Redis(store) => {
                let mut conn = store.conn.clone();
                redis::cmd("PING")
                    .query_async::<String>(&mut conn)
                    .await
                    .is_ok_and(|reply| reply == "PONG")
            }
            Backend::Memory(_) => false,
        }
    }

    #[cfg(test)]
    pub fn reset_for_tests(&self) {
        if let Backend::Memory(store) = &self.backend {
            store.buckets.lock().expect("poisoned").clear();
            store.per_email.lock().expect("poisoned").clear();
            store.familiar_clients.lock().expect("poisoned").clear();
        }
    }
}

impl Default for CloudRateLimiter {
    fn default() -> Self {
        Self::memory(CloudRateLimitConfig::default())
    }
}

#[cfg(test)]
mod budget_tests;
#[cfg(test)]
mod redis_tests;
#[cfg(test)]
mod tests;
