//! Evaluations: held for the ready Mac, run there with `search_memory` as
//! their only tool and no memories in the prompt, failed when the reply is
//! too long, and handed to the cloud once.

use super::*;

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
async fn a_ready_mac_runs_the_held_evaluation_with_only_the_memory_search() {
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
    assert_eq!(tool_names(&evaluation["tools"]), vec!["search_memory"]);
    assert_eq!(
        evaluation["tools"][0]["parameters"]["required"],
        json!(["query"])
    );
    assert_eq!(evaluation["modelChoice"], "chat");
    assert_eq!(evaluation["fastModels"]["anthropic"], "claude-haiku-4-5");
    let (prompt, base): (String, String) =
        query_as("SELECT prompt, system_prompt FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&fx.pool)
            .await
            .unwrap();
    assert_eq!(evaluation["prompt"], prompt.as_str());
    // No memories in the prompt: the evaluation searches for them.
    let system_prompt = evaluation["systemPrompt"].as_str().unwrap();
    assert_eq!(system_prompt, base.trim());
    assert!(!system_prompt.contains("## Memories"));
    assert!(!system_prompt.contains("Prefers short answers."));
    assert!(system_prompt.contains("search your owner's memories with search_memory"));
    let search = |query: &str| json!({"query": query});
    let (status, _) = fx
        .observe(
            &run_id,
            uuid::Uuid::new_v4(),
            "search_memory",
            search("short"),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "only the claim holder searches"
    );
    let (status, refused) = fx
        .observe(&run_id, claim_id, "bash", json!({"command": "ls"}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        refused["error"],
        "Only search_memory is available in this run."
    );
    let (status, answer) = fx
        .observe(&run_id, claim_id, "search_memory", search("short answers"))
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(found(&answer), vec!["Prefers short answers."]);
    assert!(answer["note"]
        .as_str()
        .unwrap()
        .contains("never quote or mention them"));
    let (_, answer) = fx
        .observe(&run_id, claim_id, "search_memory", search("ships Friday"))
        .await;
    assert_eq!(found(&answer), vec!["This group ships on Fridays."]);
    let (_, answer) = fx
        .observe(&run_id, claim_id, "search_memory", search("unrelated"))
        .await;
    assert!(found(&answer).is_empty(), "another conversation's memory");
    let (_, answer) = fx
        .observe(&run_id, claim_id, "search_memory", search("short answers"))
        .await;
    assert!(found(&answer).is_empty(), "three searches at most");
    assert!(answer["note"]
        .as_str()
        .unwrap()
        .starts_with("No searches are left"));
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
async fn with_memory_off_the_evaluation_search_finds_nothing() {
    let Some(fx) = fixture("proactive-mac-eval-nomemory", true).await else {
        return;
    };
    fx.seed_memory("global", "account", "Prefers short answers.")
        .await;
    fx.memory_off().await;
    let run_id = fx.evaluation().await;
    let claim_id = uuid::Uuid::new_v4();
    let claimed = fx.mac_takes(&run_id, claim_id).await;
    assert!(!claimed["proactive"]["systemPrompt"]
        .as_str()
        .unwrap()
        .contains("Prefers short answers."));
    let (status, answer) = fx
        .observe(
            &run_id,
            claim_id,
            "search_memory",
            json!({"query": "short answers"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert!(found(&answer).is_empty());
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
    // The Mac got the system prompt the cloud runner gets, with no memories,
    // and the runner's lease carries the same search.
    assert_eq!(run["systemPrompt"].as_str().unwrap().trim(), mac_prompt);
    assert!(!mac_prompt.contains("Answer in British English."));
    assert_eq!(tool_names(&run["connectorTools"]), vec!["search_memory"]);
    let (status, answer) = runner_search(&fx.router, runner, &run_id, "British English").await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(found(&answer["result"]), vec!["Answer in British English."]);
    let (status, _) = runner_search(&fx.router, "runner-other", &run_id, "runbook").await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "only the lease holder searches"
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
