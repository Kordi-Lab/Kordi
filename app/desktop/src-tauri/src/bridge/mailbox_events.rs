use serde_json::Value;

use super::constants::is_agent_like_runtime;
use super::events::{mailbox_payload_text, parse_bridge_event_payload, ParsedMailboxEvent};
use super::{decrypt_bridge_payload_for_host, parse_mailbox_payload, DesktopBridgeHostConfig};

pub(super) fn parse_mailbox_event(
    host: &DesktopBridgeHostConfig,
    item: &Value,
) -> Option<ParsedMailboxEvent> {
    let blob = item
        .get("blob")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if blob.trim().is_empty() {
        return None;
    }

    let mut parsed = decrypt_bridge_payload_for_host(host, parse_mailbox_payload(blob)?).ok()?;
    if parsed.get("from").is_none() {
        if let Some(from) = item.get("from") {
            parsed["from"] = from.clone();
        }
    }
    parse_bridge_event_payload(&parsed)
}

pub(super) fn bridge_response_is_done(event: &ParsedMailboxEvent) -> bool {
    event
        .payload
        .get("done")
        .and_then(|value| value.as_bool())
        .unwrap_or(true)
}

pub(super) fn is_processing_placeholder_text(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.eq_ignore_ascii_case("processing")
        || trimmed.eq_ignore_ascii_case("processing...")
        || trimmed.eq_ignore_ascii_case("processing…")
}

pub(super) fn should_buffer_partial_agent_response(event: &ParsedMailboxEvent) -> bool {
    if bridge_response_is_done(event) {
        return false;
    }
    if !is_agent_like_runtime(event.from_runtime.as_deref().unwrap_or_default()) {
        return false;
    }

    let text = mailbox_payload_text(&event.payload);
    let normalized = text.trim();
    if event_targets_group_session(event) && is_processing_placeholder_text(normalized) {
        return false;
    }
    if normalized.is_empty() {
        return true;
    }

    let word_count = normalized.split_whitespace().take(5).count();
    normalized.chars().count() < 24 && word_count <= 3
}

pub(super) fn event_session_thread(event: &ParsedMailboxEvent) -> Option<&Value> {
    event.payload.get("sessionThread")
}

pub(super) fn event_session_thread_target_kind(event: &ParsedMailboxEvent) -> Option<&str> {
    event_session_thread(event)
        .and_then(|thread| thread.get("targetKind"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub(super) fn event_session_thread_has_parent_turn(event: &ParsedMailboxEvent) -> bool {
    event_session_thread(event)
        .and_then(|thread| thread.get("parentTurnId"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
}

pub(super) fn event_targets_group_session(event: &ParsedMailboxEvent) -> bool {
    let Some(thread) = event_session_thread(event) else {
        return false;
    };
    thread
        .get("parentSessionKind")
        .and_then(|value| value.as_str())
        .is_some_and(|kind| kind.eq_ignore_ascii_case("group"))
        || thread
            .get("parentGroupSpaceId")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
}

pub(super) fn group_session_thread_relay_targets(
    event: &ParsedMailboxEvent,
    local_node_id: &str,
    local_owner_node_id: Option<&str>,
    requester_node_id: &str,
) -> Vec<String> {
    if !event_targets_group_session(event) {
        return Vec::new();
    }
    let local_node_id = local_node_id.trim();
    let local_owner_node_id = local_owner_node_id.map(str::trim).unwrap_or("");
    let requester_node_id = requester_node_id.trim();
    let mut targets = Vec::new();
    if let Some(participants) = event_session_thread(event)
        .and_then(|thread| thread.get("participants"))
        .and_then(|value| value.as_array())
    {
        for participant in participants {
            let Some(node_id) = participant
                .get("bridgeNodeId")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            if node_id == local_node_id
                || node_id == local_owner_node_id
                || node_id == requester_node_id
            {
                continue;
            }
            if !targets.iter().any(|existing| existing == node_id) {
                targets.push(node_id.to_string());
            }
        }
    }
    targets
}

pub(super) fn bridge_response_payload(
    event: &ParsedMailboxEvent,
    message: &str,
    done: bool,
) -> Value {
    let mut payload = serde_json::json!({ "message": message, "done": done });
    if let Some(thread) = event_session_thread(event) {
        payload["sessionThread"] = thread.clone();
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn processing_placeholder_text_accepts_unicode_ellipsis() {
        assert!(is_processing_placeholder_text("processing…"));
    }
}
