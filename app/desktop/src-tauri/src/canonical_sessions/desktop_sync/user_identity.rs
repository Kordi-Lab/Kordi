use rusqlite::{params, Connection};

use super::super::core::{hash_hex, now_ms};

pub(super) fn enrich_runtime_entry_id(
    conn: &Connection,
    message_id: &str,
    entry_id: &str,
) -> Result<(), String> {
    let (text, raw_content, stored_hash): (String, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT content_text, content_json, content_hash FROM session_messages WHERE id = ?1",
            params![message_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| error.to_string())?;
    let mut content = raw_content
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    let already_linked = content
        .get("desktopEntryId")
        .and_then(|value| value.as_str())
        == Some(entry_id);
    content["desktopEntryId"] = serde_json::Value::String(entry_id.to_string());
    let content_json = content.to_string();
    let content_hash = hash_hex(&format!("{text}|{content_json}"), 16);
    // Repair older alias writes whose fingerprints were never refreshed.
    if already_linked && stored_hash.as_deref() == Some(content_hash.as_str()) {
        return Ok(());
    }
    // Do not overwrite a concurrent sync/edit. The next runtime sync can retry
    // enrichment against that newer row; rendering already uses the wire ID.
    conn.execute(
        "UPDATE session_messages SET content_json = ?2, content_hash = ?3,
         updated_at_ms = MAX(updated_at_ms + 1, ?4)
         WHERE id = ?1 AND content_json IS ?5 AND content_text = ?6 AND content_hash IS ?7",
        params![
            message_id,
            content_json,
            content_hash,
            now_ms(),
            raw_content,
            text,
            stored_hash
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}
