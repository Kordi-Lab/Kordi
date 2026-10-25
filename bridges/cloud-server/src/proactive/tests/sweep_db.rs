//! Which conversations the sweep picks, and what an evaluation run looks like.

use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use super::fixture::*;
use crate::proactive::sweep::{evaluate, Outcome};
use crate::proactive::ProactiveConfig;

#[tokio::test]
async fn history_is_never_evaluated() {
    let Some(f) = fixture().await else { return };
    f.seed().await;
    let (seen, active, _) = f.state().await;
    assert_eq!(
        seen,
        f.latest_sequence().await,
        "the cursor starts at the newest message"
    );
    assert!(active.is_none());
    assert!(
        f.candidate(&config()).await.is_none(),
        "old messages are not new"
    );
}

#[tokio::test]
async fn collaborators_wake_the_sweep_once_the_chat_is_quiet() {
    let Some(f) = fixture().await else { return };
    f.seed().await;
    say(&f.pool, &f.owner, f.group, "Can someone check my build?", 5).await;
    assert!(
        f.candidate(&config()).await.is_none(),
        "the owner's own messages"
    );
    let stuck = say(&f.pool, &f.member, f.group, "I'm stuck on the login bug", 0).await;
    assert!(f.candidate(&config()).await.is_none(), "still talking");
    let mut quiet = config();
    quiet.quiet_seconds = 0;
    assert!(f.candidate(&quiet).await.is_some(), "quiet window passed");
    // The oldest new message waited long enough even if the chat goes on.
    query("UPDATE cloud_chat_messages SET created_at = now() - interval '4 minutes' WHERE message_id::text = $1")
        .bind(&stuck)
        .execute(&f.pool)
        .await
        .unwrap();
    say(&f.pool, &f.member, f.group, "anyone?", 0).await;
    assert!(
        f.candidate(&config()).await.is_some(),
        "the max wait passed"
    );
}

#[tokio::test]
async fn service_and_agent_messages_never_trigger() {
    let Some(f) = fixture().await else { return };
    crate::system_account::ensure_account(&f.pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_chat_conversation_members (conversation_id, account_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING")
        .bind(f.group)
        .bind(crate::system_account::SYSTEM_ACCOUNT_ID)
        .execute(&f.pool)
        .await
        .unwrap();
    f.seed().await;
    say(
        &f.pool,
        crate::system_account::SYSTEM_ACCOUNT_ID,
        f.group,
        "Help is on the way?",
        5,
    )
    .await;
    assert!(f.candidate(&config()).await.is_none(), "a service account");
    // A collaborator's own agent replies in the group from their account.
    let reply = crate::cloud_agent_runtime::runs::encode_cloud_agent_response_body(
        "req_1",
        "I can't find the error, can you help?",
    );
    say(&f.pool, &f.member, f.group, &reply, 5).await;
    let candidate = f
        .candidate(&config())
        .await
        .expect("the reply reaches selection");
    assert_eq!(
        evaluate(&f.pool, &candidate).await.unwrap(),
        Outcome::Skipped
    );
    let (seen, active, _) = f.state().await;
    assert_eq!(seen, f.latest_sequence().await, "the cursor moved on");
    assert!(active.is_none(), "no evaluation for an agent's message");
}

#[tokio::test]
async fn mentions_and_small_talk_only_move_the_cursor() {
    let Some(f) = fixture().await else { return };
    f.seed().await;
    say(
        &f.pool,
        &f.member,
        f.group,
        "@ScoutMina can you fix the build?",
        5,
    )
    .await;
    let candidate = f.candidate(&config()).await.expect("a mention is selected");
    assert_eq!(
        evaluate(&f.pool, &candidate).await.unwrap(),
        Outcome::Skipped
    );
    assert_eq!(f.state().await.0, f.latest_sequence().await);
    say(&f.pool, &f.member, f.group, "haha nice photo", 5).await;
    let candidate = f
        .candidate(&config())
        .await
        .expect("small talk is selected");
    assert_eq!(
        evaluate(&f.pool, &candidate).await.unwrap(),
        Outcome::Skipped
    );
    assert_eq!(f.state().await.0, f.latest_sequence().await);
    let (runs,): (i64,) =
        query_as("SELECT count(*) FROM cloud_agent_fallback_runs WHERE execution_agent_id = $1")
            .bind(&f.agent_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(runs, 0);
}

#[tokio::test]
async fn an_evaluation_run_has_the_documented_columns() {
    let Some(f) = fixture().await else { return };
    let run_id = f.queue_evaluation().await;
    assert!(run_id.starts_with("proactive_eval_"));
    type Row = (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        Value,
        Option<String>,
    );
    let row: Row = query_as(
        "SELECT idempotency_key, request_message_id, session_id, owner_account_id, \
                requester_account_id, execution_agent_id, run_trigger, connector_audience, \
                status, prompt, system_prompt, runtime_route_json, sandbox_id \
         FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(row.0, run_id);
    assert_eq!(row.1, run_id);
    assert_eq!(row.2, f.session_id);
    assert_eq!(
        (row.3.as_str(), row.4.as_str()),
        (f.owner.as_str(), f.owner.as_str())
    );
    assert_eq!(row.5, f.agent_id);
    assert_eq!((row.6.as_str(), row.7.as_str()), ("background", "shared"));
    assert_eq!(row.8, "queued");
    assert_eq!(row.11["defaultModel"], "gpt-test");
    assert!(row.12.is_none(), "no sandbox");
    assert!(row.10.starts_with("You are Scout, Mina's agent."));
    assert!(row.10.contains("Be precise and kind."));
    assert!(row
        .10
        .contains("Your owner reviews every offer before anything is posted"));
    let snapshot: Value = serde_json::from_str(&row.9).unwrap();
    assert_eq!(snapshot["agent"]["skills"], json!(["Build doctor"]));
    assert_eq!(snapshot["owner"]["handle"], "@Mina");
    assert_eq!(snapshot["conversation"]["title"], "Launch");
    let members = snapshot["members"].as_array().unwrap();
    assert_eq!(members.len(), 2);
    assert!(members
        .iter()
        .any(|m| m["name"] == "Mina" && m["isOwner"] == true));
    assert!(members
        .iter()
        .any(|m| m["handle"] == "@Riya" && m["isOwner"] == false));
    let messages = snapshot["messages"].as_array().unwrap();
    assert!(messages.len() <= 20);
    let newest = messages.last().unwrap();
    assert_eq!(newest["isNew"], true);
    assert_eq!(newest["senderName"], "Riya");
    assert_eq!(messages[0]["isNew"], false, "history is context only");
    assert!(snapshot["now"].is_string());
    assert!(
        f.candidate(&config()).await.is_none(),
        "one evaluation at a time"
    );
}

#[tokio::test]
async fn the_snapshot_keeps_twenty_messages() {
    let Some(f) = fixture().await else { return };
    f.seed().await;
    for index in 0..25 {
        say(
            &f.pool,
            &f.member,
            f.group,
            &format!("step {index} is broken?"),
            5,
        )
        .await;
    }
    let candidate = f.candidate(&config()).await.unwrap();
    assert_eq!(
        evaluate(&f.pool, &candidate).await.unwrap(),
        Outcome::Queued
    );
    let (prompt,): (String,) =
        query_as("SELECT prompt FROM cloud_agent_fallback_runs WHERE execution_agent_id = $1")
            .bind(&f.agent_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    let snapshot: Value = serde_json::from_str(&prompt).unwrap();
    let messages = snapshot["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 20);
    assert_eq!(messages.last().unwrap()["text"], "step 24 is broken?");
}

#[tokio::test]
async fn the_daily_cap_and_disabled_agents_stop_selection() {
    let Some(f) = fixture().await else { return };
    let run_id = f.queue_evaluation().await;
    f.finish(&run_id, "{\"decision\":\"silence\"}").await;
    say(&f.pool, &f.member, f.group, "Still broken, help?", 5).await;
    let capped = ProactiveConfig {
        daily_cap: 1,
        ..config()
    };
    assert!(
        f.candidate(&capped).await.is_none(),
        "one evaluation used of one"
    );
    assert!(f.candidate(&config()).await.is_some());
    query("UPDATE cloud_agent_definitions SET proactive_json = '{\"enabled\":false}' WHERE agent_id = $1")
        .bind(&f.agent_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(f.candidate(&config()).await.is_none(), "a disabled agent");
}

#[tokio::test]
async fn a_candidate_that_fails_before_it_queues_waits_and_stays_free() {
    let Some(f) = fixture().await else { return };
    f.seed().await;
    let (before, _, _) = f.state().await;
    say(
        &f.pool,
        &f.member,
        f.group,
        "Can anyone help with the deploy?",
        5,
    )
    .await;
    let candidate = f.candidate(&config()).await.expect("a candidate");
    crate::proactive::sweep::defer(&f.pool, &candidate)
        .await
        .unwrap();
    let (seen, active, _) = f.state().await;
    assert!(active.is_none(), "nothing is reserved");
    assert_eq!(seen, before, "the messages are kept for the retry");
    let (attempts, later): (i32, bool) = query_as(
        "SELECT attempts, retry_after > now() FROM cloud_agent_proactive_state WHERE agent_id = $1",
    )
    .bind(&f.agent_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!((attempts, later), (1, true));
    assert!(
        f.candidate(&config()).await.is_none(),
        "not picked again on the next tick"
    );
}
