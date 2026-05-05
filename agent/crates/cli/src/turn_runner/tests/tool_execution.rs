use super::*;

#[tokio::test]
async fn run_turn_contains_tool_panics_without_aborting_the_turn() {
    let conn = store::open_memory().expect("memory db");
    let session_id = store::create_session(&conn, "/tmp").expect("session");
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();

    let config = TurnConfig {
        conn: wrap_conn(conn),
        session_id,
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
        tool_registry: ToolRegistry::from_tools(vec![Box::new(PanicTool)]),
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

    let (returned_config, result) = run_turn(config, event_tx, "hi".to_string()).await;
    result.expect("tool panic should be contained without aborting the turn");
    assert_eq!(returned_config.tool_registry.len(), 1);

    let mut saw_tool_panic_error = false;
    let mut saw_done = false;
    while let Ok(event) = event_rx.try_recv() {
        match event {
            TurnEvent::ToolResult {
                is_error, content, ..
            } => {
                if is_error {
                    let text = content
                        .iter()
                        .filter_map(|block| match block {
                            ContentBlock::Text { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    if text.contains("panic containment test marker") {
                        saw_tool_panic_error = true;
                    }
                }
            }
            TurnEvent::Done { text } => {
                saw_done = true;
                assert_eq!(text, "done");
            }
            _ => {}
        }
    }
    assert!(
        saw_tool_panic_error,
        "should convert tool panic into tool error output"
    );
    assert!(
        saw_done,
        "turn should still complete after contained tool panic"
    );
}

#[tokio::test]
async fn run_turn_continues_after_error_tool_results_when_provider_needs_error_flag() {
    let conn = store::open_memory().expect("memory db");
    let session_id = store::create_session(&conn, "/tmp").expect("session");
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();

    let config = TurnConfig {
        conn: wrap_conn(conn),
        session_id,
        system_prompt: "system".to_string(),
        model: test_model(128_000),
        provider: Arc::new(ErrorAwareToolProvider {
            call_count: AtomicUsize::new(0),
        }),
        auth: None,
        api_key: "dummy".to_string(),
        base_url: "http://dummy.invalid".to_string(),
        headers: std::collections::HashMap::new(),
        compaction_settings: kordi_core::types::CompactionSettings::default(),
        tool_registry: ToolRegistry::from_tools(vec![Box::new(FailingTool)]),
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

    let (_returned_config, result) = run_turn(config, event_tx, "hi".to_string()).await;
    result.expect("turn should continue after errored tool result");

    let mut saw_timeout_tool_error = false;
    let mut saw_done = false;
    while let Ok(event) = event_rx.try_recv() {
        match event {
            TurnEvent::ToolResult {
                is_error, content, ..
            } => {
                if is_error {
                    let text = content
                        .iter()
                        .filter_map(|block| match block {
                            ContentBlock::Text { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    if text.contains("timed out") {
                        saw_timeout_tool_error = true;
                    }
                }
            }
            TurnEvent::Done { text } => {
                saw_done = true;
                assert_eq!(text, "continued after timeout");
            }
            _ => {}
        }
    }

    assert!(
        saw_timeout_tool_error,
        "should persist the errored tool result"
    );
    assert!(
        saw_done,
        "turn should complete after the provider sees the error tool result"
    );
}

#[tokio::test]
async fn run_turn_normalizes_builtin_tool_aliases_before_lookup() {
    let conn = store::open_memory().expect("memory db");
    let session_id = store::create_session(&conn, "/tmp").expect("session");
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let invocations = Arc::new(AtomicUsize::new(0));

    let config = TurnConfig {
        conn: wrap_conn(conn),
        session_id,
        system_prompt: "system".to_string(),
        model: test_model(128_000),
        provider: Arc::new(AliasProvider {
            call_count: AtomicUsize::new(0),
        }),
        auth: None,
        api_key: "dummy".to_string(),
        base_url: "http://dummy.invalid".to_string(),
        headers: std::collections::HashMap::new(),
        compaction_settings: kordi_core::types::CompactionSettings::default(),
        tool_registry: ToolRegistry::from_tools(vec![Box::new(EchoTool {
            invocations: invocations.clone(),
        })]),
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

    let (_returned_config, result) = run_turn(config, event_tx, "hi".to_string()).await;
    result.expect("aliased builtin tool should resolve successfully");
    assert_eq!(invocations.load(Ordering::SeqCst), 1);

    let mut saw_successful_tool_result = false;
    let mut saw_done = false;
    while let Ok(event) = event_rx.try_recv() {
        match event {
            TurnEvent::ToolResult {
                is_error, content, ..
            } => {
                let text = content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if !is_error && text.contains("echoed: pwd") {
                    saw_successful_tool_result = true;
                }
            }
            TurnEvent::Done { text } => {
                saw_done = true;
                assert_eq!(text, "done");
            }
            _ => {}
        }
    }

    assert!(
        saw_successful_tool_result,
        "normalized alias should execute the builtin tool"
    );
    assert!(saw_done, "turn should complete after the aliased tool call");
}

#[tokio::test]
async fn run_turn_preserves_reflection_runtime_for_tool_execution() {
    let conn = store::open_memory().expect("memory db");
    let session_id = store::create_session(&conn, "/tmp").expect("session");
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let reflection_invocations = Arc::new(AtomicUsize::new(0));
    let reflection_invocations_for_runtime = reflection_invocations.clone();
    let save_lesson: kordi_tools::SaveReflectionLessonFn = Arc::new(move |request| {
        let reflection_invocations_for_runtime = reflection_invocations_for_runtime.clone();
        Box::pin(async move {
            reflection_invocations_for_runtime.fetch_add(1, Ordering::SeqCst);
            assert_eq!(request.scope, "conversation");
            assert_eq!(request.scope_id, "session-1");
            assert_eq!(request.source, "manual");
            assert_eq!(request.lesson, "Keep lesson storage scoped.");
            Ok(kordi_tools::ReflectionLessonResponse {
                lesson_id: "lesson-1".to_string(),
                scope: request.scope,
                scope_id: request.scope_id,
                artifact_path: "reflection-lessons/conversation/session-1.md".to_string(),
            })
        })
    });
    let mut tool_ctx = test_tool_context();
    tool_ctx.reflection = Some(kordi_tools::ReflectionRuntime { save_lesson });

    let config = TurnConfig {
        conn: wrap_conn(conn),
        session_id,
        system_prompt: "system".to_string(),
        model: test_model(128_000),
        provider: Arc::new(ReflectionCallProvider {
            call_count: AtomicUsize::new(0),
        }),
        auth: None,
        api_key: "dummy".to_string(),
        base_url: "http://dummy.invalid".to_string(),
        headers: std::collections::HashMap::new(),
        compaction_settings: kordi_core::types::CompactionSettings::default(),
        tool_registry: ToolRegistry::from_tools(vec![Box::new(
            kordi_tools::reflection_tool::ReflectionTool,
        )]),
        tool_ctx,
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

    let (_returned_config, result) = run_turn(config, event_tx, "hi".to_string()).await;
    result.expect("reflection tool should receive configured lesson runtime");
    assert_eq!(reflection_invocations.load(Ordering::SeqCst), 1);

    let mut saw_reflection_tool_result = false;
    let mut saw_done = false;
    while let Ok(event) = event_rx.try_recv() {
        match event {
            TurnEvent::ToolResult {
                is_error,
                content,
                artifact_path,
                ..
            } => {
                let text = content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if !is_error
                    && text.contains("Reflection lesson saved")
                    && artifact_path.as_deref()
                        == Some("reflection-lessons/conversation/session-1.md")
                {
                    saw_reflection_tool_result = true;
                }
            }
            TurnEvent::Done { text } => {
                saw_done = true;
                assert_eq!(text, "done");
            }
            _ => {}
        }
    }

    assert!(
        saw_reflection_tool_result,
        "reflection should execute with configured runtime instead of unavailable storage"
    );
    assert!(saw_done, "turn should complete after reflection tool call");
}

#[tokio::test]
async fn cancelled_turn_with_tool_calls_persists_cancelled_tool_results() {
    let conn = store::open_memory().expect("memory db");
    let session_id = store::create_session(&conn, "/tmp").expect("session");
    let wrapped = wrap_conn(conn);
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();

    let config = TurnConfig {
        conn: wrapped.clone(),
        session_id: session_id.clone(),
        system_prompt: "system".to_string(),
        model: test_model(128_000),
        provider: Arc::new(CancelAfterToolCallProvider),
        auth: None,
        api_key: "dummy".to_string(),
        base_url: "http://dummy.invalid".to_string(),
        headers: std::collections::HashMap::new(),
        compaction_settings: kordi_core::types::CompactionSettings::default(),
        tool_registry: ToolRegistry::from_tools(vec![Box::new(PanicTool)]),
        tool_ctx: test_tool_context(),
        thinking: None,
        retry_enabled: false,
        retry_max_retries: 1,
        retry_base_delay_ms: 10,
        retry_max_delay_ms: 10,
        cancel,
        extensions: ExtensionCommandRegistry::default(),
        request_metrics_tracker: test_request_metrics_tracker(),
        request_metrics_log_path: None,
    };

    let (_returned_config, result) = run_turn(config, event_tx, "hi".to_string()).await;
    result.expect("cancelled turn should remain transcript-safe");

    let mut saw_cancelled_tool_result = false;
    while let Ok(event) = event_rx.try_recv() {
        if let TurnEvent::ToolResult {
            is_error,
            details,
            content,
            ..
        } = event
        {
            let text = content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            if is_error
                && text.contains("tool execution cancelled before start")
                && details
                    .as_ref()
                    .and_then(|value| value.get("cancelled"))
                    .and_then(|value| value.as_bool())
                    == Some(true)
            {
                saw_cancelled_tool_result = true;
            }
        }
    }
    assert!(
        saw_cancelled_tool_result,
        "should emit a cancelled tool result event"
    );

    let db = wrapped.lock().await;
    let session = store::get_session(&db, &session_id)
        .expect("get session")
        .expect("session exists");
    let leaf_id = session.leaf_id.expect("leaf id");
    let path = kordi_session::tree::walk_to_root(&db, &session_id, &leaf_id).expect("path to root");
    let messages = path
        .into_iter()
        .filter_map(|entry| store::parse_entry(&entry).ok())
        .filter_map(|entry| match entry {
            SessionEntry::Message { message, .. } => Some(message),
            _ => None,
        })
        .collect::<Vec<_>>();

    assert!(matches!(
        messages.iter().find(|message| matches!(message, AgentMessage::Assistant(_))),
        Some(AgentMessage::Assistant(assistant)) if assistant.stop_reason == StopReason::ToolUse
    ));
    assert!(matches!(
        messages.iter().find(|message| matches!(message, AgentMessage::ToolResult(_))),
        Some(AgentMessage::ToolResult(tool_result))
            if tool_result.tool_call_id == "tool-cancel-1"
                && tool_result.is_error
                && tool_result.details.as_ref().and_then(|value| value.get("cancelled")).and_then(|value| value.as_bool()) == Some(true)
    ));
}

#[tokio::test]
async fn read_only_tool_calls_can_overlap_in_real_turn_execution() {
    let conn = store::open_memory().expect("memory db");
    let session_id = store::create_session(&conn, "/tmp").expect("session");
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let entered = Arc::new(AtomicUsize::new(0));
    let notify = Arc::new(Notify::new());

    let config = TurnConfig {
        conn: wrap_conn(conn),
        session_id,
        system_prompt: "system".to_string(),
        model: test_model(128_000),
        provider: Arc::new(MultiToolProvider {
            tool_name: "overlap-probe",
            first_args: "{}",
            second_args: "{}",
            call_count: AtomicUsize::new(0),
        }),
        auth: None,
        api_key: "dummy".to_string(),
        base_url: "http://dummy.invalid".to_string(),
        headers: std::collections::HashMap::new(),
        compaction_settings: kordi_core::types::CompactionSettings::default(),
        tool_registry: ToolRegistry::from_tools(vec![Box::new(OverlapProbeTool {
            entered,
            notify,
        })]),
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

    let (_returned_config, result) = run_turn(config, event_tx, "hi".to_string()).await;
    result.expect("read-only tool calls should be allowed to overlap");

    let mut saw_error = false;
    let mut saw_done = false;
    while let Ok(event) = event_rx.try_recv() {
        match event {
            TurnEvent::ToolResult { is_error, .. } => saw_error |= is_error,
            TurnEvent::Done { text } => {
                saw_done = true;
                assert_eq!(text, "done");
            }
            _ => {}
        }
    }

    assert!(
        !saw_error,
        "parallel read-only execution should not time out"
    );
    assert!(
        saw_done,
        "turn should complete after overlapping tool calls"
    );
}

#[tokio::test]
async fn same_file_mutations_stay_serialized_in_real_turn_execution() {
    let conn = store::open_memory().expect("memory db");
    let session_id = store::create_session(&conn, "/tmp").expect("session");
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let active = Arc::new(AtomicUsize::new(0));
    let max_active = Arc::new(AtomicUsize::new(0));

    let config = TurnConfig {
        conn: wrap_conn(conn),
        session_id,
        system_prompt: "system".to_string(),
        model: test_model(128_000),
        provider: Arc::new(MultiToolProvider {
            tool_name: "same-file-mutation-probe",
            first_args: r#"{"path":"shared.txt"}"#,
            second_args: r#"{"path":"shared.txt"}"#,
            call_count: AtomicUsize::new(0),
        }),
        auth: None,
        api_key: "dummy".to_string(),
        base_url: "http://dummy.invalid".to_string(),
        headers: std::collections::HashMap::new(),
        compaction_settings: kordi_core::types::CompactionSettings::default(),
        tool_registry: ToolRegistry::from_tools(vec![Box::new(SameFileMutationProbeTool {
            active,
            max_active: max_active.clone(),
        })]),
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

    let (_returned_config, result) = run_turn(config, event_tx, "hi".to_string()).await;
    result.expect("same-file mutations should serialize safely");
    assert_eq!(max_active.load(Ordering::SeqCst), 1);

    let mut saw_done = false;
    while let Ok(event) = event_rx.try_recv() {
        if let TurnEvent::Done { text } = event {
            saw_done = true;
            assert_eq!(text, "done");
        }
    }
    assert!(saw_done, "turn should complete after serialized mutations");
}
