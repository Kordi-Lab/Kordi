use super::*;

#[tokio::test]
async fn subsession_is_created_only_by_a_real_model_tool_call() {
    let client = RecordingClient::default();
    let provider = FakeProvider::new(vec![
        ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: "spawn-real".into(),
            name: "task_operator".into(),
            arguments: json!({"action":"spawn","taskName":"research","taskTitle":"Research","message":"Compare the sources","forkTurns":"none"}),
        }]),
        ModelProviderResponse::FinalText("Research is in the background session.".into()),
    ]);
    let text = run_model_loop(
        &client,
        &provider,
        &run(),
        &sandbox_handle(),
        provider_auth(),
    )
    .await
    .unwrap();
    assert_eq!(client.spawns.lock().unwrap().len(), 1);
    assert_eq!(text, "Research is in the background session.");
    {
        let prompts = provider.seen_messages.lock().unwrap();
        assert!(prompts[1].iter().any(|message| message["role"] == "tool"
            && message["content"]
                .as_str()
                .unwrap_or_default()
                .contains("actual-child")));
    }
    let short = RecordingClient::default();
    let provider = FakeProvider::new(vec![ModelProviderResponse::FinalText("ACK".into())]);
    assert_eq!(
        run_model_loop(
            &short,
            &provider,
            &run(),
            &sandbox_handle(),
            provider_auth()
        )
        .await
        .unwrap(),
        "ACK"
    );
    assert!(short.spawns.lock().unwrap().is_empty());
}

#[tokio::test]
async fn read_only_subsession_cannot_spawn_or_mutate_files() {
    let client = RecordingClient::default();
    let provider = FakeProvider::new(vec![
        ModelProviderResponse::ToolCalls(vec![
            ModelToolCall {
                id: "nested".into(),
                name: "task_operator".into(),
                arguments: json!({"action":"spawn"}),
            },
            ModelToolCall {
                id: "write".into(),
                name: "write".into(),
                arguments: json!({"path":"out.txt","content":"forbidden"}),
            },
        ]),
        ModelProviderResponse::FinalText("No mutation performed.".into()),
    ]);
    let mut child = run();
    child.subsession_id = Some("child".into());
    let sandbox = sandbox_handle();
    run_model_loop(&client, &provider, &child, &sandbox, provider_auth())
        .await
        .unwrap();
    assert!(client.spawns.lock().unwrap().is_empty());
    assert!(sandbox.read_text("out.txt").await.is_err());
}
#[tokio::test]
async fn group_directory_is_disclosed_only_after_explicit_tool_call() {
    let client = RecordingClient::default();
    let provider = FakeProvider::new(vec![
        ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: "read-directory".to_string(),
            name: "read_session".to_string(),
            arguments: json!({"sessionId": run().session_id, "mode": "participants"}),
        }]),
        ModelProviderResponse::FinalText("Found the participant".to_string()),
    ]);
    let text = run_model_loop(
        &client,
        &provider,
        &run(),
        &sandbox_handle(),
        provider_auth(),
    )
    .await
    .unwrap();
    assert_eq!(text, "Found the participant");
    let messages = provider.seen_messages.lock().unwrap();
    assert!(!serde_json::to_string(&messages[0])
        .unwrap()
        .contains("Retrieved Group Participant"));
    assert!(serde_json::to_string(&messages[1])
        .unwrap()
        .contains("Retrieved Group Participant"));
}
#[tokio::test]
async fn runtime_identity_is_frozen_across_tool_calls_and_appended_after_history() {
    let mut first = run();
    first.subsession_id = Some("child".into());
    let identity = kordi_core::types::RuntimeIdentity {
        request_id: "request-a".into(),
        agent_id: "agent-owner".into(),
        agent_name: "Owner's Kordi".into(),
        owner_account_id: first.owner_account_id.clone(),
        owner_name: "Owner".into(),
        requester_account_id: first.requester_account_id.clone(),
        requester_name: "Visitor".into(),
        request_policy: None,
    };
    first.turn_identity = Some(identity.clone());
    first.history_messages = vec![
        json!({"role":"user","content":"Earlier question"}),
        json!({"role":"assistant","content":"Earlier answer"}),
    ];
    let provider = FakeProvider::new(vec![
        ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: "lookup".into(),
            name: "read_session".into(),
            arguments: json!({"mode":"participants"}),
        }]),
        ModelProviderResponse::FinalText("I am Owner's Kordi".into()),
        ModelProviderResponse::FinalText("I am your Kordi".into()),
    ]);
    let client = RecordingClient::default();
    run_model_loop(
        &client,
        &provider,
        &first,
        &sandbox_handle(),
        provider_auth(),
    )
    .await
    .unwrap();
    let seen = provider.seen_messages.lock().unwrap().clone();
    assert_eq!(seen[0][3], identity.provider_message());
    assert_eq!(&seen[1][..seen[0].len()], seen[0].as_slice());
    assert!(!seen[0][0]["content"].as_str().unwrap().contains("Visitor"));
    let mut follow = first.clone();
    follow.requester_account_id = follow.owner_account_id.clone();
    follow.turn_identity.as_mut().unwrap().request_id = "request-b".into();
    follow.turn_identity.as_mut().unwrap().requester_account_id = follow.owner_account_id.clone();
    follow.turn_identity.as_mut().unwrap().requester_name = "Renamed owner".into();
    follow.history_messages.extend([
        json!({"role":"runtimeIdentity","content":identity}),
        json!({"role":"user","content":first.prompt}),
        json!({"role":"assistant","content":"I am Owner's Kordi"}),
    ]);
    follow.prompt = "And who owns you?".into();
    run_model_loop(
        &client,
        &provider,
        &follow,
        &sandbox_handle(),
        provider_auth(),
    )
    .await
    .unwrap();
    let seen = provider.seen_messages.lock().unwrap();
    assert_eq!(&seen[2][..seen[0].len()], seen[0].as_slice());
    assert_eq!(
        seen[2][6],
        follow.turn_identity.as_ref().unwrap().provider_message()
    );
}
