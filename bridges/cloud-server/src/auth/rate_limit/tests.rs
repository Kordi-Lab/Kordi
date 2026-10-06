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
        .record_login_success("alice@example.com", client(1))
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
async fn email_wide_ceiling_blocks_unfamiliar_clients() {
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
    tokio::time::sleep(Duration::from_millis(220)).await;
    assert_eq!(
        limiter
            .check_email_lockout("target@example.com", client(99))
            .await,
        RateLimitDecision::Allowed
    );
}

#[tokio::test]
async fn familiar_clients_keep_their_own_budget_during_an_email_wide_lock() {
    let limiter = CloudRateLimiter::memory(fast_config());
    let owner = client(50);
    limiter
        .record_login_success("owner@example.com", owner)
        .await;
    for last in 1..=7 {
        limiter
            .record_email_failure("owner@example.com", client(last))
            .await;
    }
    assert!(
        matches!(
            limiter
                .check_email_lockout("owner@example.com", client(98))
                .await,
            RateLimitDecision::Limited { .. }
        ),
        "new addresses are locked once the email-wide ceiling is reached"
    );
    assert_eq!(
        limiter
            .check_email_lockout("owner@example.com", owner)
            .await,
        RateLimitDecision::Allowed,
        "the owner's familiar address still signs in"
    );
    for last in 1..=7 {
        limiter
            .record_email_failure("other@example.com", client(last))
            .await;
    }
    assert!(
        matches!(
            limiter
                .check_email_lockout("other@example.com", owner)
                .await,
            RateLimitDecision::Limited { .. }
        ),
        "familiarity is per email"
    );

    for _ in 0..3 {
        limiter
            .record_email_failure("owner@example.com", owner)
            .await;
    }
    assert!(
        matches!(
            limiter
                .check_email_lockout("owner@example.com", owner)
                .await,
            RateLimitDecision::Limited { .. }
        ),
        "a familiar address is still limited by its own failures"
    );
}

#[test]
fn ipv6_clients_are_counted_by_their_64_prefix() {
    let first: IpAddr = "2001:db8:1:2:aaaa::1".parse().unwrap();
    let second: IpAddr = "2001:db8:1:2:ffff:ffff:ffff:ffff".parse().unwrap();
    let other: IpAddr = "2001:db8:1:3::1".parse().unwrap();
    assert_eq!(
        rate_limit_client_key(Some(first)),
        rate_limit_client_key(Some(second))
    );
    assert_ne!(
        rate_limit_client_key(Some(first)),
        rate_limit_client_key(Some(other))
    );
    assert_eq!(
        rate_limit_client_key(Some("::ffff:203.0.113.7".parse().unwrap())),
        "203.0.113.7".parse::<IpAddr>().unwrap(),
        "IPv4-mapped addresses count as their IPv4 address"
    );
    assert_eq!(
        rate_limit_client_key(Some("203.0.113.7".parse().unwrap())),
        "203.0.113.7".parse::<IpAddr>().unwrap()
    );
    assert_eq!(
        rate_limit_client_key(None),
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    );
}

#[tokio::test]
async fn addresses_in_one_ipv6_64_share_ip_and_lockout_buckets() {
    let limiter = CloudRateLimiter::memory(fast_config());
    let address = |suffix: &str| Some(format!("2001:db8:5:6::{suffix}").parse().unwrap());
    for suffix in ["1", "2", "3"] {
        assert_eq!(
            limiter.observe_ip(address(suffix)).await,
            RateLimitDecision::Allowed
        );
    }
    assert!(matches!(
        limiter.observe_ip(address("4")).await,
        RateLimitDecision::Limited { .. }
    ));
    assert_eq!(
        limiter
            .observe_ip(Some("2001:db8:5:7::1".parse().unwrap()))
            .await,
        RateLimitDecision::Allowed
    );

    for suffix in ["a", "b", "c"] {
        limiter
            .record_email_failure("v6@example.com", address(suffix))
            .await;
    }
    assert!(matches!(
        limiter
            .check_email_lockout("v6@example.com", address("d"))
            .await,
        RateLimitDecision::Limited { .. }
    ));
}

#[test]
fn production_limits_bound_distributed_guessing() {
    let config = CloudRateLimitConfig::production();
    assert_eq!(config.per_email_failure_limit, 5);
    assert!(config.per_email_global_failure_limit <= 10);
    assert!(config.per_email_global_failure_limit > config.per_email_failure_limit);
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

/// A Redis-backed limiter under a key prefix unique to one test, plus a raw
/// connection for inspecting its keys. `None` when `KORDI_TEST_REDIS_URL` is
/// not set.
async fn redis_limiter(
    config: CloudRateLimitConfig,
) -> Option<(CloudRateLimiter, ConnectionManager, String)> {
    let Ok(url) = std::env::var("KORDI_TEST_REDIS_URL") else {
        eprintln!("KORDI_TEST_REDIS_URL not set — skipping");
        return None;
    };
    let mut limiter = CloudRateLimiter::redis(&url, config)
        .await
        .expect("connect to test redis");
    let prefix = format!("crl-test-{}", uuid::Uuid::new_v4().simple());
    let Backend::Redis(store) = &mut limiter.backend else {
        unreachable!("redis constructor returns a redis backend");
    };
    store.key_prefix = prefix.clone();
    let conn = store.conn.clone();
    Some((limiter, conn, prefix))
}

fn redis_lockout_config() -> CloudRateLimitConfig {
    CloudRateLimitConfig {
        per_email_lockout: Duration::from_secs(60),
        ..fast_config()
    }
}

#[tokio::test]
async fn redis_email_failure_counters_always_expire() {
    let Some((limiter, mut conn, prefix)) = redis_limiter(redis_lockout_config()).await else {
        return;
    };
    let email = "redis-expiry@example.com";
    let client_scope = format!("client:{}:{email}", rate_limit_client_key(client(1)));
    let client_fail = format!("{prefix}:email:{client_scope}:fail");
    let client_lock = format!("{prefix}:email:{client_scope}:lock");
    let global_fail = format!("{prefix}:email:all:{email}:fail");

    limiter.record_email_failure(email, client(1)).await;
    for key in [&client_fail, &global_fail] {
        let pttl: i64 = conn.pttl(key).await.unwrap();
        assert!(pttl > 0, "{key} has no expiry (PTTL {pttl})");
    }

    // A counter left without a TTL by an older build gets one on the next
    // failure.
    conn.persist::<_, ()>(&client_fail).await.unwrap();
    limiter.record_email_failure(email, client(1)).await;
    let pttl: i64 = conn.pttl(&client_fail).await.unwrap();
    assert!(
        pttl > 0,
        "persisted counter regained no expiry (PTTL {pttl})"
    );

    limiter.record_email_failure(email, client(1)).await;
    let count: i64 = conn.get(&client_fail).await.unwrap();
    assert_eq!(count, 3);
    let lock_pttl: i64 = conn.pttl(&client_lock).await.unwrap();
    assert!(
        lock_pttl > 0,
        "lock key missing or without TTL ({lock_pttl})"
    );
    assert!(matches!(
        limiter.check_email_lockout(email, client(1)).await,
        RateLimitDecision::Limited { .. }
    ));

    limiter.record_login_success(email, client(1)).await;
    let remaining: i64 = conn.exists(&[&client_fail, &client_lock]).await.unwrap();
    assert_eq!(remaining, 0);
    let known: bool = conn
        .exists(format!("{prefix}:email:{client_scope}:known"))
        .await
        .unwrap();
    assert!(known);
    assert_eq!(
        limiter.check_email_lockout(email, client(1)).await,
        RateLimitDecision::Allowed
    );

    let keys: Vec<String> = conn.keys(format!("{prefix}:*")).await.unwrap();
    if !keys.is_empty() {
        conn.del::<_, ()>(keys).await.unwrap();
    }
}

#[tokio::test]
async fn redis_ip_counter_expires_and_counts_within_its_window() {
    let config = CloudRateLimitConfig {
        per_ip_window: Duration::from_secs(60),
        ..fast_config()
    };
    let Some((limiter, mut conn, prefix)) = redis_limiter(config).await else {
        return;
    };
    let ip = client(2);
    let key = format!("{prefix}:ip:{}", rate_limit_client_key(ip));

    assert_eq!(limiter.observe_ip(ip).await, RateLimitDecision::Allowed);
    let first_pttl: i64 = conn.pttl(&key).await.unwrap();
    assert!(first_pttl > 0, "{key} has no expiry (PTTL {first_pttl})");

    assert_eq!(limiter.observe_ip(ip).await, RateLimitDecision::Allowed);
    assert_eq!(limiter.observe_ip(ip).await, RateLimitDecision::Allowed);
    let count: i64 = conn.get(&key).await.unwrap();
    assert_eq!(count, 3);
    let pttl: i64 = conn.pttl(&key).await.unwrap();
    assert!(
        pttl > 0 && pttl <= first_pttl,
        "later hits must not extend the window (PTTL {pttl}, first {first_pttl})"
    );
    match limiter.observe_ip(ip).await {
        RateLimitDecision::Limited { retry_after } => {
            assert!(retry_after > Duration::ZERO && retry_after <= Duration::from_secs(60));
        }
        RateLimitDecision::Allowed => panic!("fourth hit within the window was allowed"),
    }

    // A counter left without a TTL by an older build gets one on the next hit.
    conn.persist::<_, ()>(&key).await.unwrap();
    limiter.observe_ip(ip).await;
    let pttl: i64 = conn.pttl(&key).await.unwrap();
    assert!(
        pttl > 0,
        "persisted counter regained no expiry (PTTL {pttl})"
    );

    conn.del::<_, ()>(&key).await.unwrap();
}
