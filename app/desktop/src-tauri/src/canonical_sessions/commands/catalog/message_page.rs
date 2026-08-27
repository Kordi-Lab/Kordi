//! Bounded transcript page loading for a canonical session.

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use super::super::super::{open_db, CanonicalMessagePage, CanonicalSessionMessage};
use super::rows::canonical_message_from_row;

fn cloud_group_wire_message_id(message: &CanonicalSessionMessage) -> Option<&str> {
    if message.sender_role != "user" || message.source_transport.as_deref() != Some("cloud-group") {
        return None;
    }
    message
        .source_event_id
        .as_deref()?
        .strip_prefix("cloud-group:")?
        .split(':')
        .next()
        .filter(|value| !value.is_empty())
}

fn attach_cloud_group_read_receipts(
    conn: &Connection,
    messages: &mut [CanonicalSessionMessage],
) -> Result<(), String> {
    let requested = messages
        .iter()
        .filter_map(|message| {
            cloud_group_wire_message_id(message).map(|wire_message_id| {
                json!({
                    "canonicalMessageId": message.id,
                    "wireMessageId": wire_message_id,
                })
            })
        })
        .collect::<Vec<_>>();
    if requested.is_empty() {
        return Ok(());
    }
    let encoded = serde_json::to_string(&requested).map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT json_extract(request.value, '$.canonicalMessageId'),
                    wire.conversation_sequence,
                    wire.snapshot_json,
                    conversation.snapshot_json
             FROM json_each(?1) AS request
             JOIN chat_sync_messages AS wire
               ON wire.message_id = json_extract(request.value, '$.wireMessageId')
             JOIN chat_sync_conversations AS conversation
               ON conversation.account_id = wire.account_id
              AND conversation.conversation_id = wire.conversation_id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([encoded], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut summaries = HashMap::new();
    for row in rows {
        let (message_id, sequence, wire_json, conversation_json) =
            row.map_err(|error| error.to_string())?;
        let wire: Value = serde_json::from_str(&wire_json).map_err(|error| error.to_string())?;
        let conversation: Value =
            serde_json::from_str(&conversation_json).map_err(|error| error.to_string())?;
        let viewer_account_id = conversation
            .pointer("/preferences/account_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if wire.get("sender_account_id").and_then(Value::as_str) != Some(viewer_account_id) {
            continue;
        }
        let mut readers = conversation
            .get("members")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|member| {
                let account_id = member.get("account_id")?.as_str()?;
                (account_id != viewer_account_id
                    && member.get("membership_state").and_then(Value::as_str) == Some("active")
                    && member
                        .get("last_read_sequence")
                        .and_then(Value::as_i64)
                        .unwrap_or_default()
                        >= sequence)
                    .then(|| {
                        json!({
                            "accountId": account_id,
                            "identityId": format!("human:{account_id}"),
                            "readAt": null,
                        })
                    })
            })
            .collect::<Vec<_>>();
        readers.sort_by(|left, right| {
            left.get("accountId")
                .and_then(Value::as_str)
                .cmp(&right.get("accountId").and_then(Value::as_str))
        });
        summaries.insert(message_id, readers);
    }
    for message in messages {
        let Some(readers) = summaries.remove(&message.id) else {
            continue;
        };
        let content = message.content.get_or_insert_with(|| json!({}));
        let Some(content) = content.as_object_mut() else {
            continue;
        };
        content.insert(
            "deliveryState".to_string(),
            Value::String(
                if readers.is_empty() {
                    "delivered"
                } else {
                    "read"
                }
                .to_string(),
            ),
        );
        content.insert(
            "readReceiptSummary".to_string(),
            if readers.is_empty() {
                Value::Null
            } else {
                json!({ "count": readers.len(), "participants": readers })
            },
        );
    }
    Ok(())
}

pub(in crate::canonical_sessions::commands) fn load_message_page_from_db(
    conn: &Connection,
    session_id: &str,
    before_sequence_num: Option<i64>,
    limit: Option<i64>,
) -> Result<CanonicalMessagePage, String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err("Session id is required".to_string());
    }
    let limit = limit.unwrap_or(100).clamp(25, 200) as usize;
    let mut stmt = conn
        .prepare(
            "SELECT
                id, session_id, sender_identity_id, sender_role, message_kind,
                content_text, content_json, parent_message_id, delegated_exchange_id,
                status, sequence_num, created_at_ms, updated_at_ms, content_hash,
                source_transport, source_event_id
             FROM session_messages
             WHERE session_id = ?1
               AND (?2 IS NULL OR sequence_num < ?2)
             ORDER BY sequence_num DESC, created_at_ms DESC, id DESC
             LIMIT ?3",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(
            params![session_id, before_sequence_num, (limit + 1) as i64],
            canonical_message_from_row,
        )
        .map_err(|err| err.to_string())?;
    let mut messages = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    let has_older = messages.len() > limit;
    messages.truncate(limit);
    messages.reverse();
    attach_cloud_group_read_receipts(conn, &mut messages)?;
    let oldest_sequence_num = messages.first().map(|message| message.sequence_num);
    let newest_sequence_num = messages.last().map(|message| message.sequence_num);

    Ok(CanonicalMessagePage {
        session_id: session_id.to_string(),
        messages,
        oldest_sequence_num,
        newest_sequence_num,
        has_older,
    })
}

pub(in crate::canonical_sessions) fn desktop_canonical_session_messages(
    session_id: &str,
    before_sequence_num: Option<i64>,
    limit: Option<i64>,
) -> Result<CanonicalMessagePage, String> {
    let conn = open_db()?;
    load_message_page_from_db(&conn, session_id, before_sequence_num, limit)
}
