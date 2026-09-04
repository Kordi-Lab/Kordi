use super::*;

#[test]
fn agent_names_are_trimmed_and_bounded() {
    assert_eq!(
        normalized_agent_name("  Release Scout  ").as_deref(),
        Ok("Release Scout")
    );
    assert!(normalized_agent_name("   ").is_err());
    assert!(normalized_agent_name(&"a".repeat(121)).is_err());
    assert!(normalized_agent_name("line\nbreak").is_err());
}

#[test]
fn missing_sessions_do_not_block_global_resource_updates() {
    assert!(is_missing_session_error("No session matching 'stale-id'"));
    assert!(!is_missing_session_error("Session database is unavailable"));
}

fn test_summary(title: &str, message_count: usize, draft: bool) -> DesktopChatSessionSummary {
    DesktopChatSessionSummary {
        id: format!("session:{title}:{message_count}:{draft}"),
        title: title.to_string(),
        subtitle: String::new(),
        updated_at_label: "Draft".to_string(),
        updated_at_ms: 0,
        message_count,
        draft,
        background_status: None,
        forked_from_session_id: None,
        forked_from_message_id: None,
    }
}

#[test]
fn blank_default_agent_sessions_are_filtered_as_transient_drafts() {
    assert!(is_blank_draft_summary(&test_summary("My Kordi", 0, false)));
    assert!(is_blank_draft_summary(&test_summary(
        "My Kordi session",
        0,
        false
    )));
    assert!(is_blank_draft_summary(&test_summary(
        "New session",
        0,
        false
    )));
    assert!(!is_blank_draft_summary(&test_summary(
        "Research notes",
        0,
        false
    )));
    assert!(!is_blank_draft_summary(&test_summary("My Kordi", 1, false)));
}

#[test]
fn auto_compaction_status_detection_matches_turn_runner_messages() {
    assert!(is_auto_compaction_success_status(
        "Auto-compacted session: 10 summarized, 5 kept, 12345 tokens before"
    ));
    assert!(is_auto_compaction_failure_status(
        "Auto-compaction failed: provider quota exceeded"
    ));
    assert!(!is_auto_compaction_success_status(
        "Compacted session manually"
    ));
    assert!(!is_auto_compaction_failure_status(
        "Auto-compacted session: ok"
    ));
}

#[tokio::test]
async fn running_turn_lookup_is_session_scoped() {
    let manager = DesktopChatManager::default();
    let snapshot = Arc::new(Mutex::new(DesktopChatTurnSnapshot {
        id: "turn-a".to_string(),
        session_id: "session-a".to_string(),
        prompt: "work".to_string(),
        status: "processing".to_string(),
        message: "Working…".to_string(),
        assistant_text: String::new(),
        thinking_text: String::new(),
        tools: Vec::new(),
        completed: false,
        succeeded: false,
        started_at_ms: 1,
        completed_at_ms: None,
        transcript_entry_id: None,
        error: None,
        transcript_refresh_required: false,
    }));
    manager.turns.lock().await.insert(
        "turn-a".to_string(),
        DesktopChatTurnHandle {
            snapshot,
            cancel: tokio_util::sync::CancellationToken::new(),
        },
    );

    assert!(session_has_running_turn(&manager, "session-a").await);
    assert!(!session_has_running_turn(&manager, "session-b").await);
    assert!(active_turn_snapshots(&manager).await.unwrap().is_empty());

    manager
        .background_turn_ids
        .lock()
        .await
        .insert("turn-a".to_string());
    assert_eq!(active_turn_snapshots(&manager).await.unwrap().len(), 1);
}

#[tokio::test]
async fn concurrent_turn_admission_queues_per_canonical_session() {
    fn turn_handle(turn_id: &str) -> DesktopChatTurnHandle {
        DesktopChatTurnHandle {
            snapshot: Arc::new(Mutex::new(DesktopChatTurnSnapshot {
                id: turn_id.to_string(),
                session_id: "00000000-0000-4000-8000-000000000001".to_string(),
                prompt: "work".to_string(),
                status: "starting".to_string(),
                message: "Working…".to_string(),
                assistant_text: String::new(),
                thinking_text: String::new(),
                tools: Vec::new(),
                completed: false,
                succeeded: false,
                started_at_ms: 1,
                completed_at_ms: None,
                transcript_entry_id: None,
                error: None,
                transcript_refresh_required: false,
            })),
            cancel: tokio_util::sync::CancellationToken::new(),
        }
    }

    let manager = DesktopChatManager::default();
    let left_manager = manager.clone();
    let right_manager = manager.clone();
    let right_handle = turn_handle("turn-right");
    right_handle.snapshot.lock().unwrap().session_id =
        "cloud-agent:acct_test:00000000-0000-4000-8000-000000000001".to_string();
    let (left, right) = tokio::join!(
        reserve_turn_in_session(
            &left_manager,
            "turn-left".to_string(),
            turn_handle("turn-left"),
        ),
        reserve_turn_in_session(&right_manager, "turn-right".to_string(), right_handle,),
    );

    let (left_previous, left_completion) = left.unwrap();
    let (right_previous, right_completion) = right.unwrap();
    assert_ne!(left_previous.is_some(), right_previous.is_some());
    assert_eq!(manager.turns.lock().await.len(), 2);
    if let Some(previous) = right_previous {
        assert_eq!(
            turn_snapshot_by_id(&manager, "turn-right")
                .await
                .unwrap()
                .status,
            "queued"
        );
        drop(left_completion);
        let _ = previous.await;
        drop(right_completion);
    } else {
        drop(right_completion);
        let _ = left_previous.unwrap().await;
        drop(left_completion);
    }

    let independent = turn_handle("group-request");
    independent.snapshot.lock().unwrap().session_id = "group:one:request:two".to_string();
    let (previous, _completion) =
        reserve_turn_in_session(&manager, "group-request".to_string(), independent)
            .await
            .unwrap();
    assert!(previous.is_none());
}
