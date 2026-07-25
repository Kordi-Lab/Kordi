use super::*;

#[tokio::test]
async fn run_turn_retries_retryable_stream_provider_errors_before_failing_the_turn() {
    let conn = store::open_memory().expect("memory db");
    let session_id = store::create_session(&conn, "/tmp").expect("session");
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let provider = Arc::new(StreamErrorThenSuccessProvider {
        call_count: AtomicUsize::new(0),
    });

    let config = TurnConfig {
        conn: wrap_conn(conn),
        session_id,
        system_prompt: "system".to_string(),
        model: test_model(128_000),
        provider: provider.clone(),
        auth: None,
        api_key: "dummy".to_string(),
        base_url: "http://dummy.invalid".to_string(),
        headers: std::collections::HashMap::new(),
        compaction_settings: kordi_core::types::CompactionSettings::default(),
        tool_registry: ToolRegistry::default(),
        tool_ctx: test_tool_context(),
        thinking: None,
        retry_enabled: true,
        retry_max_retries: 2,
        retry_base_delay_ms: 1,
        retry_max_delay_ms: 10,
        cancel: CancellationToken::new(),
        extensions: ExtensionCommandRegistry::default(),
        request_metrics_tracker: test_request_metrics_tracker(),
        request_metrics_log_path: None,
    };

    let (_returned_config, result) = run_turn(config, event_tx, "hi".to_string()).await;
    result.expect("transient streamed provider error should be retried");
    assert_eq!(provider.call_count.load(Ordering::SeqCst), 2);

    let mut saw_retry_start = false;
    let mut saw_error = false;
    let mut done_text = None;
    while let Ok(event) = event_rx.try_recv() {
        match event {
            TurnEvent::AutoRetryStart { attempt, .. } => {
                saw_retry_start = true;
                assert_eq!(attempt, 1);
            }
            TurnEvent::Error(_) => saw_error = true,
            TurnEvent::Done { text } => done_text = Some(text),
            _ => {}
        }
    }

    assert!(
        saw_retry_start,
        "should emit retry status for streamed provider errors"
    );
    assert!(
        !saw_error,
        "retryable streamed provider errors should not surface as final turn errors"
    );
    assert_eq!(done_text.as_deref(), Some("recovered"));
}

#[tokio::test]
async fn terminal_provider_error_is_surfaced_and_persisted_exactly_once() {
    let conn = store::open_memory().expect("memory db");
    let session_id = store::create_session(&conn, "/tmp").expect("session");
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let provider = Arc::new(AlwaysStreamErrorProvider {
        call_count: AtomicUsize::new(0),
        visible_output_before_error: false,
        error: terminal_http_error(),
    });
    let config = TurnConfig {
        conn: wrap_conn(conn),
        session_id: session_id.clone(),
        system_prompt: "system".to_string(),
        model: test_model(128_000),
        provider: provider.clone(),
        auth: None,
        api_key: "dummy".to_string(),
        base_url: "https://chatgpt.com/backend-api/codex".to_string(),
        headers: std::collections::HashMap::new(),
        compaction_settings: kordi_core::types::CompactionSettings::default(),
        tool_registry: ToolRegistry::default(),
        tool_ctx: test_tool_context(),
        thinking: None,
        retry_enabled: true,
        retry_max_retries: 3,
        retry_base_delay_ms: 1,
        retry_max_delay_ms: 10,
        cancel: CancellationToken::new(),
        extensions: ExtensionCommandRegistry::default(),
        request_metrics_tracker: test_request_metrics_tracker(),
        request_metrics_log_path: None,
    };

    let (returned_config, result) = run_turn(config, event_tx, "hi".to_string()).await;
    let error = result.expect_err("403 should end the turn");
    let expected = "unexpected status 403 Forbidden: Unknown error, url: https://chatgpt.com/backend-api/codex/responses, cf-ray: ray-test-HKG";
    assert_eq!(error.to_string(), expected);
    assert_eq!(provider.call_count.load(Ordering::SeqCst), 1);

    let events = std::iter::from_fn(|| event_rx.try_recv().ok()).collect::<Vec<_>>();
    let surfaced = events
        .iter()
        .filter_map(|event| match event {
            TurnEvent::Error(message) => Some(message.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(surfaced, vec![expected]);
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, TurnEvent::AutoRetryStart { .. }))
    );

    let conn = returned_config.conn.lock().await;
    let path = kordi_session::tree::active_path(&conn, &session_id).expect("active path");
    let persisted = path
        .iter()
        .filter_map(|entry| store::parse_entry(entry).ok())
        .filter_map(|entry| match entry {
            SessionEntry::Message {
                message:
                    AgentMessage::Assistant(AssistantMessage {
                        stop_reason: StopReason::Error,
                        error_message,
                        ..
                    }),
                ..
            } => error_message,
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(persisted, vec![expected]);
}

#[tokio::test]
async fn retryable_stream_error_after_visible_output_is_not_replayed() {
    let conn = store::open_memory().expect("memory db");
    let session_id = store::create_session(&conn, "/tmp").expect("session");
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let provider = Arc::new(AlwaysStreamErrorProvider {
        call_count: AtomicUsize::new(0),
        visible_output_before_error: true,
        error: ProviderError::stream(
            "openai",
            "responses stream",
            Some("The provider could not finish this response."),
            Some("server_error"),
        ),
    });
    let config = TurnConfig {
        conn: wrap_conn(conn),
        session_id,
        system_prompt: "system".to_string(),
        model: test_model(128_000),
        provider: provider.clone(),
        auth: None,
        api_key: "dummy".to_string(),
        base_url: "https://api.openai.com/v1".to_string(),
        headers: std::collections::HashMap::new(),
        compaction_settings: kordi_core::types::CompactionSettings::default(),
        tool_registry: ToolRegistry::default(),
        tool_ctx: test_tool_context(),
        thinking: None,
        retry_enabled: true,
        retry_max_retries: 3,
        retry_base_delay_ms: 1,
        retry_max_delay_ms: 10,
        cancel: CancellationToken::new(),
        extensions: ExtensionCommandRegistry::default(),
        request_metrics_tracker: test_request_metrics_tracker(),
        request_metrics_log_path: None,
    };

    let (_returned_config, result) = run_turn(config, event_tx, "hi".to_string()).await;
    result.expect_err("partial failed response should end the turn");
    assert_eq!(provider.call_count.load(Ordering::SeqCst), 1);

    let events = std::iter::from_fn(|| event_rx.try_recv().ok()).collect::<Vec<_>>();
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, TurnEvent::TextDelta(text) if text == "partial"))
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, TurnEvent::Error(_)))
            .count(),
        1
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, TurnEvent::AutoRetryStart { .. }))
    );
}

#[tokio::test]
async fn run_turn_reports_local_model_overload_when_stream_stalls() {
    let _timeout_override = set_local_model_timeout_override(Duration::from_millis(25));
    let conn = store::open_memory().expect("memory db");
    let session_id = store::create_session(&conn, "/tmp").expect("session");
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let stream_count = Arc::new(AtomicUsize::new(0));
    let mut model = test_model(128_000);
    model.provider = "ollama".to_string();
    model.id = "llama3.2".to_string();
    model.name = "llama3.2".to_string();

    let config = TurnConfig {
        conn: wrap_conn(conn),
        session_id: session_id.clone(),
        system_prompt: "system".to_string(),
        model,
        provider: Arc::new(StalledLocalProvider {
            stream_count: stream_count.clone(),
        }),
        auth: None,
        api_key: String::new(),
        base_url: format!("http://127.0.0.1:11434/v1/{}", uuid::Uuid::new_v4()),
        headers: std::collections::HashMap::new(),
        compaction_settings: kordi_core::types::CompactionSettings::default(),
        tool_registry: ToolRegistry::default(),
        tool_ctx: test_tool_context(),
        thinking: None,
        retry_enabled: false,
        retry_max_retries: 1,
        retry_base_delay_ms: 10,
        retry_max_delay_ms: 10,
        cancel: CancellationToken::new(),
        extensions: ExtensionCommandRegistry::default(),
        request_metrics_tracker: test_request_metrics_tracker(),
        request_metrics_log_path: None,
    };

    let (returned_config, result) = timeout(
        Duration::from_secs(2),
        run_turn(config, event_tx, "hello".to_string()),
    )
    .await
    .expect("local overload watchdog should finish the turn");
    let error = result.expect_err("stalled local provider should fail the turn");

    assert!(
        error
            .to_string()
            .contains("Local model overloaded or unresponsive"),
        "unexpected error: {error}"
    );
    assert_eq!(stream_count.load(Ordering::SeqCst), 1);

    let events = std::iter::from_fn(|| event_rx.try_recv().ok()).collect::<Vec<_>>();
    assert!(events.iter().any(|event| matches!(event, TurnEvent::Error(message) if message.contains("Local model overloaded or unresponsive"))));

    let conn = returned_config.conn.lock().await;
    let path = kordi_session::tree::active_path(&conn, &session_id).expect("active path");
    let latest = path.last().expect("persisted error message");
    let entry = store::parse_entry(latest).expect("parse latest");
    assert!(matches!(
        entry,
        SessionEntry::Message {
            message: AgentMessage::Assistant(AssistantMessage {
                stop_reason: StopReason::Error,
                error_message: Some(_),
                ..
            }),
            ..
        }
    ));
}

#[tokio::test]
async fn run_turn_writes_request_metrics_log_when_path_is_configured() {
    let conn = store::open_memory().expect("memory db");
    let session_id = store::create_session(&conn, "/tmp").expect("session");
    let (event_tx, _event_rx) = mpsc::unbounded_channel();
    let temp = tempfile::tempdir().expect("tempdir");
    let log_path = temp.path().join("request-metrics.jsonl");

    let config = TurnConfig {
        conn: wrap_conn(conn),
        session_id,
        system_prompt: "system".to_string(),
        model: test_model(128_000),
        provider: Arc::new(MetricsProvider),
        auth: None,
        api_key: "dummy".to_string(),
        base_url: "http://dummy.invalid".to_string(),
        headers: std::collections::HashMap::new(),
        compaction_settings: kordi_core::types::CompactionSettings::default(),
        tool_registry: ToolRegistry::default(),
        tool_ctx: test_tool_context(),
        thinking: None,
        retry_enabled: false,
        retry_max_retries: 1,
        retry_base_delay_ms: 10,
        retry_max_delay_ms: 10,
        cancel: CancellationToken::new(),
        extensions: ExtensionCommandRegistry::default(),
        request_metrics_tracker: test_request_metrics_tracker(),
        request_metrics_log_path: Some(log_path.clone()),
    };

    let (_returned_config, result) = run_turn(config, event_tx, "hi".to_string()).await;
    result.expect("turn should succeed and write request metrics");

    let written = std::fs::read_to_string(&log_path).expect("request metrics log");
    assert!(written.contains("\"provider\":\"metrics-provider\""));
    assert!(written.contains("\"model\":\"dummy-model\""));
    assert!(written.contains("\"cache_metrics_source\":\"official\""));
    assert!(written.contains("\"cache_read_tokens\":40"));
}
