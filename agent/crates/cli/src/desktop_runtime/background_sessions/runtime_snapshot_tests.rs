use super::*;
use kordi_core::types::{
    AgentMessage, AssistantContent, AssistantMessage, ContentBlock, EntryBase, EntryId,
    SessionEntry, StopReason, Usage, UserMessage,
};

#[test]
fn model_runtime_is_hidden_and_snapshot_excludes_private_trace_fields() -> Result<()> {
    let conn = kordi_session::store::open_memory()?;
    let id = kordi_session::store::create_session_with_parent_and_message(
        &conn,
        "/tmp/test",
        Some("parent"),
        Some("request"),
    )?;
    assert!(background_snapshot_from_store(&conn, &id).is_err());
    kordi_session::store::update_session_scope(&conn, &id, "runtime", "/tmp/test", None)?;
    let user_id = EntryId::generate();
    kordi_session::store::append_entry(
        &conn,
        &id,
        &SessionEntry::Message {
            base: EntryBase {
                id: user_id.clone(),
                parent_id: None,
                timestamp: chrono::Utc::now(),
            },
            message: AgentMessage::User(UserMessage {
                content: vec![ContentBlock::Text {
                    text: "Task brief".into(),
                }],
                timestamp: 1000,
            }),
        },
    )?;
    kordi_session::store::append_entry(
        &conn,
        &id,
        &SessionEntry::Message {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: Some(user_id),
                timestamp: chrono::Utc::now(),
            },
            message: AgentMessage::Assistant(AssistantMessage {
                content: vec![
                    AssistantContent::Thinking {
                        thinking: "PRIVATE_TRACE".into(),
                    },
                    AssistantContent::Text {
                        text: "SUBSESSION_RESULT".into(),
                    },
                ],
                provider: "test".into(),
                model: "test".into(),
                usage: Usage::default(),
                stop_reason: StopReason::Stop,
                error_message: None,
                timestamp: 2000,
            }),
        },
    )?;
    let snapshot = background_snapshot_from_store(&conn, &id)?;
    assert_eq!(snapshot.parent_session_id, "parent");
    assert_eq!(snapshot.parent_request_id.as_deref(), Some("request"));
    assert_eq!(snapshot.messages[1].text, "SUBSESSION_RESULT");
    let encoded = serde_json::to_string(&snapshot)?;
    assert!(!encoded.contains("PRIVATE_TRACE"));
    assert!(!encoded.contains("thinkingText"));
    assert!(!encoded.contains("forkedFromSessionId"));
    let profile = super::super::DesktopRuntimeProfile {
        system_prompt: Some("PRIVATE_PROFILE".into()),
        tool_names: Some(vec!["web_search".into()]),
        ..Default::default()
    };
    kordi_session::store::append_entry(
        &conn,
        &id,
        &SessionEntry::Custom {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: None,
                timestamp: chrono::Utc::now(),
            },
            custom_type: "subsession_runtime_profile".into(),
            data: Some(serde_json::json!({"profile":profile,"executionPolicy":"safety"})),
        },
    )?;
    let restored = saved_runtime_profile_from_store(&conn, &id)?.expect("saved runtime profile");
    assert_eq!(restored.tool_names, Some(vec!["web_search".into()]));
    assert_eq!(
        restored.execution_policy,
        Some(kordi_tools::ExecutionPolicy::Safety)
    );
    let snapshot = background_snapshot_from_store(&conn, &id)?;
    assert!(snapshot.can_resume);
    assert!(!serde_json::to_string(&snapshot)?.contains("PRIVATE_PROFILE"));
    assert!(kordi_session::store::list_sessions(&conn, "/tmp/test")?.is_empty());
    Ok(())
}
