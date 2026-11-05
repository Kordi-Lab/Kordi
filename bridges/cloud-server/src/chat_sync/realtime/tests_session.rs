//! Session revalidation: revocation signals, expiry, database failures, and
//! the backstop recheck schedule.

use std::time::Duration;

use chrono::Utc;
use sqlx_core::query::query;
use tokio::time::Instant;

use super::delivery::{Delivery, DeliveryEnd, REPAIR_WHILE_LISTENING, REPAIR_WITHOUT_LISTENER};
use super::retry::FAILURE_GRACE;
use super::session::{
    check_connection, GuardStep, SessionCheck, SessionGuard, SESSION_RECHECK_INTERVAL,
};
use super::tests::{account_with_device, test_pool};
use super::{spawn_wake_listener, ChatSyncWakeHub, ConsumedRealtimeTicket};
use crate::auth::session_signals::{SessionSignalHub, SignalVerdict};

fn within_jitter(delay: Duration, interval: Duration) -> bool {
    delay >= interval.mul_f64(0.8) && delay <= interval.mul_f64(1.2)
}

fn active_until(seconds: i64) -> SessionCheck {
    SessionCheck::Active {
        expires_at: Some(Utc::now() + chrono::Duration::seconds(seconds)),
    }
}

#[test]
fn rechecks_follow_the_jittered_interval() {
    let mut delays = Vec::new();
    for _ in 0..200 {
        let now = Instant::now();
        let mut guard = SessionGuard::new(now, None, None);
        delays.push(guard.deadline() - now);
        assert_eq!(guard.record(now, active_until(86_400)), GuardStep::Continue);
        delays.push(guard.deadline() - now);
    }
    assert!(delays
        .iter()
        .all(|delay| within_jitter(*delay, SESSION_RECHECK_INTERVAL)));
    assert!(
        delays.iter().min() != delays.iter().max(),
        "sockets opened together spread their checks"
    );
}

#[test]
fn a_socket_closes_at_its_known_session_expiry() {
    let now = Instant::now();
    let expires_at = Utc::now() + chrono::Duration::seconds(5);
    let guard = SessionGuard::new(now, Some(expires_at), None);
    let deadline = guard.deadline() - now;
    assert!(
        deadline <= Duration::from_secs(5) && deadline >= Duration::from_secs(4),
        "the expiry, not the 30 s recheck, sets the deadline: {deadline:?}"
    );
    let at_expiry = now + Duration::from_secs(5);
    let mut expired = SessionGuard::new(now, Some(expires_at), None);
    assert_eq!(
        expired.record(at_expiry, SessionCheck::Inactive),
        GuardStep::Close
    );
    let mut unknown = SessionGuard::new(now, Some(expires_at), None);
    assert_eq!(
        unknown.record(at_expiry, SessionCheck::Unavailable),
        GuardStep::Close,
        "an unconfirmed session past its expiry fails closed"
    );
    let mut extended = SessionGuard::new(now, Some(expires_at), None);
    assert_eq!(
        extended.record(at_expiry, active_until(86_400)),
        GuardStep::Continue
    );
    assert!(within_jitter(
        extended.deadline() - at_expiry,
        SESSION_RECHECK_INTERVAL
    ));
}

#[test]
fn legacy_tickets_close_at_their_deadline_without_a_query() {
    let now = Instant::now();
    let guard = SessionGuard::new(now, None, Some(now + Duration::from_secs(3)));
    assert_eq!(guard.deadline(), now + Duration::from_secs(3));
    assert!(!guard.must_close(now));
    assert!(guard.must_close(now + Duration::from_secs(3)));
}

#[test]
fn database_failures_retry_with_backoff_before_closing() {
    let opened = Instant::now();
    let mut guard = SessionGuard::new(opened, Some(Utc::now() + chrono::Duration::days(30)), None);
    let mut now = opened;
    let mut delays = Vec::new();
    while now.duration_since(opened) < FAILURE_GRACE {
        assert_eq!(
            guard.record(now, SessionCheck::Unavailable),
            GuardStep::Continue,
            "failing for {:?} keeps the socket open",
            now.duration_since(opened)
        );
        let delay = guard.deadline() - now;
        assert!(delay <= Duration::from_secs(36), "{delay:?}");
        delays.push(delay);
        now = guard.deadline();
    }
    assert!(
        delays[0] <= Duration::from_millis(1_200),
        "first retry is quick"
    );
    assert!(
        delays.windows(2).any(|pair| pair[1] > pair[0]),
        "retries back off"
    );
    assert_eq!(
        guard.record(now, SessionCheck::Unavailable),
        GuardStep::Close
    );

    let mut recovered = SessionGuard::new(opened, None, None);
    let later = opened + Duration::from_secs(100);
    assert_eq!(
        recovered.record(opened, SessionCheck::Unavailable),
        GuardStep::Continue
    );
    assert_eq!(
        recovered.record(later, SessionCheck::Active { expires_at: None }),
        GuardStep::Continue
    );
    assert_eq!(
        recovered.record(later + Duration::from_secs(60), SessionCheck::Unavailable),
        GuardStep::Continue,
        "a success restarts the failure grace"
    );
}

#[test]
fn signals_and_listener_reconnects_pull_the_recheck_forward() {
    let now = Instant::now();
    let mut guard = SessionGuard::new(now, None, None);
    guard.recheck_within(now, Duration::ZERO);
    assert_eq!(guard.deadline(), now);
    let mut guard = SessionGuard::new(now, None, None);
    guard.recheck_within(now, Duration::from_secs(10));
    assert!(guard.deadline() <= now + Duration::from_secs(10));
}

#[test]
fn durable_reads_back_off_on_failure_and_relax_while_listening() {
    let now = Instant::now();
    let listening = Delivery::new(now, 0, true);
    assert!(within_jitter(
        listening.repair_deadline() - now,
        REPAIR_WHILE_LISTENING
    ));
    let mut polling = Delivery::new(now, 0, false);
    assert!(within_jitter(
        polling.repair_deadline() - now,
        REPAIR_WITHOUT_LISTENER
    ));
    assert_eq!(polling.fail_for_test(now), DeliveryEnd::Continue);
    assert!(polling.repair_deadline() - now <= Duration::from_millis(1_200));
    assert_eq!(
        polling.fail_for_test(now + FAILURE_GRACE),
        DeliveryEnd::Resync("SERVER_ERROR")
    );
}

#[tokio::test]
async fn an_unreachable_database_is_unavailable_not_signed_out() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let (account_id, device_id) = account_with_device(&pool).await;
    let session = crate::auth::session::issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    let ticket = ConsumedRealtimeTicket {
        account_id,
        device_id,
        allowed_origin: None,
        session_token_id: Some(session.token_id),
    };
    let policy = Default::default();
    let SessionCheck::Active { expires_at } = check_connection(&pool, &ticket, &policy).await
    else {
        panic!("a fresh session is active");
    };
    let expected = session.expires_at.timestamp();
    assert_eq!(expires_at.map(|at| at.timestamp()), Some(expected));
    pool.close().await;
    assert_eq!(
        check_connection(&pool, &ticket, &policy).await,
        SessionCheck::Unavailable
    );
}

#[tokio::test]
async fn expired_sessions_are_inactive() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let (account_id, device_id) = account_with_device(&pool).await;
    let session = crate::auth::session::issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    query("UPDATE cloud_refresh_tokens SET expires_at = $1 WHERE token_id = $2")
        .bind((Utc::now() - chrono::Duration::seconds(1)).to_rfc3339())
        .bind(&session.token_id)
        .execute(&pool)
        .await
        .unwrap();
    let ticket = ConsumedRealtimeTicket {
        account_id,
        device_id,
        allowed_origin: None,
        session_token_id: Some(session.token_id),
    };
    assert_eq!(
        check_connection(&pool, &ticket, &Default::default()).await,
        SessionCheck::Inactive
    );
}

async fn wait_for_listener(hub: &ChatSyncWakeHub) {
    let mut status = hub.listener_status();
    tokio::time::timeout(
        Duration::from_secs(10),
        status.wait_for(|status| status.connected),
    )
    .await
    .expect("listener connects")
    .expect("listener status is live");
}

#[tokio::test]
async fn revocations_reach_open_sockets_through_the_listener() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let url = std::env::var("DATABASE_URL").unwrap();
    let wakes = ChatSyncWakeHub::new();
    let signals = SessionSignalHub::new();
    spawn_wake_listener(url, wakes.clone(), signals.clone());
    wait_for_listener(&wakes).await;

    let (account_id, device_id) = account_with_device(&pool).await;
    let first = crate::auth::session::issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    let second = crate::auth::session::issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    let mut first_socket = signals.subscribe(&account_id, &device_id, Some(&first.token_id));
    let mut second_socket = signals.subscribe(&account_id, &device_id, Some(&second.token_id));
    let prompt = Duration::from_secs(2);

    // Sign-out of one session closes only its sockets, at once.
    crate::auth::session::revoke_session(&pool, &first.token_id)
        .await
        .unwrap();
    let verdict = tokio::time::timeout(prompt, first_socket.recv()).await;
    assert_eq!(verdict.expect("revocation is prompt"), SignalVerdict::Close);

    // An admission-relevant account change asks the others to recheck.
    query("UPDATE cloud_accounts SET primary_email_verified_at = $1 WHERE account_id = $2")
        .bind(Utc::now().to_rfc3339())
        .bind(&account_id)
        .execute(&pool)
        .await
        .unwrap();
    let verdict = tokio::time::timeout(prompt, second_socket.recv()).await;
    assert_eq!(verdict.expect("recheck is prompt"), SignalVerdict::Recheck);

    // Revoking the device closes every socket on it.
    query("UPDATE cloud_devices SET revoked_at = $1 WHERE device_id = $2")
        .bind(Utc::now().to_rfc3339())
        .bind(&device_id)
        .execute(&pool)
        .await
        .unwrap();
    let verdict = tokio::time::timeout(prompt, second_socket.recv()).await;
    assert_eq!(
        verdict.expect("device revocation is prompt"),
        SignalVerdict::Close
    );
}

#[tokio::test]
async fn account_deletion_reaches_open_sockets() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let url = std::env::var("DATABASE_URL").unwrap();
    let wakes = ChatSyncWakeHub::new();
    let signals = SessionSignalHub::new();
    spawn_wake_listener(url, wakes.clone(), signals.clone());
    wait_for_listener(&wakes).await;

    let (account_id, device_id) = account_with_device(&pool).await;
    let mut legacy_socket = signals.subscribe(&account_id, &device_id, None);
    query("DELETE FROM cloud_accounts WHERE account_id = $1")
        .bind(&account_id)
        .execute(&pool)
        .await
        .unwrap();
    let verdict = tokio::time::timeout(Duration::from_secs(2), legacy_socket.recv()).await;
    assert_eq!(verdict.expect("deletion is prompt"), SignalVerdict::Close);
}
