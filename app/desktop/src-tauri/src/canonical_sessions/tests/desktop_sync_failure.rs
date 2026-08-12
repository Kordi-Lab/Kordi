use super::*;
use crate::canonical_sessions::desktop_sync::sync_desktop_chat_message;

#[test]
fn desktop_sync_persists_failed_agent_turn_as_terminal_failure() {
    let conn = test_conn();
    let user = kordi_cli::desktop_runtime::DesktopChatMessage {
        role: "user".to_string(),
        sender: Some("You".to_string()),
        text: "check my account".to_string(),
        detail: None,
        time_label: "22:39".to_string(),
        timestamp_ms: 1_000,
        thinking_text: None,
        tools: Vec::new(),
        attachments: Vec::new(),
        failed: false,
        cancelled: false,
        entry_id: Some("runtime-user".to_string()),
    };
    let failed = kordi_cli::desktop_runtime::DesktopChatMessage {
        role: "assistant".to_string(),
        sender: Some("Kordi".to_string()),
        text: "Your authentication token has been invalidated.".to_string(),
        detail: Some("openai/gpt-5 • error".to_string()),
        time_label: "22:39".to_string(),
        timestamp_ms: 2_000,
        thinking_text: None,
        tools: Vec::new(),
        attachments: Vec::new(),
        failed: true,
        cancelled: false,
        entry_id: Some("runtime-agent".to_string()),
    };

    let user_id = sync_desktop_chat_message(
        &conn,
        "session:failed",
        "human:local",
        "agent:local",
        0,
        &user,
        None,
    )
    .expect("sync user")
    .expect("user message id");
    let failed_id = sync_desktop_chat_message(
        &conn,
        "session:failed",
        "human:local",
        "agent:local",
        1,
        &failed,
        Some(&user_id),
    )
    .expect("sync failed agent")
    .expect("failed message id");

    let (status, content_json): (String, String) = conn
        .query_row(
            "SELECT status, content_json FROM session_messages WHERE id = ?1",
            rusqlite::params![failed_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("load failed message");
    let content: serde_json::Value = serde_json::from_str(&content_json).expect("parse content");
    assert_eq!(status, "failed");
    assert_eq!(content["deliveryState"], "failed");
    assert_eq!(
        content["error"],
        "Your authentication token has been invalidated."
    );
}
