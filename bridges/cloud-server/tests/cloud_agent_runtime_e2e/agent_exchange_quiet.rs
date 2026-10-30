//! A shared question and answer need no acknowledgement or retelling.
use super::*;
const SILENT: &str = r#"{"agentExchangeOutcome":"silent"}"#;
const WAITING: &str = r#"{"agentExchangeOutcome":"waiting"}"#;

impl Fixture {
    async fn complete_parent(&self, cloud: bool) -> Value {
        if cloud {
            query("UPDATE cloud_agent_fallback_runs SET execution_backend='cloud',claimed_by='quiet-runner' WHERE run_id=$1")
                .bind(&self.root).execute(&self.pool).await.unwrap();
            let response = self
                .router
                .clone()
                .oneshot(post_json_with_runner_token(
                    &format!("/v1/cloud/agent-runs/{}/complete", self.root),
                    "runner-test-token",
                    json!({"runnerId":"quiet-runner","responseText":"I asked and am waiting."}),
                ))
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::OK,
                "{}",
                read_json(response).await
            );
            let (body,): (String,) = query_as("SELECT m.content #>> '{blocks,0,text}' FROM cloud_agent_fallback_runs r JOIN cloud_chat_messages m ON m.message_id::text=r.response_message_id WHERE r.run_id=$1")
                .bind(&self.root).fetch_one(&self.pool).await.unwrap();
            return json!({"body":body});
        }
        self.parent_progress("I asked and am waiting.", "complete")
            .await
    }
    async fn parent_progress(&self, text: &str, phase: &str) -> Value {
        let (request,): (String,) =
            query_as("SELECT request_message_id FROM cloud_agent_fallback_runs WHERE run_id=$1")
                .bind(&self.root)
                .fetch_one(&self.pool)
                .await
                .unwrap();
        let (kind,): (String,) =
            query_as("SELECT kind FROM cloud_chat_conversations WHERE legacy_session_id=$1")
                .bind(&self.session)
                .fetch_one(&self.pool)
                .await
                .unwrap();
        let response =
            json!({"kind":"agent-response","requestId":request,"text":text,"deliveryState":phase});
        let (prefix, envelope) = if kind == "group" {
            let mut message = response;
            message["id"] = json!(uuid::Uuid::new_v4());
            message["senderAccountId"] = json!(self.people[0].account_id);
            message["senderAgentId"] = json!(format!("cloud-agent:{}", self.people[0].account_id));
            message["senderKind"] = json!("agent");
            message["createdAtMs"] = json!(chrono::Utc::now().timestamp_millis());
            (
                "kordi-cloud-group",
                json!({"kind":"group-message","groupId":self.session,"message":message}),
            )
        } else {
            ("kordi-cloud-agent-response", response)
        };
        let wire = format!(
            "{prefix}:{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(envelope.to_string())
        );
        self.post(
            0,
            &format!("/v1/cloud/agent-runs/desktop/{}/progress", self.root),
            json!({"claimId":self.claim,"body":wire,"clientMessageId":uuid::Uuid::new_v4()}),
        )
        .await
    }
    async fn public_texts(&self) -> Vec<String> {
        let rows: Vec<(Value,)> = query_as("SELECT m.content FROM cloud_chat_messages m JOIN cloud_chat_conversations c USING(conversation_id) WHERE c.legacy_session_id=$1 ORDER BY m.conversation_sequence")
            .bind(&self.session).fetch_all(&self.pool).await.unwrap();
        rows.into_iter()
            .filter_map(|(content,)| {
                let text = content.pointer("/blocks/0/text")?.as_str()?;
                let (_, body) = text.split_once(':')?;
                let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(body)
                    .ok()?;
                let envelope: Value = serde_json::from_slice(&decoded).ok()?;
                let response = envelope.get("message").unwrap_or(&envelope);
                let text = response["text"].as_str()?;
                (response["deliveryState"] == "complete"
                    && text != WAITING
                    && response["synchronizationOnly"] != true
                    && response["structuredContent"]["synchronizationOnly"] != true)
                    .then(|| text.to_owned())
            })
            .collect()
    }
}

#[tokio::test]
async fn shared_question_silently_finishes_after_a_reply_on_mac_and_cloud() {
    for (group, cloud) in [(true, false), (false, false), (true, true)] {
        let Some(f) = Fixture::kind(group).await else {
            return;
        };
        f.send("quiet", 1).await;
        let parent = f.complete_parent(cloud).await;
        {
            let body = parent["body"].as_str().unwrap().split_once(':').unwrap().1;
            let value: Value = serde_json::from_slice(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(body)
                    .unwrap(),
            )
            .unwrap();
            let response = value.get("message").unwrap_or(&value);
            assert_eq!(response["text"], "");
            let control = response.get("structuredContent").unwrap_or(response);
            assert_eq!(control["synchronizationOnly"], true);
            assert_eq!(control["agentExchangeOutcome"], "waiting");
        }
        let target = f.pending(1).await.remove(0);
        let target_run = target["runId"].as_str().unwrap();
        let target_claim = f.claim(1, &target).await;
        // An actual reply is required; the recipient cannot pretend to be silent.
        for invalid in [SILENT, ""] {
            let response = f
                .router
                .clone()
                .oneshot(post_json_with_token(
                    &format!("/v1/cloud/agent-exchanges/desktop/{target_run}/complete"),
                    &f.people[1].token,
                    json!({"claimId":target_claim,"text":invalid}),
                ))
                .await
                .unwrap();
            assert_ne!(response.status(), StatusCode::OK);
        }
        f.finish(1, target_run, target_claim, "Synthetic status: ready")
            .await;
        let resume = f.pending(0).await.remove(0);
        assert!(resume["prompt"]
            .as_str()
            .unwrap()
            .contains("already visible"));
        let resume_run = resume["runId"].as_str().unwrap();
        if cloud {
            query("UPDATE cloud_agent_fallback_runs SET desktop_preferred_until=now()-interval '1 second' WHERE run_id=$1").bind(resume_run).execute(&f.pool).await.unwrap();
            assert!(
                super::super::hosted_only_admission::runner_can_lease(&f.router, resume_run).await
            );
            for _ in 0..2 {
                let response = f
                    .router
                    .clone()
                    .oneshot(post_json_with_runner_token(
                        &format!("/v1/cloud/agent-runs/{resume_run}/complete"),
                        "runner-test-token",
                        json!({"runnerId":"runner-mac-first","responseText":SILENT}),
                    ))
                    .await
                    .unwrap();
                assert_eq!(
                    response.status(),
                    StatusCode::OK,
                    "{}",
                    read_json(response).await
                );
            }
        } else {
            let old = f.claim(0, &resume).await;
            query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()-interval '1 second')::text WHERE run_id=$1").bind(resume_run).execute(&f.pool).await.unwrap();
            assert_eq!(f.pending(0).await.len(), 1);
            let current = f.claim(0, &resume).await;
            let stale = f
                .router
                .clone()
                .oneshot(post_json_with_token(
                    &format!("/v1/cloud/agent-exchanges/desktop/{resume_run}/complete"),
                    &f.people[0].token,
                    json!({"claimId":old,"text":SILENT}),
                ))
                .await
                .unwrap();
            assert_ne!(stale.status(), StatusCode::OK);
            f.finish(0, resume_run, current, SILENT).await;
            f.finish(0, resume_run, current, SILENT).await;
        }
        let (state,processed,message):(String,bool,Option<String>)=query_as("SELECT e.status,e.processed_at IS NOT NULL,r.response_message_id FROM cloud_agent_exchanges e JOIN cloud_agent_fallback_runs r ON r.run_id=e.resume_run_id WHERE r.run_id=$1")
            .bind(resume_run).fetch_one(&f.pool).await.unwrap();
        assert_eq!(state, "completed");
        assert!(processed);
        assert!(message.is_none());
        assert!(f.pending(0).await.is_empty());
        let texts = f.public_texts().await;
        assert_eq!(
            texts.len(),
            2,
            "only the question and recipient answer: {texts:?}"
        );
        assert_eq!(texts[1], "Synthetic status: ready");
    }
}

#[tokio::test]
async fn useful_follow_up_is_public_and_timeout_cannot_disappear_silently() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    f.send("compute", 1).await;
    f.complete_parent(false).await;
    let target = f.pending(1).await.remove(0);
    let claim = f.claim(1, &target).await;
    f.finish(1, target["runId"].as_str().unwrap(), claim, "15")
        .await;
    let resume = f.pending(0).await.remove(0);
    let claim = f.claim(0, &resume).await;
    f.finish(
        0,
        resume["runId"].as_str().unwrap(),
        claim,
        "The requested total is 19.",
    )
    .await;
    let texts = f.public_texts().await;
    assert_eq!(texts.len(), 3);
    assert_eq!(texts[2], "The requested total is 19.");

    let Some(f) = Fixture::new().await else {
        return;
    };
    f.send("timeout", 1).await;
    f.complete_parent(false).await;
    query("UPDATE cloud_agent_exchanges SET deadline_at=now()-interval '1 second' WHERE parent_run_id=$1").bind(&f.root).execute(&f.pool).await.unwrap();
    let resume = f.pending(0).await.remove(0);
    let claim = f.claim(0, &resume).await;
    let response = f
        .router
        .clone()
        .oneshot(post_json_with_token(
            &format!(
                "/v1/cloud/agent-exchanges/desktop/{}/complete",
                resume["runId"].as_str().unwrap()
            ),
            &f.people[0].token,
            json!({"claimId":claim,"text":SILENT}),
        ))
        .await
        .unwrap();
    assert_ne!(response.status(), StatusCode::OK);
    f.finish(
        0,
        resume["runId"].as_str().unwrap(),
        claim,
        "The agent did not reply before the deadline.",
    )
    .await;
    assert_eq!(f.public_texts().await.len(), 2);
}

#[tokio::test]
async fn a_follow_up_that_delegates_again_yields_without_another_acknowledgement() {
    let Some(mut f) = Fixture::new().await else {
        return;
    };
    f.send("first", 1).await;
    f.complete_parent(false).await;
    let target = f.pending(1).await.remove(0);
    let claim = f.claim(1, &target).await;
    f.finish(1, target["runId"].as_str().unwrap(), claim, "Ready")
        .await;
    let resume = f.pending(0).await.remove(0);
    let claim = f.claim(0, &resume).await;
    let run = resume["runId"].as_str().unwrap();
    f.root = run.into();
    f.claim = claim;
    f.send("follow-up", 2).await;
    f.finish(0, run, claim, "I asked another agent and am waiting.")
        .await;
    let texts = f.public_texts().await;
    assert_eq!(
        texts.len(),
        3,
        "first question, answer, and new question only"
    );
    assert!(texts.iter().all(|text| !text.contains("am waiting")));
    assert_eq!(f.pending(2).await.len(), 1);
}

#[tokio::test]
async fn continuation_uses_canonical_trigger_not_historical_run_prompt() {
    for group in [true, false] {
        let Some(f) = Fixture::kind(group).await else {
            return;
        };
        query("UPDATE cloud_agent_fallback_runs SET prompt=$2 WHERE run_id=$1")
            .bind(&f.root)
            .bind("Conversation history: Create an old synthetic document. Current request: Ask Beta and continue")
            .execute(&f.pool).await.unwrap();
        f.send("canonical-trigger", 1).await;
        f.complete_parent(true).await;
        let target = f.pending(1).await.remove(0);
        let claim = f.claim(1, &target).await;
        f.finish(1, target["runId"].as_str().unwrap(), claim, "Ready")
            .await;
        let resume = f.pending(0).await.remove(0);
        let prompt = resume["prompt"].as_str().unwrap();
        let data: Value = serde_json::from_str(prompt.split_once('\n').unwrap().1).unwrap();
        assert_eq!(data["originalRequest"], "Ask Beta and continue");
        assert!(!prompt.contains("old synthetic document"));
        assert!(prompt.contains("not unfinished tasks"));
    }
}

#[tokio::test]
async fn desktop_streaming_control_is_metadata_before_completion() {
    for group in [true, false] {
        let Some(f) = Fixture::kind(group).await else {
            return;
        };
        for text in ["{", r#"{"agentExchangeOutcome":"#, WAITING] {
            let response = f.parent_progress(text, "processing").await;
            let encoded = response["body"]
                .as_str()
                .unwrap()
                .split_once(':')
                .unwrap()
                .1;
            let value: Value = serde_json::from_slice(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(encoded)
                    .unwrap(),
            )
            .unwrap();
            let message = value.get("message").unwrap_or(&value);
            assert_eq!(message["text"], "");
            let metadata = message.get("structuredContent").unwrap_or(message);
            assert_eq!(metadata["synchronizationOnly"], true);
        }
        f.complete_parent(false).await;
    }
}
