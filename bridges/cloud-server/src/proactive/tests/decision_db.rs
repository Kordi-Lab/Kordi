//! The owner's decision, the run it starts, and what turning the setting off
//! stops.

use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use super::fixture::*;
use super::offer_db::{card, offer};

fn decision_uri(f: &Fixture, proposal_id: &str) -> String {
    format!(
        "/v1/cloud/agents/{}/proactive/proposals/{proposal_id}/decision",
        f.agent_id
    )
}

async fn group_messages(f: &Fixture) -> i64 {
    let (count,): (i64,) =
        query_as("SELECT count(*) FROM cloud_chat_messages WHERE conversation_id = $1")
            .bind(f.group)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    count
}

#[tokio::test]
async fn allow_queues_an_owner_started_group_run() {
    let Some(f) = fixture().await else { return };
    let (proposal_id, trigger) = offer(&f).await;
    let uri = decision_uri(&f, &proposal_id);
    let allow = Some(json!({"decision": "allow"}));
    let (status, _) = f.send("POST", &uri, &f.member_token, allow.clone()).await;
    assert_eq!(status, 403, "only the owner decides");
    let (status, body) = f
        .send(
            "POST",
            &uri,
            &f.owner_token,
            Some(json!({"decision": "maybe"})),
        )
        .await;
    assert_eq!(status, 400, "{body}");
    let (status, body) = f.send("POST", &uri, &f.owner_token, allow.clone()).await;
    assert_eq!(status, 200, "{body}");
    let proposal = &body["proposal"];
    let run_id = format!("proactive_run_{proposal_id}");
    assert_eq!(proposal["status"], "approved");
    assert_eq!(proposal["runId"], run_id);
    assert!(proposal["decidedAt"].is_string());

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
        Option<String>,
    );
    let row: Row = query_as(
        "SELECT idempotency_key, request_message_id, session_id, owner_account_id, \
                requester_account_id, execution_agent_id, run_trigger, connector_audience, \
                status, prompt, system_prompt, sandbox_id \
         FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(row.0, run_id);
    assert_eq!(
        row.1, trigger,
        "the reply threads under the collaborator's message"
    );
    assert_eq!(row.2, f.session_id);
    assert_eq!(
        (row.3.as_str(), row.4.as_str()),
        (f.owner.as_str(), f.owner.as_str())
    );
    assert_eq!(row.5, f.agent_id);
    assert_eq!(
        (row.6.as_str(), row.7.as_str()),
        ("person_started", "shared")
    );
    assert_eq!(row.8, "queued");
    assert!(row.9.contains("Mina asked you to help Riya"));
    assert!(row.9.contains("The deploy fails on every push"));
    assert!(row.9.contains("Read the latest deploy log"));
    assert!(row.10.contains("You are Scout, Mina's Cloud Agent."));
    assert!(row.10.contains("Be precise and kind."));
    assert!(row.11.is_some(), "a group run has the group's sandbox");
    let (_, _, _, content) = card(&f, &proposal_id).await;
    assert_eq!(content["blocks"][1]["status"], "approved");
    assert_eq!(content["blocks"][1]["runId"], run_id);

    let (status, _) = f.send("POST", &uri, &f.owner_token, allow).await;
    assert_eq!(status, 409, "decided once");

    // The run answers in the group, and the proposal follows it.
    let before = group_messages(&f).await;
    f.finish(&run_id, "Riya, the deploy fails at the migration step.")
        .await;
    assert_eq!(
        group_messages(&f).await,
        before + 1,
        "the reply lands in the group"
    );
    let (status, done) = f
        .send(
            "GET",
            &format!(
                "/v1/cloud/agents/{}/proactive/proposals?status=done",
                f.agent_id
            ),
            &f.owner_token,
            None,
        )
        .await;
    assert_eq!(status, 200, "{done}");
    let proposal = &done["proposals"][0];
    assert_eq!(proposal["proposalId"], proposal_id);
    assert!(proposal["replyMessageId"].is_string());
    let (_, _, _, content) = card(&f, &proposal_id).await;
    assert_eq!(content["blocks"][1]["status"], "done");
}

#[tokio::test]
async fn decline_and_expiry_post_nothing() {
    let Some(f) = fixture().await else { return };
    let (proposal_id, _) = offer(&f).await;
    let before = group_messages(&f).await;
    let uri = decision_uri(&f, &proposal_id);
    let (status, body) = f
        .send(
            "POST",
            &uri,
            &f.owner_token,
            Some(json!({"decision": "decline"})),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["proposal"]["status"], "declined");
    assert!(body["proposal"]["runId"].is_null());
    assert_eq!(group_messages(&f).await, before);
    let (runs,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_agent_fallback_runs WHERE starts_with(run_id, 'proactive_run_') AND execution_agent_id = $1",
    )
    .bind(&f.agent_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(runs, 0);
    let (_, _, _, content) = card(&f, &proposal_id).await;
    assert_eq!(content["blocks"][1]["status"], "declined");

    // A second offer that runs out of time cannot be allowed.
    query("UPDATE cloud_agent_proactive_state SET cooldown_until = now() WHERE agent_id = $1")
        .bind(&f.agent_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let (late, _) = offer(&f).await;
    query("UPDATE cloud_agent_proactive_proposals SET expires_at = now() - interval '1 second' WHERE proposal_id = $1")
        .bind(&late)
        .execute(&f.pool)
        .await
        .unwrap();
    let (status, _) = f
        .send(
            "POST",
            &decision_uri(&f, &late),
            &f.owner_token,
            Some(json!({"decision": "allow"})),
        )
        .await;
    assert_eq!(status, 409);
    let (status,): (String,) =
        query_as("SELECT status FROM cloud_agent_proactive_proposals WHERE proposal_id = $1")
            .bind(&late)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(status, "expired");
    let (status, _) = f
        .send(
            "POST",
            &decision_uri(&f, "pro_missing"),
            &f.owner_token,
            Some(json!({"decision": "allow"})),
        )
        .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn turning_the_setting_off_stops_everything() {
    let Some(f) = fixture().await else { return };
    let (proposal_id, _) = offer(&f).await;
    query("UPDATE cloud_agent_proactive_state SET cooldown_until = now() WHERE agent_id = $1")
        .bind(&f.agent_id)
        .execute(&f.pool)
        .await
        .unwrap();
    // A second group with a queued evaluation.
    let other = uuid::Uuid::new_v4();
    query("INSERT INTO cloud_chat_conversations (conversation_id, kind, shared_title, created_by_account_id, client_operation_id, creation_fingerprint, legacy_session_id) VALUES ($1, 'group', 'Ops', $2, $3, 'fixture', $4)")
        .bind(other)
        .bind(&f.owner)
        .bind(uuid::Uuid::new_v4())
        .bind(format!("session:group:{}", uuid::Uuid::new_v4().simple()))
        .execute(&f.pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_chat_conversation_members (conversation_id, account_id) VALUES ($1, $2), ($1, $3)")
        .bind(other)
        .bind(&f.owner)
        .bind(&f.member)
        .execute(&f.pool)
        .await
        .unwrap();
    f.seed().await;
    say(
        &f.pool,
        &f.member,
        other,
        "The pager is broken, can anyone help?",
        5,
    )
    .await;
    query("UPDATE cloud_agent_proactive_state SET checked_at = now() - interval '1 hour' WHERE agent_id = $1")
        .bind(&f.agent_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let candidate = crate::proactive::sweep::select(&f.pool, &config(), 10_000)
        .await
        .unwrap()
        .into_iter()
        .find(|c| c.agent_id == f.agent_id && c.conversation_id == other)
        .expect("the second group");
    crate::proactive::sweep::evaluate(&f.pool, &candidate)
        .await
        .unwrap();
    let (queued,): (String,) = query_as(
        "SELECT active_run_id FROM cloud_agent_proactive_state WHERE agent_id = $1 AND conversation_id = $2",
    )
    .bind(&f.agent_id)
    .bind(other)
    .fetch_one(&f.pool)
    .await
    .unwrap();

    let (status, body) = f
        .send(
            "PUT",
            &format!("/v1/cloud/agents/{}", f.agent_id),
            &f.owner_token,
            Some(json!({"proactive": {"enabled": false}})),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["agent"]["proactive"], json!({"enabled": false}));
    let (run_status,): (String,) =
        query_as("SELECT status FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&queued)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(run_status, "cancelled");
    let (proposal_status,): (String,) =
        query_as("SELECT status FROM cloud_agent_proactive_proposals WHERE proposal_id = $1")
            .bind(&proposal_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(proposal_status, "expired");
    let (_, _, _, content) = card(&f, &proposal_id).await;
    assert_eq!(content["blocks"][1]["status"], "expired");
    let (active,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_agent_proactive_state WHERE agent_id = $1 AND active_run_id IS NOT NULL",
    )
    .bind(&f.agent_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(active, 0);
    f.seed().await;
    let (rows,): (i64,) =
        query_as("SELECT count(*) FROM cloud_agent_proactive_state WHERE agent_id = $1")
            .bind(&f.agent_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(rows, 0, "turning it back on starts from the newest message");
    let _: Value = body;
}

#[tokio::test]
async fn archiving_the_agent_expires_its_offers() {
    let Some(f) = fixture().await else { return };
    let (proposal_id, _) = offer(&f).await;
    let (status, _) = f
        .send(
            "DELETE",
            &format!("/v1/cloud/agents/{}", f.agent_id),
            &f.owner_token,
            None,
        )
        .await;
    assert_eq!(status, 200);
    let (proposal_status,): (String,) =
        query_as("SELECT status FROM cloud_agent_proactive_proposals WHERE proposal_id = $1")
            .bind(&proposal_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(proposal_status, "expired");
}

/// Sends a group envelope message as a collaborator, as clients do.
async fn say_in_group(f: &Fixture, text: &str) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let id = format!("grp_msg_{}", uuid::Uuid::new_v4().simple());
    let person = |account: &str, name: &str| json!({"accountId": account, "displayName": name, "avatarUrl": null, "role": "person"});
    let envelope = json!({
        "kind": "group-message",
        "groupId": f.group.to_string(),
        "groupTitle": "Launch",
        "createdByAccountId": f.owner,
        "actor": person(&f.member, "Riya"),
        "participants": [person(&f.owner, "Mina"), person(&f.member, "Riya")],
        "message": {
            "id": id,
            "senderAccountId": f.member,
            "text": text,
            "createdAtMs": chrono::Utc::now().timestamp_millis(),
            "senderKind": "human",
        },
    });
    let body = format!(
        "kordi-cloud-group:{}",
        URL_SAFE_NO_PAD.encode(envelope.to_string())
    );
    say(&f.pool, &f.member, f.group, &body, 5).await;
    id
}

#[tokio::test]
async fn the_reply_answers_the_group_message_as_the_agent() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let Some(f) = fixture().await else { return };
    f.seed().await;
    let trigger = say_in_group(&f, "The pager is broken, can anyone help?").await;
    let candidate = f.candidate(&config()).await.expect("a candidate");
    crate::proactive::sweep::evaluate(&f.pool, &candidate)
        .await
        .unwrap();
    let run_id = f.state().await.1.expect("an evaluation");
    f.finish(&run_id, &offer_reply(&trigger)).await;
    let (proposal_id, stored_trigger): (String, String) = query_as(
        "SELECT proposal_id, trigger_message_id FROM cloud_agent_proactive_proposals WHERE evaluation_run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(stored_trigger, trigger, "the envelope's own id");
    let (status, body) = f
        .send(
            "POST",
            &decision_uri(&f, &proposal_id),
            &f.owner_token,
            Some(json!({"decision": "allow"})),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let approved = format!("proactive_run_{proposal_id}");
    f.finish(&approved, "Riya, the pager needs its token renewed.")
        .await;
    let (reply,): (Value,) = query_as(
        "SELECT m.content FROM cloud_agent_fallback_runs run \
         JOIN cloud_chat_messages m ON m.message_id::text = run.response_message_id \
         WHERE run.run_id = $1",
    )
    .bind(&approved)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    let text = reply["blocks"][0]["text"].as_str().unwrap();
    let encoded = text
        .strip_prefix("kordi-cloud-group:")
        .expect("a group reply");
    let envelope: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
    let message = &envelope["message"];
    assert_eq!(message["senderKind"], "agent");
    assert_eq!(message["senderAgentId"], f.agent_id);
    assert_eq!(message["senderDisplayName"], "Scout");
    assert_eq!(message["replyToMessageId"], trigger);
    assert_eq!(message["text"], "Riya, the pager needs its token renewed.");
    let (status,): (String,) =
        query_as("SELECT status FROM cloud_agent_proactive_proposals WHERE proposal_id = $1")
            .bind(&proposal_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(status, "done");
}
