//! Which agents the sweep picks, and what an evaluation run looks like.

use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use super::fixture::*;
use crate::personal_agent::PersonalAgentConfig;

#[tokio::test]
async fn history_is_never_evaluated_and_off_agents_are_never_picked() {
    let Some(f) = fixture().await else { return };
    f.mail("Sam <sam@example.com>", "Before", 600).await;
    assert!(f.candidate(&quick()).await.is_none(), "off by default");
    let (status, _) = f.set_proactive(&f.agent_id, true).await;
    assert_eq!(status, 200);
    assert!(
        f.candidate(&quick()).await.is_none(),
        "the cursor starts at now"
    );
    f.rewind().await;
    assert!(f.candidate(&quick()).await.is_some());
    f.set_proactive(&f.agent_id, false).await;
    assert!(f.candidate(&quick()).await.is_none(), "turned off");
}

#[tokio::test]
async fn only_granted_events_with_content_count() {
    let Some(f) = fixture().await else { return };
    f.watching().await;
    let ungranted = connector(&f.pool, &f.owner, "slack").await;
    event_on(&f.pool, &ungranted, "message", json!({"text": "hi"}), 120).await;
    event_on(
        &f.pool,
        &f.connector_id,
        "mailbox.changed",
        json!({"historyId": "7"}),
        120,
    )
    .await;
    // Received "later" than now, so it is still settling for the whole test.
    event_on(
        &f.pool,
        &f.connector_id,
        "message.received",
        json!({}),
        -3_600,
    )
    .await;
    assert!(
        f.candidate(&quick()).await.is_none(),
        "another connector, a content-free push, and an event still settling"
    );
    grant(&f.pool, &ungranted, &f.agent_id).await;
    assert!(f.candidate(&quick()).await.is_some(), "once granted");
    query("UPDATE cloud_connectors SET status = 'revoked', revoked_at = now() WHERE connector_id = $1")
        .bind(&ungranted)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(f.candidate(&quick()).await.is_none(), "revoked");
}

#[tokio::test]
async fn events_wait_for_quiet_or_the_longest_wait() {
    let Some(f) = fixture().await else { return };
    f.watching().await;
    f.mail("Sam", "Now", 20).await;
    let config = PersonalAgentConfig::default();
    assert!(f.candidate(&config).await.is_none(), "still arriving");
    f.mail("Sam", "Earlier", 400).await;
    assert!(
        f.candidate(&config).await.is_some(),
        "the oldest new event waited five minutes"
    );
}

#[tokio::test]
async fn cooldown_retries_and_caps_hold() {
    let Some(f) = fixture().await else { return };
    f.watching().await;
    f.mail("Sam", "Hello", 120).await;
    assert!(f.candidate(&quick()).await.is_some());
    for column in ["cooldown_until", "retry_after"] {
        query(&format!(
            "UPDATE cloud_personal_agent_state SET {column} = now() + interval '1 hour' \
             WHERE agent_id = $1"
        ))
        .bind(&f.agent_id)
        .execute(&f.pool)
        .await
        .unwrap();
        assert!(f.candidate(&quick()).await.is_none(), "{column}");
        query(&format!(
            "UPDATE cloud_personal_agent_state SET {column} = now() WHERE agent_id = $1"
        ))
        .bind(&f.agent_id)
        .execute(&f.pool)
        .await
        .unwrap();
    }
    query(
        "INSERT INTO cloud_personal_agent_messages (run_id, agent_id, owner_account_id, message_id, text) \
         VALUES ($1, $2, $3, gen_random_uuid(), 'Earlier')",
    )
    .bind(format!("personal_agent_eval_cap_{}", uuid::Uuid::new_v4().simple()))
    .bind(&f.agent_id)
    .bind(&f.owner)
    .execute(&f.pool)
    .await
    .unwrap();
    let shares = PersonalAgentConfig {
        daily_shares: 1,
        ..quick()
    };
    assert!(f.candidate(&shares).await.is_none(), "the message cap");
    let (run_id, _) = f.queue_evaluation().await;
    query("UPDATE cloud_agent_fallback_runs SET status = 'completed' WHERE run_id = $1")
        .bind(&run_id)
        .execute(&f.pool)
        .await
        .unwrap();
    query("UPDATE cloud_personal_agent_state SET active_run_id = NULL WHERE agent_id = $1")
        .bind(&f.agent_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let evaluations = PersonalAgentConfig {
        daily_evaluations: 1,
        ..quick()
    };
    assert!(
        f.candidate(&evaluations).await.is_none(),
        "the evaluation cap"
    );
    assert!(f.candidate(&quick()).await.is_some());
}

#[tokio::test]
async fn an_evaluation_is_a_background_run_with_the_snapshot() {
    let Some(f) = fixture().await else { return };
    let (conversation_id, _) = f.personal_session(&f.agent_id).await;
    let (run_id, event_id) = f.queue_evaluation().await;
    assert!(
        f.candidate(&quick()).await.is_none(),
        "one evaluation at a time"
    );
    let row: (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
    ) = query_as(
        "SELECT session_id, request_message_id, execution_agent_id, requester_account_id, \
                run_trigger, connector_audience, system_prompt, prompt \
         FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(run_id.starts_with("personal_agent_eval_"));
    assert_eq!(row.0, format!("personal-agent:{}", f.agent_id));
    assert_eq!(row.1, run_id);
    assert_eq!(row.2, f.agent_id);
    assert_eq!(row.3, f.owner);
    assert_eq!(
        (row.4.as_str(), row.5.as_str()),
        ("background", "owner_private")
    );
    assert!(row.6.starts_with("You are Scout, Mina's agent."));
    assert!(row.6.contains("Be precise and kind."));
    let snapshot: Value = serde_json::from_str(&row.7).unwrap();
    assert_eq!(snapshot["owner"]["name"], "Mina");
    assert_eq!(snapshot["agent"]["name"], "Scout");
    assert_eq!(snapshot["events"][0]["eventId"], event_id.as_str());
    assert_eq!(snapshot["events"][0]["title"], "Sam · Dinner tonight?");
    assert_eq!(snapshot["events"][0]["provider"], "gmail");
    assert_eq!(snapshot["recentShares"], json!([]));
    assert!(snapshot["recentChat"].is_array());
    let (bound,): (uuid::Uuid,) =
        query_as("SELECT conversation_id FROM cloud_personal_agent_sessions WHERE agent_id = $1")
            .bind(&f.agent_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(bound, conversation_id);
}

#[tokio::test]
async fn turning_it_off_cancels_the_queued_evaluation() {
    let Some(f) = fixture().await else { return };
    let (run_id, _) = f.queue_evaluation().await;
    let (status, _) = f.set_proactive(&f.agent_id, false).await;
    assert_eq!(status, 200);
    let (run_status,): (String,) =
        query_as("SELECT status FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(run_status, "cancelled");
    assert_eq!(f.state().await.1, None);
}

#[tokio::test]
async fn the_sweep_queues_through_the_public_entry_point() {
    let Some(f) = fixture().await else { return };
    f.watching().await;
    f.mail("Sam", "Hello", 400).await;
    query("UPDATE cloud_personal_agent_state SET checked_at = now() - interval '20 years' WHERE agent_id = $1")
        .bind(&f.agent_id)
        .execute(&f.pool)
        .await
        .unwrap();
    for _ in 0..20 {
        crate::personal_agent::sweep(&f.pool, &PersonalAgentConfig::default())
            .await
            .unwrap();
        if f.state().await.1.is_some() {
            return;
        }
        query("UPDATE cloud_personal_agent_state SET checked_at = now() - interval '20 years' WHERE agent_id = $1")
            .bind(&f.agent_id)
            .execute(&f.pool)
            .await
            .unwrap();
    }
    panic!("the sweep queued no evaluation");
}
