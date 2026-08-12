use super::*;

pub(super) fn required_text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Chat sync snapshot is missing {key}"))
}

pub(super) fn required_i64(value: &Value, key: &str) -> Result<i64, String> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("Chat sync snapshot is missing {key}"))
}

pub(super) fn upsert_conversation(
    tx: &Transaction<'_>,
    account_id: &str,
    conversation: &Value,
) -> Result<(), String> {
    let conversation_id = required_text(conversation, "id")?;
    let version = required_i64(conversation, "version")?;
    if version < 1 {
        return Err("Chat sync conversation version is invalid".to_string());
    }
    let client_session_id = conversation
        .get("legacy_session_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let encoded = serde_json::to_string(conversation).map_err(|error| error.to_string())?;
    tx.execute(
        "INSERT INTO chat_sync_conversations
         (account_id, conversation_id, client_session_id, version, snapshot_json, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(account_id, conversation_id) DO UPDATE SET
             client_session_id = excluded.client_session_id,
             version = excluded.version,
             snapshot_json = excluded.snapshot_json,
             updated_at_ms = excluded.updated_at_ms
         WHERE excluded.version >= chat_sync_conversations.version",
        params![
            account_id,
            conversation_id,
            client_session_id,
            version,
            encoded,
            now_ms(),
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn upsert_message(
    tx: &Transaction<'_>,
    account_id: &str,
    message: &Value,
) -> Result<(), String> {
    let message_id = required_text(message, "id")?;
    let conversation_id = required_text(message, "conversation_id")?;
    let sequence = required_i64(message, "conversation_sequence")?;
    let version = required_i64(message, "version")?;
    if sequence < 1 || version < 1 {
        return Err("Chat sync message sequence or version is invalid".to_string());
    }
    let encoded = serde_json::to_string(message).map_err(|error| error.to_string())?;
    tx.execute(
        "INSERT INTO chat_sync_messages
         (account_id, message_id, conversation_id, conversation_sequence, version, snapshot_json, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(account_id, message_id) DO UPDATE SET
             conversation_id = excluded.conversation_id,
             conversation_sequence = excluded.conversation_sequence,
             version = excluded.version,
             snapshot_json = excluded.snapshot_json,
             updated_at_ms = excluded.updated_at_ms
         WHERE excluded.version >= chat_sync_messages.version",
        params![
            account_id,
            message_id,
            conversation_id,
            sequence,
            version,
            encoded,
            now_ms(),
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn merge_conversation_projection(
    tx: &Transaction<'_>,
    account_id: &str,
    conversation_id: &str,
    update: impl FnOnce(&mut serde_json::Map<String, Value>),
) -> Result<(), String> {
    let stored: Option<String> = tx
        .query_row(
            "SELECT snapshot_json FROM chat_sync_conversations
             WHERE account_id = ?1 AND conversation_id = ?2",
            params![account_id, conversation_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(stored) = stored else {
        return Err("Chat sync event references an unknown conversation".to_string());
    };
    let mut snapshot: Value = serde_json::from_str(&stored).map_err(|error| error.to_string())?;
    let object = snapshot
        .as_object_mut()
        .ok_or_else(|| "Stored chat sync conversation is invalid".to_string())?;
    update(object);
    let encoded = serde_json::to_string(&snapshot).map_err(|error| error.to_string())?;
    tx.execute(
        "UPDATE chat_sync_conversations
         SET snapshot_json = ?1, updated_at_ms = ?2
         WHERE account_id = ?3 AND conversation_id = ?4",
        params![encoded, now_ms(), account_id, conversation_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn apply_event(
    tx: &Transaction<'_>,
    account_id: &str,
    event: &Value,
) -> Result<(), String> {
    let protocol_version = required_i64(event, "protocol_version")?;
    if protocol_version != 2 {
        return Err("Unsupported chat sync protocol version".to_string());
    }
    let event_type = required_text(event, "type")?;
    let critical = event
        .get("critical")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let supported = matches!(
        event_type,
        "conversation.created"
            | "conversation.updated"
            | "conversation.preferences.updated"
            | "membership.updated"
            | "membership.removed"
            | "message.created"
            | "message.updated"
            | "message.deleted"
            | "delivery_cursor.updated"
            | "read_cursor.updated"
            | "generation.updated"
            | "generation.completed"
            | "generation.failed"
            | "agent.definition.upserted"
            | "agent.definition.archived"
            | "task.upsert"
            | "artifact.upsert"
            | "artifact.archived"
            | "session.pin.updated"
            | "session.hidden"
            | "session.unhidden"
            | "session.deleted"
            | "session-forked"
    );
    if !supported {
        return if critical {
            Err(format!(
                "CLIENT_UPDATE_REQUIRED: unknown critical event {event_type}"
            ))
        } else {
            Ok(())
        };
    }
    let payload = event
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(|| "Chat sync event payload is invalid".to_string())?;
    if event_type == "membership.removed" {
        let conversation_id = required_text(event, "conversation_id")?;
        let removed_account_id = payload
            .get("account_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if removed_account_id == account_id {
            tx.execute(
                "DELETE FROM chat_sync_messages
                 WHERE account_id = ?1 AND conversation_id = ?2",
                params![account_id, conversation_id],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "DELETE FROM chat_sync_conversations
                 WHERE account_id = ?1 AND conversation_id = ?2",
                params![account_id, conversation_id],
            )
            .map_err(|error| error.to_string())?;
        }
        return Ok(());
    }
    if let Some(conversation) = payload.get("conversation") {
        upsert_conversation(tx, account_id, conversation)?;
    }
    if let Some(message) = payload.get("message") {
        upsert_message(tx, account_id, message)?;
    }
    if event_type == "conversation.preferences.updated" {
        let conversation_id = required_text(event, "conversation_id")?;
        let preferences = payload
            .get("preferences")
            .cloned()
            .ok_or_else(|| "Chat sync preference event is invalid".to_string())?;
        merge_conversation_projection(tx, account_id, conversation_id, |conversation| {
            conversation.insert("preferences".to_string(), preferences);
        })?;
    }
    if matches!(
        event_type,
        "delivery_cursor.updated" | "read_cursor.updated"
    ) {
        let conversation_id = required_text(event, "conversation_id")?;
        let cursor = payload
            .get("cursor")
            .and_then(Value::as_object)
            .ok_or_else(|| "Chat sync cursor event is invalid".to_string())?;
        let cursor_account_id = cursor
            .get("account_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let delivered = cursor
            .get("last_delivered_sequence")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let read = cursor
            .get("last_read_sequence")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        merge_conversation_projection(tx, account_id, conversation_id, |conversation| {
            if let Some(members) = conversation
                .get_mut("members")
                .and_then(Value::as_array_mut)
            {
                for member in members {
                    if member.get("account_id").and_then(Value::as_str) != Some(&cursor_account_id)
                    {
                        continue;
                    }
                    if let Some(member) = member.as_object_mut() {
                        member.insert(
                            "last_delivered_sequence".to_string(),
                            Value::from(delivered),
                        );
                        member.insert("last_read_sequence".to_string(), Value::from(read));
                    }
                }
            }
        })?;
    }
    Ok(())
}
