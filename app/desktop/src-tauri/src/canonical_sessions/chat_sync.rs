//! Atomic local projection for the canonical reliable chat protocol.
//!
//! The renderer never stores a cursor separately from the rows it represents.
//! Bootstrap replacement and every incremental event batch commit the opaque
//! cursor, stream sequence, conversations, and messages in one SQLite
//! transaction. Replaying a batch is safe because snapshots are versioned.

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{now_ms, open_db};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSyncApplyRequest {
    pub account_id: String,
    pub bootstrap: bool,
    pub cursor: Option<String>,
    pub last_stream_seq: Option<i64>,
    #[serde(default)]
    pub conversations: Vec<Value>,
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub events: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSyncLocalState {
    pub account_id: String,
    pub cursor: Option<String>,
    pub last_stream_seq: i64,
    pub conversations: Vec<Value>,
    pub messages: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSyncOutboxEnqueueRequest {
    pub account_id: String,
    pub operation_id: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSyncOutboxFailureRequest {
    pub account_id: String,
    pub operation_id: String,
    pub error: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSyncPendingOperation {
    pub account_id: String,
    pub operation_id: String,
    pub payload: Value,
    pub attempt_count: i64,
    pub next_attempt_at_ms: i64,
    pub last_error: Option<String>,
}

mod apply;
mod outbox;
mod projection;

use apply::*;
use outbox::*;
use projection::*;
#[tauri::command]
pub async fn desktop_chat_sync_apply(
    request: ChatSyncApplyRequest,
) -> Result<ChatSyncLocalState, String> {
    tauri::async_runtime::spawn_blocking(move || apply(request))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn desktop_chat_sync_load(account_id: String) -> Result<ChatSyncLocalState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account_id = account_id.trim().to_string();
        if account_id.is_empty() {
            return Err("Chat sync account id is required".to_string());
        }
        let conn = open_db()?;
        load_state(&conn, &account_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn desktop_chat_sync_outbox_enqueue(
    request: ChatSyncOutboxEnqueueRequest,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || enqueue_outbox(request))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn desktop_chat_sync_outbox_due(
    account_id: String,
) -> Result<Vec<ChatSyncPendingOperation>, String> {
    tauri::async_runtime::spawn_blocking(move || list_due_outbox(&account_id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn desktop_chat_sync_outbox_complete(
    account_id: String,
    operation_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account_id = clean_outbox_key(&account_id, "account id")?;
        let operation_id = clean_outbox_key(&operation_id, "operation id")?;
        let conn = open_db()?;
        conn.execute(
            "DELETE FROM chat_sync_pending_operations
             WHERE account_id = ?1 AND operation_id = ?2",
            params![account_id, operation_id],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn desktop_chat_sync_outbox_fail(
    request: ChatSyncOutboxFailureRequest,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || record_outbox_failure(request))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{apply_event, apply_on_connection, ChatSyncApplyRequest};

    fn test_connection() -> rusqlite::Connection {
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
                account_id TEXT, message_id TEXT, conversation_id TEXT,
                conversation_sequence INTEGER, version INTEGER,
                snapshot_json TEXT, updated_at_ms INTEGER,
                PRIMARY KEY(account_id, message_id),
                UNIQUE(account_id, conversation_id, conversation_sequence)
             );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn unknown_critical_events_are_rejected_before_cursor_advance() {
        let mut conn = test_connection();
        let tx = conn.transaction().unwrap();
        let error = apply_event(
            &tx,
            "acct_test",
            &json!({
                "stream_seq": 1,
                "protocol_version": 2,
                "type": "future.required",
                "critical": true,
                "payload": {}
            }),
        )
        .unwrap_err();
        assert!(error.contains("CLIENT_UPDATE_REQUIRED"));
    }

    #[test]
    fn ancillary_events_are_accepted_by_the_atomic_cursor_applier() {
        let mut conn = test_connection();
        let event_types = [
            "agent.definition.upserted",
            "agent.definition.archived",
            "provider-auth.updated",
            "task.upsert",
            "artifact.upsert",
            "artifact.archived",
            "session.pin.updated",
            "session.hidden",
            "session.unhidden",
            "session.deleted",
            "session-forked",
            "call.created",
            "call.updated",
            "device.added",
            "device.confirmed",
            "device.revoked",
            "device.renamed",
        ];
        let events = event_types
            .iter()
            .enumerate()
            .map(|(index, event_type)| {
                json!({
                    "stream_seq": index as i64 + 1,
                    "protocol_version": 2,
                    "type": event_type,
                    "critical": true,
                    "payload": {}
                })
            })
            .collect();
        let final_stream_seq = event_types.len() as i64;
        let final_cursor = format!("cursor-{final_stream_seq}");
        let state = apply_on_connection(
            &mut conn,
            ChatSyncApplyRequest {
                account_id: "acct_test".to_string(),
                bootstrap: false,
                cursor: Some(final_cursor.clone()),
                last_stream_seq: Some(final_stream_seq),
                conversations: vec![],
                messages: vec![],
                events,
            },
        )
        .unwrap();
        assert_eq!(state.cursor.as_deref(), Some(final_cursor.as_str()));
        assert_eq!(state.last_stream_seq, final_stream_seq);
    }

    #[test]
    fn entity_changes_and_cursor_roll_back_together_on_critical_event_failure() {
        let mut conn = test_connection();
        let conversation = json!({
            "id": "conversation-1",
            "legacy_session_id": "session-1",
            "version": 1
        });
        apply_on_connection(
            &mut conn,
            ChatSyncApplyRequest {
                account_id: "acct_test".to_string(),
                bootstrap: true,
                cursor: Some("cursor-0".to_string()),
                last_stream_seq: Some(0),
                conversations: vec![conversation],
                messages: vec![],
                events: vec![],
            },
        )
        .unwrap();
        let message = json!({
            "id": "message-1",
            "conversation_id": "conversation-1",
            "conversation_sequence": 1,
            "version": 1
        });
        let error = apply_on_connection(
            &mut conn,
            ChatSyncApplyRequest {
                account_id: "acct_test".to_string(),
                bootstrap: false,
                cursor: Some("cursor-2".to_string()),
                last_stream_seq: Some(2),
                conversations: vec![],
                messages: vec![],
                events: vec![
                    json!({
                        "stream_seq": 1,
                        "protocol_version": 2,
                        "type": "message.created",
                        "critical": true,
                        "payload": { "message": message }
                    }),
                    json!({
                        "stream_seq": 2,
                        "protocol_version": 2,
                        "type": "future.required",
                        "critical": true,
                        "payload": {}
                    }),
                ],
            },
        )
        .unwrap_err();
        assert!(error.contains("CLIENT_UPDATE_REQUIRED"));
        let cursor: (String, i64) = conn.query_row(
            "SELECT cursor, last_stream_seq FROM chat_sync_state WHERE account_id = 'acct_test'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(cursor, ("cursor-0".to_string(), 0));
        let message_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM chat_sync_messages", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(message_count, 0);
    }
}
