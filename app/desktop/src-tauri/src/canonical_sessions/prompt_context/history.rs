use super::*;

pub(super) fn recent_session_message_lines(
    conn: &Connection,
    session_id: &str,
    limit: usize,
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT COALESCE(i.display_name, m.sender_role), m.sender_role, m.content_text, m.content_json, m.parent_message_id
             FROM session_messages m
             LEFT JOIN identities i ON i.id = m.sender_identity_id
             WHERE m.session_id = ?1
               AND TRIM(m.content_text) <> ''
             ORDER BY m.sequence_num DESC, m.created_at_ms DESC
             LIMIT ?2",
        )
        .map_err(|err| err.to_string())?;
    let mut messages = stmt
        .query_map(params![session_id, limit as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    messages.reverse();
    Ok(messages
        .into_iter()
        .map(|(sender, role, text, content_json, parent_message_id)| {
            let text = super::super::voice_context::message_text(text, content_json.as_deref());
            let action_context =
                message_action_context(content_json.as_deref(), parent_message_id.as_deref());
            let line = format!("{} ({role}): {}", sender, truncate_context_line(&text, 700));
            match action_context {
                Some(context) => format!("{line} [{context}]"),
                None => line,
            }
        })
        .collect())
}

fn message_action_context(
    content_json: Option<&str>,
    parent_message_id: Option<&str>,
) -> Option<String> {
    let content = content_json
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| serde_json::from_str::<Value>(value).ok())?;
    let action = content.get("messageAction")?;
    let kind = action
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let source = action.get("source").and_then(Value::as_object)?;
    let source_message_id = source
        .get("sourceMessageId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            parent_message_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
        });
    let sender = source
        .get("senderLabel")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown sender");
    let preview = source
        .get("textPreview")
        .and_then(Value::as_str)
        .map(|value| truncate_context_line(value, 180))
        .filter(|value| !value.is_empty());
    match kind {
        "quote" => Some(format!(
            "quotes message {} from {}{}",
            source_message_id.unwrap_or("unknown"),
            sender,
            preview
                .map(|value| format!(": {value}"))
                .unwrap_or_default(),
        )),
        "forward" => Some(format!(
            "forwarded from message {} by {}{}",
            source_message_id.unwrap_or("unknown"),
            sender,
            preview
                .map(|value| format!(": {value}"))
                .unwrap_or_default(),
        )),
        _ => None,
    }
}
