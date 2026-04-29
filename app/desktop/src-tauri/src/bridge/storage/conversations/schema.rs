use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::super::config::{
    desktop_bridge_conversations_path, ensure_owner_only_permissions,
    legacy_desktop_bridge_conversations_path,
};
use super::outreach_metadata::reconcile_message_outreach_metadata;
use super::records::{optional_json, parse_optional_json, upsert_conversation_record};
use super::repair::repair_split_bridge_person_session_relay_rows;
use crate::bridge::{DesktopBridgeConversationStore, DesktopBridgeOutreachMetadata};

const BRIDGE_CONVERSATION_SCHEMA_VERSION: i64 = 2;
const BRIDGE_CONVERSATION_JSON_MIGRATION_KEY: &str = "legacy_json_migrated";
const BRIDGE_MESSAGE_OUTREACH_RECONCILE_KEY: &str = "message_outreach_reconciled_v1";

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

fn message_outreach_reconciled(conn: &Connection) -> Result<bool, String> {
    let reconciled = conn
        .query_row(
            "SELECT value FROM bridge_schema_meta WHERE key = ?1",
            params![BRIDGE_MESSAGE_OUTREACH_RECONCILE_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sqlite_error)?
        .is_some_and(|value| value == "1");
    Ok(reconciled)
}

fn mark_message_outreach_reconciled(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "INSERT INTO bridge_schema_meta(key, value) VALUES (?1, '1')\n         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![BRIDGE_MESSAGE_OUTREACH_RECONCILE_KEY],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

fn reconcile_persisted_message_outreach_metadata(conn: &mut Connection) -> Result<(), String> {
    if message_outreach_reconciled(conn)? {
        return Ok(());
    }

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    let mut statement = tx
        .prepare(
            "SELECT id, text, timestamp_ms, delivery_state, outreach_metadata\n             FROM bridge_messages\n             WHERE delivery_state IS NOT NULL\n               AND outreach_metadata IS NOT NULL\n               AND trim(outreach_metadata) != ''",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
                parse_optional_json::<DesktopBridgeOutreachMetadata>(
                    row.get::<_, Option<String>>(4)?,
                )?,
            ))
        })
        .map_err(sqlite_error)?;

    let mut updates = Vec::new();
    for row in rows {
        let (message_id, text, timestamp_ms, delivery_state, outreach) =
            row.map_err(sqlite_error)?;
        let Some(mut outreach) = outreach else {
            continue;
        };
        if reconcile_message_outreach_metadata(
            &mut outreach,
            delivery_state.as_deref(),
            Some(&text),
            None,
            timestamp_ms,
        ) {
            updates.push((message_id, optional_json(&Some(outreach))?));
        }
    }
    drop(statement);

    for (message_id, outreach_metadata) in updates {
        tx.execute(
            "UPDATE bridge_messages SET outreach_metadata = ?1 WHERE id = ?2",
            params![outreach_metadata, message_id],
        )
        .map_err(sqlite_error)?;
    }
    mark_message_outreach_reconciled(&tx)?;
    tx.commit().map_err(sqlite_error)?;
    Ok(())
}

pub(in crate::bridge::storage) fn reconcile_and_repair_persisted_conversation_rows(
    conn: &mut Connection,
) -> Result<(), String> {
    reconcile_persisted_message_outreach_metadata(conn)?;
    repair_split_bridge_person_session_relay_rows(conn)?;
    Ok(())
}

pub(in crate::bridge::storage) fn migrate_legacy_conversation_json(
    conn: &mut Connection,
) -> Result<(), String> {
    if conversation_json_migrated(conn)? {
        return reconcile_and_repair_persisted_conversation_rows(conn);
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
    reconcile_and_repair_persisted_conversation_rows(conn)
}
