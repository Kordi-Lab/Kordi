pub(super) fn test_connection() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE chat_sync_state (
            account_id TEXT PRIMARY KEY, cursor TEXT NOT NULL,
            last_stream_seq INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
         );
         CREATE TABLE chat_sync_conversations (
            account_id TEXT, conversation_id TEXT, client_session_id TEXT,
            version INTEGER, snapshot_json TEXT, updated_at_ms INTEGER,
            PRIMARY KEY(account_id, conversation_id)
         );
         CREATE TABLE chat_sync_messages (
            account_id TEXT, message_id TEXT, client_message_id TEXT, message_kind TEXT,
            conversation_id TEXT,
            conversation_sequence INTEGER, version INTEGER,
            snapshot_json TEXT, updated_at_ms INTEGER,
            PRIMARY KEY(account_id, message_id),
            UNIQUE(account_id, conversation_id, conversation_sequence)
         );
         CREATE TABLE chat_sync_pending_operations (
            account_id TEXT, operation_id TEXT, PRIMARY KEY(account_id, operation_id)
         );",
    )
    .unwrap();
    conn
}
