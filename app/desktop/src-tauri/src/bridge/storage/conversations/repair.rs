use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::lookup::scoped_conversation_id;
use super::merge::merge_conversation_message_records;
use super::outreach_metadata::reconcile_message_outreach_for_storage;
use super::records::{
    load_conversation_record, load_conversation_store_from_db, store_conversation_record,
    store_message_record,
};
use super::schema::sqlite_error;
use crate::bridge::constants::{
    BRIDGE_MESSAGE_DIRECTION_INBOUND, BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE,
    BRIDGE_MESSAGE_DIRECTION_OUTBOUND, BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
};
use crate::bridge::{DesktopBridgeConversationMessageRecord, DesktopBridgeConversationRecord};

const BRIDGE_PERSON_SESSION_RELAY_REPAIR_KEY: &str = "bridge_person_session_relay_repaired_v1";

#[derive(Debug, Clone)]
struct RepairMove {
    source_conversation_id: String,
    target_conversation_id: String,
    source_message_id: String,
    message: DesktopBridgeConversationMessageRecord,
}

fn is_session_policy(value: Option<&str>) -> bool {
    value.map(str::trim).is_some_and(|policy| {
        policy.eq_ignore_ascii_case("session-relay")
            || policy.eq_ignore_ascii_case("session-message")
    })
}

fn has_text(value: Option<&str>) -> bool {
    value.map(str::trim).is_some_and(|value| !value.is_empty())
}

fn response_direction(direction: &str) -> Option<&'static str> {
    match direction {
        BRIDGE_MESSAGE_DIRECTION_INBOUND | BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE => {
            Some(BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE)
        }
        BRIDGE_MESSAGE_DIRECTION_OUTBOUND | BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE => {
            Some(BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE)
        }
        _ => None,
    }
}

fn should_repair_message(message: &DesktopBridgeConversationMessageRecord) -> bool {
    let Some(outreach) = message.outreach.as_ref() else {
        return false;
    };
    outreach
        .target_kind
        .trim()
        .eq_ignore_ascii_case("bridge-person")
        && is_session_policy(outreach.context_policy.as_deref())
        && has_text(outreach.parent_session_id.as_deref())
        && (has_text(outreach.parent_turn_id.as_deref())
            || matches!(
                message.direction.as_str(),
                BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE
                    | BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE
            ))
        && response_direction(&message.direction).is_some()
}

fn target_person_conversation_id(conversation: &DesktopBridgeConversationRecord) -> String {
    scoped_conversation_id(
        &conversation.host_id,
        &conversation.peer_node_id,
        conversation.project_id.as_deref(),
        "person",
    )
}

fn normalize_message_for_target(
    mut message: DesktopBridgeConversationMessageRecord,
    target_conversation_id: &str,
) -> Option<DesktopBridgeConversationMessageRecord> {
    message.direction = response_direction(&message.direction)?.to_string();
    if let Some(outreach) = message.outreach.as_mut() {
        outreach.bridge_conversation_id = Some(target_conversation_id.to_string());
        if outreach.bridge_request_id.is_none() {
            outreach.bridge_request_id = message.request_id.clone();
        }
        reconcile_message_outreach_for_storage(
            outreach,
            target_conversation_id,
            message.request_id.as_deref(),
            message.delivery_state.as_deref(),
            &message.text,
            None,
            message.timestamp_ms,
        );
    }
    Some(message)
}

fn collect_repair_moves(conversations: &[DesktopBridgeConversationRecord]) -> Vec<RepairMove> {
    let mut moves = Vec::new();
    for conversation in conversations {
        let target_conversation_id = target_person_conversation_id(conversation);
        for message in &conversation.messages {
            if !should_repair_message(message) {
                continue;
            }
            let Some(normalized_message) =
                normalize_message_for_target(message.clone(), &target_conversation_id)
            else {
                continue;
            };
            let already_repaired = conversation.id == target_conversation_id
                && normalized_message.direction == message.direction
                && normalized_message
                    .outreach
                    .as_ref()
                    .and_then(|outreach| outreach.bridge_conversation_id.as_deref())
                    == Some(target_conversation_id.as_str());
            if already_repaired {
                continue;
            }
            moves.push(RepairMove {
                source_conversation_id: conversation.id.clone(),
                target_conversation_id: target_conversation_id.clone(),
                source_message_id: message.id.clone(),
                message: normalized_message,
            });
        }
    }
    moves
}

fn fallback_person_conversation(
    source: &DesktopBridgeConversationRecord,
    target_conversation_id: &str,
) -> DesktopBridgeConversationRecord {
    DesktopBridgeConversationRecord {
        id: target_conversation_id.to_string(),
        host_id: source.host_id.clone(),
        peer_node_id: source.peer_node_id.clone(),
        peer_display_name: source
            .peer_owner_name
            .clone()
            .or_else(|| source.peer_display_name.clone()),
        peer_owner_name: source.peer_owner_name.clone(),
        peer_runtime: "person".to_string(),
        project_id: source.project_id.clone(),
        project_name: source.project_name.clone(),
        unread_count: 0,
        updated_at_ms: source.updated_at_ms,
        peer_last_typing_at_ms: None,
        peer_last_heartbeat_at_ms: source.peer_last_heartbeat_at_ms,
        outreach: None,
        identity: source.identity.clone(),
        messages: Vec::new(),
    }
}

fn merge_message_into_target(
    target: &mut DesktopBridgeConversationRecord,
    message: DesktopBridgeConversationMessageRecord,
) -> String {
    let stored_message_id = if let Some(existing_index) =
        message.request_id.as_deref().and_then(|request_id| {
            target.messages.iter().position(|existing| {
                existing.request_id.as_deref() == Some(request_id)
                    && existing.direction == message.direction
            })
        }) {
        let mut merged =
            merge_conversation_message_records(&target.messages[existing_index], &message);
        merged.id = target.messages[existing_index].id.clone();
        let stored_message_id = merged.id.clone();
        target.messages[existing_index] = merged;
        stored_message_id
    } else if let Some(existing_index) = target
        .messages
        .iter()
        .position(|existing| existing.id == message.id)
    {
        let merged = merge_conversation_message_records(&target.messages[existing_index], &message);
        let stored_message_id = merged.id.clone();
        target.messages[existing_index] = merged;
        stored_message_id
    } else {
        let stored_message_id = message.id.clone();
        target.messages.push(message);
        stored_message_id
    };

    target.messages.sort_by(|left, right| {
        left.timestamp_ms
            .cmp(&right.timestamp_ms)
            .then_with(|| left.id.cmp(&right.id))
    });
    target.updated_at_ms = target
        .messages
        .iter()
        .map(|message| message.timestamp_ms)
        .max()
        .unwrap_or(target.updated_at_ms)
        .max(target.updated_at_ms);
    stored_message_id
}

fn refresh_conversation_timestamp(conversation: &mut DesktopBridgeConversationRecord) {
    if let Some(updated_at_ms) = conversation
        .messages
        .iter()
        .map(|message| message.timestamp_ms)
        .max()
    {
        conversation.updated_at_ms = updated_at_ms;
    }
}

fn repair_already_applied(conn: &Connection) -> Result<bool, String> {
    conn.query_row(
        "SELECT value FROM bridge_schema_meta WHERE key = ?1",
        params![BRIDGE_PERSON_SESSION_RELAY_REPAIR_KEY],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(sqlite_error)
    .map(|value| value.is_some_and(|value| value == "1"))
}

fn mark_repair_applied(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "INSERT INTO bridge_schema_meta(key, value) VALUES (?1, '1')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![BRIDGE_PERSON_SESSION_RELAY_REPAIR_KEY],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

pub(in crate::bridge::storage) fn repair_split_bridge_person_session_relay_rows(
    conn: &mut Connection,
) -> Result<(), String> {
    if repair_already_applied(conn)? {
        return Ok(());
    }

    let store = load_conversation_store_from_db(conn)?;
    let moves = collect_repair_moves(&store.conversations);
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;

    if moves.is_empty() {
        mark_repair_applied(&tx)?;
        tx.commit().map_err(sqlite_error)?;
        return Ok(());
    }

    for repair_move in moves {
        let Some(mut source) = load_conversation_record(&tx, &repair_move.source_conversation_id)?
        else {
            continue;
        };
        let mut target = if repair_move.source_conversation_id == repair_move.target_conversation_id
        {
            source.clone()
        } else {
            load_conversation_record(&tx, &repair_move.target_conversation_id)?.unwrap_or_else(
                || fallback_person_conversation(&source, &repair_move.target_conversation_id),
            )
        };

        let stored_message_id = merge_message_into_target(&mut target, repair_move.message);
        if repair_move.source_conversation_id == repair_move.target_conversation_id
            && stored_message_id != repair_move.source_message_id
        {
            target
                .messages
                .retain(|message| message.id != repair_move.source_message_id);
        }
        store_conversation_record(&tx, &target)?;
        for message in &target.messages {
            store_message_record(&tx, &target.id, message)?;
        }

        if repair_move.source_conversation_id == repair_move.target_conversation_id {
            if stored_message_id != repair_move.source_message_id {
                tx.execute(
                    "DELETE FROM bridge_messages WHERE id = ?1 AND conversation_id = ?2",
                    params![repair_move.source_message_id, target.id],
                )
                .map_err(sqlite_error)?;
            }
            continue;
        }

        source
            .messages
            .retain(|message| message.id != repair_move.source_message_id);
        refresh_conversation_timestamp(&mut source);
        if let Some(outreach) = source.outreach.as_mut() {
            if outreach
                .target_kind
                .trim()
                .eq_ignore_ascii_case("bridge-person")
                && has_text(outreach.parent_turn_id.as_deref())
                && outreach.bridge_conversation_id.as_deref() == Some(source.id.as_str())
            {
                outreach.bridge_conversation_id = Some(target.id.clone());
            }
        }
        store_conversation_record(&tx, &source)?;
        tx.execute(
            "DELETE FROM bridge_messages WHERE id = ?1 AND conversation_id = ?2",
            params![repair_move.source_message_id, source.id],
        )
        .map_err(sqlite_error)?;
    }

    mark_repair_applied(&tx)?;
    tx.commit().map_err(sqlite_error)?;
    Ok(())
}
