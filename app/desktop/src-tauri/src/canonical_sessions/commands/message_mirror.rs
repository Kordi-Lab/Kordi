//! Atomic convergence of a local-first message and its delayed Cloud mirror.

mod exported_intent;
pub(super) use exported_intent::cloud_request_client_message_id;
use exported_intent::exported_agent_intent_matches;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::super::{hash_hex, now_ms, open_db, select_message};

fn exact_cloud_history_reply_echo(
    conn: &Connection,
    preferred: &super::super::CanonicalSessionMessage,
    duplicate: &super::super::CanonicalSessionMessage,
) -> Result<Option<String>, String> {
    if preferred.source_transport.as_deref() != Some("cloud-self-agent")
        || duplicate.source_transport.as_deref() != Some("cloud-self-agent")
        || preferred.session_id != duplicate.session_id
        || preferred.sender_role != "owned-agent"
        || duplicate.sender_role != "owned-agent"
        || preferred.message_kind != "agent-turn"
        || duplicate.message_kind != "agent-turn"
        || preferred.sender_identity_id != duplicate.sender_identity_id
    {
        return Ok(None);
    }
    let Some(parent_id) = preferred.parent_message_id.as_deref() else {
        return Ok(None);
    };
    let Some(parent) = select_message(conn, parent_id)? else {
        return Ok(None);
    };
    let parent_transport = parent.source_transport.as_deref();
    let parent_wire_id = match parent_transport {
        Some("cloud-self-agent") => parent.source_event_id.as_deref(),
        Some("desktop-chat") => parent
            .content
            .as_ref()
            .and_then(|content| content.get("desktopEntryId"))
            .and_then(Value::as_str),
        Some("desktop-chat-ui") => duplicate
            .content
            .as_ref()
            .and_then(|content| content.get("cloudRequestMessageId"))
            .and_then(Value::as_str),
        _ => None,
    };
    let Some(request_wire_id) = parent_wire_id.filter(|id| !id.trim().is_empty()) else {
        return Ok(None);
    };
    let Some(direct_wire_id) = duplicate.source_event_id.as_deref() else {
        return Ok(None);
    };
    let direct_request_wire_id = duplicate
        .content
        .as_ref()
        .and_then(|content| content.get("cloudRequestMessageId"))
        .and_then(Value::as_str);
    if parent.session_id != preferred.session_id
        || parent.sender_role != "user"
        || direct_request_wire_id != Some(request_wire_id)
    {
        return Ok(None);
    }
    let original_request_id = if parent_transport == Some("desktop-chat-ui")
        || parent_transport == Some("cloud-self-agent")
    {
        Some(parent.id.clone())
    } else {
        conn.query_row(
            "SELECT id FROM session_messages
             WHERE session_id = ?1 AND sender_role = 'user'
               AND source_transport = 'cloud-self-agent' AND source_event_id = ?2
             LIMIT 1",
            params![preferred.session_id, request_wire_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        // The native transcript can materialize before the Cloud request
        // does. Its entry ID is the exact Cloud wire ID, so retain that
        // canonical user row when the Cloud projection is still absent.
        .or_else(|| Some(parent.id.clone()))
    };
    let Some(original_request_id) = original_request_id else {
        return Ok(None);
    };
    let expected_request_client_id = (parent_transport == Some("desktop-chat-ui"))
        .then(|| cloud_request_client_message_id(&preferred.session_id, &parent.id));
    // Older history imports can restore the reply under a Cloud-derived ID.
    // Its exact source wire still proves the export, independent of that ID.
    let wire_proof = conn
        .query_row(
            "SELECT 1 FROM chat_sync_messages echo
         JOIN chat_sync_messages direct
           ON direct.account_id = echo.account_id
          AND direct.conversation_id = echo.conversation_id
         JOIN chat_sync_messages request
           ON request.account_id = echo.account_id
          AND request.conversation_id = echo.conversation_id
         JOIN chat_sync_conversations conversation
           ON conversation.account_id = echo.account_id
          AND conversation.conversation_id = echo.conversation_id
         WHERE echo.message_kind = 'canonical-history-agent'
           AND (json_extract(echo.snapshot_json, '$.content.canonical_history.local_message_id') = ?1
                OR echo.message_id = ?6)
           AND direct.message_id = ?2
           AND direct.message_kind = 'text'
           AND conversation.client_session_id = ?3
           AND request.message_id = ?4
           AND request.message_kind = 'text'
           AND (?5 IS NULL OR request.client_message_id = ?5)
         LIMIT 1",
            params![
                preferred.id,
                direct_wire_id,
                preferred.session_id,
                request_wire_id,
                expected_request_client_id,
                preferred.source_event_id,
            ],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
        .map_err(|error| error.to_string())?;
    Ok(wire_proof.then_some(original_request_id))
}

fn enrich_cloud_history_reply_from_direct_reply(
    conn: &Connection,
    preferred: &super::super::CanonicalSessionMessage,
    duplicate: &super::super::CanonicalSessionMessage,
    original_request_id: &str,
) -> Result<(), String> {
    let mut content = duplicate
        .content
        .clone()
        .filter(Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    content["replyToMessageId"] = Value::String(original_request_id.to_string());
    content["requestId"] = Value::String(original_request_id.to_string());
    let content_json = content.to_string();
    let content_hash = hash_hex(&format!("{}|{}", duplicate.content_text, content_json), 16);
    conn.execute(
        "UPDATE session_messages
         SET content_text = ?2, content_json = ?3, content_hash = ?4,
             status = ?5, parent_message_id = ?6,
             updated_at_ms = MAX(updated_at_ms, ?7)
         WHERE id = ?1",
        params![
            preferred.id,
            duplicate.content_text,
            content_json,
            content_hash,
            duplicate.status,
            original_request_id,
            now_ms(),
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

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

pub(crate) fn reconcile_canonical_message_mirror_in_db(
    conn: &Connection,
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
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let Some(preferred) = select_message(&transaction, preferred_message_id)? else {
        return Ok(false);
    };
    let Some(duplicate) = select_message(&transaction, duplicate_message_id)? else {
        // The database merge can commit before the IPC response reaches the
        // webview. Treat the missing duplicate as an idempotent success even
        // when the retained row has already adopted its Cloud provenance so
        // the caller can remove the stale mirror from in-memory state.
        return Ok(true);
    };
    let preferred_is_local = matches!(
        preferred.source_transport.as_deref(),
        Some("desktop-chat-ui" | "desktop-chat")
    );
    let duplicate_is_local = matches!(
        duplicate.source_transport.as_deref(),
        Some("desktop-chat-ui" | "desktop-chat")
    );
    let preferred_is_cloud = preferred.source_transport.as_deref() == Some("cloud-self-agent");
    let duplicate_is_cloud = duplicate.source_transport.as_deref() == Some("cloud-self-agent");
    let runtime_entry_id = preferred
        .content
        .as_ref()
        .and_then(|content| content.get("desktopEntryId"))
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty());
    let native_request_echo = preferred.source_transport.as_deref() == Some("desktop-chat-ui")
        && duplicate.source_transport.as_deref() == Some("desktop-chat")
        && preferred.sender_role == "user"
        && runtime_entry_id.is_some()
        && runtime_entry_id
            == duplicate
                .content
                .as_ref()
                .and_then(|content| content.get("desktopEntryId"))
                .and_then(Value::as_str);
    let cloud_reply_request_id =
        exact_cloud_history_reply_echo(&transaction, &preferred, &duplicate)?;
    let cloud_reply_echo = cloud_reply_request_id.is_some();
    let (local, cloud) = if let Some(original_request_id) = cloud_reply_request_id.as_deref() {
        enrich_cloud_history_reply_from_direct_reply(
            &transaction,
            &preferred,
            &duplicate,
            original_request_id,
        )?;
        (&preferred, &duplicate)
    } else if preferred_is_local && duplicate_is_cloud {
        (&preferred, &duplicate)
    } else if preferred_is_cloud && duplicate_is_local {
        (&duplicate, &preferred)
    } else if native_request_echo {
        (&preferred, &duplicate)
    } else {
        return Err(
            "Canonical mirror reconciliation requires one local and one Cloud self-agent message"
                .to_string(),
        );
    };
    let local_is_user = local.sender_role == "user";
    let local_is_owned_agent =
        local.sender_role == "owned-agent" && local.message_kind == "agent-turn";
    if !local_is_user && !local_is_owned_agent {
        return Err(
            "Canonical mirror reconciliation requires a local self-agent message".to_string(),
        );
    }
    let sender_matches = if local_is_user {
        cloud.sender_role == "user" && local.sender_identity_id == cloud.sender_identity_id
    } else {
        cloud.sender_role == "owned-agent" && cloud.message_kind == "agent-turn"
    };
    let payload_matches = if local_is_user {
        local.content_text.trim() == cloud.content_text.trim()
    } else {
        local.parent_message_id.is_some()
            && (local.parent_message_id == cloud.parent_message_id
                || exported_agent_intent_matches(&transaction, local, cloud)?)
    };
    if !cloud_reply_echo
        && (local.session_id != cloud.session_id
            || !sender_matches
            || local.message_kind != cloud.message_kind
            || !payload_matches)
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
    let conn = open_db()?;
    reconcile_canonical_message_mirror_in_db(&conn, &preferred_message_id, &duplicate_message_id)
}
