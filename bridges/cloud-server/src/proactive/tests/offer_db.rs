//! Finished evaluations: silence writes nothing, an offer becomes a proposal
//! and a card in the owner's conversation with the agent.

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

/// (conversation kind, session, sender, content) of a proposal's card.
pub(super) async fn card(f: &Fixture, proposal_id: &str) -> (String, String, String, Value) {
    query_as(
        "SELECT c.kind, c.legacy_session_id, m.sender_account_id, m.content \
         FROM cloud_agent_proactive_proposals p \
         JOIN cloud_chat_messages m ON m.message_id::text = p.card_message_id \
         JOIN cloud_chat_conversations c ON c.conversation_id = m.conversation_id \
         WHERE p.proposal_id = $1",
    )
    .bind(proposal_id)
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
async fn an_offer_becomes_a_proposal_and_a_card() {
    let Some(f) = fixture().await else { return };
    let (proposal_id, trigger) = offer(&f).await;
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

    let (kind, session, sender, content) = card(&f, &proposal_id).await;
    assert_eq!(kind, "ai");
    assert_eq!(
        session,
        format!("session:self-agent:proactive:{}", f.agent_id)
    );
    assert_eq!(sender, f.owner);
    let blocks = content["blocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 2);
    let fallback = blocks[0]["text"].as_str().unwrap();
    assert!(fallback.starts_with("kordi-cloud-agent-response:"));
    let block = &blocks[1];
    assert_eq!(block["type"], "proactive_offer");
    assert_eq!(block["proposalId"], proposal_id);
    assert_eq!(block["agentId"], f.agent_id);
    assert_eq!(block["agentName"], "Scout");
    assert_eq!(block["conversationId"], f.group.to_string());
    assert_eq!(block["sessionId"], f.session_id);
    assert_eq!(block["conversationTitle"], "Launch");
    assert_eq!(block["triggerMessageId"], trigger);
    assert_eq!(block["status"], "pending");
    assert!(block["runId"].is_null() && block["decidedAt"].is_null());
    assert!(block["expiresAt"].as_str().unwrap().ends_with('Z'));

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
    let (_, _, _, content) = card(&f, &proposal_id).await;
    assert_eq!(
        content["blocks"][1]["status"], "expired",
        "the card refreshed in place"
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
