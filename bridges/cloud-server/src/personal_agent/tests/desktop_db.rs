//! Evaluations go to the owner's ready Mac first, through the proactive
//! evaluation claim, the digest observe route, and the proactive complete
//! route.

use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::fixture::*;

/// Marks the owner's Mac online and ready for proactive runs.
async fn mac_ready(f: &Fixture) {
    query("INSERT INTO cloud_agent_desktop_capabilities (device_id, agent_id) VALUES ($1, 'proactive')")
        .bind(&f.owner_device)
        .execute(&f.pool)
        .await
        .unwrap();
    query(
        "INSERT INTO cloud_device_presence (device_id, account_id, state, last_heartbeat_at, \
         updated_at) VALUES ($1, $2, 'online', $3, $3)",
    )
    .bind(&f.owner_device)
    .bind(&f.owner)
    .bind(Utc::now().to_rfc3339())
    .execute(&f.pool)
    .await
    .unwrap();
}

fn claim_body(f: &Fixture, run_id: &str, claim_id: Uuid) -> Value {
    json!({
        "claimId": claim_id,
        "requestMessageId": run_id,
        "sessionId": format!("personal-agent:{}", f.agent_id),
        "ownerAccountId": f.owner,
        "requesterAccountId": f.owner,
        "prompt": "evaluation",
        "idempotencyKey": run_id,
    })
}

#[tokio::test]
async fn a_ready_mac_claims_searches_and_completes_the_evaluation() {
    let Some(f) = fixture().await else { return };
    mac_ready(&f).await;
    let (conversation_id, _) = f.personal_session(&f.agent_id).await;
    let (run_id, event_id) = f.queue_evaluation().await;
    let (held,): (bool,) = query_as(
        "SELECT desktop_preferred_until > now() FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(held, "held for the Mac");
    let (hint,): (Value,) = query_as(
        "SELECT payload FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND event_type = 'personal_agent.eval_requested' \
         ORDER BY stream_seq DESC LIMIT 1",
    )
    .bind(&f.owner)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(
        hint,
        json!({
            "runId": run_id,
            "sessionId": format!("personal-agent:{}", f.agent_id),
            "agentId": f.agent_id,
        })
    );

    let claim_id = Uuid::new_v4();
    let (status, body) = f
        .send(
            "POST",
            "/v1/cloud/agent-runs/desktop/claim",
            &f.owner_token,
            Some(claim_body(&f, &run_id, claim_id)),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["acquired"], true, "{body}");
    assert_eq!(body["proactive"]["kind"], "evaluation");
    assert_eq!(body["proactive"]["tools"][0]["name"], "search_memory");
    assert_eq!(body["proactive"]["tools"].as_array().unwrap().len(), 1);
    assert_eq!(body["proactive"]["model"], "gpt-test");
    assert_eq!(body["proactive"]["modelChoice"], "named");
    assert!(body["proactive"]["systemPrompt"]
        .as_str()
        .unwrap()
        .starts_with("You are Scout"));
    let snapshot: Value =
        serde_json::from_str(body["proactive"]["prompt"].as_str().unwrap()).unwrap();
    assert_eq!(snapshot["events"][0]["eventId"], event_id.as_str());

    let observe = format!("/v1/cloud/digest/desktop/{run_id}/observe");
    let search =
        json!({"claimId": claim_id, "tool": "search_memory", "arguments": {"query": "Sam"}});
    for _ in 0..3 {
        let (status, body) = f
            .send("POST", &observe, &f.owner_token, Some(search.clone()))
            .await;
        assert_eq!(status, 200, "{body}");
        assert!(body["memories"].is_array(), "{body}");
    }
    let (_, body) = f
        .send("POST", &observe, &f.owner_token, Some(search.clone()))
        .await;
    assert_eq!(
        body["note"],
        "No searches are left in this run. Answer with what you have."
    );
    let stranger =
        json!({"claimId": Uuid::new_v4(), "tool": "search_memory", "arguments": {"query": "x"}});
    let (status, _) = f
        .send("POST", &observe, &f.owner_token, Some(stranger))
        .await;
    assert_eq!(status, 409, "another claim");

    let complete = format!("/v1/cloud/proactive/desktop/{run_id}/complete");
    let (status, body) = f
        .send(
            "POST",
            &complete,
            &f.owner_token,
            Some(json!({"claimId": claim_id, "text": share(&event_id)})),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let messages = f.messages(conversation_id).await;
    assert_eq!(messages.len(), 1);
    assert_eq!(
        envelope(&messages[0])["sources"][0]["eventId"],
        event_id.as_str()
    );
    let (status, _) = f
        .send(
            "POST",
            &complete,
            &f.owner_token,
            Some(json!({"claimId": claim_id, "text": share(&event_id)})),
        )
        .await;
    assert_eq!(status, 409, "the run is over");
    assert_eq!(f.messages(conversation_id).await.len(), 1, "posted once");
}

#[tokio::test]
async fn the_claim_is_refused_for_runs_that_are_not_the_active_evaluation() {
    let Some(f) = fixture().await else { return };
    mac_ready(&f).await;
    let (run_id, _) = f.queue_evaluation().await;
    let made_up = format!("personal_agent_eval_{}", Uuid::new_v4().simple());
    let (status, _) = f
        .send(
            "POST",
            "/v1/cloud/agent-runs/desktop/claim",
            &f.owner_token,
            Some(claim_body(&f, &made_up, Uuid::new_v4())),
        )
        .await;
    assert_eq!(status, 403);
    query("DELETE FROM cloud_agent_desktop_capabilities WHERE device_id = $1")
        .bind(&f.owner_device)
        .execute(&f.pool)
        .await
        .unwrap();
    let (status, _) = f
        .send(
            "POST",
            "/v1/cloud/agent-runs/desktop/claim",
            &f.owner_token,
            Some(claim_body(&f, &run_id, Uuid::new_v4())),
        )
        .await;
    assert_eq!(status, 403, "a Mac that is not ready");
    assert_eq!(
        crate::proactive::memory_search::lease_tools(&run_id)[0].name,
        "search_memory"
    );
}
