use anyhow::Result;
use kordi_core::types::{AgentMessage, AssistantContent, ContentBlock, SessionEntry};
use std::collections::HashMap;

use super::super::attachments::{
    attachments_from_details, image_attachments_from_blocks, merge_attachment_metadata,
};
use super::super::{
    ATTACHMENT_CONTEXT_CUSTOM_TYPE, DesktopChatMessage, DesktopChatStoredTool,
    format_message_timestamp, format_utc_timestamp, thinking_label,
};
use super::historical_turn::{
    HistoricalTurnBuilder, flush_historical_turn, tool_artifact_path, tool_detail_label, tool_layer,
};

pub(in crate::desktop_runtime) fn load_session_messages(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Vec<DesktopChatMessage>> {
    let path = kordi_session::tree::active_path(conn, session_id)?;
    let mut out = Vec::new();
    let mut current_turn = None;

    for row in path {
        match kordi_session::store::parse_entry(&row)? {
            SessionEntry::Message { message, .. } => {
                append_agent_message(&mut out, &mut current_turn, &row.entry_id, message)
            }
            entry => append_session_metadata(&mut out, &mut current_turn, entry),
        }
    }

    flush_historical_turn(&mut out, &mut current_turn);
    Ok(out)
}

fn append_agent_message(
    out: &mut Vec<DesktopChatMessage>,
    current_turn: &mut Option<HistoricalTurnBuilder>,
    entry_id: &str,
    message: AgentMessage,
) {
    match message {
        AgentMessage::User(user) => {
            flush_historical_turn(out, current_turn);
            out.push(DesktopChatMessage {
                role: "user".to_string(),
                sender: Some("You".to_string()),
                text: user_visible_text_from_blocks(&user.content),
                detail: None,
                time_label: format_message_timestamp(user.timestamp),
                timestamp_ms: user.timestamp,
                failed: false,
                cancelled: false,
                attachments: image_attachments_from_blocks(&user.content),
                thinking_text: None,
                tools: Vec::new(),
                entry_id: Some(entry_id.to_string()),
            });
        }
        AgentMessage::Assistant(message) => {
            let turn = current_turn.get_or_insert_with(HistoricalTurnBuilder::default);
            turn.touch_timestamp(message.timestamp);
            turn.last_entry_id = Some(entry_id.to_string());

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
            turn.awaiting_final_response =
                message.stop_reason == kordi_core::types::StopReason::ToolUse;
            if message.stop_reason == kordi_core::types::StopReason::Error {
                turn.failed = true;
                if let Some(error_message) = message.error_message.as_deref() {
                    turn.error_message = Some(error_message.to_string());
                }
            } else if message.stop_reason == kordi_core::types::StopReason::Aborted {
                turn.cancelled = true;
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
                            status: "running".to_string(),
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
            turn.last_entry_id = Some(entry_id.to_string());
            if message
                .details
                .as_ref()
                .and_then(|details| details.get("cancelled"))
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
            {
                turn.cancelled = true;
            }
            let tool_index =
                if let Some(index) = turn.tool_index_by_id.get(&message.tool_call_id).copied() {
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
            flush_historical_turn(out, current_turn);
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
            *current_turn = Some(HistoricalTurnBuilder {
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
                    arguments: serde_json::json!({ "command": message.command }).to_string(),
                    live_output: String::new(),
                    result_text: Some(if message.output.trim().is_empty() {
                        "(no output)".to_string()
                    } else {
                        message.output
                    }),
                    detail,
                    artifact_path: message.full_output_path.clone(),
                    tool_layer: Some("execution".to_string()),
                    is_error: message.cancelled || message.exit_code.unwrap_or_default() != 0,
                }],
                tool_index_by_id: HashMap::new(),
                detail: Some("bash".to_string()),
                error_message: None,
                failed: false,
                cancelled: message.cancelled,
                awaiting_final_response: false,
                timestamp_ms: message.timestamp,
                last_entry_id: Some(entry_id.to_string()),
            });
            flush_historical_turn(out, current_turn);
        }
        AgentMessage::Custom(message) => {
            flush_historical_turn(out, current_turn);
            if message.display {
                out.push(DesktopChatMessage {
                    role: "system".to_string(),
                    sender: None,
                    text: text_from_blocks(&message.content),
                    detail: Some(message.custom_type),
                    time_label: format_message_timestamp(message.timestamp),
                    timestamp_ms: message.timestamp,
                    failed: false,
                    cancelled: false,
                    attachments: Vec::new(),
                    thinking_text: None,
                    tools: Vec::new(),
                    entry_id: None,
                });
            }
        }
        AgentMessage::BranchSummary(message) => {
            flush_historical_turn(out, current_turn);
            out.push(DesktopChatMessage {
                role: "system".to_string(),
                sender: None,
                text: message.summary,
                detail: Some("Branch summary".to_string()),
                time_label: format_message_timestamp(message.timestamp),
                timestamp_ms: message.timestamp,
                failed: false,
                cancelled: false,
                attachments: Vec::new(),
                thinking_text: None,
                tools: Vec::new(),
                entry_id: None,
            });
        }
        AgentMessage::CompactionSummary(message) => {
            flush_historical_turn(out, current_turn);
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
                cancelled: false,
                attachments: Vec::new(),
                thinking_text: None,
                tools: Vec::new(),
                entry_id: None,
            });
        }
    }
}

fn append_session_metadata(
    out: &mut Vec<DesktopChatMessage>,
    current_turn: &mut Option<HistoricalTurnBuilder>,
    entry: SessionEntry,
) {
    match entry {
        SessionEntry::Message { .. } => unreachable!("message entries are handled separately"),
        SessionEntry::ModelChange {
            provider,
            model_id,
            base,
        } => {
            flush_historical_turn(out, current_turn);
            out.push(DesktopChatMessage {
                role: "system".to_string(),
                sender: None,
                text: format!("Switched model to {provider}/{model_id}"),
                detail: Some("Model updated".to_string()),
                time_label: format_utc_timestamp(base.timestamp.timestamp_millis()),
                timestamp_ms: base.timestamp.timestamp_millis(),
                failed: false,
                cancelled: false,
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
            flush_historical_turn(out, current_turn);
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
                cancelled: false,
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
            flush_historical_turn(out, current_turn);
            if custom_type == ATTACHMENT_CONTEXT_CUSTOM_TYPE {
                if let Some(last_user_message) =
                    out.iter_mut().rev().find(|message| message.role == "user")
                {
                    last_user_message.attachments = merge_attachment_metadata(
                        std::mem::take(&mut last_user_message.attachments),
                        attachments_from_details(&details),
                    );
                }
                return;
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
                    cancelled: false,
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
            flush_historical_turn(out, current_turn);
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
                cancelled: false,
                attachments: Vec::new(),
                thinking_text: None,
                tools: Vec::new(),
                entry_id: None,
            })
        }
        SessionEntry::BranchSummary { summary, base, .. } => {
            flush_historical_turn(out, current_turn);
            out.push(DesktopChatMessage {
                role: "system".to_string(),
                sender: None,
                text: summary,
                detail: Some("Branch summary".to_string()),
                time_label: format_utc_timestamp(base.timestamp.timestamp_millis()),
                timestamp_ms: base.timestamp.timestamp_millis(),
                failed: false,
                cancelled: false,
                attachments: Vec::new(),
                thinking_text: None,
                tools: Vec::new(),
                entry_id: None,
            })
        }
        SessionEntry::SessionInfo { name, base } => {
            flush_historical_turn(out, current_turn);
            if let Some(name) = name.filter(|value| !value.trim().is_empty()) {
                out.push(DesktopChatMessage {
                    role: "system".to_string(),
                    sender: None,
                    text: format!("Renamed session to {name}"),
                    detail: Some("Session updated".to_string()),
                    time_label: format_utc_timestamp(base.timestamp.timestamp_millis()),
                    timestamp_ms: base.timestamp.timestamp_millis(),
                    failed: false,
                    cancelled: false,
                    attachments: Vec::new(),
                    thinking_text: None,
                    tools: Vec::new(),
                    entry_id: None,
                });
            }
        }
        SessionEntry::Label { label, base, .. } => {
            flush_historical_turn(out, current_turn);
            if let Some(label) = label.filter(|value| !value.trim().is_empty()) {
                out.push(DesktopChatMessage {
                    role: "system".to_string(),
                    sender: None,
                    text: format!("Added label: {label}"),
                    detail: Some("Label updated".to_string()),
                    time_label: format_utc_timestamp(base.timestamp.timestamp_millis()),
                    timestamp_ms: base.timestamp.timestamp_millis(),
                    failed: false,
                    cancelled: false,
                    attachments: Vec::new(),
                    thinking_text: None,
                    tools: Vec::new(),
                    entry_id: None,
                });
            }
        }
        SessionEntry::Custom { .. } => {
            flush_historical_turn(out, current_turn);
        }
    }
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
