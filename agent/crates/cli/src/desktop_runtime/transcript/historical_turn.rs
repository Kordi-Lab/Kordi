use std::collections::HashMap;

use super::super::{DesktopChatMessage, DesktopChatStoredTool, format_message_timestamp};

#[derive(Default)]
pub(super) struct HistoricalTurnBuilder {
    pub(super) assistant_text_parts: Vec<String>,
    pub(super) thinking_parts: Vec<String>,
    pub(super) tools: Vec<DesktopChatStoredTool>,
    pub(super) tool_index_by_id: HashMap<String, usize>,
    pub(super) detail: Option<String>,
    pub(super) error_message: Option<String>,
    pub(super) failed: bool,
    pub(super) cancelled: bool,
    pub(super) awaiting_final_response: bool,
    pub(super) timestamp_ms: i64,
    /// Last entry id observed while building this turn. Used as the
    /// fork target when the user clicks the aggregated assistant
    /// bubble — fork-at semantics include this entry in the fork.
    pub(super) last_entry_id: Option<String>,
}

impl HistoricalTurnBuilder {
    pub(super) fn is_empty(&self) -> bool {
        self.assistant_text_parts.is_empty()
            && self.thinking_parts.is_empty()
            && self.tools.is_empty()
            && self.error_message.is_none()
            && !self.cancelled
    }

    pub(super) fn touch_timestamp(&mut self, timestamp_ms: i64) {
        self.timestamp_ms = self.timestamp_ms.max(timestamp_ms);
    }
}

pub(super) fn flush_historical_turn(
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
    let interrupted = !turn.cancelled && turn.awaiting_final_response;
    let failed = turn.failed || interrupted;
    let visible_text = if interrupted {
        "Background task interrupted before producing a final result.".to_string()
    } else if assistant_text.trim().is_empty() && failed {
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
        failed,
        cancelled: turn.cancelled,
        attachments: Vec::new(),
        thinking_text: (!thinking_text.trim().is_empty()).then_some(thinking_text),
        tools: turn.tools,
        entry_id: turn.last_entry_id,
    });
}

pub(super) fn tool_detail_label(details: &Option<serde_json::Value>) -> Option<String> {
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

pub(super) fn tool_artifact_path(details: &Option<serde_json::Value>) -> Option<String> {
    let details = details.as_ref()?;
    details
        .get("artifactPath")
        .or_else(|| details.get("artifact_path"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub(super) fn tool_layer(details: &Option<serde_json::Value>) -> Option<String> {
    let details = details.as_ref()?;
    details
        .get("toolLayer")
        .or_else(|| details.get("tool_layer"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}
