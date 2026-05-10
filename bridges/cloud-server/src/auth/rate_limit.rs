//! In-memory rate limiter for the Cloud Edition email/password endpoints.
//!
//! This is the Phase 1 implementation. State lives in-process and resets on
//! restart. A future phase will move counters to a SQLite-backed table or
//! Redis when we run more than one instance.

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

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
struct EmailFailureWindow {
    attempts: u32,
    locked_until: Option<Instant>,
    first_attempt_at: Instant,
}

#[derive(Debug)]
pub struct CloudRateLimiter {
    config: CloudRateLimitConfig,
    per_ip: Mutex<HashMap<IpAddr, VecDeque<Instant>>>,
    per_email: Mutex<HashMap<String, EmailFailureWindow>>,
}

impl CloudRateLimiter {
    pub fn new(config: CloudRateLimitConfig) -> Self {
        Self {
            config,
            per_ip: Mutex::new(HashMap::new()),
            per_email: Mutex::new(HashMap::new()),
        }
    }

    /// Record an auth attempt from `peer` and decide whether to allow it.
    /// Caller passes `Option<IpAddr>` because tests and certain transports
    /// may not have a peer IP — `None` means "unknown peer", which we still
    /// rate-limit globally but more leniently.
    pub fn observe_ip(&self, peer: Option<IpAddr>) -> RateLimitDecision {
        let key = peer.unwrap_or(IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
        let mut buckets = self.per_ip.lock().expect("rate limiter poisoned");
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

    /// Check whether `email` is currently locked out from login. Does NOT
    /// record an attempt — call `record_email_failure` after a real failure.
    pub fn check_email_lockout(&self, email: &str) -> RateLimitDecision {
        let buckets = self.per_email.lock().expect("rate limiter poisoned");
        let Some(entry) = buckets.get(email) else {
            return RateLimitDecision::Allowed;
        };
        if let Some(until) = entry.locked_until {
            if Instant::now() < until {
                return RateLimitDecision::Limited {
                    retry_after: until.duration_since(Instant::now()),
                };
            }
        }
        RateLimitDecision::Allowed
    }

    /// Record a failed login for `email`. After `per_email_failure_limit`
    /// failures within `per_email_lockout`, the email is locked.
    pub fn record_email_failure(&self, email: &str) {
        let mut buckets = self.per_email.lock().expect("rate limiter poisoned");
        let now = Instant::now();
        let entry = buckets.entry(email.to_string()).or_insert_with(|| EmailFailureWindow {
            attempts: 0,
            locked_until: None,
            first_attempt_at: now,
        });
        // Reset window if the previous lockout has elapsed.
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

    /// Clear failure history for `email` after a successful login.
    pub fn clear_email_failures(&self, email: &str) {
        let mut buckets = self.per_email.lock().expect("rate limiter poisoned");
        buckets.remove(email);
    }

    #[cfg(test)]
    pub fn reset_for_tests(&self) {
        self.per_ip.lock().expect("poisoned").clear();
        self.per_email.lock().expect("poisoned").clear();
    }
}

impl Default for CloudRateLimiter {
    fn default() -> Self {
        Self::new(CloudRateLimitConfig::default())
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

    #[test]
    fn ip_allows_then_limits_then_recovers() {
        let limiter = CloudRateLimiter::new(fast_config());
        let ip = Some(IpAddr::V4(Ipv4Addr::LOCALHOST));

        assert_eq!(limiter.observe_ip(ip), RateLimitDecision::Allowed);
        assert_eq!(limiter.observe_ip(ip), RateLimitDecision::Allowed);
        assert_eq!(limiter.observe_ip(ip), RateLimitDecision::Allowed);
        assert!(matches!(
            limiter.observe_ip(ip),
            RateLimitDecision::Limited { .. }
        ));

        std::thread::sleep(Duration::from_millis(220));
        assert_eq!(limiter.observe_ip(ip), RateLimitDecision::Allowed);
    }

    #[test]
    fn email_failures_lock_out_then_clear_on_success() {
        let limiter = CloudRateLimiter::new(fast_config());
        for _ in 0..3 {
            limiter.record_email_failure("alice@example.com");
        }
        assert!(matches!(
            limiter.check_email_lockout("alice@example.com"),
            RateLimitDecision::Limited { .. }
        ));

        limiter.clear_email_failures("alice@example.com");
        assert_eq!(
            limiter.check_email_lockout("alice@example.com"),
            RateLimitDecision::Allowed
        );
    }

    #[test]
    fn email_lockout_expires_after_window() {
        let limiter = CloudRateLimiter::new(fast_config());
        for _ in 0..3 {
            limiter.record_email_failure("bob@example.com");
        }
        std::thread::sleep(Duration::from_millis(220));
        assert_eq!(
            limiter.check_email_lockout("bob@example.com"),
            RateLimitDecision::Allowed
        );
    }

    #[test]
    fn separate_ips_dont_interfere() {
        let limiter = CloudRateLimiter::new(fast_config());
        let alice = Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)));
        let bob = Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2)));

        for _ in 0..3 {
            assert_eq!(limiter.observe_ip(alice), RateLimitDecision::Allowed);
        }
        // Alice exhausted, bob still has a budget.
        assert_eq!(limiter.observe_ip(bob), RateLimitDecision::Allowed);
    }
}
