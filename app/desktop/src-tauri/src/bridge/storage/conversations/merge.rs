use super::outreach_metadata::reconcile_message_outreach_metadata;
use crate::bridge::{DesktopBridgeConversationMessageRecord, DesktopBridgeConversationRecord};

pub(in crate::bridge::storage) fn delivery_state_rank(value: Option<&str>) -> i32 {
    match value.unwrap_or_default().trim().to_lowercase().as_str() {
        "sending" | "pending_send" => 0,
        "sent" => 1,
        "delivered" => 2,
        "processing" | "handed_off_direct" | "handed_off_mailbox" => 3,
        "read" => 4,
        "responded" | "processing_failed" => 5,
        "cancelled" => 6,
        _ => 0,
    }
}

pub(in crate::bridge::storage) fn merge_conversation_message_records(
    existing: &DesktopBridgeConversationMessageRecord,
    incoming: &DesktopBridgeConversationMessageRecord,
) -> DesktopBridgeConversationMessageRecord {
    let newer = if incoming.timestamp_ms >= existing.timestamp_ms {
        incoming
    } else {
        existing
    };
    let older = if std::ptr::eq(newer, incoming) {
        existing
    } else {
        incoming
    };

    let text = if newer.text.trim().is_empty() {
        older.text.clone()
    } else {
        newer.text.clone()
    };
    let timestamp_ms = newer.timestamp_ms.max(older.timestamp_ms);
    let delivery_state = if delivery_state_rank(newer.delivery_state.as_deref())
        >= delivery_state_rank(older.delivery_state.as_deref())
    {
        newer
            .delivery_state
            .clone()
            .or_else(|| older.delivery_state.clone())
    } else {
        older
            .delivery_state
            .clone()
            .or_else(|| newer.delivery_state.clone())
    };
    let mut outreach = newer.outreach.clone().or_else(|| older.outreach.clone());
    if let Some(outreach) = outreach.as_mut() {
        reconcile_message_outreach_metadata(
            outreach,
            delivery_state.as_deref(),
            Some(&text),
            Some(&older.text),
            timestamp_ms,
        );
    }

    DesktopBridgeConversationMessageRecord {
        id: newer.id.clone(),
        direction: newer.direction.clone(),
        sender: newer.sender.clone().or_else(|| older.sender.clone()),
        text,
        timestamp_ms,
        request_id: newer
            .request_id
            .clone()
            .or_else(|| older.request_id.clone()),
        delivery_state,
        outreach,
    }
}

pub(in crate::bridge::storage) fn merge_conversation_records(
    existing: &DesktopBridgeConversationRecord,
    incoming: &DesktopBridgeConversationRecord,
) -> DesktopBridgeConversationRecord {
    let incoming_is_newer = incoming.updated_at_ms >= existing.updated_at_ms;
    let newer = if incoming_is_newer {
        incoming
    } else {
        existing
    };
    let older = if incoming_is_newer {
        existing
    } else {
        incoming
    };

    let mut messages_by_key =
        std::collections::BTreeMap::<String, DesktopBridgeConversationMessageRecord>::new();
    for message in existing.messages.iter().chain(incoming.messages.iter()) {
        let key = message
            .request_id
            .as_ref()
            .map(|request_id| format!("{}:{request_id}", message.direction))
            .unwrap_or_else(|| format!("id:{}", message.id));
        messages_by_key
            .entry(key)
            .and_modify(|current| {
                *current = merge_conversation_message_records(current, message);
            })
            .or_insert_with(|| message.clone());
    }
    let mut messages: Vec<_> = messages_by_key.into_values().collect();
    for message in &mut messages {
        if let Some(outreach) = message.outreach.as_mut() {
            reconcile_message_outreach_metadata(
                outreach,
                message.delivery_state.as_deref(),
                Some(&message.text),
                None,
                message.timestamp_ms,
            );
        }
    }
    messages.sort_by(|a, b| {
        a.timestamp_ms
            .cmp(&b.timestamp_ms)
            .then_with(|| a.id.cmp(&b.id))
    });

    DesktopBridgeConversationRecord {
        id: newer.id.clone(),
        host_id: newer.host_id.clone(),
        peer_node_id: newer.peer_node_id.clone(),
        peer_display_name: newer
            .peer_display_name
            .clone()
            .or_else(|| older.peer_display_name.clone()),
        peer_owner_name: newer
            .peer_owner_name
            .clone()
            .or_else(|| older.peer_owner_name.clone()),
        peer_runtime: if newer.peer_runtime.trim().is_empty() {
            older.peer_runtime.clone()
        } else {
            newer.peer_runtime.clone()
        },
        project_id: newer
            .project_id
            .clone()
            .or_else(|| older.project_id.clone()),
        project_name: newer
            .project_name
            .clone()
            .or_else(|| older.project_name.clone()),
        unread_count: if incoming_is_newer {
            incoming.unread_count
        } else {
            existing.unread_count
        },
        updated_at_ms: newer.updated_at_ms.max(older.updated_at_ms),
        peer_last_typing_at_ms: if incoming_is_newer {
            incoming.peer_last_typing_at_ms
        } else {
            existing.peer_last_typing_at_ms
        },
        peer_last_heartbeat_at_ms: newer
            .peer_last_heartbeat_at_ms
            .or(older.peer_last_heartbeat_at_ms),
        outreach: newer.outreach.clone().or_else(|| older.outreach.clone()),
        identity: newer.identity.clone().or_else(|| older.identity.clone()),
        messages,
    }
}
