mod historical_turn;
mod history;

pub(super) use history::load_session_messages;

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use chrono::Utc;
    use kordi_core::types::{
        AgentMessage, AssistantContent, AssistantMessage, ContentBlock, EntryBase, EntryId,
        SessionEntry, StopReason, ToolResultMessage, Usage, UserMessage,
    };

    #[test]
    fn load_session_messages_preserves_failed_assistant_error() -> Result<()> {
        let conn = kordi_session::store::open_memory()?;
        let session_id = "desktop-error-session";
        kordi_session::store::create_session_with_id(&conn, session_id, "/tmp/kordi")?;

        let user_entry = SessionEntry::Message {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: None,
                timestamp: Utc::now(),
            },
            message: AgentMessage::User(UserMessage {
                content: vec![ContentBlock::Text {
                    text: "hi".to_string(),
                }],
                timestamp: 1_000,
            }),
        };
        kordi_session::store::append_entry(&conn, session_id, &user_entry)?;

        let error_text = "Claude OAuth credentials are not usable.";
        let assistant_entry = SessionEntry::Message {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: crate::turn_runner::get_leaf_raw(&conn, session_id),
                timestamp: Utc::now(),
            },
            message: AgentMessage::Assistant(AssistantMessage {
                content: vec![AssistantContent::Text {
                    text: error_text.to_string(),
                }],
                provider: "anthropic".to_string(),
                model: "claude-opus-4-6".to_string(),
                usage: Usage::default(),
                stop_reason: StopReason::Error,
                error_message: Some(error_text.to_string()),
                timestamp: 2_000,
            }),
        };
        kordi_session::store::append_entry(&conn, session_id, &assistant_entry)?;

        let messages = load_session_messages(&conn, session_id)?;
        assert_eq!(messages.len(), 2);
        let assistant = messages.last().expect("assistant message");
        assert_eq!(assistant.role, "assistant");
        assert!(assistant.failed);
        assert_eq!(assistant.text, error_text);
        assert!(
            assistant
                .detail
                .as_deref()
                .unwrap_or_default()
                .contains("error")
        );
        Ok(())
    }

    #[test]
    fn load_session_messages_preserves_empty_cancelled_assistant_turn() -> Result<()> {
        let conn = kordi_session::store::open_memory()?;
        let session_id = "desktop-cancelled-session";
        kordi_session::store::create_session_with_id(&conn, session_id, "/tmp/kordi")?;

        let user_entry = SessionEntry::Message {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: None,
                timestamp: Utc::now(),
            },
            message: AgentMessage::User(UserMessage {
                content: vec![ContentBlock::Text {
                    text: "stop this".to_string(),
                }],
                timestamp: 1_000,
            }),
        };
        kordi_session::store::append_entry(&conn, session_id, &user_entry)?;

        let cancelled_entry = SessionEntry::Message {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: crate::turn_runner::get_leaf_raw(&conn, session_id),
                timestamp: Utc::now(),
            },
            message: AgentMessage::Assistant(AssistantMessage {
                content: Vec::new(),
                provider: "openai".to_string(),
                model: "gpt-test".to_string(),
                usage: Usage::default(),
                stop_reason: StopReason::Aborted,
                error_message: None,
                timestamp: 2_000,
            }),
        };
        kordi_session::store::append_entry(&conn, session_id, &cancelled_entry)?;

        let messages = load_session_messages(&conn, session_id)?;
        assert_eq!(messages.len(), 2);
        let assistant = messages.last().expect("cancelled assistant message");
        assert_eq!(assistant.role, "assistant");
        assert_eq!(assistant.text, "");
        assert!(assistant.cancelled);
        assert!(!assistant.failed);
        Ok(())
    }

    #[test]
    fn load_session_messages_preserves_tool_layer_from_result_details() -> Result<()> {
        let conn = kordi_session::store::open_memory()?;
        let session_id = "desktop-tool-layer-session";
        kordi_session::store::create_session_with_id(&conn, session_id, "/tmp/kordi")?;

        let assistant_entry = SessionEntry::Message {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: None,
                timestamp: Utc::now(),
            },
            message: AgentMessage::Assistant(AssistantMessage {
                content: vec![AssistantContent::ToolCall {
                    id: "tool-1".to_string(),
                    name: "read".to_string(),
                    arguments: serde_json::json!({ "path": "src/main.rs" }),
                }],
                provider: "anthropic".to_string(),
                model: "claude-opus-4-6".to_string(),
                usage: Usage::default(),
                stop_reason: StopReason::ToolUse,
                error_message: None,
                timestamp: 2_000,
            }),
        };
        kordi_session::store::append_entry(&conn, session_id, &assistant_entry)?;

        let tool_result_entry = SessionEntry::Message {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: crate::turn_runner::get_leaf_raw(&conn, session_id),
                timestamp: Utc::now(),
            },
            message: AgentMessage::ToolResult(ToolResultMessage {
                tool_call_id: "tool-1".to_string(),
                tool_name: "read".to_string(),
                content: vec![ContentBlock::Text {
                    text: "file contents".to_string(),
                }],
                details: Some(serde_json::json!({
                    "toolLayer": "observation",
                    "artifactPath": "artifacts/read-output.txt",
                })),
                is_error: false,
                timestamp: 2_100,
            }),
        };
        kordi_session::store::append_entry(&conn, session_id, &tool_result_entry)?;

        let messages = load_session_messages(&conn, session_id)?;
        let assistant = messages.last().expect("assistant message");
        let tool = assistant.tools.first().expect("tool snapshot");
        assert_eq!(tool.tool_layer.as_deref(), Some("observation"));
        assert_eq!(
            tool.artifact_path.as_deref(),
            Some("artifacts/read-output.txt")
        );
        Ok(())
    }
}
