//! Atomic convergence of a local-first message and its delayed Cloud mirror.

use rusqlite::{params, Connection, TransactionBehavior};
use serde_json::Value;

use super::super::{hash_hex, now_ms, open_db, select_message};

fn replace_json_message_reference(
    value: &mut Value,
    duplicate_message_id: &str,
    preferred_message_id: &str,
) -> bool {
    match value {
        Value::Array(values) => {
            let mut changed = false;
            for value in values {
                changed |= replace_json_message_reference(
                    value,
                    duplicate_message_id,
                    preferred_message_id,
                );
            }
            changed
        }
        Value::Object(values) => {
            let mut changed = false;
            for (key, value) in values {
                let replaced = match key.as_str() {
                    "replyToMessageId"
                    | "requestId"
                    | "requestMessageId"
                    | "sourceMessageId"
                    | "sessionTitleGeneratedFromMessageId"
                    | "forkedFromMessageId" => match value {
                        Value::String(current) if current == duplicate_message_id => {
                            *current = preferred_message_id.to_string();
                            true
                        }
                        _ => false,
                    },
                    "forkedFromMessageAliases" => match value {
                        Value::Array(values) => {
                            let mut aliases_changed = false;
                            for value in values {
                                let replaced = matches!(value, Value::String(current) if current == duplicate_message_id);
                                if replaced {
                                    *value = Value::String(preferred_message_id.to_string());
                                }
                                aliases_changed |= replaced;
                            }
                            aliases_changed
                        }
                        _ => false,
                    },
                    _ => replace_json_message_reference(
                        value,
                        duplicate_message_id,
                        preferred_message_id,
                    ),
                };
                changed |= replaced;
            }
            changed
        }
        _ => false,
    }
}

pub(super) fn reconcile_canonical_message_mirror_in_db(
    conn: &mut Connection,
    preferred_message_id: &str,
    duplicate_message_id: &str,
) -> Result<bool, String> {
    let preferred_message_id = preferred_message_id.trim();
    let duplicate_message_id = duplicate_message_id.trim();
    if preferred_message_id.is_empty()
        || duplicate_message_id.is_empty()
        || preferred_message_id == duplicate_message_id
    {
        return Err("Two distinct canonical message ids are required".to_string());
    }

    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let Some(preferred) = select_message(&transaction, preferred_message_id)? else {
        return Ok(false);
    };
    let preferred_is_local = matches!(
        preferred.source_transport.as_deref(),
        Some("desktop-chat-ui" | "desktop-chat")
    );
    if !preferred_is_local || preferred.sender_role != "user" {
        return Err("Canonical mirror reconciliation requires a local user message".to_string());
    }
    let Some(duplicate) = select_message(&transaction, duplicate_message_id)? else {
        // A command can commit while its IPC response is lost. A missing
        // duplicate is therefore an idempotent success on retry.
        return Ok(true);
    };
    let duplicate_is_cloud = duplicate.source_transport.as_deref() == Some("cloud-self-agent");
    if !duplicate_is_cloud
        || preferred.session_id != duplicate.session_id
        || preferred.sender_identity_id != duplicate.sender_identity_id
        || duplicate.sender_role != "user"
        || preferred.message_kind != duplicate.message_kind
        || preferred.content_text.trim() != duplicate.content_text.trim()
    {
        return Err("Canonical mirror reconciliation did not match one user intent".to_string());
    }

    transaction
        .execute(
            "UPDATE session_messages SET parent_message_id = ?1 WHERE parent_message_id = ?2",
            params![preferred_message_id, duplicate_message_id],
        )
        .map_err(|error| error.to_string())?;
    let message_content_rows = {
        let mut statement = transaction
            .prepare(
                "SELECT id, content_text, content_json
                 FROM session_messages
                 WHERE content_json IS NOT NULL
                   AND INSTR(content_json, ?1) > 0",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![duplicate_message_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    for (message_id, content_text, content_json) in message_content_rows {
        let Ok(mut content) = serde_json::from_str::<Value>(&content_json) else {
            continue;
        };
        if !replace_json_message_reference(&mut content, duplicate_message_id, preferred_message_id)
        {
            continue;
        }
        let content_json = serde_json::to_string(&content).map_err(|error| error.to_string())?;
        let content_hash = hash_hex(&format!("{content_text}|{content_json}"), 16);
        transaction
            .execute(
                "UPDATE session_messages
                 SET content_json = ?1, content_hash = ?2
                 WHERE id = ?3",
                params![content_json, content_hash, message_id],
            )
            .map_err(|error| error.to_string())?;
    }
    let session_metadata_rows = {
        let mut statement = transaction
            .prepare(
                "SELECT id, metadata_json
                 FROM sessions
                 WHERE metadata_json IS NOT NULL
                   AND INSTR(metadata_json, ?1) > 0",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![duplicate_message_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    for (session_id, metadata_json) in session_metadata_rows {
        let Ok(mut metadata) = serde_json::from_str::<Value>(&metadata_json) else {
            continue;
        };
        if !replace_json_message_reference(
            &mut metadata,
            duplicate_message_id,
            preferred_message_id,
        ) {
            continue;
        }
        transaction
            .execute(
                "UPDATE sessions SET metadata_json = ?1 WHERE id = ?2",
                params![
                    serde_json::to_string(&metadata).map_err(|error| error.to_string())?,
                    session_id,
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction
        .execute(
            "UPDATE session_participants SET last_read_message_id = ?1
             WHERE last_read_message_id = ?2",
            params![preferred_message_id, duplicate_message_id],
        )
        .map_err(|error| error.to_string())?;
    for column in [
        "trigger_message_id",
        "request_message_id",
        "response_message_id",
    ] {
        transaction
            .execute(
                &format!("UPDATE delegated_exchanges SET {column} = ?1 WHERE {column} = ?2"),
                params![preferred_message_id, duplicate_message_id],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction
        .execute(
            "UPDATE context_snapshots
             SET upto_message_id = ?1,
                 invalidated_at_ms = COALESCE(invalidated_at_ms, ?2)
             WHERE upto_message_id = ?3",
            params![preferred_message_id, now_ms(), duplicate_message_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM kv_cache_entries WHERE session_id = ?1",
            params![preferred.session_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM session_messages WHERE id = ?1",
            params![duplicate_message_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE sessions
             SET last_message_at_ms = (
                 SELECT MAX(created_at_ms) FROM session_messages WHERE session_id = ?1
             )
             WHERE id = ?1",
            params![preferred.session_id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(true)
}

pub(in crate::canonical_sessions) fn desktop_canonical_reconcile_message_mirror(
    preferred_message_id: String,
    duplicate_message_id: String,
) -> Result<bool, String> {
    let mut conn = open_db()?;
    reconcile_canonical_message_mirror_in_db(
        &mut conn,
        &preferred_message_id,
        &duplicate_message_id,
    )
}
