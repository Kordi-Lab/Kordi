use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::merge::merge_conversation_message_records;
use super::merge::merge_conversation_records;
use super::schema::sqlite_error;
use crate::bridge::{
    DesktopBridgeConversationMessageRecord, DesktopBridgeConversationRecord,
    DesktopBridgeConversationStore,
};

pub(in crate::bridge::storage) fn load_conversation_messages(
    conn: &Connection,
    conversation_id: &str,
) -> Result<Vec<DesktopBridgeConversationMessageRecord>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, direction, sender, text, timestamp_ms, request_id, delivery_state, outreach_metadata\n             FROM bridge_messages\n             WHERE conversation_id = ?1\n             ORDER BY timestamp_ms ASC, id ASC",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(params![conversation_id], |row| {
            Ok(DesktopBridgeConversationMessageRecord {
                id: row.get(0)?,
                direction: row.get(1)?,
                sender: row.get(2)?,
                text: row.get(3)?,
                timestamp_ms: row.get(4)?,
                request_id: row.get(5)?,
                delivery_state: row.get(6)?,
                outreach: parse_optional_json(row.get(7)?)?,
            })
        })
        .map_err(sqlite_error)?;

    let mut messages = Vec::new();
    for row in rows {
        messages.push(row.map_err(sqlite_error)?);
    }
    Ok(messages)
}

pub(in crate::bridge::storage) fn parse_optional_json<T: for<'de> Deserialize<'de>>(
    value: Option<String>,
) -> Result<Option<T>, rusqlite::Error> {
    value
        .filter(|raw| !raw.trim().is_empty())
        .map(|raw| {
            serde_json::from_str(&raw).map_err(|err| {
                rusqlite::Error::FromSqlConversionFailure(
                    raw.len(),
                    rusqlite::types::Type::Text,
                    Box::new(err),
                )
            })
        })
        .transpose()
}

pub(in crate::bridge::storage) fn optional_json<T: Serialize>(
    value: &Option<T>,
) -> Result<Option<String>, String> {
    value
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|err| err.to_string())
}

pub(in crate::bridge::storage) fn load_conversation_record(
    conn: &Connection,
    conversation_id: &str,
) -> Result<Option<DesktopBridgeConversationRecord>, String> {
    let record = conn
        .query_row(
            "SELECT id, host_id, peer_node_id, peer_display_name, peer_owner_name,\n                    peer_runtime, project_id, project_name, unread_count, updated_at_ms,\n                    peer_last_typing_at_ms, peer_last_heartbeat_at_ms,\n                    outreach_metadata, identity_snapshot\n             FROM bridge_conversations\n             WHERE id = ?1",
            params![conversation_id],
            |row| {
                let unread_count: i64 = row.get(8)?;
                Ok(DesktopBridgeConversationRecord {
                    id: row.get(0)?,
                    host_id: row.get(1)?,
                    peer_node_id: row.get(2)?,
                    peer_display_name: row.get(3)?,
                    peer_owner_name: row.get(4)?,
                    peer_runtime: row.get(5)?,
                    project_id: row.get(6)?,
                    project_name: row.get(7)?,
                    unread_count: unread_count.max(0) as usize,
                    updated_at_ms: row.get(9)?,
                    peer_last_typing_at_ms: row.get(10)?,
                    peer_last_heartbeat_at_ms: row.get(11)?,
                    outreach: parse_optional_json(row.get(12)?)?,
                    identity: parse_optional_json(row.get(13)?)?,
                    messages: Vec::new(),
                })
            },
        )
        .optional()
        .map_err(sqlite_error)?;

    match record {
        Some(mut record) => {
            record.messages = load_conversation_messages(conn, conversation_id)?;
            Ok(Some(record))
        }
        None => Ok(None),
    }
}

pub(in crate::bridge::storage) fn load_conversation_store_from_db(
    conn: &Connection,
) -> Result<DesktopBridgeConversationStore, String> {
    let mut statement = conn
        .prepare("SELECT id FROM bridge_conversations ORDER BY updated_at_ms DESC, id ASC")
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?;

    let mut conversations = Vec::new();
    for row in rows {
        let id = row.map_err(sqlite_error)?;
        if let Some(record) = load_conversation_record(conn, &id)? {
            conversations.push(record);
        }
    }
    Ok(DesktopBridgeConversationStore { conversations })
}

pub(in crate::bridge::storage) fn store_conversation_record(
    conn: &Connection,
    record: &DesktopBridgeConversationRecord,
) -> Result<(), String> {
    let outreach_metadata = optional_json(&record.outreach)?;
    let identity_snapshot = optional_json(&record.identity)?;
    conn.execute(
        "INSERT INTO bridge_conversations(\n             id, host_id, peer_node_id, peer_display_name, peer_owner_name, peer_runtime,\n             project_id, project_name, unread_count, updated_at_ms, peer_last_typing_at_ms,\n             peer_last_heartbeat_at_ms, outreach_metadata, identity_snapshot\n         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)\n         ON CONFLICT(id) DO UPDATE SET\n             host_id = excluded.host_id,\n             peer_node_id = excluded.peer_node_id,\n             peer_display_name = excluded.peer_display_name,\n             peer_owner_name = excluded.peer_owner_name,\n             peer_runtime = excluded.peer_runtime,\n             project_id = excluded.project_id,\n             project_name = excluded.project_name,\n             unread_count = excluded.unread_count,\n             updated_at_ms = excluded.updated_at_ms,\n             peer_last_typing_at_ms = excluded.peer_last_typing_at_ms,\n             peer_last_heartbeat_at_ms = excluded.peer_last_heartbeat_at_ms,\n             outreach_metadata = excluded.outreach_metadata,\n             identity_snapshot = excluded.identity_snapshot",
        params![
            record.id,
            record.host_id,
            record.peer_node_id,
            record.peer_display_name,
            record.peer_owner_name,
            record.peer_runtime,
            record.project_id,
            record.project_name,
            record.unread_count as i64,
            record.updated_at_ms,
            record.peer_last_typing_at_ms,
            record.peer_last_heartbeat_at_ms,
            outreach_metadata,
            identity_snapshot,
        ],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

pub(in crate::bridge::storage) fn find_existing_message_for_merge(
    conn: &Connection,
    conversation_id: &str,
    message: &DesktopBridgeConversationMessageRecord,
) -> Result<Option<DesktopBridgeConversationMessageRecord>, String> {
    let mut statement = if message.request_id.is_some() {
        conn.prepare(
            "SELECT id, direction, sender, text, timestamp_ms, request_id, delivery_state, outreach_metadata\n             FROM bridge_messages\n             WHERE conversation_id = ?1 AND direction = ?2 AND request_id = ?3\n             LIMIT 1",
        )
    } else {
        conn.prepare(
            "SELECT id, direction, sender, text, timestamp_ms, request_id, delivery_state, outreach_metadata\n             FROM bridge_messages\n             WHERE conversation_id = ?1 AND id = ?2\n             LIMIT 1",
        )
    }
    .map_err(sqlite_error)?;

    let mapper = |row: &rusqlite::Row<'_>| {
        Ok(DesktopBridgeConversationMessageRecord {
            id: row.get(0)?,
            direction: row.get(1)?,
            sender: row.get(2)?,
            text: row.get(3)?,
            timestamp_ms: row.get(4)?,
            request_id: row.get(5)?,
            delivery_state: row.get(6)?,
            outreach: parse_optional_json(row.get(7)?)?,
        })
    };

    if let Some(request_id) = message.request_id.as_deref() {
        statement
            .query_row(
                params![conversation_id, message.direction, request_id],
                mapper,
            )
            .optional()
            .map_err(sqlite_error)
    } else {
        statement
            .query_row(params![conversation_id, message.id], mapper)
            .optional()
            .map_err(sqlite_error)
    }
}

pub(in crate::bridge::storage) fn store_message_record(
    conn: &Connection,
    conversation_id: &str,
    message: &DesktopBridgeConversationMessageRecord,
) -> Result<(), String> {
    let outreach_metadata = optional_json(&message.outreach)?;
    conn.execute(
        "INSERT INTO bridge_messages(\n             id, conversation_id, direction, sender, text, timestamp_ms, request_id, delivery_state, outreach_metadata\n         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)\n         ON CONFLICT(id) DO UPDATE SET\n             conversation_id = excluded.conversation_id,\n             direction = excluded.direction,\n             sender = excluded.sender,\n             text = excluded.text,\n             timestamp_ms = excluded.timestamp_ms,\n             request_id = excluded.request_id,\n             delivery_state = excluded.delivery_state,\n             outreach_metadata = excluded.outreach_metadata",
        params![
            message.id,
            conversation_id,
            message.direction,
            message.sender,
            message.text,
            message.timestamp_ms,
            message.request_id,
            message.delivery_state,
            outreach_metadata,
        ],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

pub(in crate::bridge::storage) fn upsert_message_record(
    conn: &Connection,
    conversation_id: &str,
    message: &DesktopBridgeConversationMessageRecord,
) -> Result<(), String> {
    let merged =
        if let Some(existing) = find_existing_message_for_merge(conn, conversation_id, message)? {
            let mut merged = merge_conversation_message_records(&existing, message);
            merged.id = existing.id;
            merged
        } else {
            message.clone()
        };
    store_message_record(conn, conversation_id, &merged)
}

pub(in crate::bridge::storage) fn upsert_conversation_record(
    conn: &Connection,
    incoming: &DesktopBridgeConversationRecord,
) -> Result<(), String> {
    let merged = load_conversation_record(conn, &incoming.id)?
        .map(|existing| merge_conversation_records(&existing, incoming))
        .unwrap_or_else(|| incoming.clone());
    store_conversation_record(conn, &merged)?;
    for message in &merged.messages {
        upsert_message_record(conn, &merged.id, message)?;
    }
    Ok(())
}
