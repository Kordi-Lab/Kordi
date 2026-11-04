//! Synthetic failures must stay honest without publishing agent instructions.
use super::*;

async fn public_reply(f: &Fixture, run: &str) -> String {
    let (content,): (Value,) = query_as("SELECT m.content FROM cloud_agent_fallback_runs r JOIN cloud_chat_messages m ON m.message_id::text=r.response_message_id WHERE r.run_id=$1")
        .bind(run).fetch_one(&f.pool).await.unwrap();
    let body = content["blocks"][0]["text"].as_str().unwrap();
    let encoded = body.split_once(':').unwrap().1;
    let envelope: Value = serde_json::from_slice(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .unwrap(),
    )
    .unwrap();
    envelope.get("message").unwrap_or(&envelope)["text"]
        .as_str()
        .unwrap()
        .into()
}

#[tokio::test]
async fn failed_target_and_unavailable_initiator_publish_recovery_without_orchestration() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    f.send("synthetic-failed-target", 1).await;
    f.end_parent().await;
    let target = f.pending(1).await.remove(0);
    let run = target["runId"].as_str().unwrap();
    let claim = f.claim(1, &target).await;
    f.post(
        1,
        &format!("/v1/cloud/agent-exchanges/desktop/{run}/fail"),
        json!({"claimId":claim,"text":"Synthetic private executor diagnostic"}),
    )
    .await;
    let target_reply = public_reply(&f, run).await;
    assert!(target_reply.contains("no answer is available"));
    assert!(target_reply.contains("try again"));
    assert!(!target_reply.contains("Continue with"));
    assert!(!target_reply.contains("executor diagnostic"));

    let resume = f.pending(0).await.remove(0);
    let prompt = resume["prompt"].as_str().unwrap();
    assert!(prompt.contains("do not invent an answer"));
    assert!(prompt.contains(&target_reply));
    let resume_run = resume["runId"].as_str().unwrap();
    let resume_claim = f.claim(0, &resume).await;
    // The initiating executor cannot use its provider either.
    for _ in 0..2 {
        f.post(
            0,
            &format!("/v1/cloud/agent-exchanges/desktop/{resume_run}/fail"),
            json!({"claimId":resume_claim,"text":"Synthetic unavailable provider"}),
        )
        .await;
    }
    assert_eq!(public_reply(&f, resume_run).await, target_reply);
    let (status, processed): (String, bool) = query_as(
        "SELECT status,processed_at IS NOT NULL FROM cloud_agent_exchanges WHERE resume_run_id=$1",
    )
    .bind(resume_run)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(status, "failed");
    assert!(processed);
}
