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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSyncCursorState {
    pub account_id: String,
    pub cursor: Option<String>,
    pub last_stream_seq: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSyncApplyResult {
    pub account_id: String,
    pub cursor: Option<String>,
    pub last_stream_seq: i64,
    pub changed_conversation_heads: Vec<ChatSyncConversationHead>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSyncConversationCoverage {
    pub conversation_id: String,
    pub earliest_sequence: i64,
    pub latest_sequence: i64,
    pub message_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSyncMessagePage {
    pub conversation_id: String,
    pub messages: Vec<Value>,
    pub next_after_sequence: Option<i64>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSyncRecoveryMessageIds {
    pub conversation_id: String,
    pub message_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatSyncMessageRef {
    pub id: String,
    pub client_message_id: String,
    pub conversation_id: String,
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
mod compaction;
mod message_reads;
mod outbox;
mod projection;
pub mod unread;

pub use apply::ChatSyncConversationHead;
use apply::*;
use message_reads::*;
use outbox::*;
use projection::*;
#[tauri::command]
pub async fn desktop_chat_sync_apply(
    request: ChatSyncApplyRequest,
) -> Result<ChatSyncApplyResult, String> {
    tauri::async_runtime::spawn_blocking(move || apply(request))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn desktop_chat_sync_cursor(account_id: String) -> Result<ChatSyncCursorState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account_id = account_id.trim().to_string();
        if account_id.is_empty() {
            return Err("Chat sync account id is required".to_string());
        }
        let conn = open_db()?;
        load_cursor_state(&conn, &account_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn desktop_chat_sync_coverage(
    account_id: String,
) -> Result<Vec<ChatSyncConversationCoverage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account_id = account_id.trim().to_string();
        if account_id.is_empty() {
            return Err("Chat sync account id is required".to_string());
        }
        let conn = open_db()?;
        load_coverage(&conn, &account_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn desktop_chat_sync_conversations(account_id: String) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account_id = account_id.trim().to_string();
        if account_id.is_empty() {
            return Err("Chat sync account id is required".to_string());
        }
        let conn = open_db()?;
        load_conversations(&conn, &account_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn desktop_chat_sync_message_refs(
    account_id: String,
    conversation_ids: Vec<String>,
) -> Result<Vec<ChatSyncMessageRef>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account_id = account_id.trim().to_string();
        if account_id.is_empty() {
            return Err("Chat sync account id is required".to_string());
        }
        let conn = open_db()?;
        load_message_refs(&conn, &account_id, &conversation_ids)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn desktop_chat_sync_messages_page(
    account_id: String,
    conversation_id: String,
    after_sequence: Option<i64>,
    limit: Option<i64>,
) -> Result<ChatSyncMessagePage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account_id = account_id.trim().to_string();
        let conversation_id = conversation_id.trim().to_string();
        if account_id.is_empty() {
            return Err("Chat sync account id is required".to_string());
        }
        if conversation_id.is_empty() {
            return Err("Chat sync conversation id is required".to_string());
        }
        let conn = open_db()?;
        load_message_page(
            &conn,
            &account_id,
            &conversation_id,
            after_sequence,
            limit.unwrap_or(100),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn desktop_chat_sync_recovery_message_ids(
    account_id: String,
    conversation_id: String,
) -> Result<ChatSyncRecoveryMessageIds, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account_id = account_id.trim().to_string();
        let conversation_id = conversation_id.trim().to_string();
        if account_id.is_empty() {
            return Err("Chat sync account id is required".to_string());
        }
        if conversation_id.is_empty() {
            return Err("Chat sync conversation id is required".to_string());
        }
        let conn = open_db()?;
        load_recovery_message_ids(&conn, &account_id, &conversation_id)
    })
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

    use super::test_support::test_connection;
    use super::{apply_event, apply_on_connection, ChatSyncApplyRequest};

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
            "account.profile.updated",
            "account.directory.changed",
            "agent.definition.upserted",
            "agent.definition.archived",
            "agent.directory.changed",
            "provider-auth.updated",
            "task.upsert",
            "artifact.upsert",
            "artifact.archived",
            "session.pin.updated",
            "session.hidden",
            "session.unhidden",
            "session.deleted",
            "session.pinned",
            "session.unpinned",
            "session.muted",
            "session.unmuted",
            "session.marked_unread",
            "session.unmarked_unread",
            "group_space.pinned",
            "group_space.unpinned",
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
                let payload = if *event_type == "session.deleted" {
                    json!({ "sessionId": "session:obsolete" })
                } else {
                    json!({})
                };
                json!({
                    "stream_seq": index as i64 + 1,
                    "protocol_version": 2,
                    "type": event_type,
                    "critical": true,
                    "payload": payload
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

#[cfg(test)]
#[path = "chat_sync/bounded_tests.rs"]
mod bounded_tests;

#[cfg(test)]
#[path = "chat_sync/test_support.rs"]
mod test_support;

#[cfg(test)]
#[path = "chat_sync/unread_tests.rs"]
mod unread_tests;
