//! Finished evaluations: silence writes nothing, an offer becomes a proposal
//! and a `proactive.proposal_changed` hint for the owner, never a message.

use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::fixture::*;

/// The newest collaborator message id in the evaluation's snapshot.
async fn trigger_of(f: &Fixture, run_id: &str) -> String {
    let (prompt,): (String,) =
        query_as("SELECT prompt FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(run_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    let snapshot: Value = serde_json::from_str(&prompt).unwrap();
    snapshot["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["isNew"] == true && message["fromOwner"] == false)
        .unwrap()["messageId"]
        .as_str()
        .unwrap()
        .to_string()
}

pub(super) async fn offer(f: &Fixture) -> (String, String) {
    let run_id = f.queue_evaluation().await;
    let trigger = trigger_of(f, &run_id).await;
    f.finish(&run_id, &offer_reply(&trigger)).await;
    let (proposal_id,): (String,) = query_as(
        "SELECT proposal_id FROM cloud_agent_proactive_proposals WHERE evaluation_run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    (proposal_id, trigger)
}

/// The `proactive.proposal_changed` payloads `account` received for a
/// proposal, oldest first.
pub(super) async fn hints_for(f: &Fixture, account: &str, proposal_id: &str) -> Vec<Value> {
    let rows: Vec<(Value,)> = query_as(
        "SELECT payload FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND event_type = 'proactive.proposal_changed' \
           AND payload->>'proposalId' = $2 ORDER BY stream_seq",
    )
    .bind(account)
    .bind(proposal_id)
    .fetch_all(&f.pool)
    .await
    .unwrap();
    rows.into_iter().map(|(payload,)| payload).collect()
}

/// The owner's latest hint for a proposal.
pub(super) async fn last_hint(f: &Fixture, proposal_id: &str) -> Value {
    hints_for(f, &f.owner, proposal_id)
        .await
        .pop()
        .expect("a hint for the owner")
}

/// Every conversation and message the owner can see, to show an offer adds
/// neither.
pub(super) async fn owner_footprint(f: &Fixture) -> (i64, i64) {
    query_as(
        "SELECT (SELECT count(*) FROM cloud_chat_conversation_members WHERE account_id = $1), \
                (SELECT count(*) FROM cloud_chat_messages m \
                 JOIN cloud_chat_conversation_members member USING (conversation_id) \
                 WHERE member.account_id = $1)",
    )
    .bind(&f.owner)
    .fetch_one(&f.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn silence_writes_nothing_and_frees_the_conversation() {
    let Some(f) = fixture().await else { return };
    let run_id = f.queue_evaluation().await;
    f.finish(&run_id, "Happy to help with anything!").await;
    let (status,): (String,) =
        query_as("SELECT status FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(status, "completed");
    let (proposals,): (i64,) =
        query_as("SELECT count(*) FROM cloud_agent_proactive_proposals WHERE agent_id = $1")
            .bind(&f.agent_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(proposals, 0, "bare text is silence");
    let (_, active, cooling) = f.state().await;
    assert!(active.is_none());
    assert!(!cooling);
    let (cards,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_chat_messages m JOIN cloud_chat_conversations c USING (conversation_id) \
         WHERE c.kind = 'ai' AND m.sender_account_id = $1",
    )
    .bind(&f.owner)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(cards, 0);
    let (status, activity) = f
        .send(
            "GET",
            &format!(
                "/v1/cloud/agents/{}/proactive/activity?limit=50",
                f.agent_id
            ),
            &f.owner_token,
            None,
        )
        .await;
    assert_eq!(status, 200, "{activity}");
    assert_eq!(activity["activity"][0]["decision"], "silence");
    assert_eq!(activity["activity"][0]["conversationTitle"], "Launch");
    assert_eq!(
        activity["activity"][0]["conversationId"],
        f.group.to_string()
    );
}

#[tokio::test]
async fn an_offer_becomes_a_proposal_and_a_hint_but_no_message() {
    let Some(f) = fixture().await else { return };
    let run_id = f.queue_evaluation().await;
    let footprint = owner_footprint(&f).await;
    let trigger = trigger_of(&f, &run_id).await;
    f.finish(&run_id, &offer_reply(&trigger)).await;
    assert_eq!(
        owner_footprint(&f).await,
        footprint,
        "no message and no new chat"
    );
    let (proposal_id,): (String,) = query_as(
        "SELECT proposal_id FROM cloud_agent_proactive_proposals WHERE evaluation_run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(proposal_id.starts_with("pro_"));
    type Row = (
        String,
        Uuid,
        String,
        String,
        Value,
        String,
        String,
        String,
        bool,
    );
    let row: Row = query_as(
        "SELECT owner_account_id, conversation_id, session_id, trigger_message_id, evidence_json, \
                problem, plan, status, expires_at BETWEEN now() + interval '23 hours' AND now() + interval '25 hours' \
         FROM cloud_agent_proactive_proposals WHERE proposal_id = $1",
    )
    .bind(&proposal_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(row.0, f.owner);
    assert_eq!(row.1, f.group);
    assert_eq!(row.2, f.session_id);
    assert_eq!(row.3, trigger);
    assert_eq!(
        row.4,
        serde_json::json!([trigger]),
        "unknown ids are dropped"
    );
    assert_eq!(row.5, "The deploy fails on every push");
    assert!(row.6.starts_with("Read the latest deploy log"));
    assert_eq!(row.7, "pending");
    assert!(row.8, "expires in 24 hours");
    let (_, active, cooling) = f.state().await;
    assert!(active.is_none());
    assert!(cooling, "an offer starts the cooldown");

    let hints = hints_for(&f, &f.owner, &proposal_id).await;
    assert_eq!(hints.len(), 1, "one hint on creation");
    let hint = &hints[0];
    let mut keys: Vec<&str> = hint
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "agentId",
            "conversationId",
            "expiresAt",
            "offer",
            "plan",
            "problem",
            "proposalId",
            "replyMessageId",
            "runId",
            "sessionId",
            "status"
        ]
    );
    assert_eq!(hint["agentId"], f.agent_id);
    assert_eq!(hint["conversationId"], f.group.to_string());
    assert_eq!(hint["sessionId"], f.session_id);
    assert_eq!(hint["status"], "pending");
    assert_eq!(hint["problem"], "The deploy fails on every push");
    assert!(hint["runId"].is_null() && hint["replyMessageId"].is_null());
    assert!(hint["expiresAt"].as_str().unwrap().ends_with('Z'));
    assert!(
        hints_for(&f, &f.member, &proposal_id).await.is_empty(),
        "only the owner hears of it"
    );

    // Cooldown, then the pending proposal, hold the conversation.
    say(&f.pool, &f.member, f.group, "still failing, help?", 5).await;
    assert!(f.candidate(&config()).await.is_none(), "cooling down");
    query("UPDATE cloud_agent_proactive_state SET cooldown_until = now() WHERE agent_id = $1")
        .bind(&f.agent_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        f.candidate(&config()).await.is_none(),
        "a proposal is pending"
    );
    query("UPDATE cloud_agent_proactive_proposals SET expires_at = now() - interval '1 minute' WHERE proposal_id = $1")
        .bind(&proposal_id)
        .execute(&f.pool)
        .await
        .unwrap();
    crate::proactive::sync_runs(&f.pool, None).await.unwrap();
    assert_eq!(
        last_hint(&f, &proposal_id).await["status"],
        "expired",
        "the sweep expires it and tells the owner"
    );
    assert!(f.candidate(&config()).await.is_some(), "free again");

    let (status, pending) = f
        .send(
            "GET",
            &format!(
                "/v1/cloud/agents/{}/proactive/proposals?status=expired",
                f.agent_id
            ),
            &f.owner_token,
            None,
        )
        .await;
    assert_eq!(status, 200, "{pending}");
    assert_eq!(pending["proposals"][0]["proposalId"], proposal_id);
    let (status, activity) = f
        .send(
            "GET",
            &format!("/v1/cloud/agents/{}/proactive/activity", f.agent_id),
            &f.owner_token,
            None,
        )
        .await;
    assert_eq!(status, 200);
    let item = &activity["activity"][0];
    assert_eq!(item["decision"], "offer");
    assert_eq!(item["proposalId"], proposal_id);
    assert_eq!(item["status"], "expired");
    assert_eq!(item["problem"], "The deploy fails on every push");
    let (status, _) = f
        .send(
            "GET",
            &format!("/v1/cloud/agents/{}/proactive/activity", f.agent_id),
            &f.member_token,
            None,
        )
        .await;
    assert_eq!(status, 403, "activity is the owner's only");
}

#[tokio::test]
async fn failed_evaluations_back_off_and_retry_the_same_messages() {
    let Some(f) = fixture().await else { return };
    let (before, _, _) = {
        f.seed().await;
        f.state().await
    };
    let run_id = f.queue_evaluation().await;
    crate::proactive::fail(&f.pool, &run_id, None, "model_provider_error")
        .await
        .unwrap();
    let (seen, active, _) = f.state().await;
    assert!(active.is_none());
    assert_eq!(
        seen, before,
        "the cursor rolls back to where the run started"
    );
    let (retry_later,): (bool,) =
        query_as("SELECT retry_after > now() FROM cloud_agent_proactive_state WHERE agent_id = $1")
            .bind(&f.agent_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(retry_later);
}
