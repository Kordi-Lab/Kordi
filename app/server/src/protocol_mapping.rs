//! Mapping between persisted session entries and app-server wire DTOs.

use anyhow::Result;
use axum::http::HeaderMap;
use kordi_core::types::{AgentMessage, AssistantContent, ContentBlock, SessionEntry};
use kordi_protocol::{
    APP_PROTOCOL_VERSION, ClientKind, ClientMetadata, TimelineEntry, TimelineEntryKind,
    TimelineRole, TimelineState,
};
use kordi_session::store;
use std::path::Path;

pub(super) fn timeline_entry_from_row(row: &store::EntryRow) -> Result<TimelineEntry> {
    let parsed = store::parse_entry(row)?;
    let (role, text, detail, state) = timeline_fields_from_entry(&parsed);
    Ok(TimelineEntry {
        session_id: row.session_id.clone(),
        entry_id: row.entry_id.clone(),
        parent_entry_id: row.parent_id.clone(),
        created_at: row.timestamp.clone(),
        kind: TimelineEntryKind::Message,
        role,
        text,
        detail,
        state,
        data: None,
    })
}

fn timeline_fields_from_entry(
    entry: &SessionEntry,
) -> (
    TimelineRole,
    Option<String>,
    Option<String>,
    Option<TimelineState>,
) {
    match entry {
        SessionEntry::Message { message, .. } => match message {
            AgentMessage::User(msg) => (
                TimelineRole::User,
                first_content_text(&msg.content),
                None,
                Some(TimelineState::Complete),
            ),
            AgentMessage::Assistant(msg) => (
                TimelineRole::Assistant,
                first_assistant_text(&msg.content),
                None,
                Some(TimelineState::Complete),
            ),
            AgentMessage::ToolResult(msg) => (
                TimelineRole::Tool,
                first_content_text(&msg.content),
                Some(if msg.is_error {
                    format!("Tool {} failed", msg.tool_name)
                } else {
                    format!("Tool {} completed", msg.tool_name)
                }),
                Some(if msg.is_error {
                    TimelineState::Error
                } else {
                    TimelineState::Complete
                }),
            ),
            AgentMessage::BashExecution(msg) => (
                TimelineRole::Tool,
                Some(msg.command.clone()),
                Some("Bash execution".to_string()),
                Some(if msg.cancelled {
                    TimelineState::Error
                } else {
                    TimelineState::Complete
                }),
            ),
            AgentMessage::Custom(msg) => (
                TimelineRole::System,
                first_content_text(&msg.content),
                Some(format!("Custom message: {}", msg.custom_type)),
                Some(TimelineState::Complete),
            ),
            AgentMessage::BranchSummary(msg) => (
                TimelineRole::System,
                Some(msg.summary.clone()),
                Some("Branch summary".to_string()),
                Some(TimelineState::Complete),
            ),
            AgentMessage::CompactionSummary(msg) => (
                TimelineRole::System,
                Some(msg.summary.clone()),
                Some("Compaction summary".to_string()),
                Some(TimelineState::Complete),
            ),
        },
        _ => (
            TimelineRole::System,
            entry_preview(entry),
            None,
            Some(TimelineState::Complete),
        ),
    }
}

pub(super) fn entry_preview(entry: &SessionEntry) -> Option<String> {
    let text = match entry {
        SessionEntry::Message { message, .. } => message_preview(message),
        SessionEntry::Compaction { summary, .. } => Some(summary.clone()),
        SessionEntry::BranchSummary { summary, .. } => Some(summary.clone()),
        SessionEntry::ModelChange {
            provider, model_id, ..
        } => Some(format!("Model changed to {provider}/{model_id}")),
        SessionEntry::ThinkingLevelChange { thinking_level, .. } => {
            Some(format!("Thinking level {}", thinking_level.as_str()))
        }
        SessionEntry::Custom { custom_type, .. } => Some(format!("Custom event: {custom_type}")),
        SessionEntry::CustomMessage { content, .. } => first_content_text(content),
        SessionEntry::SessionInfo { name, .. } => name.clone(),
        SessionEntry::Label { label, .. } => label.clone(),
    }?;

    Some(truncate_preview(&text))
}

fn message_preview(message: &AgentMessage) -> Option<String> {
    match message {
        AgentMessage::User(msg) => first_content_text(&msg.content),
        AgentMessage::Assistant(msg) => first_assistant_text(&msg.content),
        AgentMessage::ToolResult(msg) => first_content_text(&msg.content).or_else(|| {
            Some(if msg.is_error {
                format!("Tool {} failed", msg.tool_name)
            } else {
                format!("Tool {} completed", msg.tool_name)
            })
        }),
        AgentMessage::BashExecution(msg) => Some(format!(
            "bash {}{}",
            if msg.cancelled { "cancelled: " } else { "" },
            msg.command
        )),
        AgentMessage::Custom(msg) => first_content_text(&msg.content)
            .or_else(|| Some(format!("Custom message: {}", msg.custom_type))),
        AgentMessage::BranchSummary(msg) => Some(msg.summary.clone()),
        AgentMessage::CompactionSummary(msg) => Some(msg.summary.clone()),
    }
}

fn first_content_text(content: &[ContentBlock]) -> Option<String> {
    content.iter().find_map(|block| match block {
        ContentBlock::Text { text } => Some(text.clone()),
        ContentBlock::Image { .. } => None,
    })
}

fn first_assistant_text(content: &[AssistantContent]) -> Option<String> {
    content.first().map(|block| match block {
        AssistantContent::Text { text } => text.clone(),
        AssistantContent::Thinking { thinking } => thinking.clone(),
        AssistantContent::ToolCall { name, .. } => format!("Tool call: {name}"),
    })
}

fn truncate_preview(text: &str) -> String {
    const LIMIT: usize = 120;
    let trimmed = text.trim();
    if trimmed.chars().count() <= LIMIT {
        return trimmed.to_string();
    }

    let truncated = trimmed.chars().take(LIMIT - 1).collect::<String>();
    format!("{truncated}...")
}

pub(super) fn client_metadata_from_headers(headers: &HeaderMap) -> ClientMetadata {
    ClientMetadata {
        client_id: header_value(headers, "x-kordi-client-id")
            .unwrap_or_else(|| "anonymous".to_string()),
        client_kind: parse_client_kind(header_value(headers, "x-kordi-client-kind").as_deref()),
        client_name: header_value(headers, "x-kordi-client-name")
            .unwrap_or_else(|| "unknown-client".to_string()),
        protocol_version: APP_PROTOCOL_VERSION.to_string(),
        supports_streaming: header_value(headers, "x-kordi-supports-streaming")
            .as_deref()
            .map(|value| value == "true")
            .unwrap_or(true),
        supports_rich_text: header_value(headers, "x-kordi-supports-rich-text")
            .as_deref()
            .map(|value| value == "true")
            .unwrap_or(true),
    }
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn parse_client_kind(value: Option<&str>) -> ClientKind {
    match value.unwrap_or("desktop") {
        "desktop" => ClientKind::Desktop,
        "tui" => ClientKind::Tui,
        "automation" => ClientKind::Automation,
        "test" => ClientKind::Test,
        _ => ClientKind::Desktop,
    }
}

pub(super) fn workspace_root_name(cwd: &Path) -> String {
    cwd.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| cwd.display().to_string())
}
