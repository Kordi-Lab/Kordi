//! Canonical title seeds for desktop runtime sessions.

use rusqlite::{params, Connection};
use serde_json::Value;

const TITLE_SEED_SCAN_LIMIT: i64 = 50;

fn runtime_title_is_placeholder(session_id: &str, title: &str, metadata: &Value) -> bool {
    match metadata.get("sessionTitleSource").and_then(Value::as_str) {
        Some("manual" | "imported" | "external") => false,
        Some("placeholder") => true,
        _ => kordi_session::naming::is_placeholder_or_weak_legacy_title(title, session_id),
    }
}

/// The runtime summary only sees the local runtime store. A turn that failed
/// before reaching the runtime, or that ran on another route, leaves its user
/// message only in the canonical store, so a placeholder runtime title is
/// replaced by a title derived from the first meaningful canonical user
/// message. Forks keep their placeholder until they have their own message.
pub(crate) fn desktop_session_title_with_canonical_seed(
    conn: &Connection,
    session_id: &str,
    runtime_title: &str,
    mut metadata: Value,
) -> Result<(String, Value), String> {
    if metadata.get("fork").is_some()
        || !runtime_title_is_placeholder(session_id, runtime_title, &metadata)
    {
        return Ok((runtime_title.to_string(), metadata));
    }
    let mut stmt = conn
        .prepare(
            "SELECT id, content_text, content_json, created_at_ms
             FROM session_messages
             WHERE session_id = ?1
               AND sender_role = 'user'
               AND COALESCE(source_transport, '') <> 'canonical-fork-snapshot'
             ORDER BY sequence_num ASC, created_at_ms ASC
             LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![session_id, TITLE_SEED_SCAN_LIMIT], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (message_id, text, content_json, created_at_ms) =
            row.map_err(|error| error.to_string())?;
        let text = super::super::voice_context::message_text(text, content_json.as_deref());
        let Some(title) = kordi_session::naming::derive_session_title(&text) else {
            continue;
        };
        if let Some(object) = metadata.as_object_mut() {
            for key in ["sessionTitleSource", "titleSource"] {
                object.insert(key.to_string(), Value::String("auto".to_string()));
            }
            object.insert("sessionTitleRevision".to_string(), Value::from(1));
            object.insert(
                "sessionTitlePolicyVersion".to_string(),
                Value::from(kordi_session::naming::SESSION_TITLE_POLICY_VERSION),
            );
            object.insert(
                "sessionTitleUpdatedAtMs".to_string(),
                Value::from(created_at_ms),
            );
            object.insert(
                "sessionTitleGeneratedFromMessageId".to_string(),
                Value::String(message_id),
            );
        }
        return Ok((title, metadata));
    }
    Ok((runtime_title.to_string(), metadata))
}
