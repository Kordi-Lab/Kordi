use rusqlite::{params, Connection, OptionalExtension};

use super::{
    canonical_storage_root, now_ms, stable_profile_id, CanonicalLocalProfile, SCHEMA_VERSION,
};

pub(super) fn initialize_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS canonical_schema_meta (
             key TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS local_profile (
             id TEXT PRIMARY KEY,
             display_name TEXT,
             human_identity_id TEXT,
             active_agent_identity_id TEXT,
             storage_root TEXT NOT NULL,
             created_at_ms INTEGER NOT NULL,
             updated_at_ms INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS identities (
             id TEXT PRIMARY KEY,
             kind TEXT NOT NULL CHECK(kind IN ('human', 'agent')),
             display_name TEXT NOT NULL,
             owner_identity_id TEXT,
             source TEXT NOT NULL,
             source_host_id TEXT,
             bridge_node_id TEXT,
             human_id TEXT,
             agent_id TEXT,
             avatar_key TEXT NOT NULL,
             profile_image_url TEXT,
             metadata_json TEXT,
             created_at_ms INTEGER NOT NULL,
             updated_at_ms INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_identities_kind ON identities(kind);
         CREATE INDEX IF NOT EXISTS idx_identities_human_id ON identities(human_id);
         CREATE INDEX IF NOT EXISTS idx_identities_agent_id ON identities(agent_id);
         CREATE INDEX IF NOT EXISTS idx_identities_bridge_node ON identities(bridge_node_id);
         CREATE TABLE IF NOT EXISTS sessions (
             id TEXT PRIMARY KEY,
             kind TEXT NOT NULL,
             title TEXT NOT NULL,
             status TEXT NOT NULL DEFAULT 'active',
             created_by_identity_id TEXT NOT NULL,
             primary_identity_id TEXT,
             project_id TEXT,
             project_name TEXT,
             relationship_identity_id TEXT,
             metadata_json TEXT,
             created_at_ms INTEGER NOT NULL,
             updated_at_ms INTEGER NOT NULL,
             last_message_at_ms INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at_ms DESC);
         CREATE INDEX IF NOT EXISTS idx_sessions_primary_identity ON sessions(primary_identity_id);
         CREATE INDEX IF NOT EXISTS idx_sessions_relationship_identity ON sessions(relationship_identity_id);
         CREATE TABLE IF NOT EXISTS session_participants (
             session_id TEXT NOT NULL,
             identity_id TEXT NOT NULL,
             role TEXT NOT NULL,
             state TEXT NOT NULL DEFAULT 'active',
             added_by_identity_id TEXT,
             added_at_ms INTEGER NOT NULL,
             last_seen_at_ms INTEGER,
             last_read_message_id TEXT,
             metadata_json TEXT,
             PRIMARY KEY(session_id, identity_id)
         );
         CREATE INDEX IF NOT EXISTS idx_session_participants_identity ON session_participants(identity_id);
         CREATE TABLE IF NOT EXISTS session_messages (
             id TEXT PRIMARY KEY,
             session_id TEXT NOT NULL,
             sender_identity_id TEXT NOT NULL,
             sender_role TEXT NOT NULL,
             message_kind TEXT NOT NULL,
             content_text TEXT NOT NULL DEFAULT '',
             content_json TEXT,
             parent_message_id TEXT,
             delegated_exchange_id TEXT,
             status TEXT NOT NULL,
             sequence_num INTEGER NOT NULL,
             created_at_ms INTEGER NOT NULL,
             updated_at_ms INTEGER NOT NULL,
             content_hash TEXT,
             source_transport TEXT,
             source_event_id TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_session_messages_session_seq ON session_messages(session_id, sequence_num);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_session_messages_source_event
             ON session_messages(source_transport, source_event_id)
             WHERE source_transport IS NOT NULL AND source_event_id IS NOT NULL;
         CREATE TABLE IF NOT EXISTS delegated_exchanges (
             id TEXT PRIMARY KEY,
             session_id TEXT NOT NULL,
             initiator_identity_id TEXT NOT NULL,
             target_identity_id TEXT NOT NULL,
             trigger_message_id TEXT,
             request_message_id TEXT,
             response_message_id TEXT,
             transport TEXT NOT NULL,
             bridge_host_id TEXT,
             bridge_conversation_id TEXT,
             bridge_request_id TEXT,
             context_policy TEXT NOT NULL,
             status TEXT NOT NULL,
             error TEXT,
             created_at_ms INTEGER NOT NULL,
             updated_at_ms INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_delegated_exchanges_session ON delegated_exchanges(session_id);
         CREATE INDEX IF NOT EXISTS idx_delegated_exchanges_bridge_request ON delegated_exchanges(bridge_request_id);
         CREATE TABLE IF NOT EXISTS presence (
             identity_id TEXT PRIMARY KEY,
             status TEXT NOT NULL,
             session_id TEXT,
             detail TEXT,
             updated_at_ms INTEGER NOT NULL,
             expires_at_ms INTEGER
         );
         CREATE TABLE IF NOT EXISTS context_snapshots (
             id TEXT PRIMARY KEY,
             profile_id TEXT NOT NULL,
             session_id TEXT NOT NULL,
             agent_identity_id TEXT NOT NULL,
             provider TEXT NOT NULL,
             model TEXT NOT NULL,
             prompt_hash TEXT NOT NULL,
             project_context_hash TEXT,
             participant_hash TEXT NOT NULL,
             upto_message_id TEXT,
             message_range_hash TEXT NOT NULL,
             summary_text TEXT,
             summary_json TEXT,
             token_count INTEGER,
             created_at_ms INTEGER NOT NULL,
             invalidated_at_ms INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_context_snapshots_lookup
             ON context_snapshots(profile_id, session_id, agent_identity_id, provider, model, prompt_hash, participant_hash, message_range_hash);
         CREATE TABLE IF NOT EXISTS kv_cache_entries (
             key_hash TEXT PRIMARY KEY,
             profile_id TEXT NOT NULL,
             session_id TEXT,
             agent_identity_id TEXT,
             provider TEXT,
             model TEXT,
             value_json TEXT,
             value_blob_path TEXT,
             metadata_json TEXT,
             created_at_ms INTEGER NOT NULL,
             updated_at_ms INTEGER NOT NULL,
             expires_at_ms INTEGER
         );
         CREATE TABLE IF NOT EXISTS chat_sync_state (
             account_id TEXT PRIMARY KEY,
             cursor TEXT NOT NULL,
             last_stream_seq INTEGER NOT NULL CHECK(last_stream_seq >= 0),
             updated_at_ms INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS chat_sync_conversations (
             account_id TEXT NOT NULL,
             conversation_id TEXT NOT NULL,
             client_session_id TEXT,
             version INTEGER NOT NULL CHECK(version >= 1),
             snapshot_json TEXT NOT NULL,
             updated_at_ms INTEGER NOT NULL,
             PRIMARY KEY(account_id, conversation_id)
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sync_conversation_session
             ON chat_sync_conversations(account_id, client_session_id)
             WHERE client_session_id IS NOT NULL;
         CREATE TABLE IF NOT EXISTS chat_sync_messages (
             account_id TEXT NOT NULL,
             message_id TEXT NOT NULL,
             conversation_id TEXT NOT NULL,
             conversation_sequence INTEGER NOT NULL CHECK(conversation_sequence >= 1),
             version INTEGER NOT NULL CHECK(version >= 1),
             snapshot_json TEXT NOT NULL,
             updated_at_ms INTEGER NOT NULL,
             PRIMARY KEY(account_id, message_id),
             UNIQUE(account_id, conversation_id, conversation_sequence)
         );
         CREATE INDEX IF NOT EXISTS idx_chat_sync_message_history
             ON chat_sync_messages(account_id, conversation_id, conversation_sequence DESC);
         CREATE TABLE IF NOT EXISTS chat_sync_pending_operations (
             account_id TEXT NOT NULL,
             operation_id TEXT NOT NULL,
             operation_kind TEXT NOT NULL CHECK(operation_kind IN ('send_message')),
             payload_json TEXT NOT NULL,
             status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'failed')),
             attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
             next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
             last_error TEXT,
             created_at_ms INTEGER NOT NULL,
             updated_at_ms INTEGER NOT NULL,
             PRIMARY KEY(account_id, operation_id)
         );
         CREATE INDEX IF NOT EXISTS idx_chat_sync_pending_due
             ON chat_sync_pending_operations(account_id, status, next_attempt_at_ms, created_at_ms);",
    )
    .map_err(|err| err.to_string())?;
    migrate_versioned_chat_tables(conn)?;
    conn.execute(
        "INSERT INTO canonical_schema_meta(key, value) VALUES('version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![SCHEMA_VERSION.to_string()],
    )
    .map_err(|err| err.to_string())?;
    ensure_local_profile(conn)?;
    Ok(())
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        params![table],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

fn migrate_versioned_chat_tables(conn: &Connection) -> Result<(), String> {
    // These names shipped before canonical chat became the sole local model.
    // Copy their contents atomically, then remove the obsolete aliases.
    let previous_tables = [
        ("chat_sync_v2_state", "chat_sync_state"),
        ("chat_sync_v2_conversations", "chat_sync_conversations"),
        ("chat_sync_v2_messages", "chat_sync_messages"),
        (
            "chat_sync_v2_pending_operations",
            "chat_sync_pending_operations",
        ),
    ];
    let existing_tables = previous_tables
        .into_iter()
        .filter_map(|tables| match table_exists(conn, tables.0) {
            Ok(true) => Some(Ok(tables)),
            Ok(false) => None,
            Err(error) => Some(Err(error)),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if existing_tables.is_empty() {
        return Ok(());
    }

    let mut migration = String::from("BEGIN IMMEDIATE;\n");
    for (previous, current) in existing_tables {
        migration.push_str(&format!(
            "INSERT OR IGNORE INTO {current} SELECT * FROM {previous};\n\
             DROP TABLE {previous};\n"
        ));
    }
    migration.push_str("COMMIT;");

    if let Err(error) = conn.execute_batch(&migration) {
        let _ = conn.execute_batch("ROLLBACK;");
        return Err(error.to_string());
    }
    Ok(())
}

pub(super) fn ensure_local_profile(conn: &Connection) -> Result<CanonicalLocalProfile, String> {
    if let Some(profile) = select_first_local_profile(conn)? {
        return Ok(profile);
    }

    let root = canonical_storage_root();
    let storage_root = root.display().to_string();
    let profile_id = stable_profile_id(&root);

    let now = now_ms();
    conn.execute(
        "INSERT INTO local_profile(id, display_name, human_identity_id, active_agent_identity_id, storage_root, created_at_ms, updated_at_ms)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![profile_id, "Local profile", Option::<String>::None, Option::<String>::None, storage_root, now, now],
    )
    .map_err(|err| err.to_string())?;
    select_local_profile(conn, &profile_id)?
        .ok_or_else(|| "Unable to create local profile".to_string())
}

pub(super) fn select_local_profile(
    conn: &Connection,
    profile_id: &str,
) -> Result<Option<CanonicalLocalProfile>, String> {
    conn.query_row(
        "SELECT id, display_name, human_identity_id, active_agent_identity_id, storage_root, created_at_ms, updated_at_ms
         FROM local_profile WHERE id = ?1",
        params![profile_id],
        canonical_local_profile_from_row,
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn select_first_local_profile(conn: &Connection) -> Result<Option<CanonicalLocalProfile>, String> {
    conn.query_row(
        "SELECT id, display_name, human_identity_id, active_agent_identity_id, storage_root, created_at_ms, updated_at_ms
         FROM local_profile ORDER BY rowid ASC LIMIT 1",
        [],
        canonical_local_profile_from_row,
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn canonical_local_profile_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<CanonicalLocalProfile> {
    Ok(CanonicalLocalProfile {
        id: row.get(0)?,
        display_name: row.get(1)?,
        human_identity_id: row.get(2)?,
        active_agent_identity_id: row.get(3)?,
        storage_root: row.get(4)?,
        created_at_ms: row.get(5)?,
        updated_at_ms: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::{initialize_schema, table_exists};

    #[test]
    fn versioned_chat_tables_migrate_to_canonical_names_without_data_loss() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE chat_sync_v2_state (
                 account_id TEXT PRIMARY KEY, cursor TEXT NOT NULL,
                 last_stream_seq INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
             );
             CREATE TABLE chat_sync_v2_conversations (
                 account_id TEXT, conversation_id TEXT, client_session_id TEXT,
                 version INTEGER, snapshot_json TEXT, updated_at_ms INTEGER,
                 PRIMARY KEY(account_id, conversation_id)
             );
             CREATE TABLE chat_sync_v2_messages (
                 account_id TEXT, message_id TEXT, conversation_id TEXT,
                 conversation_sequence INTEGER, version INTEGER,
                 snapshot_json TEXT, updated_at_ms INTEGER,
                 PRIMARY KEY(account_id, message_id),
                 UNIQUE(account_id, conversation_id, conversation_sequence)
             );
             CREATE TABLE chat_sync_v2_pending_operations (
                 account_id TEXT, operation_id TEXT, operation_kind TEXT,
                 payload_json TEXT, status TEXT, attempt_count INTEGER,
                 next_attempt_at_ms INTEGER, last_error TEXT,
                 created_at_ms INTEGER, updated_at_ms INTEGER,
                 PRIMARY KEY(account_id, operation_id)
             );
             INSERT INTO chat_sync_v2_state VALUES ('acct', 'cursor', 7, 1);
             INSERT INTO chat_sync_v2_conversations
                 VALUES ('acct', 'conversation', 'session', 1, '{}', 1);
             INSERT INTO chat_sync_v2_messages
                 VALUES ('acct', 'message', 'conversation', 1, 1, '{}', 1);
             INSERT INTO chat_sync_v2_pending_operations
                 VALUES ('acct', 'operation', 'send_message', '{}', 'pending', 0, 0, NULL, 1, 1);",
        )
        .unwrap();

        initialize_schema(&conn).unwrap();

        for (table, expected_rows) in [
            ("chat_sync_state", 1_i64),
            ("chat_sync_conversations", 1),
            ("chat_sync_messages", 1),
            ("chat_sync_pending_operations", 1),
        ] {
            let rows: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(rows, expected_rows, "{table}");
        }
        for table in [
            "chat_sync_v2_state",
            "chat_sync_v2_conversations",
            "chat_sync_v2_messages",
            "chat_sync_v2_pending_operations",
        ] {
            assert!(!table_exists(&conn, table).unwrap(), "{table}");
        }
    }

    #[test]
    fn partial_versioned_chat_schema_migrates_without_blocking_startup() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE chat_sync_v2_state (
                 account_id TEXT PRIMARY KEY, cursor TEXT NOT NULL,
                 last_stream_seq INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
             );
             INSERT INTO chat_sync_v2_state VALUES ('acct', 'cursor', 7, 1);",
        )
        .unwrap();

        initialize_schema(&conn).unwrap();

        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM chat_sync_state", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1);
        assert!(!table_exists(&conn, "chat_sync_v2_state").unwrap());
    }
}
