use base64::Engine as _;
use uuid::Uuid;

use super::constants::{
    is_agent_like_runtime, is_inbound_message_direction, BRIDGE_DELIVERY_STATE_RESPONDED,
    BRIDGE_MESSAGE_DIRECTION_OUTBOUND, BRIDGE_MESSAGE_ID_PREFIX, DEFAULT_BRIDGE_RUNTIME,
    PEER_TYPING_WINDOW_MS,
};
use super::{
    bridge_conversation_id, format_time_label, format_time_label_with_seconds, now_ms,
    DesktopBridgeConversation, DesktopBridgeConversationMessage,
    DesktopBridgeConversationMessageRecord, DesktopBridgeConversationRecord,
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
            .map(|runtime| is_person_runtime(&conversation.peer_runtime) == is_person_runtime(runtime))
            .unwrap_or(true)
}

fn existing_runtime_for(
    store: &DesktopBridgeConversationStore,
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<&str>,
    preferred_runtime: Option<&str>,
) -> Option<String> {
    store
        .conversations
        .iter()
        .find(|conversation| {
            conversation_matches(
                conversation,
                host_id,
                peer_node_id,
                project_id,
                preferred_runtime,
            )
        })
        .or_else(|| {
            store.conversations.iter().find(|conversation| {
                conversation_matches(conversation, host_id, peer_node_id, project_id, None)
            })
        })
        .map(|conversation| conversation.peer_runtime.clone())
        .filter(|runtime| !runtime.trim().is_empty())
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
    let conversation_id = scoped_conversation_id(
        host_id,
        peer_node_id,
        project_id.as_deref(),
        &peer_runtime,
    );
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
    if let Some(existing_request_id) = request_id.as_deref() {
        if let Some(existing_message) = conversation.messages.iter_mut().find(|message| {
            message.request_id.as_deref() == Some(existing_request_id)
                && message.direction == direction
        }) {
            existing_message.sender = sender.or_else(|| existing_message.sender.clone());
            existing_message.text = text;
            existing_message.timestamp_ms = timestamp_ms;
            if delivery_state.is_some() {
                existing_message.delivery_state = delivery_state;
            }
            conversation.updated_at_ms = timestamp_ms;
            if is_inbound_message_direction(direction) {
                conversation.peer_last_typing_at_ms = None;
            }
            return;
        }
    }

    conversation.updated_at_ms = timestamp_ms;
    if is_inbound_message_direction(direction) {
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
        let mut updated_any = false;
        for message in &mut conversation.messages {
            if message.request_id.as_deref() == Some(request_id) {
                message.delivery_state = Some(delivery_state.to_string());
                updated_any = true;
            }
        }
        if updated_any {
            conversation.updated_at_ms = now_ms();
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
    let peer_runtime = existing_runtime_for(
        store,
        host_id,
        peer_node_id,
        project_id.as_deref(),
        Some("person"),
    )
    .unwrap_or_else(|| DEFAULT_BRIDGE_RUNTIME.to_string());
    let conversation = upsert_bridge_conversation(
        store,
        host_id,
        peer_node_id,
        None,
        None,
        peer_runtime,
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
    let peer_runtime = existing_runtime_for(
        store,
        host_id,
        peer_node_id,
        project_id.as_deref(),
        Some("person"),
    )
    .unwrap_or_else(|| DEFAULT_BRIDGE_RUNTIME.to_string());
    let conversation = upsert_bridge_conversation(
        store,
        host_id,
        peer_node_id,
        None,
        None,
        peer_runtime,
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
            (Some(owner), Some(agent)) if !labels_match(&owner, &agent) => {
                format!("{owner} · {agent}")
            }
            (Some(owner), Some(_agent)) => owner,
            (Some(owner), None) => owner,
            (None, Some(agent)) => agent,
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
        messages,
    }
}
