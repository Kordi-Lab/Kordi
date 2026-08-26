use super::*;

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
