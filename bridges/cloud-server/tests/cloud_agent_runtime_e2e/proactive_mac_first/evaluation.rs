//! Evaluations: held for the ready Mac, run there with the owner's memories,
//! failed when the reply is too long, and handed to the cloud once.

use super::*;
use kordi_tools::memory_prompt::{
    memory_prompt_section, tool_less_system_prompt, MemoryRun, MemorySettings, PromptMemory,
};

/// The cloud runner's lease of `run_id`, as the runner reads it.
async fn runner_lease(router: &axum::Router, runner_id: &str, run_id: &str) -> Value {
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": runner_id, "canaryRunId": run_id }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    read_json(lease).await["run"].clone()
}

/// What the cloud runner sends as the evaluation's system prompt: the run's
/// own prompt and the section the shared renderer makes from the memories
/// the runner fetches for its lease.
async fn runner_system_prompt(router: &axum::Router, runner_id: &str, run: &Value) -> String {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/v1/cloud/agent-runs/{}/memory?runnerId={runner_id}",
                    run["runId"].as_str().unwrap()
                ))
                .header("authorization", "Bearer runner-test-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let context = read_json(response).await;
    let memories: Vec<PromptMemory<'_>> = context["memories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|memory| PromptMemory {
            scope: memory["scope"].as_str().unwrap(),
            scope_id: memory["scopeId"].as_str().unwrap(),
            text: memory["text"].as_str().unwrap(),
            created_at: memory["createdAt"].as_str().unwrap(),
            updated_at: memory["updatedAt"].as_str().unwrap(),
        })
        .collect();
    let section = memory_prompt_section(
        &MemoryRun {
            session_id: run["sessionId"].as_str().unwrap(),
            subsession_id: run["subsessionId"].as_str(),
            owner_request: run["ownerAccountId"] == run["requesterAccountId"],
        },
        MemorySettings {
            enabled: context["settings"]["memoryEnabled"] == true,
            exclude_sensitive: context["settings"]["excludeSensitive"] == true,
        },
        &memories,
    );
    tool_less_system_prompt(run["systemPrompt"].as_str().unwrap(), section.as_deref())
}

#[tokio::test]
async fn without_a_ready_mac_the_cloud_answers_the_evaluation_at_once() {
    let Some(fx) = fixture("proactive-mac-none", false).await else {
        return;
    };
    let run_id = fx.evaluation().await;
    let (status, backend, held) = fx.run_state(&run_id).await;
    assert_eq!((status.as_str(), backend.as_str()), ("queued", "cloud"));
    assert!(!held, "no hold");
    assert!(fx.hints("proactive.eval_requested").await.is_empty());
    let (status, _) = fx.mac_claim(&run_id, uuid::Uuid::new_v4()).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "this Mac never said it can");
    assert!(runner_can_lease(&fx.router, &run_id).await);
    fx.finish().await;
}

#[tokio::test]
async fn a_ready_mac_runs_the_held_evaluation_with_the_owners_memories() {
    let Some(fx) = fixture("proactive-mac-eval", true).await else {
        return;
    };
    fx.seed_memory("global", "account", "Prefers short answers.")
        .await;
    fx.seed_memory(
        "conversation",
        &fx.session_id,
        "This group ships on Fridays.",
    )
    .await;
    fx.seed_memory(
        "conversation",
        "session:group:elsewhere",
        "Unrelated group note.",
    )
    .await;
    let run_id = fx.evaluation().await;
    let (status, backend, held) = fx.run_state(&run_id).await;
    assert_eq!(
        (status.as_str(), backend.as_str(), held),
        ("queued", "cloud", true)
    );
    let hints = fx.hints("proactive.eval_requested").await;
    assert_eq!(
        hints,
        vec![json!({"runId": run_id, "sessionId": fx.session_id})]
    );
    assert!(
        !runner_can_lease(&fx.router, &run_id).await,
        "the Mac goes first"
    );

    let claim_id = uuid::Uuid::new_v4();
    let claimed = fx.mac_takes(&run_id, claim_id).await;
    assert_eq!(claimed["leaseSeconds"], 45);
    let evaluation = &claimed["proactive"];
    assert_eq!(evaluation["kind"], "evaluation");
    assert_eq!(evaluation["tools"], json!([]));
    assert_eq!(evaluation["modelChoice"], "chat");
    assert_eq!(evaluation["fastModels"]["anthropic"], "claude-haiku-4-5");
    let (prompt, base): (String, String) =
        query_as("SELECT prompt, system_prompt FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&fx.pool)
            .await
            .unwrap();
    assert_eq!(evaluation["prompt"], prompt.as_str());
    let system_prompt = evaluation["systemPrompt"].as_str().unwrap();
    assert!(system_prompt.starts_with(&format!("{}\n\n## Memories", base.trim())));
    assert!(system_prompt.contains("\nGlobal:\n- Prefers short answers."));
    assert!(system_prompt.contains("\nThis conversation:\n- This group ships on Fridays."));
    assert!(!system_prompt.contains("Unrelated group note."));
    assert!(system_prompt.ends_with("do not try to save new ones."));
    assert_eq!(
        fx.run_state(&run_id).await,
        ("leased".into(), "desktop".into(), false)
    );
    let (status, second) = fx.mac_claim(&run_id, uuid::Uuid::new_v4()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second["acquired"], false, "one Mac instance runs it");
    assert_eq!(
        fx.mac_complete(&run_id, uuid::Uuid::new_v4(), "{}").await,
        StatusCode::CONFLICT,
        "only the claim holder completes"
    );

    let trigger = trigger_of(&evaluation["prompt"]);
    assert_eq!(
        fx.mac_complete(&run_id, claim_id, &offer_reply(&trigger))
            .await,
        StatusCode::OK
    );
    assert_eq!(fx.run_state(&run_id).await.0, "completed");
    let (status, trigger_id): (String, String) = query_as(
        "SELECT status, trigger_message_id FROM cloud_agent_proactive_proposals \
         WHERE evaluation_run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&fx.pool)
    .await
    .expect("the offer becomes a proposal");
    assert_eq!(
        (status.as_str(), trigger_id.as_str()),
        ("pending", trigger.as_str())
    );
    assert!(!runner_can_lease(&fx.router, &run_id).await);
    fx.finish().await;
}

#[tokio::test]
async fn an_oversized_evaluation_reply_fails_the_run() {
    let Some(fx) = fixture("proactive-mac-big", true).await else {
        return;
    };
    let run_id = fx.evaluation().await;
    let claim_id = uuid::Uuid::new_v4();
    fx.mac_takes(&run_id, claim_id).await;
    let text = "x".repeat(1_048_577);
    assert_eq!(
        fx.mac_complete(&run_id, claim_id, &text).await,
        StatusCode::OK
    );
    let (status, code): (String, Option<String>) =
        query_as("SELECT status, error_code FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&fx.pool)
            .await
            .unwrap();
    assert_eq!(
        (status.as_str(), code.as_deref()),
        ("failed", Some("invalid_output"))
    );
    let (proposals,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_agent_proactive_proposals WHERE evaluation_run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&fx.pool)
    .await
    .unwrap();
    assert_eq!(proposals, 0);
    let (active,): (Option<String>,) = query_as(
        "SELECT active_run_id FROM cloud_agent_proactive_state \
         WHERE agent_id = $1 AND conversation_id = $2",
    )
    .bind(&fx.agent_id)
    .bind(fx.group)
    .fetch_one(&fx.pool)
    .await
    .unwrap();
    assert_eq!(active, None, "the conversation is free for a later look");
    fx.finish().await;
}

#[tokio::test]
async fn a_released_evaluation_goes_to_the_cloud_once_with_the_same_prompt() {
    let Some(fx) = fixture("proactive-mac-release", true).await else {
        return;
    };
    fx.seed_memory("global", "account", "Answer in British English.")
        .await;
    fx.seed_memory("conversation", &fx.session_id, "Mention the runbook.")
        .await;
    let run_id = fx.evaluation().await;
    let claim_id = uuid::Uuid::new_v4();
    let claimed = fx.mac_takes(&run_id, claim_id).await;
    let mac_prompt = claimed["proactive"]["systemPrompt"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        fx.release(&run_id, uuid::Uuid::new_v4()).await["released"],
        false
    );
    assert_eq!(fx.release(&run_id, claim_id).await["released"], true);
    assert_eq!(
        fx.release(&run_id, claim_id).await["released"],
        false,
        "once"
    );
    let runner = "runner-proactive-release";
    let run = runner_lease(&fx.router, runner, &run_id).await;
    assert_eq!(run["runId"], run_id.as_str(), "the cloud runs it");
    assert!(!runner_can_lease(&fx.router, &run_id).await, "leased once");
    // The Mac got exactly the system prompt the cloud runner builds.
    assert_eq!(
        runner_system_prompt(&fx.router, runner, &run).await,
        mac_prompt
    );
    let (status, late) = fx.mac_claim(&run_id, uuid::Uuid::new_v4()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(late["acquired"], false, "a late Mac never runs it again");
    assert_eq!(
        fx.run_state(&run_id).await,
        ("leased".into(), "cloud".into(), false)
    );
    fx.finish().await;
}
