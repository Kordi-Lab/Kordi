use rusqlite::{params, Connection, OptionalExtension};

fn compact_agent_message_text(value: &str) -> String {
    value.split_whitespace().collect::<String>()
}

pub(crate) fn similar_agent_message_text(left: &str, right: &str) -> bool {
    let left = left.trim();
    let right = right.trim();
    if left.is_empty() || right.is_empty() {
        return false;
    }
    left == right || compact_agent_message_text(left) == compact_agent_message_text(right)
}

pub(crate) fn similar_agent_message_exists(
    conn: &Connection,
    session_id: &str,
    content_text: &str,
    source_transport: &str,
    created_at_ms: i64,
    match_window_ms: i64,
) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(
            "SELECT content_text
             FROM session_messages
             WHERE session_id = ?1
               AND message_kind = 'agent-turn'
               AND sender_role IN ('owned-agent', 'external-agent')
               AND source_transport = ?2
               AND ABS(created_at_ms - ?3) <= ?4",
        )
        .map_err(|err| err.to_string())?;
    let mut rows = stmt
        .query(params![
            session_id,
            source_transport,
            created_at_ms,
            match_window_ms
        ])
        .map_err(|err| err.to_string())?;
    while let Some(row) = rows.next().map_err(|err| err.to_string())? {
        let candidate_text: String = row.get(0).map_err(|err| err.to_string())?;
        if similar_agent_message_text(&candidate_text, content_text) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn existing_delegation_join_message_id(
    conn: &Connection,
    session_id: &str,
    target_identity_id: &str,
    target_kind: &str,
    target_display_name: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT id
         FROM session_messages
         WHERE session_id = ?1
           AND message_kind = 'status'
           AND json_extract(content_json, '$.kind') = 'delegation-join-event'
           AND json_extract(content_json, '$.targetKind') = ?3
           AND (
             json_extract(content_json, '$.targetIdentityId') = ?2
             OR json_extract(content_json, '$.targetDisplayName') = ?4
           )
         ORDER BY created_at_ms ASC, sequence_num ASC
         LIMIT 1",
        params![
            session_id,
            target_identity_id,
            target_kind,
            target_display_name
        ],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

pub(crate) fn session_message_count(conn: &Connection, session_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM session_messages WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )
    .map_err(|err| err.to_string())
}

/// Returns true if a row exists in `session_messages` for the given
/// (session_id, message_id) pair. Used to route fork dispatch: if the
/// clicked entry lives in the canonical store, the fork has to go
/// through the canonical-snapshot path even when the session id itself
/// is a plain local uuid (which happens for self-agent chats that are
/// mirrored into the canonical store for cloud sync).
pub(crate) fn canonical_message_exists(
    conn: &Connection,
    session_id: &str,
    message_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM session_messages WHERE session_id = ?1 AND id = ?2 LIMIT 1",
        params![session_id, message_id],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn similar_agent_message_text_matches_compacted_whitespace() {
        assert!(similar_agent_message_text("hello world", "hello\nworld"));
    }
}
