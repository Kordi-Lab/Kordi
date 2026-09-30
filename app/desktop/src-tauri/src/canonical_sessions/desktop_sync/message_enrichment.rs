use super::*;

pub(super) fn canonical_desktop_message_source_event_id(
    session_id: &str,
    index: usize,
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) -> String {
    let role = message.role.trim().to_lowercase();
    if role != "user" {
        return format!("desktop-chat:{session_id}:{index}:{role}:turn");
    }

    format!(
        "desktop-chat:{}:{}:{}:{}:{}",
        session_id,
        index,
        message.timestamp_ms,
        role,
        hash_hex(&message.text, 8)
    )
}

pub(super) fn should_skip_shared_local_agent_runtime_prompt(
    session_id: &str,
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) -> bool {
    if !session_id.starts_with("session:bridge:") {
        return false;
    }
    if !message.role.trim().eq_ignore_ascii_case("user") {
        return false;
    }
    message.text.trim_start().starts_with("@Kordi")
}

pub(super) fn content_with_desktop_runtime(
    content_json: Option<&str>,
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
    reply_to_message_id: Option<&str>,
) -> Result<serde_json::Value, String> {
    let mut content = content_json
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}));

    if let Some(object) = content.as_object_mut() {
        object.remove("deliveryState");
        object.remove("error");
    }
    desktop_runtime_status::apply_terminal_content(&mut content, message);

    if let Some(thinking_text) = message.thinking_text.as_deref() {
        if !thinking_text.trim().is_empty() {
            content["thinkingText"] = serde_json::Value::String(thinking_text.to_string());
        }
    }
    if !message.tools.is_empty() {
        content["tools"] = serde_json::to_value(&message.tools).map_err(|err| err.to_string())?;
    }
    content["role"] = serde_json::Value::String(message.role.clone());
    if let Some(sender) = message.sender.as_deref() {
        content["sender"] = serde_json::Value::String(sender.to_string());
    }
    if let Some(detail) = message.detail.as_deref() {
        content["detail"] = serde_json::Value::String(detail.to_string());
    }
    content["timeLabel"] = serde_json::Value::String(message.time_label.clone());
    content["timestampMs"] = serde_json::Value::Number(message.timestamp_ms.into());
    if let Some(entry_id) = message
        .entry_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        content["desktopEntryId"] = serde_json::Value::String(entry_id.to_string());
    }
    if let Some(reply_to_message_id) = reply_to_message_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        content["replyToMessageId"] = serde_json::Value::String(reply_to_message_id.to_string());
    } else if let Some(object) = content.as_object_mut() {
        object.remove("replyToMessageId");
    }
    if !message.attachments.is_empty() {
        content["attachments"] =
            serde_json::to_value(&message.attachments).map_err(|err| err.to_string())?;
    }

    Ok(content)
}

pub(super) fn update_message_with_desktop_runtime(
    conn: &Connection,
    message_id: &str,
    content_text: &str,
    content_json: Option<&str>,
    status: &str,
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) -> Result<(), String> {
    let content = content_with_desktop_runtime(content_json, message, None)?;
    let content_string = content.to_string();
    let content_hash = hash_hex(&format!("{}|{}", content_text, content_string), 16);
    conn.execute(
        "UPDATE session_messages
         SET content_text = ?2,
             content_json = ?3,
             status = ?4,
             created_at_ms = ?5,
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

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn enrich_similar_bridge_agent_message_with_desktop_runtime(
    conn: &Connection,
    session_id: &str,
    content_text: &str,
    created_at_ms: i64,
    match_window_ms: i64,
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, content_json, content_text
             FROM session_messages
             WHERE session_id = ?1
               AND message_kind = 'agent-turn'
               AND sender_role IN ('owned-agent', 'external-agent')
               AND source_transport = 'desktop-bridge-session-relay'
               AND ABS(created_at_ms - ?2) <= ?3
             ORDER BY ABS(created_at_ms - ?2) ASC, sequence_num DESC",
        )
        .map_err(|err| err.to_string())?;
    let mut rows = stmt
        .query(rusqlite::params![
            session_id,
            created_at_ms,
            match_window_ms
        ])
        .map_err(|err| err.to_string())?;
    let mut match_record: Option<(String, Option<String>)> = None;
    while let Some(row) = rows.next().map_err(|err| err.to_string())? {
        let candidate_text: String = row.get(2).map_err(|err| err.to_string())?;
        if similar_agent_message_text(&candidate_text, content_text) {
            match_record = Some((
                row.get::<_, String>(0).map_err(|err| err.to_string())?,
                row.get::<_, Option<String>>(1)
                    .map_err(|err| err.to_string())?,
            ));
            break;
        }
    }
    let Some((message_id, content_json)) = match_record else {
        return Ok(false);
    };

    update_message_with_desktop_runtime(
        conn,
        &message_id,
        content_text,
        content_json.as_deref(),
        desktop_runtime_status::status(message),
        message,
    )?;
    Ok(true)
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn reconcile_processing_bridge_agent_placeholder_with_desktop_runtime(
    conn: &Connection,
    session_id: &str,
    content_text: &str,
    created_at_ms: i64,
    match_window_ms: i64,
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) -> Result<bool, String> {
    let Some((message_id, content_json)) = conn
        .query_row(
            "SELECT id, content_json
             FROM session_messages
             WHERE session_id = ?1
               AND message_kind = 'agent-turn'
               AND sender_role = 'owned-agent'
               AND source_transport = 'desktop-bridge-session-relay'
               AND lower(trim(content_text)) IN ('processing', 'processing.', 'processing..', 'processing...', 'processing…')
               AND ABS(created_at_ms - ?2) <= ?3
             ORDER BY created_at_ms DESC, sequence_num DESC
             LIMIT 1",
            rusqlite::params![session_id, created_at_ms, match_window_ms],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?
    else {
        return Ok(false);
    };

    update_message_with_desktop_runtime(
        conn,
        &message_id,
        content_text,
        content_json.as_deref(),
        desktop_runtime_status::status(message),
        message,
    )?;
    Ok(true)
}

pub(super) fn matching_fork_snapshot_message_id(
    conn: &Connection,
    session_id: &str,
    sender_identity_id: &str,
    sender_role: &str,
    message_kind: &str,
    content_text: &str,
    created_at_ms: i64,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT id
         FROM session_messages
         WHERE session_id = ?1
           AND sender_identity_id = ?2
           AND sender_role = ?3
           AND message_kind = ?4
           AND content_text = ?5
           AND source_transport = 'canonical-fork-snapshot'
           AND ABS(created_at_ms - ?6) <= 5_000
         ORDER BY ABS(created_at_ms - ?6) ASC, sequence_num DESC
         LIMIT 1",
        params![
            session_id,
            sender_identity_id,
            sender_role,
            message_kind,
            content_text,
            created_at_ms,
        ],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}
