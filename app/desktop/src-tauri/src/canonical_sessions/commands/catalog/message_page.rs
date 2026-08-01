//! Bounded transcript page loading for a canonical session.

use rusqlite::{params, Connection};

use super::super::super::{open_db, CanonicalMessagePage};
use super::rows::canonical_message_from_row;

pub(in crate::canonical_sessions::commands) fn load_message_page_from_db(
    conn: &Connection,
    session_id: &str,
    before_sequence_num: Option<i64>,
    limit: Option<i64>,
) -> Result<CanonicalMessagePage, String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err("Session id is required".to_string());
    }
    let limit = limit.unwrap_or(100).clamp(25, 200) as usize;
    let mut stmt = conn
        .prepare(
            "SELECT
                id, session_id, sender_identity_id, sender_role, message_kind,
                content_text, content_json, parent_message_id, delegated_exchange_id,
                status, sequence_num, created_at_ms, updated_at_ms, content_hash,
                source_transport, source_event_id
             FROM session_messages
             WHERE session_id = ?1
               AND (?2 IS NULL OR sequence_num < ?2)
             ORDER BY sequence_num DESC, created_at_ms DESC, id DESC
             LIMIT ?3",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(
            params![session_id, before_sequence_num, (limit + 1) as i64],
            canonical_message_from_row,
        )
        .map_err(|err| err.to_string())?;
    let mut messages = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    let has_older = messages.len() > limit;
    messages.truncate(limit);
    messages.reverse();
    let oldest_sequence_num = messages.first().map(|message| message.sequence_num);
    let newest_sequence_num = messages.last().map(|message| message.sequence_num);

    Ok(CanonicalMessagePage {
        session_id: session_id.to_string(),
        messages,
        oldest_sequence_num,
        newest_sequence_num,
        has_older,
    })
}

pub(in crate::canonical_sessions) fn desktop_canonical_session_messages(
    session_id: &str,
    before_sequence_num: Option<i64>,
    limit: Option<i64>,
) -> Result<CanonicalMessagePage, String> {
    let conn = open_db()?;
    load_message_page_from_db(&conn, session_id, before_sequence_num, limit)
}
