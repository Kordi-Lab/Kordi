//! What a finished or failed evaluation leaves behind.

use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use super::fixture::*;

async fn log_rows(f: &Fixture) -> Vec<(String, uuid::Uuid, String, Vec<String>)> {
    query_as(
        "SELECT run_id, message_id, text, event_ids FROM cloud_personal_agent_messages \
         WHERE agent_id = $1 ORDER BY created_at",
    )
    .bind(&f.agent_id)
    .fetch_all(&f.pool)
    .await
    .unwrap()
}

async fn received_at(f: &Fixture, event_id: &str) -> chrono::DateTime<chrono::Utc> {
    let (at,): (chrono::DateTime<chrono::Utc>,) =
        query_as("SELECT received_at FROM cloud_connector_events WHERE event_id = $1")
            .bind(event_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    at
}

#[tokio::test]
async fn a_share_posts_one_agent_message_with_its_sources() {
    let Some(f) = fixture().await else { return };
    let (conversation_id, _) = f.personal_session(&f.agent_id).await;
    let (run_id, event_id) = f.queue_evaluation().await;
    f.finish(&run_id, &format!("```json\n{}\n```", share(&event_id)))
        .await;
    let messages = f.messages(conversation_id).await;
    assert_eq!(messages.len(), 1);
    let posted = envelope(&messages[0]);
    assert_eq!(posted["kind"], "agent-response");
    assert_eq!(posted["requestId"], run_id.as_str());
    assert_eq!(posted["deliveryState"], "complete");
    assert_eq!(
        posted["text"],
        "Sam asked about dinner tonight and is waiting for your answer."
    );
    assert_eq!(
        posted["sources"],
        json!([{"eventId": event_id, "provider": "gmail", "title": "Sam · Dinner tonight?"}])
    );
    assert_eq!(posted["agentId"], f.agent_id.as_str());
    assert_eq!(posted["agentName"], "Scout");
    let log = log_rows(&f).await;
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].0, run_id);
    assert_eq!(log[0].3, vec![event_id.clone()]);
    let (cursor, active, cooling, attempts) = f.state().await;
    assert_eq!(cursor, received_at(&f, &event_id).await, "the cursor moved");
    assert_eq!((active, cooling, attempts), (None, true, 0));
    let (status, response): (String, Option<String>) = query_as(
        "SELECT status, response_message_id FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!((status.as_str(), response), ("completed", None));
    // The next look starts after the shared event.
    query("UPDATE cloud_personal_agent_state SET cooldown_until = now() WHERE agent_id = $1")
        .bind(&f.agent_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(f.candidate(&quick()).await.is_none());
    let (_, list) = f
        .send("GET", "/v1/cloud/personal-agents", &f.owner_token, None)
        .await;
    assert_eq!(
        list["agents"][1]["conversationId"],
        conversation_id.to_string()
    );
}

#[tokio::test]
async fn a_skip_or_an_unknown_event_moves_the_cursor_and_posts_nothing() {
    let Some(f) = fixture().await else { return };
    let (conversation_id, _) = f.personal_session(&f.agent_id).await;
    let (run_id, event_id) = f.queue_evaluation().await;
    f.finish(&run_id, "{\"decision\":\"skip\"}").await;
    assert!(f.messages(conversation_id).await.is_empty());
    let (cursor, active, cooling, _) = f.state().await;
    assert_eq!(cursor, received_at(&f, &event_id).await);
    assert_eq!((active, cooling), (None, false));

    f.rewind().await;
    let (run_id, _) = f.queue_evaluation().await;
    let reply = json!({"decision": "share", "message": "Hi", "eventIds": ["cnevt_made_up"]});
    f.finish(&run_id, &reply.to_string()).await;
    assert!(f.messages(conversation_id).await.is_empty());
    assert!(log_rows(&f).await.is_empty());
}

#[tokio::test]
async fn a_run_that_lost_its_setting_posts_nothing() {
    let Some(f) = fixture().await else { return };
    let (conversation_id, _) = f.personal_session(&f.agent_id).await;
    let (run_id, event_id) = f.queue_evaluation().await;
    let runner = format!("runner-pa-{}", uuid::Uuid::new_v4().simple());
    crate::cloud_agent_runtime::runs::lease_canary_run(&f.pool, &runner, &run_id)
        .await
        .unwrap()
        .expect("leased");
    f.set_proactive(&f.agent_id, false).await;
    crate::cloud_agent_runtime::runs::complete_run(&f.pool, &run_id, &runner, &share(&event_id))
        .await
        .unwrap();
    assert!(f.messages(conversation_id).await.is_empty());
    assert!(log_rows(&f).await.is_empty());
}

#[tokio::test]
async fn failures_back_off_and_then_skip_the_events() {
    let Some(f) = fixture().await else { return };
    let (run_id, event_id) = f.queue_evaluation().await;
    let start = f.state().await.0;
    crate::personal_agent::fail(&f.pool, &run_id, None, "provider_error")
        .await
        .unwrap();
    let (cursor, active, _, attempts) = f.state().await;
    assert_eq!((cursor, active, attempts), (start, None, 1));
    let (retry_later,): (bool,) = query_as(
        "SELECT retry_after > now() + interval '30 seconds' FROM cloud_personal_agent_state \
         WHERE agent_id = $1",
    )
    .bind(&f.agent_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(retry_later);
    for attempt in 2..=5 {
        query("UPDATE cloud_personal_agent_state SET retry_after = now() WHERE agent_id = $1")
            .bind(&f.agent_id)
            .execute(&f.pool)
            .await
            .unwrap();
        let candidate = f.candidate(&quick()).await.expect("retried");
        crate::personal_agent::sweep::evaluate(&f.pool, &candidate)
            .await
            .unwrap();
        let run_id = f.state().await.1.expect("a retry");
        crate::personal_agent::fail(&f.pool, &run_id, None, "provider_error")
            .await
            .unwrap();
        let (cursor, _, _, attempts) = f.state().await;
        if attempt < 5 {
            assert_eq!((cursor, attempts), (start, attempt));
        } else {
            assert_eq!(attempts, 0, "the schedule starts over");
            assert_eq!(cursor, received_at(&f, &event_id).await, "events skipped");
        }
    }
}
