use rusqlite::Connection;

use super::content_with_desktop_runtime;
use crate::canonical_sessions::{
    core::hash_hex, desktop_runtime_status, similar_agent_message_text,
};

fn cancellation_notice(text: &str) -> bool {
    let normalized = text
        .trim()
        .trim_end_matches(['.', '!'])
        .to_ascii_lowercase();
    matches!(
        normalized.split_whitespace().collect::<Vec<_>>().as_slice(),
        ["stopped"]
            | ["request" | "response", "cancelled" | "canceled" | "stopped"]
            | [
                "request" | "response",
                "cancelled" | "canceled" | "stopped",
                "by",
                "sender" | "participant"
            ]
            | [
                "request" | "response",
                "cancelled" | "canceled" | "stopped",
                "by",
                "agent",
                "owner"
            ]
    )
}

fn matches_runtime_response(
    candidate_text: &str,
    candidate_json: Option<&str>,
    candidate_status: &str,
    content_text: &str,
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) -> bool {
    // These candidates already share one session and exact parent request.
    // Failure text lives in content.error on Cloud but in text in native history.
    if message.failed || message.cancelled {
        if candidate_status != desktop_runtime_status::status(message) {
            return false;
        }
        if message.cancelled {
            return candidate_text.trim().is_empty()
                || cancellation_notice(candidate_text)
                || similar_agent_message_text(candidate_text, content_text);
        }
        let content =
            candidate_json.and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok());
        let error = content
            .as_ref()
            .and_then(|value| value.get("error"))
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(candidate_text);
        let runtime_error = if content_text.trim().is_empty() {
            message.detail.as_deref().unwrap_or_default()
        } else {
            content_text
        };
        return similar_agent_message_text(error, runtime_error);
    }
    similar_agent_message_text(candidate_text, content_text)
}

fn update_cloud_message_with_desktop_runtime(
    conn: &Connection,
    message_id: &str,
    parent_message_id: &str,
    content_text: &str,
    content_json: Option<&str>,
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) -> Result<(), String> {
    let mut content = content_with_desktop_runtime(content_json, message, Some(parent_message_id))?;
    let status = desktop_runtime_status::status(message);
    content["deliveryState"] = serde_json::Value::String(status.to_string());
    let content_string = content.to_string();
    let content_hash = hash_hex(&format!("{}|{}", content_text, content_string), 16);
    conn.execute(
        "UPDATE session_messages
         SET content_text = ?2,
             content_json = ?3,
             status = ?4,
             updated_at_ms = MAX(updated_at_ms, ?5),
             content_hash = ?6
         WHERE id = ?1",
        rusqlite::params![
            message_id,
            content_text,
            content_string,
            status,
            message.timestamp_ms,
            content_hash,
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(super) fn reconcile_cloud_self_agent_message_with_desktop_runtime(
    conn: &Connection,
    session_id: &str,
    parent_message_id: Option<&str>,
    content_text: &str,
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) -> Result<Option<String>, String> {
    let Some(parent_message_id) = parent_message_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let mut stmt = conn
        .prepare(
            "SELECT id, content_json, content_text, status
             FROM session_messages
             WHERE session_id = ?1
               AND parent_message_id = ?2
               AND message_kind = 'agent-turn'
               AND sender_role = 'owned-agent'
               AND source_transport = 'cloud-self-agent'
             ORDER BY sequence_num DESC",
        )
        .map_err(|err| err.to_string())?;
    let mut rows = stmt
        .query(rusqlite::params![session_id, parent_message_id])
        .map_err(|err| err.to_string())?;
    let mut cloud_match: Option<(String, Option<String>, String)> = None;
    while let Some(row) = rows.next().map_err(|err| err.to_string())? {
        let candidate_text: String = row.get(2).map_err(|err| err.to_string())?;
        let candidate_json: Option<String> = row.get(1).map_err(|err| err.to_string())?;
        let candidate_status: String = row.get(3).map_err(|err| err.to_string())?;
        if matches_runtime_response(
            &candidate_text,
            candidate_json.as_deref(),
            &candidate_status,
            content_text,
            message,
        ) {
            cloud_match = Some((
                row.get::<_, String>(0).map_err(|err| err.to_string())?,
                candidate_json,
                candidate_text,
            ));
            break;
        }
    }
    drop(rows);
    drop(stmt);
    let Some((cloud_message_id, content_json, cloud_text)) = cloud_match else {
        return Ok(None);
    };
    let mut content = content_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    if message.cancelled && cancellation_notice(&cloud_text) {
        content["message"] = serde_json::Value::String(cloud_text.clone());
        let notice = cloud_text
            .trim()
            .trim_end_matches(['.', '!'])
            .to_ascii_lowercase();
        if let Some(actor) = ["sender", "participant", "agent owner"]
            .into_iter()
            .find(|actor| notice.ends_with(&format!(" by {actor}")))
        {
            content["cancelledByRole"] = serde_json::Value::String(actor.into());
        }
    }
    let stored_text = if message.failed && !message.cancelled {
        ""
    } else if message.cancelled && content_text.trim().is_empty() {
        cloud_text.as_str()
    } else {
        content_text
    };
    update_cloud_message_with_desktop_runtime(
        conn,
        &cloud_message_id,
        parent_message_id,
        stored_text,
        Some(&content.to_string()),
        message,
    )?;

    let duplicate_ids = {
        let mut duplicate_stmt = conn
            .prepare(
                "SELECT id, content_text, content_json, status
                 FROM session_messages
                 WHERE session_id = ?1
                   AND parent_message_id = ?2
                   AND message_kind = 'agent-turn'
                   AND sender_role = 'owned-agent'
                   AND source_transport = 'desktop-chat'
                   AND id <> ?3",
            )
            .map_err(|err| err.to_string())?;
        let candidates = duplicate_stmt
            .query_map(
                rusqlite::params![session_id, parent_message_id, cloud_message_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        candidates
            .into_iter()
            .filter_map(|(id, candidate_text, candidate_json, candidate_status)| {
                matches_runtime_response(
                    &candidate_text,
                    candidate_json.as_deref(),
                    &candidate_status,
                    content_text,
                    message,
                )
                .then_some(id)
            })
            .collect::<Vec<_>>()
    };
    for duplicate_id in duplicate_ids {
        crate::canonical_sessions::commands::reconcile_canonical_message_mirror_in_db(
            conn,
            &cloud_message_id,
            &duplicate_id,
        )?;
    }
    Ok(Some(cloud_message_id))
}

/// A cloud-synchronized local history export is not a cloud-executed request.
/// Its native terminal result must still enter the outbound synchronization path.
pub(super) fn request_uses_cloud_executor(
    conn: &Connection,
    session_id: &str,
    parent_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_messages parent
         WHERE parent.id=?1 AND parent.session_id=?2 AND parent.source_transport='cloud-self-agent'
         AND NOT EXISTS(SELECT 1 FROM chat_sync_messages wire
             JOIN chat_sync_conversations conversation
               ON conversation.account_id=wire.account_id AND conversation.conversation_id=wire.conversation_id
             WHERE wire.message_id=parent.source_event_id
               AND conversation.client_session_id=parent.session_id
               AND wire.message_kind='canonical-history-user'))",
        rusqlite::params![parent_id, session_id], |row| row.get(0),
    ).map_err(|error| error.to_string())
}
