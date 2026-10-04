use super::*;

#[tokio::test]
async fn calendar_tool_retrieves_saved_events_and_distinguishes_empty_and_denied_access() {
    assert!(tool_catalog()
        .iter()
        .any(|tool| tool["function"]["name"] == "read_calendar"));
    for (value, own_request) in [
        (
            Some(
                json!({"status":"ready","events":[{"title":"Saved appointment","status":"saved"}]}),
            ),
            true,
        ),
        (Some(json!({"status":"empty","events":[]})), true),
        (None, true),
        (
            Some(json!({"events":[{"title":"Must stay private"}]})),
            false,
        ),
    ] {
        let client = RecordingClient {
            calendar: value.clone(),
            ..Default::default()
        };
        let provider = FakeProvider::new(vec![
            ModelProviderResponse::ToolCalls(vec![ModelToolCall {
                id: "calendar".into(),
                name: "read_calendar".into(),
                arguments: json!({"shareInConversation":true}),
            }]),
            ModelProviderResponse::FinalText("Calendar checked".into()),
        ]);
        let mut run = run();
        if own_request {
            run.requester_account_id = run.owner_account_id.clone();
        }
        run_model_loop(&client, &provider, &run, &sandbox_handle(), provider_auth())
            .await
            .unwrap();
        let messages = provider.seen_messages.lock().unwrap();
        let result = messages[1].last().unwrap()["content"].as_str().unwrap();
        if let (true, Some(expected)) = (own_request, value) {
            assert_eq!(serde_json::from_str::<Value>(result).unwrap(), expected);
        } else {
            assert!(result.contains("not an empty calendar"));
            assert!(!result.contains("Must stay private"));
        }
    }
}

fn quick_wait() -> ModelLoopOptions {
    ModelLoopOptions {
        calendar_wait: CalendarApprovalWait {
            interval: std::time::Duration::from_millis(5),
            timeout: std::time::Duration::from_millis(60),
        },
    }
}

fn own_run() -> CloudAgentRun {
    let mut run = run();
    run.requester_account_id = run.owner_account_id.clone();
    run
}

fn calendar_call(id: &str) -> ModelToolCall {
    ModelToolCall {
        id: id.into(),
        name: "read_calendar".into(),
        arguments: json!({"shareInConversation": true}),
    }
}

fn tool_results(provider: &FakeProvider) -> Vec<Value> {
    let messages = provider.seen_messages.lock().unwrap();
    messages
        .last()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "tool")
        .map(|message| message["content"].clone())
        .collect()
}

fn waiting() -> Value {
    json!({"status": "approval_required", "pendingActionId": "action-1",
        "message": "Waiting for Olive to approve sharing their calendar in this chat.",
        "timeoutMessage": "Olive has not approved sharing their calendar in this chat."})
}

fn shared_page() -> Value {
    json!({"status": "ready", "scope": "owner_requested_shared_read",
        "events": [{"title": "Saved appointment", "status": "saved"}]})
}

#[tokio::test]
async fn calendar_reads_wait_for_the_owner_and_pass_data_through() {
    let client = RecordingClient {
        calendar_pages: std::sync::Mutex::new(vec![waiting(), waiting()]),
        calendar: Some(shared_page()),
        ..Default::default()
    };
    let provider = FakeProvider::new(vec![
        ModelProviderResponse::ToolCalls(vec![calendar_call("calendar")]),
        ModelProviderResponse::FinalText("Shared".into()),
    ]);
    run_model_loop_with_options(
        &client,
        &provider,
        &own_run(),
        &sandbox_handle(),
        provider_auth(),
        quick_wait(),
    )
    .await
    .unwrap();
    assert_eq!(*client.calendar_reads.lock().unwrap(), 3);
    let results = tool_results(&provider);
    assert_eq!(
        serde_json::from_str::<Value>(results[0].as_str().unwrap()).unwrap(),
        shared_page()
    );
}

#[tokio::test]
async fn an_unapproved_calendar_read_times_out_and_a_decline_is_final() {
    let client = RecordingClient {
        calendar: Some(waiting()),
        ..Default::default()
    };
    let provider = FakeProvider::new(vec![
        ModelProviderResponse::ToolCalls(vec![calendar_call("calendar")]),
        ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: "fetch".into(),
            name: "web_fetch".into(),
            arguments: json!({"url": "https://example.test/"}),
        }]),
        ModelProviderResponse::FinalText("Not shared".into()),
    ]);
    run_model_loop_with_options(
        &client,
        &provider,
        &own_run(),
        &sandbox_handle(),
        provider_auth(),
        quick_wait(),
    )
    .await
    .unwrap();
    assert!(*client.calendar_reads.lock().unwrap() >= 2);
    let results = tool_results(&provider);
    assert_eq!(
        results[0],
        "Olive has not approved sharing their calendar in this chat."
    );
    // Nothing was disclosed, so other tools stay available.
    assert_ne!(results[1], kordi_tools::calendar::CALENDAR_EGRESS_CLOSED);

    let client = RecordingClient {
        calendar: Some(json!({"status": "declined",
            "message": "Olive chose not to share their calendar in this chat."})),
        ..Default::default()
    };
    let provider = FakeProvider::new(vec![
        ModelProviderResponse::ToolCalls(vec![calendar_call("calendar")]),
        ModelProviderResponse::FinalText("Not shared".into()),
    ]);
    run_model_loop_with_options(
        &client,
        &provider,
        &own_run(),
        &sandbox_handle(),
        provider_auth(),
        quick_wait(),
    )
    .await
    .unwrap();
    assert_eq!(*client.calendar_reads.lock().unwrap(), 1);
    assert_eq!(
        tool_results(&provider)[0],
        "Olive chose not to share their calendar in this chat."
    );
}

#[tokio::test]
async fn after_shared_calendar_data_only_conversation_reads_remain() {
    let client = RecordingClient {
        calendar: Some(shared_page()),
        ..Default::default()
    };
    let call = |id: &str, name: &str, arguments: Value| ModelToolCall {
        id: id.into(),
        name: name.into(),
        arguments,
    };
    let provider = FakeProvider::new(vec![
        ModelProviderResponse::ToolCalls(vec![calendar_call("calendar")]),
        ModelProviderResponse::ToolCalls(vec![
            call(
                "fetch",
                "web_fetch",
                json!({"url": "https://example.test/?q=x"}),
            ),
            call("bash", "bash", json!({"command": "echo hi"})),
            call("spawn-real", "task_operator", json!({"action": "spawn"})),
            call(
                "participants",
                "read_session",
                json!({"mode": "participants"}),
            ),
        ]),
        ModelProviderResponse::FinalText("Shared".into()),
    ]);
    run_model_loop_with_options(
        &client,
        &provider,
        &own_run(),
        &sandbox_handle(),
        provider_auth(),
        quick_wait(),
    )
    .await
    .unwrap();
    let results = tool_results(&provider);
    for refused in &results[1..4] {
        assert_eq!(refused, kordi_tools::calendar::CALENDAR_EGRESS_CLOSED);
    }
    assert!(client.spawns.lock().unwrap().is_empty());
    assert!(results[4]
        .as_str()
        .unwrap()
        .contains("Retrieved Group Participant"));
}
