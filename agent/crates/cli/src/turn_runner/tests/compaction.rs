use super::*;

#[tokio::test]
async fn overflow_recovery_compacts_only_active_path_context() {
    let dir = tempfile::tempdir().expect("temp dir");
    let db_path = dir.path().join("session.db");
    let conn = store::open_db(&db_path).expect("db");
    let session_id = store::create_session(&conn, "/tmp").expect("session");

    let root = SessionEntry::Message {
        base: EntryBase {
            id: kordi_core::types::EntryId("root0001".into()),
            parent_id: None,
            timestamp: Utc::now(),
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "old ".repeat(400_000),
            }],
            timestamp: Utc::now().timestamp_millis(),
        }),
    };
    store::append_entry(&conn, &session_id, &root).expect("append root");

    let historical = SessionEntry::Message {
        base: EntryBase {
            id: kordi_core::types::EntryId("hist0002".into()),
            parent_id: Some(kordi_core::types::EntryId("root0001".into())),
            timestamp: Utc::now(),
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "historical ".repeat(400_000),
            }],
            timestamp: Utc::now().timestamp_millis(),
        }),
    };
    store::append_entry(&conn, &session_id, &historical).expect("append historical");

    store::set_leaf(&conn, &session_id, Some("root0001")).expect("set leaf to root branch");

    let active = SessionEntry::Message {
        base: EntryBase {
            id: kordi_core::types::EntryId("actv0003".into()),
            parent_id: Some(kordi_core::types::EntryId("root0001".into())),
            timestamp: Utc::now(),
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "active branch prompt".to_string(),
            }],
            timestamp: Utc::now().timestamp_millis(),
        }),
    };
    store::append_entry(&conn, &session_id, &active).expect("append active");

    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let config = TurnConfig {
        conn: wrap_conn(conn),
        session_id: session_id.clone(),
        system_prompt: "system".to_string(),
        bridge_outreach_prompt_context: None,
        model: test_model(10_000_000),
        provider: Arc::new(OverflowProvider),
        auth: None,
        api_key: "dummy".to_string(),
        base_url: "http://dummy.invalid".to_string(),
        headers: std::collections::HashMap::new(),
        compaction_settings: kordi_core::types::CompactionSettings {
            enabled: true,
            reserve_tokens: 0,
            keep_recent_tokens: 1,
        },
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

    let (_returned_config, result) =
        run_turn(config, event_tx, "trigger overflow".to_string()).await;
    result.expect("overflow recovery should complete without fatal error");

    let statuses = std::iter::from_fn(|| event_rx.try_recv().ok())
        .filter_map(|event| match event {
            TurnEvent::Status(message) => Some(message),
            _ => None,
        })
        .collect::<Vec<_>>();

    let auto_status = statuses
        .iter()
        .find(|message| message.starts_with("Auto-compacted session:"))
        .expect("auto-compaction status");
    assert!(
        !auto_status.contains("200000")
            && !auto_status.contains("400000")
            && !auto_status.contains("800000"),
        "auto-compaction should not report total historical session size: {auto_status}"
    );

    let append_conn = store::open_db(&db_path).expect("reopen db");
    let path = kordi_session::tree::active_path(&append_conn, &session_id).expect("active path");
    assert_eq!(
        path.len(),
        3,
        "root + active + compaction on active branch only"
    );
    assert_eq!(path[0].entry_id, "root0001");
    assert_eq!(path[1].entry_id, "actv0003");
    assert_eq!(path[2].entry_type, "compaction");
}

#[tokio::test]
async fn run_turn_auto_compacts_at_ninety_percent_before_provider_request() {
    let dir = tempfile::tempdir().expect("temp dir");
    let db_path = dir.path().join("session.db");
    let conn = store::open_db(&db_path).expect("db");
    let session_id = store::create_session(&conn, "/tmp").expect("session");

    let old_user = SessionEntry::Message {
        base: EntryBase {
            id: kordi_core::types::EntryId("old00001".into()),
            parent_id: None,
            timestamp: Utc::now(),
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "old context".repeat(100),
            }],
            timestamp: Utc::now().timestamp_millis(),
        }),
    };
    store::append_entry(&conn, &session_id, &old_user).expect("append old user");

    let latest_assistant = SessionEntry::Message {
        base: EntryBase {
            id: kordi_core::types::EntryId("asst0002".into()),
            parent_id: Some(kordi_core::types::EntryId("old00001".into())),
            timestamp: Utc::now(),
        },
        message: AgentMessage::Assistant(AssistantMessage {
            content: vec![AssistantContent::Text {
                text: "ready".to_string(),
            }],
            provider: "dummy".to_string(),
            model: "dummy-model".to_string(),
            usage: Usage {
                total_tokens: 900,
                ..Default::default()
            },
            stop_reason: StopReason::Stop,
            error_message: None,
            timestamp: Utc::now().timestamp_millis(),
        }),
    };
    store::append_entry(&conn, &session_id, &latest_assistant).expect("append assistant");

    let complete_count = Arc::new(AtomicUsize::new(0));
    let stream_count = Arc::new(AtomicUsize::new(0));
    let provider = Arc::new(PreemptiveCompactionProvider {
        complete_count: complete_count.clone(),
        stream_count: stream_count.clone(),
    });
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let config = TurnConfig {
        conn: wrap_conn(conn),
        session_id: session_id.clone(),
        system_prompt: "system".to_string(),
        bridge_outreach_prompt_context: None,
        model: test_model(1_000),
        provider,
        auth: None,
        api_key: "dummy".to_string(),
        base_url: "http://dummy.invalid".to_string(),
        headers: std::collections::HashMap::new(),
        compaction_settings: kordi_core::types::CompactionSettings {
            enabled: true,
            reserve_tokens: 0,
            keep_recent_tokens: 1,
        },
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

    let (_returned_config, result) = run_turn(config, event_tx, "continue".to_string()).await;
    result.expect("turn should continue after preemptive compaction");

    assert_eq!(complete_count.load(Ordering::SeqCst), 1);
    assert_eq!(stream_count.load(Ordering::SeqCst), 1);

    let events = std::iter::from_fn(|| event_rx.try_recv().ok()).collect::<Vec<_>>();
    let compaction_idx = events
        .iter()
        .position(|event| matches!(event, TurnEvent::AutoCompactionStart))
        .expect("auto-compaction should start");
    let turn_start_idx = events
        .iter()
        .position(|event| matches!(event, TurnEvent::TurnStart { .. }))
        .expect("turn should start after compaction");
    assert!(compaction_idx < turn_start_idx);
    assert!(events.iter().any(|event| matches!(event, TurnEvent::Status(message) if message.starts_with("Auto-compacted session:"))));
    assert!(events.iter().any(
        |event| matches!(event, TurnEvent::Done { text } if text == "answer after compression")
    ));

    let append_conn = store::open_db(&db_path).expect("reopen db");
    let path = kordi_session::tree::active_path(&append_conn, &session_id).expect("active path");
    assert!(path.iter().any(|row| row.entry_type == "compaction"));
}

#[tokio::test]
async fn run_turn_stops_when_required_auto_compaction_fails() {
    let dir = tempfile::tempdir().expect("temp dir");
    let db_path = dir.path().join("session.db");
    let conn = store::open_db(&db_path).expect("db");
    let session_id = store::create_session(&conn, "/tmp").expect("session");

    let old_user = SessionEntry::Message {
        base: EntryBase {
            id: kordi_core::types::EntryId("old00001".into()),
            parent_id: None,
            timestamp: Utc::now(),
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "old context".repeat(100),
            }],
            timestamp: Utc::now().timestamp_millis(),
        }),
    };
    store::append_entry(&conn, &session_id, &old_user).expect("append old user");

    let latest_assistant = SessionEntry::Message {
        base: EntryBase {
            id: kordi_core::types::EntryId("asst0002".into()),
            parent_id: Some(kordi_core::types::EntryId("old00001".into())),
            timestamp: Utc::now(),
        },
        message: AgentMessage::Assistant(AssistantMessage {
            content: vec![AssistantContent::Text {
                text: "ready".to_string(),
            }],
            provider: "dummy".to_string(),
            model: "dummy-model".to_string(),
            usage: Usage {
                total_tokens: 900,
                ..Default::default()
            },
            stop_reason: StopReason::Stop,
            error_message: None,
            timestamp: Utc::now().timestamp_millis(),
        }),
    };
    store::append_entry(&conn, &session_id, &latest_assistant).expect("append assistant");

    let complete_count = Arc::new(AtomicUsize::new(0));
    let stream_count = Arc::new(AtomicUsize::new(0));
    let provider = Arc::new(FailingCompactionProvider {
        complete_count: complete_count.clone(),
        stream_count: stream_count.clone(),
    });
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let config = TurnConfig {
        conn: wrap_conn(conn),
        session_id: session_id.clone(),
        system_prompt: "system".to_string(),
        bridge_outreach_prompt_context: None,
        model: test_model(1_000),
        provider,
        auth: None,
        api_key: "dummy".to_string(),
        base_url: "http://dummy.invalid".to_string(),
        headers: std::collections::HashMap::new(),
        compaction_settings: kordi_core::types::CompactionSettings {
            enabled: true,
            reserve_tokens: 0,
            keep_recent_tokens: 1,
        },
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

    let (_returned_config, result) = run_turn(config, event_tx, "continue".to_string()).await;
    let error = result.expect_err("turn should fail when compaction fails");

    assert!(
        error.to_string().contains("Auto-compaction failed:")
            && error.to_string().contains("summarizer unavailable"),
        "unexpected error: {error}"
    );
    assert_eq!(complete_count.load(Ordering::SeqCst), 1);
    assert_eq!(stream_count.load(Ordering::SeqCst), 0);

    let events = std::iter::from_fn(|| event_rx.try_recv().ok()).collect::<Vec<_>>();
    assert!(
        events
            .iter()
            .any(|event| matches!(event, TurnEvent::AutoCompactionStart))
    );
    assert!(events.iter().any(|event| matches!(event, TurnEvent::Status(message) if message.starts_with("Auto-compaction failed:"))));

    let append_conn = store::open_db(&db_path).expect("reopen db");
    let path = kordi_session::tree::active_path(&append_conn, &session_id).expect("active path");
    let latest = path.last().expect("persisted error message");
    let entry = store::parse_entry(latest).expect("parse latest");
    assert!(matches!(
        entry,
        SessionEntry::Message {
            message: AgentMessage::Assistant(AssistantMessage {
                stop_reason: StopReason::Error,
                ..
            }),
            ..
        }
    ));
}
