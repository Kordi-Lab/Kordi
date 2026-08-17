use rusqlite::Connection;

use super::content_with_desktop_runtime;
use crate::canonical_sessions::{
    core::hash_hex, desktop_runtime_status, similar_agent_message_text,
};

fn update_cloud_message_with_desktop_runtime(
    conn: &Connection,
    message_id: &str,
    content_text: &str,
    content_json: Option<&str>,
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) -> Result<(), String> {
    let mut content = content_with_desktop_runtime(content_json, message, None)?;
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
            "SELECT id, content_json, content_text
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
    let mut cloud_match: Option<(String, Option<String>)> = None;
    while let Some(row) = rows.next().map_err(|err| err.to_string())? {
        let candidate_text: String = row.get(2).map_err(|err| err.to_string())?;
        if similar_agent_message_text(&candidate_text, content_text) {
            cloud_match = Some((
                row.get::<_, String>(0).map_err(|err| err.to_string())?,
                row.get::<_, Option<String>>(1)
                    .map_err(|err| err.to_string())?,
            ));
            break;
        }
    }
    drop(rows);
    drop(stmt);
    let Some((cloud_message_id, content_json)) = cloud_match else {
        return Ok(None);
    };
    update_cloud_message_with_desktop_runtime(
        conn,
        &cloud_message_id,
        content_text,
        content_json.as_deref(),
        message,
    )?;

    let duplicate_ids = {
        let mut duplicate_stmt = conn
            .prepare(
                "SELECT id, content_text
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
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        candidates
            .into_iter()
            .filter_map(|(id, candidate_text)| {
                similar_agent_message_text(&candidate_text, content_text).then_some(id)
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
