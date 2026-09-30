use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_postgres::PgPool;
use tokio::sync::broadcast;
use uuid::Uuid;

use super::ticket::consume_ticket;
use super::{
    connection_is_active, event_is_within_delivery_window, issue_ticket, ChatSyncWakeHub,
    ConsumedRealtimeTicket, TicketError, MAX_UNACKNOWLEDGED_EVENTS,
};

#[test]
fn delivery_window_pauses_instead_of_overrunning_unacknowledged_limit() {
    assert!(event_is_within_delivery_window(
        MAX_UNACKNOWLEDGED_EVENTS,
        0
    ));
    assert!(!event_is_within_delivery_window(
        MAX_UNACKNOWLEDGED_EVENTS + 1,
        0
    ));
    assert!(event_is_within_delivery_window(
        MAX_UNACKNOWLEDGED_EVENTS + 501,
        501
    ));

    let mut acknowledged = 0;
    let mut delivered = 0;
    let mut windows = 0;
    while delivered < 1_200 {
        windows += 1;
        while delivered < 1_200 && event_is_within_delivery_window(delivered + 1, acknowledged) {
            delivered += 1;
        }
        acknowledged = delivered;
    }
    assert_eq!(delivered, 1_200);
    assert_eq!(windows, 2);
}

#[tokio::test]
async fn wake_hub_notifies_only_the_matching_account() {
    let hub = ChatSyncWakeHub::new();
    let mut first = hub.subscribe("account-a");
    let mut second = hub.subscribe("account-b");

    hub.wake("account-a");

    tokio::time::timeout(Duration::from_millis(50), first.recv())
        .await
        .expect("matching account receives wake");
    assert!(
        tokio::time::timeout(Duration::from_millis(10), second.recv())
            .await
            .is_err()
    );
    drop((first, second));
    assert_eq!(Arc::strong_count(&hub), 1);
}

#[test]
fn wake_hub_routes_large_idle_sets_without_cross_account_work() {
    let hub = ChatSyncWakeHub::new();
    let mut subscriptions = (0..1_000)
        .map(|index| hub.subscribe(&format!("account-{index}")))
        .collect::<Vec<_>>();

    hub.wake("account-777");

    for (index, subscription) in subscriptions.iter_mut().enumerate() {
        if index == 777 {
            assert!(subscription.receiver.try_recv().is_ok());
        } else {
            assert!(matches!(
                subscription.receiver.try_recv(),
                Err(broadcast::error::TryRecvError::Empty)
            ));
        }
    }
}

async fn test_pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    Some(crate::pg::init_pool(&url).await.expect("init test pool"))
}

async fn account_with_device(pool: &PgPool) -> (String, String) {
    let suffix = Uuid::new_v4().simple().to_string();
    let account_id = format!("acct_realtime_{suffix}");
    let device_id = format!("dev_realtime_{suffix}");
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, created_at, updated_at, avatar_source, \
          avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, 'Realtime', $2, $3, $3, 'generated', 'lorelei', $1, 'fixture', 1, $3)",
    )
    .bind(&account_id)
    .bind(format!("{account_id}@example.test"))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, created_at, last_seen_at) \
         VALUES ($1, $2, 'Realtime device', $3, $4, $4)",
    )
    .bind(&device_id)
    .bind(&account_id)
    .bind(format!("legacy:{suffix}"))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    (account_id, device_id)
}

#[tokio::test]
async fn realtime_tickets_are_bound_to_the_issuing_session() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let (account_id, device_id) = account_with_device(&pool).await;
    let session = crate::auth::session::issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();

    let issued = issue_ticket(&pool, &account_id, &device_id, &session.token_id, None)
        .await
        .unwrap();
    let ticket = consume_ticket(&pool, &issued.plaintext).await.unwrap();
    assert_eq!(
        ticket.session_token_id.as_deref(),
        Some(session.token_id.as_str())
    );
    assert!(connection_is_active(&pool, &ticket).await);

    crate::auth::session::revoke_session(&pool, &session.token_id)
        .await
        .unwrap();
    assert!(
        !connection_is_active(&pool, &ticket).await,
        "signing out closes sockets opened with that session's tickets"
    );
    assert!(
        matches!(
            issue_ticket(&pool, &account_id, &device_id, &session.token_id, None).await,
            Err(TicketError::InvalidTicket)
        ),
        "a signed-out session cannot obtain new tickets"
    );
}

#[tokio::test]
async fn legacy_tickets_without_a_session_fall_back_to_device_checks() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let (account_id, device_id) = account_with_device(&pool).await;
    let ticket = ConsumedRealtimeTicket {
        account_id: account_id.clone(),
        device_id: device_id.clone(),
        allowed_origin: None,
        session_token_id: None,
    };
    assert!(connection_is_active(&pool, &ticket).await);
    query("UPDATE cloud_devices SET revoked_at = $1 WHERE device_id = $2")
        .bind(Utc::now().to_rfc3339())
        .bind(&device_id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(!connection_is_active(&pool, &ticket).await);
}
