use super::compaction::{compact_agent_response_snapshots, compact_startup_snapshots};
use super::*;
use std::collections::HashSet;

const STARTUP_TAIL_PER_CONVERSATION: i64 = 64;

pub(super) fn load_cursor_state(
    conn: &Connection,
    account_id: &str,
) -> Result<ChatSyncCursorState, String> {
    let state: Option<(String, i64)> = conn
        .query_row(
            "SELECT cursor, last_stream_seq FROM chat_sync_state WHERE account_id = ?1",
            [account_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(ChatSyncCursorState {
        account_id: account_id.to_string(),
        cursor: state.as_ref().map(|value| value.0.clone()),
        last_stream_seq: state.map(|value| value.1).unwrap_or(0),
    })
}

pub(super) fn load_coverage(
    conn: &Connection,
    account_id: &str,
) -> Result<Vec<ChatSyncConversationCoverage>, String> {
    let mut statement = conn
        .prepare(
            "SELECT conversation_id,
                    MIN(conversation_sequence),
                    MAX(conversation_sequence),
                    COUNT(*)
             FROM chat_sync_messages
             WHERE account_id = ?1
             GROUP BY conversation_id
             ORDER BY conversation_id ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([account_id], |row| {
            Ok(ChatSyncConversationCoverage {
                conversation_id: row.get(0)?,
                earliest_sequence: row.get(1)?,
                latest_sequence: row.get(2)?,
                message_count: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub(super) fn load_state(
    conn: &Connection,
    account_id: &str,
) -> Result<ChatSyncLocalState, String> {
    let cursor = load_cursor_state(conn, account_id)?;
    let conversations = load_conversations(conn, account_id)?;
    let direct_conversation_ids = conversations
        .iter()
        .filter(|conversation| conversation.get("kind").and_then(Value::as_str) == Some("direct"))
        .filter_map(|conversation| conversation.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<HashSet<_>>();
    let mut message_statement = conn
        .prepare(
            "WITH tails AS (
                 SELECT snapshot_json,
                        conversation_id,
                        conversation_sequence,
                        ROW_NUMBER() OVER (
                            PARTITION BY conversation_id
                            ORDER BY conversation_sequence DESC
                        ) AS recency_rank
                 FROM chat_sync_messages
                 WHERE account_id = ?1
             ),
             routes AS (
                 SELECT snapshot_json,
                        conversation_id,
                        conversation_sequence,
                        ROW_NUMBER() OVER (
                            PARTITION BY conversation_id
                            ORDER BY conversation_sequence DESC
                        ) AS route_rank
                 FROM chat_sync_messages
                 WHERE account_id = ?1
                   AND message_kind = 'agent-model-change'
             )
             SELECT snapshot_json FROM (
                 SELECT snapshot_json, conversation_id, conversation_sequence
                 FROM tails WHERE recency_rank <= ?2
                 UNION
                 SELECT snapshot_json, conversation_id, conversation_sequence
                 FROM routes WHERE route_rank = 1
             )
             ORDER BY conversation_id ASC, conversation_sequence ASC",
        )
        .map_err(|error| error.to_string())?;
    let messages = message_statement
        .query_map(params![account_id, STARTUP_TAIL_PER_CONVERSATION], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?
        .map(|row| {
            row.map_err(|error| error.to_string()).and_then(|encoded| {
                serde_json::from_str(&encoded).map_err(|error| error.to_string())
            })
        })
        .collect::<Result<Vec<Value>, String>>()?;
    let messages = compact_startup_snapshots(
        compact_agent_response_snapshots(messages),
        &direct_conversation_ids,
    );
    Ok(ChatSyncLocalState {
        account_id: account_id.to_string(),
        cursor: cursor.cursor,
        last_stream_seq: cursor.last_stream_seq,
        conversations,
        messages,
    })
}

pub(super) fn load_conversations(
    conn: &Connection,
    account_id: &str,
) -> Result<Vec<Value>, String> {
    let mut conversation_statement = conn
        .prepare(
            "SELECT snapshot_json FROM chat_sync_conversations
             WHERE account_id = ?1 ORDER BY conversation_id ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = conversation_statement
        .query_map([account_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        row.map_err(|error| error.to_string())
            .and_then(|encoded| serde_json::from_str(&encoded).map_err(|error| error.to_string()))
    })
    .collect::<Result<Vec<Value>, String>>()
}

pub(super) fn load_message_refs(
    conn: &Connection,
    account_id: &str,
    conversation_ids: &[String],
) -> Result<Vec<ChatSyncMessageRef>, String> {
    let mut statement = conn
        .prepare(
            "SELECT message_id,
                    conversation_id,
                    client_message_id
             FROM chat_sync_messages
             WHERE account_id = ?1
               AND conversation_id = ?2
               AND client_message_id IS NOT NULL
             ORDER BY conversation_sequence ASC",
        )
        .map_err(|error| error.to_string())?;
    let mut refs = Vec::new();
    let conversation_ids = conversation_ids
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .collect::<std::collections::BTreeSet<_>>();
    for conversation_id in conversation_ids {
        let rows = statement
            .query_map(params![account_id, conversation_id], |row| {
                Ok(ChatSyncMessageRef {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    client_message_id: row.get(2)?,
                })
            })
            .map_err(|error| error.to_string())?;
        refs.extend(
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?,
        );
    }
    Ok(refs)
}

pub(super) fn apply(request: ChatSyncApplyRequest) -> Result<ChatSyncApplyResult, String> {
    let mut conn = open_db()?;
    apply_on_connection(&mut conn, request)
}

pub(super) fn apply_on_connection(
    conn: &mut Connection,
    request: ChatSyncApplyRequest,
) -> Result<ChatSyncApplyResult, String> {
    let account_id = request.account_id.trim();
    if account_id.is_empty() {
        return Err("Chat sync account id is required".to_string());
    }
    let changed_conversation_ids = changed_conversation_ids(&request);
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let previous_stream_seq: i64 = tx
        .query_row(
            "SELECT last_stream_seq FROM chat_sync_state WHERE account_id = ?1",
            [account_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or(0);

    if request.bootstrap {
        tx.execute(
            "DELETE FROM chat_sync_messages WHERE account_id = ?1",
            [account_id],
        )
        .map_err(|error| error.to_string())?;
        tx.execute(
            "DELETE FROM chat_sync_conversations WHERE account_id = ?1",
            [account_id],
        )
        .map_err(|error| error.to_string())?;
    } else if !request.events.is_empty() {
        let first = required_i64(&request.events[0], "stream_seq")?;
        if first != previous_stream_seq + 1 {
            return Err(format!(
                "STREAM_SEQUENCE_GAP: expected {}, received {first}",
                previous_stream_seq + 1
            ));
        }
        for (expected, event) in (first..).zip(&request.events) {
            let sequence = required_i64(event, "stream_seq")?;
            if sequence != expected {
                return Err(format!(
                    "STREAM_SEQUENCE_GAP: expected {expected}, received {sequence}"
                ));
            }
        }
    }

    for conversation in &request.conversations {
        upsert_conversation(&tx, account_id, conversation)?;
    }
    for message in &request.messages {
        upsert_message(&tx, account_id, message)?;
    }
    for event in &request.events {
        apply_event(&tx, account_id, event)?;
    }

    if let Some(cursor) = request
        .cursor
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let stream_seq = request.last_stream_seq.ok_or_else(|| {
            "Chat sync cursor and stream sequence must commit together".to_string()
        })?;
        if stream_seq < 0 {
            return Err("Chat sync stream sequence is invalid".to_string());
        }
        if !request.bootstrap && !request.events.is_empty() {
            let applied = required_i64(
                request.events.last().expect("non-empty events"),
                "stream_seq",
            )?;
            if stream_seq != applied {
                return Err("Chat sync cursor does not match the applied event batch".to_string());
            }
        }
        tx.execute(
            "INSERT INTO chat_sync_state(account_id, cursor, last_stream_seq, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(account_id) DO UPDATE SET
                 cursor = excluded.cursor,
                 last_stream_seq = excluded.last_stream_seq,
                 updated_at_ms = excluded.updated_at_ms",
            params![account_id, cursor, stream_seq, now_ms()],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    let cursor = load_cursor_state(conn, account_id)?;
    Ok(ChatSyncApplyResult {
        account_id: account_id.to_string(),
        cursor: cursor.cursor,
        last_stream_seq: cursor.last_stream_seq,
        changed_conversation_heads: load_conversation_heads(
            conn,
            account_id,
            &changed_conversation_ids,
        )?,
    })
}

fn changed_conversation_ids(request: &ChatSyncApplyRequest) -> std::collections::BTreeSet<String> {
    let mut ids = std::collections::BTreeSet::new();
    let mut add = |value: Option<&Value>, key: &str| {
        if let Some(id) = value
            .and_then(|value| value.get(key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            ids.insert(id.to_string());
        }
    };
    for conversation in &request.conversations {
        add(Some(conversation), "id");
    }
    for message in &request.messages {
        add(Some(message), "conversation_id");
    }
    for event in &request.events {
        add(Some(event), "conversation_id");
        add(event.pointer("/payload/conversation"), "id");
        add(event.pointer("/payload/message"), "conversation_id");
    }
    ids
}

fn load_conversation_heads(
    conn: &Connection,
    account_id: &str,
    conversation_ids: &std::collections::BTreeSet<String>,
) -> Result<Vec<ChatSyncConversationHead>, String> {
    let mut statement = conn
        .prepare(
            "SELECT snapshot_json FROM chat_sync_conversations
             WHERE account_id = ?1 AND conversation_id = ?2",
        )
        .map_err(|error| error.to_string())?;
    let mut heads = Vec::with_capacity(conversation_ids.len());
    for conversation_id in conversation_ids {
        let snapshot: Option<String> = statement
            .query_row(params![account_id, conversation_id], |row| row.get(0))
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(snapshot) = snapshot else { continue };
        let snapshot: Value = serde_json::from_str(&snapshot).map_err(|error| error.to_string())?;
        heads.push(ChatSyncConversationHead {
            conversation_id: conversation_id.clone(),
            latest_message_sequence: snapshot
                .get("latest_message_sequence")
                .and_then(Value::as_i64)
                .unwrap_or(0),
        });
    }
    Ok(heads)
}
