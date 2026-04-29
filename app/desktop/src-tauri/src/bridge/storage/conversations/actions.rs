use rusqlite::{params, OptionalExtension, TransactionBehavior};
use uuid::Uuid;

use super::super::config::now_ms;
use super::lookup::{
    apply_conversation_metadata, find_conversation_for_peer, find_recent_conversation_for_peer,
    scoped_conversation_id,
};
use super::merge::delivery_state_rank;
use super::outreach_metadata::{
    reconcile_conversation_outreach_delivery_state, reconcile_message_outreach_for_storage,
    reconcile_message_outreach_metadata,
};
use super::records::{
    load_conversation_record, load_conversation_store_from_db, optional_json, parse_optional_json,
    store_conversation_record, upsert_conversation_record,
};
use super::schema::{migrate_legacy_conversation_json, open_conversation_db, sqlite_error};
use crate::bridge::constants::{
    is_inbound_message_direction, BRIDGE_MESSAGE_DIRECTION_INBOUND,
    BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE, BRIDGE_MESSAGE_DIRECTION_OUTBOUND,
    BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE, BRIDGE_MESSAGE_ID_PREFIX,
};
use crate::bridge::{
    DesktopBridgeConversationMessageRecord, DesktopBridgeConversationRecord,
    DesktopBridgeConversationStore, DesktopBridgeIdentitySnapshot, DesktopBridgeMessageAttachment,
    DesktopBridgeOutreachMetadata,
};

pub(in crate::bridge) fn append_conversation_message_to_storage(
    host_id: &str,
    peer_node_id: &str,
    peer_display_name: Option<String>,
    peer_owner_name: Option<String>,
    peer_runtime: String,
    project_id: Option<String>,
    project_name: Option<String>,
    identity: Option<DesktopBridgeIdentitySnapshot>,
    outreach: Option<DesktopBridgeOutreachMetadata>,
    direction: &str,
    sender: Option<String>,
    text: String,
    request_id: Option<String>,
    delivery_state: Option<String>,
    attachments: Vec<DesktopBridgeMessageAttachment>,
    increment_unread: bool,
) -> Result<DesktopBridgeConversationStore, String> {
    let timestamp_ms = now_ms();
    let request_id_for_status = request_id.clone();
    let delivery_state_for_status = delivery_state.clone();
    let text_for_status = text.clone();
    let explicit_message_outreach = outreach.as_ref().map(|outreach| {
        let mut outreach = outreach.clone();
        if outreach.bridge_request_id.is_none() {
            outreach.bridge_request_id = request_id.clone();
        }
        outreach
    });
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;

    let mut conversation = find_conversation_for_peer(
        &tx,
        host_id,
        peer_node_id,
        project_id.as_deref(),
        &peer_runtime,
    )?
    .unwrap_or_else(|| DesktopBridgeConversationRecord {
        id: scoped_conversation_id(host_id, peer_node_id, project_id.as_deref(), &peer_runtime),
        host_id: host_id.to_string(),
        peer_node_id: peer_node_id.to_string(),
        peer_display_name: peer_display_name.clone(),
        peer_owner_name: peer_owner_name.clone(),
        peer_runtime: peer_runtime.clone(),
        project_id: project_id.clone(),
        project_name: project_name.clone(),
        unread_count: 0,
        updated_at_ms: timestamp_ms,
        peer_last_typing_at_ms: None,
        peer_last_heartbeat_at_ms: None,
        outreach: None,
        identity: None,
        messages: Vec::new(),
    });

    apply_conversation_metadata(
        &mut conversation,
        peer_display_name,
        peer_owner_name,
        peer_runtime,
        project_id,
        project_name,
    );
    if let Some(identity) = identity {
        conversation.identity = Some(identity);
    }
    if let Some(mut outreach) = outreach {
        if outreach.bridge_conversation_id.is_none() {
            outreach.bridge_conversation_id = Some(conversation.id.clone());
        }
        if outreach.bridge_request_id.is_none() {
            outreach.bridge_request_id = request_id.clone();
        }
        conversation.outreach = Some(outreach);
    }
    let message_outreach = explicit_message_outreach.or_else(|| {
        let incoming_request_id = request_id.as_deref()?;
        let mut outreach = conversation.outreach.clone()?;
        if outreach.bridge_request_id.as_deref() != Some(incoming_request_id) {
            return None;
        }
        if outreach.bridge_conversation_id.is_none() {
            outreach.bridge_conversation_id = Some(conversation.id.clone());
        }
        Some(outreach)
    });
    conversation.updated_at_ms = timestamp_ms;
    if is_inbound_message_direction(direction) {
        conversation.peer_last_typing_at_ms = None;
    }

    let request_was_cancelled = request_id.as_deref().is_some_and(|incoming_request_id| {
        conversation.messages.iter().any(|message| {
            message.request_id.as_deref() == Some(incoming_request_id)
                && message.delivery_state.as_deref() == Some("cancelled")
        })
    });
    if request_was_cancelled
        && matches!(
            direction,
            BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE | BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE
        )
        && delivery_state.as_deref() != Some("cancelled")
    {
        upsert_conversation_record(&tx, &conversation)?;
        tx.commit().map_err(sqlite_error)?;
        return load_conversation_store_from_db(&conn);
    }

    let existing_message = request_id.as_deref().and_then(|existing_request_id| {
        conversation.messages.iter().position(|message| {
            message.request_id.as_deref() == Some(existing_request_id)
                && message.direction == direction
        })
    });

    let conversation_id_for_message = conversation.id.clone();
    if let Some(index) = existing_message {
        let message = &mut conversation.messages[index];
        let should_apply_update = delivery_state
            .as_deref()
            .map(|next| {
                delivery_state_rank(Some(next))
                    >= delivery_state_rank(message.delivery_state.as_deref())
            })
            .unwrap_or(true);
        if should_apply_update {
            let previous_text = message.text.clone();
            message.sender = sender.or_else(|| message.sender.clone());
            message.text = text;
            message.timestamp_ms = timestamp_ms;
            if let Some(delivery_state) = delivery_state {
                message.delivery_state = Some(delivery_state);
            }
            if message.outreach.is_none() {
                message.outreach = message_outreach.clone();
            }
            if !attachments.is_empty() {
                message.attachments = attachments;
            }
            if let Some(outreach) = message.outreach.as_mut() {
                reconcile_message_outreach_for_storage(
                    outreach,
                    &conversation_id_for_message,
                    message.request_id.as_deref(),
                    message.delivery_state.as_deref(),
                    &message.text,
                    Some(&previous_text),
                    timestamp_ms,
                );
            }
        }
    } else {
        if increment_unread {
            conversation.unread_count += 1;
        }
        let mut outreach = message_outreach;
        if let Some(outreach) = outreach.as_mut() {
            reconcile_message_outreach_for_storage(
                outreach,
                &conversation_id_for_message,
                request_id.as_deref(),
                delivery_state.as_deref(),
                &text,
                None,
                timestamp_ms,
            );
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
                outreach,
                attachments,
            });
    }

    if let Some(outreach) = conversation.outreach.as_mut() {
        let matches_request = outreach
            .bridge_request_id
            .as_deref()
            .is_some_and(|request_id| request_id_for_status.as_deref() == Some(request_id));
        if matches!(
            direction,
            BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE | BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE
        ) && matches_request
        {
            if let Some(delivery_state) = delivery_state_for_status.as_deref() {
                reconcile_conversation_outreach_delivery_state(
                    outreach,
                    delivery_state,
                    Some(&text_for_status),
                    timestamp_ms,
                );
            }
        }

        let person_reply_completed = outreach.target_kind == "bridge-person"
            && matches!(
                direction,
                BRIDGE_MESSAGE_DIRECTION_INBOUND | BRIDGE_MESSAGE_DIRECTION_OUTBOUND
            )
            && !matches_request
            && timestamp_ms >= outreach.created_at_ms.saturating_sub(2_000)
            && !text_for_status.trim().is_empty();
        if person_reply_completed {
            outreach.status = "completed".to_string();
            outreach.updated_at_ms = timestamp_ms;
            outreach.completed_at_ms = Some(timestamp_ms);
            outreach.error = None;
        }
    }

    upsert_conversation_record(&tx, &conversation)?;
    tx.commit().map_err(sqlite_error)?;
    load_conversation_store_from_db(&conn)
}

pub(in crate::bridge) fn update_message_delivery_state_in_storage(
    request_id: &str,
    delivery_state: &str,
) -> Result<DesktopBridgeConversationStore, String> {
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    let now = now_ms();

    let mut statement = tx
        .prepare(
            "SELECT id, conversation_id, delivery_state, text, outreach_metadata FROM bridge_messages\n             WHERE request_id = ?1",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(params![request_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                parse_optional_json(row.get::<_, Option<String>>(4)?)?,
            ))
        })
        .map_err(sqlite_error)?;

    let mut updates = Vec::new();
    for row in rows {
        let (message_id, conversation_id, current_state, text, outreach) =
            row.map_err(sqlite_error)?;
        if delivery_state_rank(Some(delivery_state))
            >= delivery_state_rank(current_state.as_deref())
        {
            updates.push((message_id, conversation_id, text, outreach));
        }
    }
    drop(statement);

    for (message_id, conversation_id, text, mut outreach) in updates {
        if let Some(outreach) = outreach.as_mut() {
            reconcile_message_outreach_metadata(
                outreach,
                Some(delivery_state),
                Some(&text),
                None,
                now,
            );
        }
        let outreach_metadata = optional_json(&outreach)?;
        tx.execute(
            "UPDATE bridge_messages SET delivery_state = ?1, outreach_metadata = ?2 WHERE id = ?3",
            params![delivery_state, outreach_metadata, message_id],
        )
        .map_err(sqlite_error)?;

        let mut conversation = load_conversation_record(&tx, &conversation_id)?;
        if let Some(conversation) = conversation.as_mut() {
            conversation.updated_at_ms = now;
            conversation.peer_last_typing_at_ms = match delivery_state {
                "processing" => Some(now),
                "responded" | "processing_failed" | "cancelled" => None,
                _ => conversation.peer_last_typing_at_ms,
            };
            if let Some(outreach) = conversation.outreach.as_mut() {
                if outreach.bridge_request_id.as_deref() == Some(request_id) {
                    reconcile_conversation_outreach_delivery_state(
                        outreach,
                        delivery_state,
                        Some(&text),
                        now,
                    );
                }
            }
            store_conversation_record(&tx, conversation)?;
        } else {
            tx.execute(
                "UPDATE bridge_conversations\n                 SET updated_at_ms = ?1\n                 WHERE id = ?2",
                params![now, conversation_id],
            )
            .map_err(sqlite_error)?;
        }
    }

    tx.commit().map_err(sqlite_error)?;
    load_conversation_store_from_db(&conn)
}

pub(in crate::bridge) fn bridge_request_is_cancelled(request_id: &str) -> bool {
    let Ok(mut conn) = open_conversation_db() else {
        return false;
    };
    if migrate_legacy_conversation_json(&mut conn).is_err() {
        return false;
    }
    conn.query_row(
        "SELECT 1 FROM bridge_messages WHERE request_id = ?1 AND delivery_state = 'cancelled' LIMIT 1",
        params![request_id],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

pub(in crate::bridge::storage) fn update_peer_presence_metadata_in_storage(
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<String>,
    project_name: Option<String>,
    typing_at_ms: Option<Option<i64>>,
    heartbeat_at_ms: Option<i64>,
) -> Result<DesktopBridgeConversationStore, String> {
    let timestamp_ms = now_ms();
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    let Some(mut conversation) =
        find_recent_conversation_for_peer(&tx, host_id, peer_node_id, project_id.as_deref())?
    else {
        tx.commit().map_err(sqlite_error)?;
        return load_conversation_store_from_db(&conn);
    };
    if project_id.is_some() {
        conversation.project_id = project_id;
    }
    if project_name.is_some() {
        conversation.project_name = project_name;
    }
    if let Some(typing_at_ms) = typing_at_ms {
        conversation.peer_last_typing_at_ms = typing_at_ms;
    }
    if let Some(heartbeat_at_ms) = heartbeat_at_ms {
        conversation.peer_last_heartbeat_at_ms = Some(heartbeat_at_ms);
    }
    conversation.updated_at_ms = timestamp_ms;
    store_conversation_record(&tx, &conversation)?;
    tx.commit().map_err(sqlite_error)?;
    load_conversation_store_from_db(&conn)
}

pub(in crate::bridge) fn note_peer_typing_in_storage(
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<String>,
    project_name: Option<String>,
) -> Result<DesktopBridgeConversationStore, String> {
    update_peer_presence_metadata_in_storage(
        host_id,
        peer_node_id,
        project_id,
        project_name,
        Some(Some(now_ms())),
        None,
    )
}

pub(in crate::bridge) fn note_peer_heartbeat_in_storage(
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<String>,
    project_name: Option<String>,
) -> Result<DesktopBridgeConversationStore, String> {
    update_peer_presence_metadata_in_storage(
        host_id,
        peer_node_id,
        project_id,
        project_name,
        None,
        Some(now_ms()),
    )
}

pub(in crate::bridge) fn mark_bridge_conversation_read_in_storage(
    conversation_id: &str,
) -> Result<DesktopBridgeConversationStore, String> {
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    tx.execute(
        "UPDATE bridge_conversations SET unread_count = 0, updated_at_ms = ?1 WHERE id = ?2",
        params![now_ms(), conversation_id],
    )
    .map_err(sqlite_error)?;
    tx.commit().map_err(sqlite_error)?;
    load_conversation_store_from_db(&conn)
}

pub(in crate::bridge) fn load_conversation_store() -> DesktopBridgeConversationStore {
    let mut conn = match open_conversation_db() {
        Ok(conn) => conn,
        Err(error) => {
            eprintln!("Unable to open desktop bridge conversation SQLite store: {error}");
            return DesktopBridgeConversationStore::default();
        }
    };
    if let Err(error) = migrate_legacy_conversation_json(&mut conn) {
        eprintln!("Unable to migrate desktop bridge conversation JSON store: {error}");
    }
    load_conversation_store_from_db(&conn).unwrap_or_else(|error| {
        eprintln!("Unable to load desktop bridge conversations from SQLite: {error}");
        DesktopBridgeConversationStore::default()
    })
}

pub(in crate::bridge) fn save_conversation_store(
    store: &DesktopBridgeConversationStore,
) -> Result<(), String> {
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    for conversation in &store.conversations {
        upsert_conversation_record(&tx, conversation)?;
    }
    tx.commit().map_err(sqlite_error)?;
    Ok(())
}

pub(in crate::bridge) fn delete_conversations_for_host(host_id: &str) -> Result<(), String> {
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    tx.execute(
        "DELETE FROM bridge_conversations WHERE host_id = ?1",
        params![host_id],
    )
    .map_err(sqlite_error)?;
    tx.commit().map_err(sqlite_error)?;
    Ok(())
}
