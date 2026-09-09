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
