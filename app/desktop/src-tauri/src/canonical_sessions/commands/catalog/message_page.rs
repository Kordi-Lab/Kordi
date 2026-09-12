//! Bounded transcript page loading for a canonical session.

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use super::super::super::{
    open_db, CanonicalMessagePage, CanonicalSessionMessage, CanonicalTimelineCursor,
};
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
    let mut mutation_metadata = HashMap::new();
    for row in rows {
        let (message_id, sequence, wire_json, conversation_json) =
            row.map_err(|error| error.to_string())?;
        let wire: Value = serde_json::from_str(&wire_json).map_err(|error| error.to_string())?;
        let conversation: Value =
            serde_json::from_str(&conversation_json).map_err(|error| error.to_string())?;
        mutation_metadata.insert(
            message_id.clone(),
            (
                wire.get("version").and_then(Value::as_i64),
                wire.get("edited_at").cloned().unwrap_or(Value::Null),
            ),
        );
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
        let content = message.content.get_or_insert_with(|| json!({}));
        let Some(content) = content.as_object_mut() else {
            continue;
        };
        if let Some((version, edited_at)) = mutation_metadata.remove(&message.id) {
            if let Some(version) = version {
                content.insert("cloudMessageVersion".to_string(), Value::from(version));
            }
            content.insert("editedAt".to_string(), edited_at);
        }
        let Some(readers) = summaries.remove(&message.id) else {
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

pub(in crate::canonical_sessions) fn load_timeline_page_from_db(
    conn: &Connection,
    session_id: &str,
    before: Option<&CanonicalTimelineCursor>,
    limit: Option<i64>,
) -> Result<CanonicalMessagePage, String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err("Session id is required".into());
    }
    let limit = limit.unwrap_or(100).clamp(25, 200) as usize;
    let boundary = if before.is_some() {
        "AND (created_at_ms, sequence_num, id) < (?2, ?3, ?4)"
    } else {
        ""
    };
    let sql = format!(
        "SELECT id, session_id, sender_identity_id, sender_role, message_kind,
                content_text, content_json, parent_message_id, delegated_exchange_id,
                status, sequence_num, created_at_ms, updated_at_ms, content_hash,
                source_transport, source_event_id
         FROM session_messages
         WHERE session_id = ?1
           {boundary}
         ORDER BY created_at_ms DESC, sequence_num DESC, id DESC LIMIT ?5"
    );
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let mut messages = statement
        .query_map(
            params![
                session_id,
                before.map(|cursor| cursor.created_at_ms),
                before.map(|cursor| cursor.sequence_num),
                before.map(|cursor| cursor.id.as_str()),
                (limit + 1) as i64,
            ],
            canonical_message_from_row,
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let has_older = messages.len() > limit;
    messages.truncate(limit);
    messages.reverse();
    attach_cloud_group_read_receipts(conn, &mut messages)?;
    Ok(CanonicalMessagePage {
        session_id: session_id.into(),
        oldest_sequence_num: messages.first().map(|message| message.sequence_num),
        newest_sequence_num: messages.last().map(|message| message.sequence_num),
        messages,
        has_older,
    })
}

pub(in crate::canonical_sessions) fn desktop_canonical_session_messages(
    session_id: &str,
    before_sequence_num: Option<i64>,
    limit: Option<i64>,
    timeline_order: bool,
    before_timeline: Option<&CanonicalTimelineCursor>,
) -> Result<CanonicalMessagePage, String> {
    let conn = open_db()?;
    if timeline_order {
        load_timeline_page_from_db(&conn, session_id, before_timeline, limit)
    } else {
        load_message_page_from_db(&conn, session_id, before_sequence_num, limit)
    }
}

#[cfg(test)]
mod timeline_tests {
    use super::*;

    #[test]
    fn timeline_pages_keep_late_replayed_joins_with_their_history_and_handle_ties() {
        let conn = Connection::open_in_memory().unwrap();
        crate::canonical_sessions::schema::initialize_schema(&conn).unwrap();
        conn.execute("INSERT INTO identities (id,kind,display_name,source,avatar_key,created_at_ms,updated_at_ms)
            VALUES ('human:test','human','Test','local','test',1,1)", []).unwrap();
        conn.execute("INSERT INTO sessions (id,kind,title,status,created_by_identity_id,created_at_ms,updated_at_ms,last_message_at_ms)
            VALUES ('group:test','group','Test','active','human:test',1,1,200)", []).unwrap();
        let insert = |id: &str, sequence: i64, time: i64, role: &str| {
            conn.execute("INSERT INTO session_messages (id,session_id,sender_identity_id,sender_role,message_kind,
                content_text,status,sequence_num,created_at_ms,updated_at_ms)
                VALUES (?1,'group:test','human:test',?4,'text','Synthetic','sent',?2,?3,?3)",
                params![id, sequence, time, role]).unwrap();
        };
        for index in 1..=120 {
            insert(&format!("user:{index:03}"), index, index, "person");
        }
        insert("join:old", 999, 2, "system");
        // Identical timestamps and sequences must not lose a row across a page boundary.
        for index in 0..30 {
            insert(&format!("tie:{index:03}"), 500, 70, "person");
        }
        let legacy = load_message_page_from_db(&conn, "group:test", None, Some(25)).unwrap();
        assert!(legacy
            .messages
            .iter()
            .any(|message| message.id == "join:old"));
        let mut cursor = None;
        let mut loaded = Vec::new();
        loop {
            let page =
                load_timeline_page_from_db(&conn, "group:test", cursor.as_ref(), Some(25)).unwrap();
            if cursor.is_none() {
                assert!(page
                    .messages
                    .iter()
                    .all(|message| message.created_at_ms >= 96));
            }
            if let Some(first) = page.messages.first() {
                cursor = Some(CanonicalTimelineCursor {
                    id: first.id.clone(),
                    created_at_ms: first.created_at_ms,
                    sequence_num: first.sequence_num,
                });
            }
            loaded.splice(0..0, page.messages);
            if !page.has_older {
                break;
            }
        }
        assert_eq!(loaded.len(), 151);
        assert_eq!(
            loaded
                .iter()
                .map(|row| &row.id)
                .collect::<std::collections::HashSet<_>>()
                .len(),
            151
        );
        assert!(loaded.windows(2).all(|pair| (
            pair[0].created_at_ms,
            pair[0].sequence_num,
            &pair[0].id
        ) < (
            pair[1].created_at_ms,
            pair[1].sequence_num,
            &pair[1].id
        )));
        assert_eq!(loaded[2].id, "join:old");
        // Cursor values remain usable if the boundary message is deleted during the request.
        let first = load_timeline_page_from_db(&conn, "group:test", None, Some(25)).unwrap();
        let row = &first.messages[0];
        let cursor = CanonicalTimelineCursor {
            id: row.id.clone(),
            created_at_ms: row.created_at_ms,
            sequence_num: row.sequence_num,
        };
        conn.execute("DELETE FROM session_messages WHERE id=?1", [&row.id])
            .unwrap();
        let next =
            load_timeline_page_from_db(&conn, "group:test", Some(&cursor), Some(25)).unwrap();
        assert_eq!(next.messages.last().unwrap().created_at_ms, 95);
    }
}
