use super::*;

#[tokio::test]
async fn cancelled_turn_persists_an_aborted_assistant_entry() {
    let conn = store::open_memory().expect("memory db");
    let session_id = store::create_session(&conn, "/tmp").expect("session");
    let shared_conn = wrap_conn(conn);
    crate::turn_runner::append_user_message_with_images(
        &shared_conn,
        &session_id,
        "stop this",
        &[],
    )
    .await
    .expect("user message");

    let cancel = CancellationToken::new();
    cancel.cancel();
    let config = TurnConfig {
        conn: shared_conn,
        session_id: session_id.clone(),
        system_prompt: "system".to_string(),
        model: test_model(128_000),
        provider: Arc::new(DummyProvider {
            call_count: AtomicUsize::new(0),
        }),
        auth: None,
        api_key: "dummy".to_string(),
        base_url: "http://dummy.invalid".to_string(),
        headers: std::collections::HashMap::new(),
        compaction_settings: kordi_core::types::CompactionSettings::default(),
        tool_registry: ToolRegistry::default(),
        tool_ctx: test_tool_context(),
        thinking: None,
        retry_enabled: false,
        retry_max_retries: 0,
        retry_base_delay_ms: 1,
        retry_max_delay_ms: 1,
        cancel,
        extensions: ExtensionCommandRegistry::default(),
        request_metrics_tracker: test_request_metrics_tracker(),
        request_metrics_log_path: None,
    };
    let (returned_config, result) =
        run_turn(config, mpsc::unbounded_channel().0, "stop this".to_string()).await;
    result.expect("cancelled turn should finish cleanly");

    let conn = returned_config.conn.lock().await;
    let path = kordi_session::tree::active_path(&conn, &session_id).expect("active path");
    let last = path.last().expect("cancelled assistant entry");
    let entry = store::parse_entry(last).expect("parse cancelled entry");
    let SessionEntry::Message {
        message: AgentMessage::Assistant(assistant),
        ..
    } = entry
    else {
        panic!("expected assistant cancellation entry");
    };
    assert_eq!(assistant.stop_reason, StopReason::Aborted);
    assert!(assistant.content.is_empty());
}
