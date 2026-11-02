use super::*;
use std::time::Duration;
use tokio::time::timeout;

#[path = "worker_tests/support.rs"]
mod support;
use support::{MockServer, api, credentials};

#[tokio::test]
async fn three_workers_wait_for_two_model_slots_then_progress_once_without_restarts() {
    let actors = ["actor-a", "actor-b", "actor-c"];
    let mock = MockServer::new(&actors, 2, false).await;
    let workers = actors
        .into_iter()
        .map(|actor| {
            let api = api(&mock.base);
            tokio::spawn(async move { run_configured(api, actor, credentials(actor)).await })
        })
        .collect::<Vec<_>>();
    for worker in workers {
        timeout(Duration::from_secs(8), worker)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
    let state = mock.state.lock().unwrap();
    assert_eq!(state.sends.len(), 3, "each worker should send exactly once");
    assert_eq!(
        state
            .sends
            .iter()
            .map(|(_, id)| *id)
            .collect::<std::collections::HashSet<_>>()
            .len(),
        3
    );
    assert!(
        state
            .actors
            .values()
            .map(|record| record.capacity_rejections)
            .sum::<u64>()
            > 0
    );
    for actor in actors {
        assert_eq!(
            state
                .sends
                .iter()
                .filter(|(sent_by, _)| sent_by == actor)
                .count(),
            1
        );
    }
    for actor in actors {
        let record = &state.actors[actor];
        assert!(
            record.syncs >= record.decides,
            "each retry attempt must be preceded by another sync"
        );
        assert_eq!(record.view.messages_sent, 1);
        assert_eq!(record.view.model_calls, 1);
    }
}

#[tokio::test]
async fn shutdown_during_capacity_wait_stops_before_another_decision_or_send() {
    let actor = "actor-stop";
    let mock = MockServer::new(&[actor], 0, true).await;
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let api = api(&mock.base);
    let worker = tokio::spawn(async move {
        run_configured_until(api, actor, credentials(actor), async {
            let _ = stop_rx.await;
        })
        .await
    });
    timeout(Duration::from_secs(2), async {
        loop {
            if mock.state.lock().unwrap().actors[actor].capacity_rejections > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    stop_tx.send(()).unwrap();
    timeout(Duration::from_secs(2), worker)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let attempts_at_stop = mock.state.lock().unwrap().actors[actor].decides;
    tokio::time::sleep(Duration::from_millis(150)).await;
    let state = mock.state.lock().unwrap();
    assert_eq!(state.actors[actor].decides, attempts_at_stop);
    assert!(state.sends.is_empty());
}

#[tokio::test]
async fn operator_stop_conflicts_with_heartbeat_and_cancels_capacity_wait() {
    let actor = "actor-operator-stop";
    let mock = MockServer::new(&[actor], 0, true).await;
    let api = api(&mock.base);
    let worker = tokio::spawn(async move {
        run_configured_with_heartbeat_interval(
            api,
            actor,
            credentials(actor),
            Duration::from_millis(50),
            std::future::pending(),
        )
        .await
    });

    timeout(Duration::from_secs(2), async {
        loop {
            let ready = {
                let state = mock.state.lock().unwrap();
                let record = &state.actors[actor];
                record.capacity_rejections > 0 && record.heartbeats >= 2
            };
            if ready {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let (attempts_before_stop, heartbeats_before_stop) = {
        let mut state = mock.state.lock().unwrap();
        let record = state.actors.get_mut(actor).unwrap();
        record.operator_stopped = true;
        (record.decides, record.heartbeats)
    };

    let result = timeout(Duration::from_secs(2), worker)
        .await
        .unwrap()
        .unwrap();
    assert!(
        result.is_err(),
        "ownership conflict should end worker dispatch"
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    let state = mock.state.lock().unwrap();
    assert_eq!(
        state.actors[actor].heartbeats,
        heartbeats_before_stop + 1,
        "the next heartbeat should observe the operator stop"
    );
    assert_eq!(state.actors[actor].decides, attempts_before_stop);
    assert!(state.sends.is_empty());
}

#[tokio::test]
async fn stale_revision_conflict_is_not_retried() {
    let actor = "actor-stale-revision";
    let mock = MockServer::new(&[actor], 1, false).await;
    mock.state
        .lock()
        .unwrap()
        .actors
        .get_mut(actor)
        .unwrap()
        .decide_failure_status = Some(409);
    let api = api(&mock.base);
    let result = run_configured_until(api, actor, credentials(actor), std::future::pending()).await;
    assert!(result.is_err());
    let state = mock.state.lock().unwrap();
    let record = &state.actors[actor];
    assert_eq!(record.decides, 1);
    assert_eq!(record.capacity_rejections, 0);
    assert!(state.sends.is_empty());
}

#[test]
fn capacity_backoff_grows_exponentially_and_stays_capped() {
    let mut delay = Duration::from_secs(1);
    let mut observed = vec![delay];
    for _ in 0..8 {
        delay = next_capacity_backoff(delay);
        observed.push(delay);
    }
    assert_eq!(
        observed,
        [1, 2, 4, 8, 16, 32, 60, 60, 60].map(Duration::from_secs)
    );
    for _ in 0..100 {
        let jittered = capacity_retry_delay(Duration::from_secs(60));
        assert!((Duration::from_secs(30)..=Duration::from_secs(60)).contains(&jittered));
    }
}
