use rusqlite::{params, Connection};
use serde_json::Value;

use super::compaction::compact_agent_response_snapshots;
use super::{ChatSyncMessagePage, ChatSyncRecoveryMessageIds};

pub(super) fn load_message_page(
    conn: &Connection,
    account_id: &str,
    conversation_id: &str,
    after_sequence: Option<i64>,
    limit: i64,
) -> Result<ChatSyncMessagePage, String> {
    if after_sequence.is_some_and(|sequence| sequence < 0) {
        return Err("Chat sync message page cursor must be non-negative".to_string());
    }
    if !(1..=200).contains(&limit) {
        return Err("Chat sync message page limit must be between 1 and 200".to_string());
    }
    let mut statement = conn
        .prepare(
            "SELECT conversation_sequence, snapshot_json
             FROM chat_sync_messages
             WHERE account_id = ?1
               AND conversation_id = ?2
               AND conversation_sequence > ?3
             ORDER BY conversation_sequence ASC
             LIMIT ?4",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(
            params![
                account_id,
                conversation_id,
                after_sequence.unwrap_or(0),
                limit + 1
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let has_more = rows.len() > limit as usize;
    let mut messages = Vec::with_capacity(rows.len().min(limit as usize));
    let mut next_after_sequence = None;
    for (sequence, encoded) in rows.into_iter().take(limit as usize) {
        messages.push(serde_json::from_str(&encoded).map_err(|error| error.to_string())?);
        next_after_sequence = Some(sequence);
    }
    Ok(ChatSyncMessagePage {
        conversation_id: conversation_id.to_string(),
        messages,
        next_after_sequence,
        has_more,
    })
}

pub(super) fn load_recovery_message_ids(
    conn: &Connection,
    account_id: &str,
    conversation_id: &str,
) -> Result<ChatSyncRecoveryMessageIds, String> {
    let mut statement = conn
        .prepare(
            "SELECT snapshot_json
             FROM chat_sync_messages
             WHERE account_id = ?1 AND conversation_id = ?2
             ORDER BY conversation_sequence ASC",
        )
        .map_err(|error| error.to_string())?;
    let messages = statement
        .query_map(params![account_id, conversation_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?
        .map(|row| {
            row.map_err(|error| error.to_string()).and_then(|encoded| {
                serde_json::from_str(&encoded).map_err(|error| error.to_string())
            })
        })
        .collect::<Result<Vec<Value>, String>>()?;
    let message_ids = compact_agent_response_snapshots(messages)
        .into_iter()
        .filter_map(|message| {
            message
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    Ok(ChatSyncRecoveryMessageIds {
        conversation_id: conversation_id.to_string(),
        message_ids,
    })
}
