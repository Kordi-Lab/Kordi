use base64::Engine as _;

use super::constants::{
    is_agent_like_runtime, BRIDGE_DELIVERY_STATE_RESPONDED, BRIDGE_MESSAGE_DIRECTION_OUTBOUND,
    PEER_TYPING_WINDOW_MS,
};
use super::{
    bridge_conversation_id, format_time_label, format_time_label_with_seconds, now_ms,
    DesktopBridgeConversation, DesktopBridgeConversationMessage, DesktopBridgeConversationRecord,
    DesktopBridgeConversationStore,
};

fn is_person_runtime(runtime: &str) -> bool {
    runtime.trim().eq_ignore_ascii_case("person")
}

fn scoped_conversation_id(
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<&str>,
    peer_runtime: &str,
) -> String {
    let base = bridge_conversation_id(host_id, peer_node_id, project_id);
    if is_person_runtime(peer_runtime) {
        format!("{base}:person")
    } else {
        base
    }
}

fn conversation_matches(
    conversation: &DesktopBridgeConversationRecord,
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<&str>,
    peer_runtime: Option<&str>,
) -> bool {
    conversation.host_id == host_id
        && conversation.peer_node_id == peer_node_id
        && conversation.project_id.as_deref() == project_id
        && peer_runtime
            .map(|runtime| {
                is_person_runtime(&conversation.peer_runtime) == is_person_runtime(runtime)
            })
            .unwrap_or(true)
}

pub(super) fn upsert_bridge_conversation<'a>(
    store: &'a mut DesktopBridgeConversationStore,
    host_id: &str,
    peer_node_id: &str,
    peer_display_name: Option<String>,
    peer_owner_name: Option<String>,
    peer_runtime: String,
    project_id: Option<String>,
    project_name: Option<String>,
) -> &'a mut DesktopBridgeConversationRecord {
    let conversation_id =
        scoped_conversation_id(host_id, peer_node_id, project_id.as_deref(), &peer_runtime);
    let maybe_index = store.conversations.iter().position(|conversation| {
        conversation.id == conversation_id
            || conversation_matches(
                conversation,
                host_id,
                peer_node_id,
                project_id.as_deref(),
                Some(&peer_runtime),
            )
    });
    let index = if let Some(index) = maybe_index {
        index
    } else {
        store.conversations.push(DesktopBridgeConversationRecord {
            id: conversation_id,
            host_id: host_id.to_string(),
            peer_node_id: peer_node_id.to_string(),
            peer_display_name: peer_display_name.clone(),
            peer_owner_name: peer_owner_name.clone(),
            peer_runtime: peer_runtime.clone(),
            project_id: project_id.clone(),
            project_name: project_name.clone(),
            unread_count: 0,
            updated_at_ms: now_ms(),
            peer_last_typing_at_ms: None,
            peer_last_heartbeat_at_ms: None,
            outreach: None,
            identity: None,
            messages: Vec::new(),
        });
        store.conversations.len() - 1
    };

    let conversation = &mut store.conversations[index];
    if peer_display_name.is_some() {
        conversation.peer_display_name = peer_display_name;
    }
    if peer_owner_name.is_some() {
        conversation.peer_owner_name = peer_owner_name;
    }
    if !peer_runtime.trim().is_empty() {
        conversation.peer_runtime = peer_runtime;
    }
    if project_id.is_some() {
        conversation.project_id = project_id;
    }
    if project_name.is_some() {
        conversation.project_name = project_name;
    }
    conversation
}

pub(super) fn parse_mailbox_payload(blob: &str) -> Option<serde_json::Value> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(blob)
        .ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn labels_match(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

pub(super) fn conversation_title(record: &DesktopBridgeConversationRecord) -> String {
    if record.peer_runtime.trim().eq_ignore_ascii_case("person") {
        return record
            .peer_owner_name
            .clone()
            .or_else(|| record.peer_display_name.clone())
            .unwrap_or_else(|| record.peer_node_id.clone());
    }

    if is_agent_like_runtime(&record.peer_runtime) {
        let owner = record
            .peer_owner_name
            .clone()
            .filter(|value| !value.trim().is_empty());
        let agent = record
            .peer_display_name
            .clone()
            .filter(|value| !value.trim().is_empty());

        return match (owner, agent) {
            (Some(owner), Some(agent)) if labels_match(&owner, &agent) => owner,
            (_owner, Some(agent)) => agent,
            (Some(owner), None) => owner,
            (None, None) => record.peer_node_id.clone(),
        };
    }

    record
        .peer_display_name
        .clone()
        .or_else(|| record.peer_owner_name.clone())
        .unwrap_or_else(|| record.peer_node_id.clone())
}

pub(super) fn build_conversation_state(
    record: &DesktopBridgeConversationRecord,
) -> DesktopBridgeConversation {
    let messages: Vec<DesktopBridgeConversationMessage> = record
        .messages
        .iter()
        .map(|message| DesktopBridgeConversationMessage {
            id: message.id.clone(),
            direction: message.direction.clone(),
            sender: message.sender.clone(),
            text: message.text.clone(),
            time_label: format_time_label(message.timestamp_ms),
            timestamp_ms: message.timestamp_ms,
            delivery_state: message.delivery_state.clone(),
        })
        .collect();
    let subtitle = messages
        .last()
        .map(|message| message.text.clone())
        .unwrap_or_default();
    let awaiting_reply = record
        .messages
        .iter()
        .rev()
        .find(|message| message.direction == BRIDGE_MESSAGE_DIRECTION_OUTBOUND)
        .and_then(|message| message.delivery_state.clone())
        .map(|state| state != BRIDGE_DELIVERY_STATE_RESPONDED)
        .unwrap_or(false);
    let peer_typing = record
        .peer_last_typing_at_ms
        .map(|timestamp| now_ms().saturating_sub(timestamp) <= PEER_TYPING_WINDOW_MS)
        .unwrap_or(false);
    let peer_last_heartbeat_label = record
        .peer_last_heartbeat_at_ms
        .map(format_time_label_with_seconds);
    DesktopBridgeConversation {
        id: record.id.clone(),
        host_id: record.host_id.clone(),
        peer_node_id: record.peer_node_id.clone(),
        peer_display_name: record.peer_display_name.clone(),
        peer_owner_name: record.peer_owner_name.clone(),
        peer_runtime: record.peer_runtime.clone(),
        project_id: record.project_id.clone(),
        project_name: record.project_name.clone(),
        title: conversation_title(record),
        subtitle,
        unread_count: record.unread_count,
        updated_at_ms: record.updated_at_ms,
        updated_at_label: format_time_label(record.updated_at_ms),
        awaiting_reply,
        peer_typing,
        peer_last_heartbeat_label,
        outreach: record.outreach.clone(),
        identity: record.identity.clone(),
        messages,
    }
}
