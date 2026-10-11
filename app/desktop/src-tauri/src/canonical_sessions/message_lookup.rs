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

/// The stored title of `session_id`, when the session exists and has one.
pub(crate) fn session_title(session_id: &str) -> Option<String> {
    let conn = super::open_db().ok()?;
    super::select_session(&conn, session_id.trim())
        .ok()
        .flatten()
        .map(|session| session.title.trim().to_string())
        .filter(|title| !title.is_empty())
}

/// The cloud conversation id the chat sync mapped to `client_session_id`
/// (such as `session:group:<local id>`), newest mapping first.
pub(crate) fn cloud_conversation_id_for_client_session(client_session_id: &str) -> Option<String> {
    let conn = super::open_db().ok()?;
    cloud_conversation_id_in_db(&conn, client_session_id)
        .ok()
        .flatten()
}

fn cloud_conversation_id_in_db(
    conn: &Connection,
    client_session_id: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT conversation_id FROM chat_sync_conversations
         WHERE client_session_id = ?1
         ORDER BY updated_at_ms DESC LIMIT 1",
        [client_session_id.trim()],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map(|id| {
        id.map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
    })
}

/// Every `(client session id, cloud conversation id)` pair of the group
/// sessions the chat sync mapped for `account_id`.
pub(crate) fn group_conversation_mappings(account_id: &str) -> Vec<(String, String)> {
    let Ok(conn) = super::open_db() else {
        return Vec::new();
    };
    group_conversation_mappings_in_db(&conn, account_id).unwrap_or_default()
}

fn group_conversation_mappings_in_db(
    conn: &Connection,
    account_id: &str,
) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT client_session_id, conversation_id FROM chat_sync_conversations
         WHERE account_id = ?1 AND client_session_id LIKE 'session:group:%'",
    )?;
    let rows = stmt.query_map([account_id.trim()], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_conversation_ids_come_from_the_chat_sync_mapping() {
        let conn = Connection::open_in_memory().expect("open db");
        super::super::initialize_schema(&conn).expect("schema");
        for (account, conversation, session, updated) in [
            ("acct_a", "cloud-old", "session:group:local-1", 1),
            ("acct_b", "cloud-new", "session:group:local-1", 2),
            ("acct_a", "cloud-dm", "session:direct:local-2", 3),
        ] {
            conn.execute(
                "INSERT INTO chat_sync_conversations(account_id, conversation_id, client_session_id, version, snapshot_json, updated_at_ms) VALUES (?1, ?2, ?3, 1, '{}', ?4)",
                params![account, conversation, session, updated],
            )
            .expect("insert mapping");
        }
        assert_eq!(
            cloud_conversation_id_in_db(&conn, " session:group:local-1 ").unwrap(),
            Some("cloud-new".to_string())
        );
        assert_eq!(
            cloud_conversation_id_in_db(&conn, "session:group:missing").unwrap(),
            None
        );
        assert_eq!(
            group_conversation_mappings_in_db(&conn, "acct_a").unwrap(),
            vec![("session:group:local-1".to_string(), "cloud-old".to_string())]
        );
    }

    #[test]
    fn similar_agent_message_text_matches_compacted_whitespace() {
        assert!(similar_agent_message_text("hello world", "hello\nworld"));
    }
}
