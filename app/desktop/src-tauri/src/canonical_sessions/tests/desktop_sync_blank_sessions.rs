use super::*;

#[test]
fn blank_desktop_drafts_do_not_sync_into_canonical_sessions() {
    let blank_summary = kordi_cli::desktop_runtime::DesktopChatSessionSummary {
        id: "draft:local-chat".to_string(),
        title: "New session".to_string(),
        subtitle: String::new(),
        updated_at_label: "Draft".to_string(),
        updated_at_ms: 0,
        message_count: 0,
        draft: true,
        background_status: None,
        forked_from_session_id: None,
        forked_from_message_id: None,
    };
    let blank_detail = kordi_cli::desktop_runtime::DesktopChatSessionDetail {
        id: "draft:local-chat".to_string(),
        cwd: "/tmp/workspace".to_string(),
        title: "New session".to_string(),
        subtitle: String::new(),
        provider: "openai".to_string(),
        provider_label: "OpenAI".to_string(),
        model: "gpt-5".to_string(),
        model_label: "gpt-5".to_string(),
        thinking: "medium".to_string(),
        thinking_label: "Medium".to_string(),
        thinking_levels: vec!["off".to_string(), "medium".to_string()],
        updated_at_label: "Draft".to_string(),
        updated_at_ms: 0,
        message_count: 0,
        draft: true,
        cache_monitor_text: None,
        context_window_text: "0 / 0".to_string(),
        context_window_status: kordi_cli::desktop_runtime::DesktopChatContextWindowStatus {
            context_window: 0,
            used_tokens: None,
            used_percent: None,
            auto_compaction: false,
            compaction_threshold_percent: 90,
        },
        project: None,
        reflection_lesson_artifacts: Vec::new(),
        forked_from_session_id: None,
        forked_from_message_id: None,
        messages: Vec::new(),
    };
    let blank_default_agent_summary = kordi_cli::desktop_runtime::DesktopChatSessionSummary {
        id: "session:blank-agent-runtime".to_string(),
        title: "My Kordi".to_string(),
        subtitle: String::new(),
        updated_at_label: "23:16".to_string(),
        updated_at_ms: 1,
        message_count: 0,
        draft: false,
        background_status: None,
        forked_from_session_id: None,
        forked_from_message_id: None,
    };
    let named_empty_summary = kordi_cli::desktop_runtime::DesktopChatSessionSummary {
        id: "session:named-empty".to_string(),
        title: "Research notes".to_string(),
        subtitle: String::new(),
        updated_at_label: "23:16".to_string(),
        updated_at_ms: 1,
        message_count: 0,
        draft: false,
        background_status: None,
        forked_from_session_id: None,
        forked_from_message_id: None,
    };
    let materialized_blank_detail = kordi_cli::desktop_runtime::DesktopChatSessionDetail {
        id: "session:materialized-blank".to_string(),
        title: "New chat".to_string(),
        updated_at_label: "23:16".to_string(),
        updated_at_ms: 1,
        draft: false,
        ..blank_detail.clone()
    };
    let named_empty_detail = kordi_cli::desktop_runtime::DesktopChatSessionDetail {
        id: "session:named-empty".to_string(),
        title: "Research notes".to_string(),
        updated_at_label: "23:16".to_string(),
        updated_at_ms: 1,
        draft: false,
        ..blank_detail.clone()
    };

    assert!(!should_sync_desktop_chat_summary(&blank_summary));
    assert!(!should_sync_desktop_chat_summary(
        &blank_default_agent_summary
    ));
    assert!(should_sync_desktop_chat_summary(&named_empty_summary));
    assert!(!should_sync_desktop_chat_detail(&blank_detail));
    assert!(!should_sync_desktop_chat_detail(&materialized_blank_detail));
    assert!(should_sync_desktop_chat_detail(&named_empty_detail));
}
