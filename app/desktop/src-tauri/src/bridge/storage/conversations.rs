use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::super::constants::{
    is_inbound_message_direction, BRIDGE_CONVERSATION_ID_PREFIX, BRIDGE_DELIVERY_STATE_RESPONDED,
    BRIDGE_MESSAGE_DIRECTION_INBOUND, BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE,
    BRIDGE_MESSAGE_DIRECTION_OUTBOUND, BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
    BRIDGE_MESSAGE_ID_PREFIX,
};
use super::super::{
    DesktopBridgeConversationMessageRecord, DesktopBridgeConversationRecord,
    DesktopBridgeConversationStore, DesktopBridgeIdentitySnapshot, DesktopBridgeOutreachMetadata,
};
use super::config::{
    desktop_bridge_conversations_path, ensure_owner_only_permissions,
    legacy_desktop_bridge_conversations_path, now_ms,
};

const BRIDGE_CONVERSATION_SCHEMA_VERSION: i64 = 2;
const BRIDGE_CONVERSATION_JSON_MIGRATION_KEY: &str = "legacy_json_migrated";

pub(in crate::bridge::storage) fn sqlite_error(err: rusqlite::Error) -> String {
    err.to_string()
}

pub(in crate::bridge::storage) fn open_conversation_db() -> Result<Connection, String> {
    let path = desktop_bridge_conversations_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let conn = Connection::open(&path).map_err(sqlite_error)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(sqlite_error)?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;\n         PRAGMA journal_mode = WAL;\n         PRAGMA synchronous = NORMAL;",
    )
    .map_err(sqlite_error)?;
    init_conversation_schema(&conn)?;
    let _ = ensure_owner_only_permissions(&path);
    Ok(conn)
}

pub(in crate::bridge::storage) fn ensure_conversation_column(
    conn: &Connection,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let exists = conn
        .prepare("PRAGMA table_info(bridge_conversations)")
        .map_err(sqlite_error)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(sqlite_error)?
        .filter_map(Result::ok)
        .any(|name| name == column);

    if !exists {
        conn.execute(
            &format!("ALTER TABLE bridge_conversations ADD COLUMN {definition}"),
            [],
        )
        .map_err(sqlite_error)?;
    }
    Ok(())
}

pub(in crate::bridge::storage) fn ensure_bridge_message_column(
    conn: &Connection,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let exists = conn
        .prepare("PRAGMA table_info(bridge_messages)")
        .map_err(sqlite_error)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(sqlite_error)?
        .filter_map(Result::ok)
        .any(|name| name == column);

    if !exists {
        conn.execute(
            &format!("ALTER TABLE bridge_messages ADD COLUMN {definition}"),
            [],
        )
        .map_err(sqlite_error)?;
    }
    Ok(())
}

pub(in crate::bridge::storage) fn init_conversation_schema(
    conn: &Connection,
) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS bridge_schema_meta (\n            key TEXT PRIMARY KEY,\n            value TEXT NOT NULL\n        );\n        CREATE TABLE IF NOT EXISTS bridge_conversations (\n            id TEXT PRIMARY KEY,\n            host_id TEXT NOT NULL,\n            peer_node_id TEXT NOT NULL,\n            peer_display_name TEXT,\n            peer_owner_name TEXT,\n            peer_runtime TEXT NOT NULL,\n            project_id TEXT,\n            project_name TEXT,\n            unread_count INTEGER NOT NULL DEFAULT 0,\n            updated_at_ms INTEGER NOT NULL,\n            peer_last_typing_at_ms INTEGER,\n            peer_last_heartbeat_at_ms INTEGER,\n            outreach_metadata TEXT,\n            identity_snapshot TEXT\n        );\n        CREATE TABLE IF NOT EXISTS bridge_messages (\n            id TEXT PRIMARY KEY,\n            conversation_id TEXT NOT NULL REFERENCES bridge_conversations(id) ON DELETE CASCADE,\n            direction TEXT NOT NULL,\n            sender TEXT,\n            text TEXT NOT NULL,\n            timestamp_ms INTEGER NOT NULL,\n            request_id TEXT,\n            delivery_state TEXT,\n            outreach_metadata TEXT\n        );\n        CREATE INDEX IF NOT EXISTS idx_bridge_conversations_updated\n            ON bridge_conversations(updated_at_ms DESC);\n        CREATE INDEX IF NOT EXISTS idx_bridge_messages_conversation\n            ON bridge_messages(conversation_id, timestamp_ms ASC, id ASC);\n        CREATE INDEX IF NOT EXISTS idx_bridge_messages_request\n            ON bridge_messages(request_id) WHERE request_id IS NOT NULL;\n        CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_messages_stream_key\n            ON bridge_messages(conversation_id, direction, request_id)\n            WHERE request_id IS NOT NULL;",
    )
    .map_err(sqlite_error)?;
    ensure_conversation_column(conn, "outreach_metadata", "outreach_metadata TEXT")?;
    ensure_conversation_column(conn, "identity_snapshot", "identity_snapshot TEXT")?;
    ensure_bridge_message_column(conn, "outreach_metadata", "outreach_metadata TEXT")?;
    conn.execute(
        "INSERT INTO bridge_schema_meta(key, value) VALUES ('schema_version', ?1)\n         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![BRIDGE_CONVERSATION_SCHEMA_VERSION.to_string()],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

pub(in crate::bridge::storage) fn conversation_json_migrated(
    conn: &Connection,
) -> Result<bool, String> {
    let migrated = conn
        .query_row(
            "SELECT value FROM bridge_schema_meta WHERE key = ?1",
            params![BRIDGE_CONVERSATION_JSON_MIGRATION_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sqlite_error)?
        .is_some_and(|value| value == "1");
    Ok(migrated)
}

pub(in crate::bridge::storage) fn mark_conversation_json_migrated(
    conn: &Connection,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO bridge_schema_meta(key, value) VALUES (?1, '1')\n         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![BRIDGE_CONVERSATION_JSON_MIGRATION_KEY],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

pub(in crate::bridge::storage) fn migrate_legacy_conversation_json(
    conn: &mut Connection,
) -> Result<(), String> {
    if conversation_json_migrated(conn)? {
        return Ok(());
    }

    let legacy_path = legacy_desktop_bridge_conversations_path()?;
    let legacy_store = if legacy_path.exists() {
        let raw = std::fs::read_to_string(&legacy_path).map_err(|err| err.to_string())?;
        Some(
            serde_json::from_str::<DesktopBridgeConversationStore>(&raw)
                .map_err(|err| err.to_string())?,
        )
    } else {
        None
    };

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    if let Some(store) = legacy_store {
        for conversation in &store.conversations {
            upsert_conversation_record(&tx, conversation)?;
        }
    }
    mark_conversation_json_migrated(&tx)?;
    tx.commit().map_err(sqlite_error)?;
    Ok(())
}

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

    DesktopBridgeConversationMessageRecord {
        id: newer.id.clone(),
        direction: newer.direction.clone(),
        sender: newer.sender.clone().or_else(|| older.sender.clone()),
        text: if newer.text.trim().is_empty() {
            older.text.clone()
        } else {
            newer.text.clone()
        },
        timestamp_ms: newer.timestamp_ms.max(older.timestamp_ms),
        request_id: newer
            .request_id
            .clone()
            .or_else(|| older.request_id.clone()),
        delivery_state: if delivery_state_rank(newer.delivery_state.as_deref())
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
        },
        outreach: newer.outreach.clone().or_else(|| older.outreach.clone()),
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

pub(in crate::bridge::storage) fn is_person_runtime(runtime: &str) -> bool {
    runtime.trim().eq_ignore_ascii_case("person")
}

pub(in crate::bridge::storage) fn scoped_conversation_id(
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

pub(in crate::bridge::storage) fn conversation_matches_runtime(
    existing_runtime: &str,
    peer_runtime: &str,
) -> bool {
    is_person_runtime(existing_runtime) == is_person_runtime(peer_runtime)
}

pub(in crate::bridge::storage) fn find_conversation_for_peer(
    conn: &Connection,
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<&str>,
    peer_runtime: &str,
) -> Result<Option<DesktopBridgeConversationRecord>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, peer_runtime FROM bridge_conversations\n             WHERE host_id = ?1\n               AND peer_node_id = ?2\n               AND ((project_id IS NULL AND ?3 IS NULL) OR project_id = ?3)\n             ORDER BY updated_at_ms DESC, id ASC",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(params![host_id, peer_node_id, project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sqlite_error)?;

    for row in rows {
        let (id, existing_runtime) = row.map_err(sqlite_error)?;
        if conversation_matches_runtime(&existing_runtime, peer_runtime) {
            return load_conversation_record(conn, &id);
        }
    }

    Ok(None)
}

pub(in crate::bridge::storage) fn find_recent_conversation_for_peer(
    conn: &Connection,
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<&str>,
) -> Result<Option<DesktopBridgeConversationRecord>, String> {
    let conversation_id = conn
        .query_row(
            "SELECT id FROM bridge_conversations
             WHERE host_id = ?1
               AND peer_node_id = ?2
               AND ((project_id IS NULL AND ?3 IS NULL) OR project_id = ?3)
             ORDER BY updated_at_ms DESC, id ASC
             LIMIT 1",
            params![host_id, peer_node_id, project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sqlite_error)?;

    match conversation_id {
        Some(id) => load_conversation_record(conn, &id),
        None => Ok(None),
    }
}

pub(in crate::bridge::storage) fn apply_conversation_metadata(
    conversation: &mut DesktopBridgeConversationRecord,
    peer_display_name: Option<String>,
    peer_owner_name: Option<String>,
    peer_runtime: String,
    project_id: Option<String>,
    project_name: Option<String>,
) {
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
}

#[allow(clippy::too_many_arguments)]
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
            message.sender = sender.or_else(|| message.sender.clone());
            message.text = text;
            message.timestamp_ms = timestamp_ms;
            if delivery_state.is_some() {
                message.delivery_state = delivery_state;
            }
            if message.outreach.is_none() {
                message.outreach = message_outreach.clone();
            }
        }
    } else {
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
                outreach: message_outreach,
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
            && outreach.status != "cancelled"
        {
            match delivery_state_for_status.as_deref() {
                Some(BRIDGE_DELIVERY_STATE_RESPONDED) => {
                    outreach.status = "completed".to_string();
                    outreach.updated_at_ms = timestamp_ms;
                    outreach.completed_at_ms = Some(timestamp_ms);
                    outreach.error = None;
                }
                Some("processing_failed") => {
                    outreach.status = "failed".to_string();
                    outreach.updated_at_ms = timestamp_ms;
                    outreach.completed_at_ms = Some(timestamp_ms);
                    outreach.error = Some(text_for_status.clone());
                }
                _ => {}
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
            "SELECT id, conversation_id, delivery_state FROM bridge_messages\n             WHERE request_id = ?1",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(params![request_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(sqlite_error)?;

    let mut updates = Vec::new();
    for row in rows {
        let (message_id, conversation_id, current_state) = row.map_err(sqlite_error)?;
        if delivery_state_rank(Some(delivery_state))
            >= delivery_state_rank(current_state.as_deref())
        {
            updates.push((message_id, conversation_id));
        }
    }
    drop(statement);

    for (message_id, conversation_id) in updates {
        tx.execute(
            "UPDATE bridge_messages SET delivery_state = ?1 WHERE id = ?2",
            params![delivery_state, message_id],
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
                    match delivery_state {
                        "cancelled" => {
                            outreach.status = "cancelled".to_string();
                            outreach.updated_at_ms = now;
                            outreach.completed_at_ms = Some(now);
                            outreach.error = Some("Cancelled by user".to_string());
                        }
                        "processing_failed" if outreach.status != "cancelled" => {
                            outreach.status = "failed".to_string();
                            outreach.updated_at_ms = now;
                            outreach.completed_at_ms = Some(now);
                        }
                        "responded" if outreach.status != "cancelled" => {
                            outreach.status = "completed".to_string();
                            outreach.updated_at_ms = now;
                            outreach.completed_at_ms = Some(now);
                            outreach.error = None;
                        }
                        "processing" if outreach.status != "cancelled" => {
                            outreach.status = "processing".to_string();
                            outreach.updated_at_ms = now;
                        }
                        _ => {}
                    }
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

pub(in crate::bridge) fn bridge_conversation_id(
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<&str>,
) -> String {
    match project_id.filter(|value| !value.trim().is_empty()) {
        Some(project_id) => {
            format!("{BRIDGE_CONVERSATION_ID_PREFIX}{host_id}:{peer_node_id}:{project_id}")
        }
        None => format!("{BRIDGE_CONVERSATION_ID_PREFIX}{host_id}:{peer_node_id}"),
    }
}
