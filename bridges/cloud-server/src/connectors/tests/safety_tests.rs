//! Events never outlive a disconnect, and each account's connector calls
//! stay within the hourly budget.

use std::time::Duration;

use super::broker_tests::{call, leased_run, runner};
use super::*;
use crate::connectors::broker_route::broker_status;
use crate::connectors::budget::{self, CallBudget};

async fn event_count(pool: &PgPool, connector_id: &str) -> i64 {
    count_rows(
        pool,
        "SELECT count(*) FROM cloud_connector_events WHERE connector_id = $1",
        connector_id,
    )
    .await
}

fn record_later(
    pool: &PgPool,
    connector_id: &str,
    external_id: &str,
) -> tokio::task::JoinHandle<Result<Option<String>, sqlx_core::Error>> {
    let (pool, connector_id, external_id) = (
        pool.clone(),
        connector_id.to_string(),
        external_id.to_string(),
    );
    tokio::spawn(async move {
        events::record_event(
            &pool,
            NewConnectorEvent {
                connector_id: &connector_id,
                provider: STUB.id,
                kind: "item.created",
                external_id: Some(&external_id),
                occurred_at: Utc::now(),
                payload: &json!({ "title": "Late" }),
            },
        )
        .await
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_webhook_during_disconnect_records_nothing() {
    let Some(pool) = pool().await else { return };
    let (runtime, _) = stub_runtime();
    let (owner, _) = signed_in_account(&pool, "disconnect_race").await;
    let connector_id = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;

    // An event that arrives while a disconnect holds the connector row waits,
    // then sees the connector revoked and stores nothing.
    let mut disconnecting = pool.begin().await.unwrap();
    query("SELECT connector_id FROM cloud_connectors WHERE connector_id = $1 FOR UPDATE")
        .bind(&connector_id)
        .execute(&mut *disconnecting)
        .await
        .unwrap();
    let late = record_later(&pool, &connector_id, "late-1");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!late.is_finished(), "the event waits for the disconnect");
    query("DELETE FROM cloud_connector_events WHERE connector_id = $1")
        .bind(&connector_id)
        .execute(&mut *disconnecting)
        .await
        .unwrap();
    query("UPDATE cloud_connectors SET status = 'revoked', revoked_at = now() WHERE connector_id = $1")
        .bind(&connector_id)
        .execute(&mut *disconnecting)
        .await
        .unwrap();
    disconnecting.commit().await.unwrap();
    assert_eq!(late.await.unwrap().unwrap(), None);
    assert_eq!(event_count(&pool, &connector_id).await, 0);

    // The other order: the real disconnect waits for an event being stored
    // and then deletes it.
    let (owner, _) = signed_in_account(&pool, "disconnect_waits").await;
    let connector_id = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    let record = store::load_account_connector(&pool, &owner, &connector_id)
        .await
        .unwrap()
        .unwrap();
    let mut recording = pool.begin().await.unwrap();
    query("SELECT connector_id FROM cloud_connectors WHERE connector_id = $1 FOR SHARE")
        .bind(&connector_id)
        .execute(&mut *recording)
        .await
        .unwrap();
    let disconnect = {
        let pool = pool.clone();
        tokio::spawn(async move { store::disconnect(&pool, &record).await })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !disconnect.is_finished(),
        "the disconnect waits for the event"
    );
    query(
        "INSERT INTO cloud_connector_events \
         (event_id, connector_id, provider, kind, occurred_at, expires_at) \
         VALUES ($1, $2, 'stub', 'item.created', now(), now() + interval '1 day')",
    )
    .bind(format!("cnevt_{}", Uuid::new_v4().simple()))
    .bind(&connector_id)
    .execute(&mut *recording)
    .await
    .unwrap();
    recording.commit().await.unwrap();
    assert_eq!(disconnect.await.unwrap().unwrap(), 1);
    assert_eq!(event_count(&pool, &connector_id).await, 0);
    let after = record_later(&pool, &connector_id, "after-1").await.unwrap();
    assert_eq!(after.unwrap(), None, "a revoked connector stores nothing");
}

#[tokio::test]
async fn connector_calls_stop_at_the_hourly_budget() {
    let Some(pool) = pool().await else { return };
    let (runtime, _) = stub_runtime();
    let runtime = runtime.with_budget(CallBudget::new(2));
    let (owner, _) = signed_in_account(&pool, "call_budget").await;
    let connector_id = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    store::replace_agent_grants(&pool, &connector_id, &[store::default_agent_id(&owner)])
        .await
        .unwrap();
    let (lease, _) = leased_run(&pool, &runtime, &owner, RunTrigger::PersonStarted).await;
    let request = call(&lease, &connector_id, STUB_READ_TOOL);
    for _ in 0..2 {
        let allowed = broker::call_connector_tool(&pool, &runtime, &runner(), &request).await;
        assert!(allowed.ok, "{allowed:?}");
    }
    let refused = broker::call_connector_tool(&pool, &runtime, &runner(), &request).await;
    assert_eq!(refused.error_code(), Some(codes::BUDGET_EXCEEDED));
    assert_eq!(broker_status(&refused), StatusCode::TOO_MANY_REQUESTS);
    let (outcome, summary): (String, String) = query_as(
        "SELECT outcome, summary FROM cloud_connector_audit \
         WHERE connector_id = $1 ORDER BY created_at DESC, audit_id DESC LIMIT 1",
    )
    .bind(&connector_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(outcome, "denied");
    assert!(summary.contains("budget"), "{summary}");

    // Another account has its own budget.
    let (other, _) = signed_in_account(&pool, "call_budget_other").await;
    let other_connector = connect_stub(&pool, &runtime, &other, ConnectorToolGroup::Read).await;
    store::replace_agent_grants(&pool, &other_connector, &[store::default_agent_id(&other)])
        .await
        .unwrap();
    let (other_lease, _) = leased_run(&pool, &runtime, &other, RunTrigger::PersonStarted).await;
    let other_call = call(&other_lease, &other_connector, STUB_READ_TOOL);
    let allowed = broker::call_connector_tool(&pool, &runtime, &runner(), &other_call).await;
    assert!(allowed.ok, "{allowed:?}");
}

#[test]
fn the_call_budget_reads_its_environment_value() {
    assert_eq!(budget::calls_per_hour_from(None), 600);
    assert_eq!(budget::calls_per_hour_from(Some(" 50 ")), 50);
    for invalid in ["0", "-1", "lots", "1000000"] {
        assert_eq!(budget::calls_per_hour_from(Some(invalid)), 600, "{invalid}");
    }
    assert_eq!(budget::CALLS_PER_HOUR_ENV, "KORDI_CONNECTOR_CALLS_PER_HOUR");
}
