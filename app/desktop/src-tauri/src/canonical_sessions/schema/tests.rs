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
             VALUES ('acct', 'message', 'conversation', 1, 1,
                     '{\"client_message_id\":\"client-message\"}', 1);
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
    let client_message_id: String = conn
        .query_row(
            "SELECT client_message_id FROM chat_sync_messages WHERE message_id = 'message'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(client_message_id, "client-message");
}

#[test]
fn current_chat_message_table_adds_and_backfills_projection_columns() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE chat_sync_messages (
             account_id TEXT, message_id TEXT, conversation_id TEXT,
             conversation_sequence INTEGER, version INTEGER,
             snapshot_json TEXT, updated_at_ms INTEGER,
             PRIMARY KEY(account_id, message_id),
             UNIQUE(account_id, conversation_id, conversation_sequence)
         );
         INSERT INTO chat_sync_messages VALUES
             ('acct', 'message', 'conversation', 1, 1,
              '{\"client_message_id\":\"client-message\",\"kind\":\"text\"}', 1);",
    )
    .unwrap();

    initialize_schema(&conn).unwrap();

    let client_message_id: String = conn
        .query_row(
            "SELECT client_message_id FROM chat_sync_messages WHERE message_id = 'message'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(client_message_id, "client-message");
    let message_kind: String = conn
        .query_row(
            "SELECT message_kind FROM chat_sync_messages WHERE message_id = 'message'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(message_kind, "text");
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
