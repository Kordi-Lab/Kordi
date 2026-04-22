use base64::Engine as _;
use uuid::Uuid;

use super::constants::{
    BRIDGE_DELIVERY_STATE_RESPONDED, BRIDGE_MESSAGE_ID_PREFIX, DEFAULT_BRIDGE_RUNTIME,
    PEER_TYPING_WINDOW_MS,
};
use super::{
    bridge_conversation_id, format_time_label, format_time_label_with_seconds, now_ms,
    DesktopBridgeConversation, DesktopBridgeConversationMessage,
    DesktopBridgeConversationMessageRecord, DesktopBridgeConversationRecord,
    DesktopBridgeConversationStore,
};

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
    let conversation_id = bridge_conversation_id(host_id, peer_node_id, project_id.as_deref());
    let maybe_index = store
        .conversations
        .iter()
        .position(|conversation| conversation.id == conversation_id);
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

pub(super) fn append_conversation_message(
    store: &mut DesktopBridgeConversationStore,
    host_id: &str,
    peer_node_id: &str,
    peer_display_name: Option<String>,
    peer_owner_name: Option<String>,
    peer_runtime: String,
    project_id: Option<String>,
    project_name: Option<String>,
    direction: &str,
    sender: Option<String>,
    text: String,
    request_id: Option<String>,
    delivery_state: Option<String>,
    increment_unread: bool,
) {
    let timestamp_ms = now_ms();
    let conversation = upsert_bridge_conversation(
        store,
        host_id,
        peer_node_id,
        peer_display_name,
        peer_owner_name,
        peer_runtime,
        project_id,
        project_name,
    );
    conversation.updated_at_ms = timestamp_ms;
    if direction == "inbound" || direction == "inbound-response" {
        conversation.peer_last_typing_at_ms = None;
    }
    if increment_unread {
        conversation.unread_count += 1;
    }
    conversation
        .messages
        .push(DesktopBridgeConversationMessageRecord {
            id: format!("{}{}", BRIDGE_MESSAGE_ID_PREFIX, Uuid::new_v4().simple()),
            direction: direction.to_string(),
            sender,
            text,
            timestamp_ms,
            request_id,
            delivery_state,
        });
}

pub(super) fn update_message_delivery_state(
    store: &mut DesktopBridgeConversationStore,
    request_id: &str,
    delivery_state: &str,
) {
    for conversation in &mut store.conversations {
        if let Some(message) = conversation
            .messages
            .iter_mut()
            .find(|message| message.request_id.as_deref() == Some(request_id))
        {
            message.delivery_state = Some(delivery_state.to_string());
            conversation.updated_at_ms = now_ms();
            break;
        }
    }
}

pub(super) fn note_peer_typing(
    store: &mut DesktopBridgeConversationStore,
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<String>,
    project_name: Option<String>,
) {
    let conversation = upsert_bridge_conversation(
        store,
        host_id,
        peer_node_id,
        None,
        None,
        DEFAULT_BRIDGE_RUNTIME.to_string(),
        project_id,
        project_name,
    );
    conversation.peer_last_typing_at_ms = Some(now_ms());
}

pub(super) fn note_peer_heartbeat(
    store: &mut DesktopBridgeConversationStore,
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<String>,
    project_name: Option<String>,
) {
    let conversation = upsert_bridge_conversation(
        store,
        host_id,
        peer_node_id,
        None,
        None,
        DEFAULT_BRIDGE_RUNTIME.to_string(),
        project_id,
        project_name,
    );
    conversation.peer_last_heartbeat_at_ms = Some(now_ms());
}

pub(super) fn parse_mailbox_payload(blob: &str) -> Option<serde_json::Value> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(blob)
        .ok()?;
    serde_json::from_slice(&decoded).ok()
}

pub(super) fn conversation_title(record: &DesktopBridgeConversationRecord) -> String {
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
        .find(|message| message.direction == "outbound")
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
        messages,
    }
}
