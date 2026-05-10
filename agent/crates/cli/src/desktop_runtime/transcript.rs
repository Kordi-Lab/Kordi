use anyhow::Result;
use kordi_core::types::{AgentMessage, AssistantContent, ContentBlock, SessionEntry};
use std::collections::HashMap;

use super::attachments::{
    attachments_from_details, image_attachments_from_blocks, merge_attachment_metadata,
};
use super::{
    ATTACHMENT_CONTEXT_CUSTOM_TYPE, DesktopChatMessage, DesktopChatStoredTool,
    format_message_timestamp, format_utc_timestamp, thinking_label,
};

#[derive(Default)]
struct HistoricalTurnBuilder {
    assistant_text_parts: Vec<String>,
    thinking_parts: Vec<String>,
    tools: Vec<DesktopChatStoredTool>,
    tool_index_by_id: HashMap<String, usize>,
    detail: Option<String>,
    error_message: Option<String>,
    failed: bool,
    timestamp_ms: i64,
}

impl HistoricalTurnBuilder {
    fn is_empty(&self) -> bool {
        self.assistant_text_parts.is_empty()
            && self.thinking_parts.is_empty()
            && self.tools.is_empty()
            && self.error_message.is_none()
    }

    fn touch_timestamp(&mut self, timestamp_ms: i64) {
        self.timestamp_ms = self.timestamp_ms.max(timestamp_ms);
    }
}

fn flush_historical_turn(
    out: &mut Vec<DesktopChatMessage>,
    current_turn: &mut Option<HistoricalTurnBuilder>,
) {
    let Some(turn) = current_turn.take() else {
        return;
    };
    if turn.is_empty() {
        return;
    }

    let assistant_text = turn.assistant_text_parts.join("\n\n");
    let thinking_text = turn.thinking_parts.join("\n\n");
    let visible_text = if assistant_text.trim().is_empty() && turn.failed {
        turn.error_message.clone().unwrap_or_default()
    } else {
        assistant_text
    };
    out.push(DesktopChatMessage {
        role: "assistant".to_string(),
        sender: Some("Kordi".to_string()),
        text: visible_text,
        detail: turn.detail,
        time_label: format_message_timestamp(turn.timestamp_ms),
        timestamp_ms: turn.timestamp_ms,
        failed: turn.failed,
        attachments: Vec::new(),
        thinking_text: (!thinking_text.trim().is_empty()).then_some(thinking_text),
        tools: turn.tools,
        entry_id: None,
    });
}

fn tool_detail_label(details: &Option<serde_json::Value>) -> Option<String> {
    let details = details.as_ref()?;
    let mut parts = Vec::new();
    if let Some(duration_ms) = details.get("durationMs").and_then(|value| value.as_u64()) {
        parts.push(format!("{}ms", duration_ms));
    }
    if let Some(exit_code) = details.get("exitCode").and_then(|value| value.as_i64()) {
        parts.push(format!("exit {exit_code}"));
    }
    if details
        .get("truncated")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        parts.push("truncated".to_string());
    }
    if details
        .get("cancelled")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        parts.push("cancelled".to_string());
    }
    (!parts.is_empty()).then(|| parts.join(" • "))
}

fn tool_artifact_path(details: &Option<serde_json::Value>) -> Option<String> {
    let details = details.as_ref()?;
    details
        .get("artifactPath")
        .or_else(|| details.get("artifact_path"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn tool_layer(details: &Option<serde_json::Value>) -> Option<String> {
    let details = details.as_ref()?;
    details
        .get("toolLayer")
        .or_else(|| details.get("tool_layer"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub(super) fn load_session_messages(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Vec<DesktopChatMessage>> {
    let path = kordi_session::tree::active_path(conn, session_id)?;
    let mut out = Vec::new();
    let mut current_turn: Option<HistoricalTurnBuilder> = None;

    for row in path {
        let entry = kordi_session::store::parse_entry(&row)?;
        match entry {
            SessionEntry::Message { message, .. } => match message {
                AgentMessage::User(user) => {
                    flush_historical_turn(&mut out, &mut current_turn);
                    out.push(DesktopChatMessage {
                        role: "user".to_string(),
                        sender: Some("You".to_string()),
                        text: user_visible_text_from_blocks(&user.content),
                        detail: None,
                        time_label: format_message_timestamp(user.timestamp),
                        timestamp_ms: user.timestamp,
                        failed: false,
                        attachments: image_attachments_from_blocks(&user.content),
                        thinking_text: None,
                        tools: Vec::new(),
                        entry_id: Some(row.entry_id.clone()),
                    });
                }
                AgentMessage::Assistant(message) => {
                    let turn = current_turn.get_or_insert_with(HistoricalTurnBuilder::default);
                    turn.touch_timestamp(message.timestamp);

                    let stop_reason_label = match &message.stop_reason {
                        kordi_core::types::StopReason::Stop => "completed",
                        kordi_core::types::StopReason::Length => "length limit",
                        kordi_core::types::StopReason::ToolUse => "tool use",
                        kordi_core::types::StopReason::Error => "error",
                        kordi_core::types::StopReason::Aborted => "aborted",
                    };
                    turn.detail = Some(format!(
                        "{}/{} • {}",
                        message.provider, message.model, stop_reason_label,
                    ));
                    if message.stop_reason == kordi_core::types::StopReason::Error {
                        turn.failed = true;
                        if let Some(error_message) = message.error_message.as_deref() {
                            turn.error_message = Some(error_message.to_string());
                        }
                    }

                    for item in message.content {
                        match item {
                            AssistantContent::Text { text } => {
                                if !text.trim().is_empty() {
                                    turn.assistant_text_parts.push(text);
                                }
                            }
                            AssistantContent::Thinking { thinking } => {
                                if !thinking.trim().is_empty() {
                                    turn.thinking_parts.push(thinking);
                                }
                            }
                            AssistantContent::ToolCall {
                                id,
                                name,
                                arguments,
                            } => {
                                let raw_args = arguments.to_string();
                                let next_index = turn.tools.len();
                                turn.tool_index_by_id.insert(id.clone(), next_index);
                                turn.tools.push(DesktopChatStoredTool {
                                    id,
                                    name,
                                    status: "done".to_string(),
                                    arguments: raw_args,
                                    live_output: String::new(),
                                    result_text: None,
                                    detail: None,
                                    artifact_path: None,
                                    tool_layer: None,
                                    is_error: false,
                                });
                            }
                        }
                    }
                }
                AgentMessage::ToolResult(message) => {
                    let turn = current_turn.get_or_insert_with(HistoricalTurnBuilder::default);
                    turn.touch_timestamp(message.timestamp);
                    let tool_index = if let Some(index) =
                        turn.tool_index_by_id.get(&message.tool_call_id).copied()
                    {
                        index
                    } else {
                        let index = turn.tools.len();
                        turn.tool_index_by_id
                            .insert(message.tool_call_id.clone(), index);
                        turn.tools.push(DesktopChatStoredTool {
                            id: message.tool_call_id.clone(),
                            name: message.tool_name.clone(),
                            status: if message.is_error {
                                "error".to_string()
                            } else {
                                "done".to_string()
                            },
                            arguments: String::new(),
                            live_output: String::new(),
                            result_text: None,
                            detail: None,
                            artifact_path: tool_artifact_path(&message.details),
                            tool_layer: tool_layer(&message.details),
                            is_error: message.is_error,
                        });
                        index
                    };

                    if let Some(tool) = turn.tools.get_mut(tool_index) {
                        tool.status = if message.is_error {
                            "error".to_string()
                        } else {
                            "done".to_string()
                        };
                        tool.result_text = Some(text_from_blocks(&message.content));
                        tool.detail = tool_detail_label(&message.details);
                        tool.artifact_path = tool_artifact_path(&message.details);
                        tool.tool_layer = tool_layer(&message.details);
                        tool.is_error = message.is_error;
                    }
                }
                AgentMessage::BashExecution(message) => {
                    flush_historical_turn(&mut out, &mut current_turn);
                    let detail = {
                        let mut parts = Vec::new();
                        if let Some(exit_code) = message.exit_code {
                            parts.push(format!("exit {exit_code}"));
                        }
                        if message.truncated {
                            parts.push("truncated".to_string());
                        }
                        if message.cancelled {
                            parts.push("cancelled".to_string());
                        }
                        (!parts.is_empty()).then(|| parts.join(" • "))
                    };
                    current_turn = Some(HistoricalTurnBuilder {
                        assistant_text_parts: Vec::new(),
                        thinking_parts: Vec::new(),
                        tools: vec![DesktopChatStoredTool {
                            id: format!("bash-exec-{}", message.timestamp),
                            name: "bash".to_string(),
                            status: if message.cancelled {
                                "error".to_string()
                            } else {
                                "done".to_string()
                            },
                            arguments: serde_json::json!({ "command": message.command })
                                .to_string(),
                            live_output: String::new(),
                            result_text: Some(if message.output.trim().is_empty() {
                                "(no output)".to_string()
                            } else {
                                message.output
                            }),
                            detail,
                            artifact_path: message.full_output_path.clone(),
                            tool_layer: Some("execution".to_string()),
                            is_error: message.cancelled
                                || message.exit_code.unwrap_or_default() != 0,
                        }],
                        tool_index_by_id: HashMap::new(),
                        detail: Some("bash".to_string()),
                        error_message: None,
                        failed: false,
                        timestamp_ms: message.timestamp,
                    });
                    flush_historical_turn(&mut out, &mut current_turn);
                }
                AgentMessage::Custom(message) => {
                    flush_historical_turn(&mut out, &mut current_turn);
                    if message.display {
                        out.push(DesktopChatMessage {
                            role: "system".to_string(),
                            sender: None,
                            text: text_from_blocks(&message.content),
                            detail: Some(message.custom_type),
                            time_label: format_message_timestamp(message.timestamp),
                            timestamp_ms: message.timestamp,
                            failed: false,
                            attachments: Vec::new(),
                            thinking_text: None,
                            tools: Vec::new(),
                            entry_id: None,
                        });
                    }
                }
                AgentMessage::BranchSummary(message) => {
                    flush_historical_turn(&mut out, &mut current_turn);
                    out.push(DesktopChatMessage {
                        role: "system".to_string(),
                        sender: None,
                        text: message.summary,
                        detail: Some("Branch summary".to_string()),
                        time_label: format_message_timestamp(message.timestamp),
                        timestamp_ms: message.timestamp,
                        failed: false,
                        attachments: Vec::new(),
                        thinking_text: None,
                        tools: Vec::new(),
                        entry_id: None,
                    });
                }
                AgentMessage::CompactionSummary(message) => {
                    flush_historical_turn(&mut out, &mut current_turn);
                    out.push(DesktopChatMessage {
                        role: "system".to_string(),
                        sender: None,
                        text: message.summary,
                        detail: Some(format!(
                            "Conversation compressed • {} tokens before",
                            message.tokens_before
                        )),
                        time_label: format_message_timestamp(message.timestamp),
                        timestamp_ms: message.timestamp,
                        failed: false,
                        attachments: Vec::new(),
                        thinking_text: None,
                        tools: Vec::new(),
                        entry_id: None,
                    });
                }
            },
            SessionEntry::ModelChange {
                provider,
                model_id,
                base,
            } => {
                flush_historical_turn(&mut out, &mut current_turn);
                out.push(DesktopChatMessage {
                    role: "system".to_string(),
                    sender: None,
                    text: format!("Switched model to {provider}/{model_id}"),
                    detail: Some("Model updated".to_string()),
                    time_label: format_utc_timestamp(base.timestamp.timestamp_millis()),
                    timestamp_ms: base.timestamp.timestamp_millis(),
                    failed: false,
                    attachments: Vec::new(),
                    thinking_text: None,
                    tools: Vec::new(),
                    entry_id: None,
                })
            }
            SessionEntry::ThinkingLevelChange {
                thinking_level,
                base,
            } => {
                flush_historical_turn(&mut out, &mut current_turn);
                out.push(DesktopChatMessage {
                    role: "system".to_string(),
                    sender: None,
                    text: format!(
                        "Thinking set to {}",
                        thinking_label(thinking_level.as_str())
                    ),
                    detail: Some("Thinking updated".to_string()),
                    time_label: format_utc_timestamp(base.timestamp.timestamp_millis()),
                    timestamp_ms: base.timestamp.timestamp_millis(),
                    failed: false,
                    attachments: Vec::new(),
                    thinking_text: None,
                    tools: Vec::new(),
                    entry_id: None,
                })
            }
            SessionEntry::CustomMessage {
                custom_type,
                content,
                display,
                details,
                base,
            } => {
                flush_historical_turn(&mut out, &mut current_turn);
                if custom_type == ATTACHMENT_CONTEXT_CUSTOM_TYPE {
                    if let Some(last_user_message) =
                        out.iter_mut().rev().find(|message| message.role == "user")
                    {
                        last_user_message.attachments = merge_attachment_metadata(
                            std::mem::take(&mut last_user_message.attachments),
                            attachments_from_details(&details),
                        );
                    }
                    continue;
                }
                if display {
                    out.push(DesktopChatMessage {
                        role: "system".to_string(),
                        sender: None,
                        text: text_from_blocks(&content),
                        detail: Some(custom_type),
                        time_label: format_utc_timestamp(base.timestamp.timestamp_millis()),
                        timestamp_ms: base.timestamp.timestamp_millis(),
                        failed: false,
                        attachments: Vec::new(),
                        thinking_text: None,
                        tools: Vec::new(),
                        entry_id: None,
                    });
                }
            }
            SessionEntry::Compaction {
                summary,
                tokens_before,
                base,
                ..
            } => {
                flush_historical_turn(&mut out, &mut current_turn);
                out.push(DesktopChatMessage {
                    role: "system".to_string(),
                    sender: None,
                    text: summary,
                    detail: Some(format!(
                        "Conversation compressed • {} tokens before",
                        tokens_before
                    )),
                    time_label: format_utc_timestamp(base.timestamp.timestamp_millis()),
                    timestamp_ms: base.timestamp.timestamp_millis(),
                    failed: false,
                    attachments: Vec::new(),
                    thinking_text: None,
                    tools: Vec::new(),
                    entry_id: None,
                })
            }
            SessionEntry::BranchSummary { summary, base, .. } => {
                flush_historical_turn(&mut out, &mut current_turn);
                out.push(DesktopChatMessage {
                    role: "system".to_string(),
                    sender: None,
                    text: summary,
                    detail: Some("Branch summary".to_string()),
                    time_label: format_utc_timestamp(base.timestamp.timestamp_millis()),
                    timestamp_ms: base.timestamp.timestamp_millis(),
                    failed: false,
                    attachments: Vec::new(),
                    thinking_text: None,
                    tools: Vec::new(),
                    entry_id: None,
                })
            }
            SessionEntry::SessionInfo { name, base } => {
                flush_historical_turn(&mut out, &mut current_turn);
                if let Some(name) = name.filter(|value| !value.trim().is_empty()) {
                    out.push(DesktopChatMessage {
                        role: "system".to_string(),
                        sender: None,
                        text: format!("Renamed session to {name}"),
                        detail: Some("Session updated".to_string()),
                        time_label: format_utc_timestamp(base.timestamp.timestamp_millis()),
                        timestamp_ms: base.timestamp.timestamp_millis(),
                        failed: false,
                        attachments: Vec::new(),
                        thinking_text: None,
                        tools: Vec::new(),
                        entry_id: None,
                    });
                }
            }
            SessionEntry::Label { label, base, .. } => {
                flush_historical_turn(&mut out, &mut current_turn);
                if let Some(label) = label.filter(|value| !value.trim().is_empty()) {
                    out.push(DesktopChatMessage {
                        role: "system".to_string(),
                        sender: None,
                        text: format!("Added label: {label}"),
                        detail: Some("Label updated".to_string()),
                        time_label: format_utc_timestamp(base.timestamp.timestamp_millis()),
                        timestamp_ms: base.timestamp.timestamp_millis(),
                        failed: false,
                        attachments: Vec::new(),
                        thinking_text: None,
                        tools: Vec::new(),
                        entry_id: None,
                    });
                }
            }
            SessionEntry::Custom { .. } => {
                flush_historical_turn(&mut out, &mut current_turn);
            }
        }
    }

    flush_historical_turn(&mut out, &mut current_turn);
    Ok(out)
}

fn user_visible_text_from_blocks(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            ContentBlock::Image { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn text_from_blocks(blocks: &[ContentBlock]) -> String {
    let joined = user_visible_text_from_blocks(blocks);

    if joined.trim().is_empty() {
        "(non-text content)".to_string()
    } else {
        joined
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
