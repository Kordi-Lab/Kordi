//! Redis-backed counters. Each test skips unless `KORDI_TEST_REDIS_URL` names
//! a disposable Redis.

use super::tests::{client, fast_config, SLOW_ADDRESS};
use super::*;

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
async fn redis_address_counter_expires_and_counts_within_its_window() {
    let Some((limiter, mut conn, prefix)) = redis_limiter(fast_config()).await else {
        return;
    };
    let ip = client(2);
    let key = format!("{prefix}:addr:slow-address:{}", rate_limit_client_key(ip));

    assert_eq!(
        limiter.observe_address_limit(SLOW_ADDRESS, ip).await,
        RateLimitDecision::Allowed
    );
    let first_pttl: i64 = conn.pttl(&key).await.unwrap();
    assert!(first_pttl > 0, "{key} has no expiry (PTTL {first_pttl})");

    assert_eq!(
        limiter.observe_address_limit(SLOW_ADDRESS, ip).await,
        RateLimitDecision::Allowed
    );
    assert_eq!(
        limiter.observe_address_limit(SLOW_ADDRESS, ip).await,
        RateLimitDecision::Allowed
    );
    let count: i64 = conn.get(&key).await.unwrap();
    assert_eq!(count, 3);
    let pttl: i64 = conn.pttl(&key).await.unwrap();
    assert!(
        pttl > 0 && pttl <= first_pttl,
        "later hits must not extend the window (PTTL {pttl}, first {first_pttl})"
    );
    match limiter.observe_address_limit(SLOW_ADDRESS, ip).await {
        RateLimitDecision::Limited { retry_after } => {
            assert!(retry_after > Duration::ZERO && retry_after <= Duration::from_secs(60));
        }
        RateLimitDecision::Allowed => panic!("fourth hit within the window was allowed"),
    }

    // A counter left without a TTL by an older build gets one on the next hit.
    conn.persist::<_, ()>(&key).await.unwrap();
    limiter.observe_address_limit(SLOW_ADDRESS, ip).await;
    let pttl: i64 = conn.pttl(&key).await.unwrap();
    assert!(
        pttl > 0,
        "persisted counter regained no expiry (PTTL {pttl})"
    );

    conn.del::<_, ()>(&key).await.unwrap();
}
