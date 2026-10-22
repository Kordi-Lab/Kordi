use super::*;

#[test]
fn shared_bridge_local_agent_runtime_prompt_is_not_synced_as_extra_user_message() {
    let message = kordi_cli::desktop_runtime::DesktopChatMessage {
        role: "user".to_string(),
        sender: Some("You".to_string()),
        text: "@Kordi hi do a review".to_string(),
        detail: None,
        time_label: "Now".to_string(),
        timestamp_ms: 1,
        thinking_text: None,
        segments: Vec::new(),
        tools: Vec::new(),
        attachments: Vec::new(),
        failed: false,
        cancelled: false,
        entry_id: None,
    };

    assert!(should_skip_shared_local_agent_runtime_prompt(
        "session:bridge:humans:test",
        &message,
    ));
    assert!(!should_skip_shared_local_agent_runtime_prompt(
        "session:local:test",
        &message,
    ));

    let normal_message = kordi_cli::desktop_runtime::DesktopChatMessage {
        text: "hello".to_string(),
        ..message
    };
    assert!(!should_skip_shared_local_agent_runtime_prompt(
        "session:bridge:humans:test",
        &normal_message,
    ));
}
