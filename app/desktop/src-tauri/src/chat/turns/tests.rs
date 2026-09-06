use super::*;

#[tokio::test]
async fn new_admission_preserves_recent_terminal_snapshots_for_publishers() {
    fn handle(id: &str, completed_at_ms: Option<i64>) -> super::super::DesktopChatTurnHandle {
        super::super::DesktopChatTurnHandle {
            snapshot: Arc::new(Mutex::new(DesktopChatTurnSnapshot {
                id: id.into(),
                session_id: id.into(),
                prompt: String::new(),
                status: if completed_at_ms.is_some() {
                    "complete"
                } else {
                    "starting"
                }
                .into(),
                message: String::new(),
                assistant_text: "Result".into(),
                thinking_text: String::new(),
                tools: vec![],
                completed: completed_at_ms.is_some(),
                succeeded: completed_at_ms.is_some(),
                started_at_ms: completed_at_ms.unwrap_or_else(super::super::now_millis),
                completed_at_ms,
                transcript_entry_id: None,
                error: None,
                transcript_refresh_required: false,
            })),
            cancel: tokio_util::sync::CancellationToken::new(),
            execution_lease_deadline: Arc::new(Mutex::new(None)),
        }
    }
    let manager = DesktopChatManager::default();
    let now = super::super::now_millis();
    {
        let mut turns = manager.turns.lock().await;
        turns.insert("recent".into(), handle("recent", Some(now)));
        turns.insert(
            "expired".into(),
            handle("expired", Some(now - 6 * 60 * 1_000)),
        );
    }
    let (_previous, _completion) =
        reserve_turn_in_session(&manager, "next".into(), handle("next", None))
            .await
            .unwrap();
    assert!(
        turn_snapshot_by_id(&manager, "recent")
            .await
            .unwrap()
            .completed
    );
    assert!(turn_snapshot_by_id(&manager, "expired").await.is_err());
    assert!(
        !turn_snapshot_by_id(&manager, "next")
            .await
            .unwrap()
            .completed
    );
}

fn persisted_message(
    role: &str,
    timestamp_ms: i64,
    cancelled: bool,
) -> kordi_cli::desktop_runtime::DesktopChatMessage {
    kordi_cli::desktop_runtime::DesktopChatMessage {
        role: role.to_string(),
        sender: None,
        text: String::new(),
        detail: None,
        time_label: String::new(),
        timestamp_ms,
        failed: false,
        cancelled,
        attachments: Vec::new(),
        thinking_text: None,
        tools: Vec::new(),
        entry_id: cancelled.then(|| "entry:aborted".to_string()),
    }
}

#[test]
fn persisted_abort_completes_only_its_mounted_live_turn() {
    let mut turn = DesktopChatTurnSnapshot {
        id: "turn-live".to_string(),
        session_id: "session-live".to_string(),
        prompt: "work".to_string(),
        status: "tooling".to_string(),
        message: "Tool failed".to_string(),
        assistant_text: String::new(),
        thinking_text: String::new(),
        tools: vec![DesktopChatToolSnapshot {
            id: "tool-failed".to_string(),
            name: "read".to_string(),
            status: "error".to_string(),
            arguments: String::new(),
            live_output: String::new(),
            result_text: Some("late failure".to_string()),
            detail: None,
            artifact_path: None,
            tool_layer: None,
            is_error: true,
        }],
        completed: false,
        succeeded: false,
        started_at_ms: 100,
        completed_at_ms: None,
        transcript_entry_id: None,
        error: Some("tool failed".to_string()),
        transcript_refresh_required: false,
    };

    assert!(!reconcile_persisted_cancelled_turn(
        &mut turn,
        &[persisted_message("assistant", 99, true)],
    ));
    assert!(reconcile_persisted_cancelled_turn(
        &mut turn,
        &[
            persisted_message("user", 100, false),
            persisted_message("assistant", 200, true),
        ],
    ));
    assert!(turn.completed);
    assert_eq!(turn.status, "cancelled");
    assert_eq!(turn.message, "Response stopped");
    assert_eq!(turn.completed_at_ms, Some(200));
    assert_eq!(turn.transcript_entry_id.as_deref(), Some("entry:aborted"));
    assert!(turn.error.is_none());
}
