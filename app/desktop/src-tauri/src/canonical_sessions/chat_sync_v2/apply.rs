use super::*;

pub(super) fn load_state(
    conn: &Connection,
    account_id: &str,
) -> Result<ChatSyncV2LocalState, String> {
    let state: Option<(String, i64)> = conn
        .query_row(
            "SELECT cursor, last_stream_seq FROM chat_sync_v2_state WHERE account_id = ?1",
            [account_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let mut conversation_statement = conn
        .prepare(
            "SELECT snapshot_json FROM chat_sync_v2_conversations
             WHERE account_id = ?1 ORDER BY conversation_id ASC",
        )
        .map_err(|error| error.to_string())?;
    let conversations = conversation_statement
        .query_map([account_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .map(|row| {
            row.map_err(|error| error.to_string()).and_then(|encoded| {
                serde_json::from_str(&encoded).map_err(|error| error.to_string())
            })
        })
        .collect::<Result<Vec<Value>, String>>()?;
    let mut message_statement = conn
        .prepare(
            "SELECT snapshot_json FROM chat_sync_v2_messages
             WHERE account_id = ?1
             ORDER BY conversation_id ASC, conversation_sequence ASC",
        )
        .map_err(|error| error.to_string())?;
    let messages = message_statement
        .query_map([account_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .map(|row| {
            row.map_err(|error| error.to_string()).and_then(|encoded| {
                serde_json::from_str(&encoded).map_err(|error| error.to_string())
            })
        })
        .collect::<Result<Vec<Value>, String>>()?;
    Ok(ChatSyncV2LocalState {
        account_id: account_id.to_string(),
        cursor: state.as_ref().map(|value| value.0.clone()),
        last_stream_seq: state.map(|value| value.1).unwrap_or(0),
        conversations,
        messages,
    })
}

pub(super) fn apply(request: ChatSyncV2ApplyRequest) -> Result<ChatSyncV2LocalState, String> {
    let mut conn = open_db()?;
    apply_on_connection(&mut conn, request)
}

pub(super) fn apply_on_connection(
    conn: &mut Connection,
    request: ChatSyncV2ApplyRequest,
) -> Result<ChatSyncV2LocalState, String> {
    let account_id = request.account_id.trim();
    if account_id.is_empty() {
        return Err("Chat sync v2 account id is required".to_string());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let previous_stream_seq: i64 = tx
        .query_row(
            "SELECT last_stream_seq FROM chat_sync_v2_state WHERE account_id = ?1",
            [account_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or(0);

    if request.bootstrap {
        tx.execute(
            "DELETE FROM chat_sync_v2_messages WHERE account_id = ?1",
            [account_id],
        )
        .map_err(|error| error.to_string())?;
        tx.execute(
            "DELETE FROM chat_sync_v2_conversations WHERE account_id = ?1",
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
            "Chat sync v2 cursor and stream sequence must commit together".to_string()
        })?;
        if stream_seq < 0 {
            return Err("Chat sync v2 stream sequence is invalid".to_string());
        }
        if !request.bootstrap && !request.events.is_empty() {
            let applied = required_i64(
                request.events.last().expect("non-empty events"),
                "stream_seq",
            )?;
            if stream_seq != applied {
                return Err(
                    "Chat sync v2 cursor does not match the applied event batch".to_string()
                );
            }
        }
        tx.execute(
            "INSERT INTO chat_sync_v2_state(account_id, cursor, last_stream_seq, updated_at_ms)
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
    load_state(conn, account_id)
}
