use std::sync::Arc;
use std::time::Duration;

use tokio::sync::broadcast;

use super::{event_is_within_delivery_window, ChatSyncWakeHub, MAX_UNACKNOWLEDGED_EVENTS};

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
