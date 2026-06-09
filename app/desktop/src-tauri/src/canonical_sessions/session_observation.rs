use kordi_tools::{
    ReadSessionRequest, ReadSessionResponse, SearchSessionsRequest, SearchSessionsResponse,
    SessionObservationMessage, SessionObservationParticipant, SessionObservationReadSession,
    SessionObservationSearchResult, SessionObservationSnippet, SessionObservationWindow,
};
use rusqlite::{Connection, OptionalExtension, params};

use super::open_db;

const DEFAULT_SEARCH_LIMIT: usize = 8;
const MAX_SEARCH_LIMIT: usize = 20;
const DEFAULT_READ_LIMIT: usize = 30;
const MAX_READ_LIMIT: usize = 80;
const MAX_SEARCH_SNIPPET_TEXT_CHARS: usize = 500;
const MAX_READ_MESSAGE_TEXT_CHARS: usize = 1_200;

pub(crate) fn search_sessions_for_observation(
    request: SearchSessionsRequest,
) -> Result<SearchSessionsResponse, String> {
    let conn = open_db()?;
    search_sessions_for_observation_in_db(&conn, request)
}

pub(crate) fn read_session_for_observation(
    request: ReadSessionRequest,
) -> Result<ReadSessionResponse, String> {
    let conn = open_db()?;
    read_session_for_observation_in_db(&conn, request)
}

pub(crate) fn search_sessions_for_observation_in_db(
    conn: &Connection,
    request: SearchSessionsRequest,
) -> Result<SearchSessionsResponse, String> {
    let query = request.query.trim().to_lowercase();
    if query.is_empty() {
        return Err("query cannot be empty".to_string());
    }
    let limit = request
        .limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .clamp(1, MAX_SEARCH_LIMIT);
    let include_messages = request.include_messages.unwrap_or(false);
    let mut sessions = Vec::new();
    let mut stmt = conn
        .prepare(
            "SELECT id, title, kind, updated_at_ms
             FROM sessions
             WHERE status <> 'archived'
             ORDER BY COALESCE(last_message_at_ms, updated_at_ms) DESC, updated_at_ms DESC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|err| err.to_string())?;

    for row in rows {
        let (session_id, title, kind, updated_at_ms) = row.map_err(|err| err.to_string())?;
        let participants = participant_names(conn, &session_id)?;
        let title_matches =
            title.to_lowercase().contains(&query) || kind.to_lowercase().contains(&query);
        let participant_matches = participants
            .iter()
            .any(|name| name.to_lowercase().contains(&query));
        let message_matches = session_has_message_match(conn, &session_id, &query)?;
        let snippets = if include_messages {
            message_snippets(conn, &session_id, &query)?
        } else {
            Vec::new()
        };
        if !title_matches && !participant_matches && !message_matches {
            continue;
        }
        let reason = if title_matches {
            "Matched session title".to_string()
        } else if participant_matches {
            "Matched participant".to_string()
        } else {
            "Matched message text".to_string()
        };
        sessions.push(SessionObservationSearchResult {
            session_id,
            title,
            kind,
            participants,
            updated_at_label: Some(updated_at_ms.to_string()),
            reason,
            snippets,
        });
        if sessions.len() >= limit {
            break;
        }
    }
    Ok(SearchSessionsResponse { sessions })
}

pub(crate) fn read_session_for_observation_in_db(
    conn: &Connection,
    request: ReadSessionRequest,
) -> Result<ReadSessionResponse, String> {
    let session_id = request.session_id.trim();
    if session_id.is_empty() {
        return Err("sessionId cannot be empty".to_string());
    }
    let limit = request
        .limit
        .unwrap_or(DEFAULT_READ_LIMIT)
        .clamp(1, MAX_READ_LIMIT);
    let session = conn
        .query_row(
            "SELECT id, title, kind FROM sessions WHERE id = ?1 AND status <> 'archived'",
            params![session_id],
            |row| {
                Ok(SessionObservationReadSession {
                    session_id: row.get(0)?,
                    title: row.get(1)?,
                    kind: row.get(2)?,
                    participants: Vec::new(),
                })
            },
        )
        .optional()
        .map_err(|err| err.to_string())?
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let participants = participants_for_read(conn, session_id)?;
    let mode = request
        .mode
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("index");
    let around_message_id = request
        .around_message_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let (messages, has_more_before, has_more_after) = match mode {
        "index" => {
            let bounds = message_sequence_bounds(conn, session_id)?;
            if let Some(around) = around_message_id.as_deref() {
                let sequence = conn
                    .query_row(
                        "SELECT sequence_num FROM session_messages WHERE session_id = ?1 AND id = ?2",
                        params![session_id, around],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()
                    .map_err(|err| err.to_string())?
                    .ok_or_else(|| format!("message not found in session: {around}"))?;
                let half_before = (limit / 2) as i64;
                let start_sequence = (sequence - half_before).max(0);
                let rows = read_messages_from_sequence(conn, session_id, start_sequence, limit)?;
                let first_sequence = rows.first().map(|row| row.sequence_num).unwrap_or(sequence);
                let last_sequence = rows.last().map(|row| row.sequence_num).unwrap_or(sequence);
                let has_before = bounds
                    .map(|(min_seq, _)| first_sequence > min_seq)
                    .unwrap_or(false);
                let has_after = bounds
                    .map(|(_, max_seq)| last_sequence < max_seq)
                    .unwrap_or(false);
                (
                    rows.into_iter()
                        .map(ObservedMessageRow::into_index_message)
                        .collect(),
                    has_before,
                    has_after,
                )
            } else {
                let rows = read_latest_messages(conn, session_id, limit)?;
                let first_sequence = rows.first().map(|row| row.sequence_num);
                let last_sequence = rows.last().map(|row| row.sequence_num);
                let has_before = match (bounds, first_sequence) {
                    (Some((min_seq, _)), Some(first)) => first > min_seq,
                    _ => false,
                };
                let has_after = match (bounds, last_sequence) {
                    (Some((_, max_seq)), Some(last)) => last < max_seq,
                    _ => false,
                };
                (
                    rows.into_iter()
                        .map(ObservedMessageRow::into_index_message)
                        .collect(),
                    has_before,
                    has_after,
                )
            }
        }
        "messages" => {
            let message_ids = request
                .message_ids
                .unwrap_or_default()
                .into_iter()
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty())
                .take(limit)
                .collect::<Vec<_>>();
            if message_ids.is_empty() {
                return Err("messageIds cannot be empty when mode is messages".to_string());
            }
            (
                read_messages_by_ids(conn, session_id, &message_ids)?
                    .into_iter()
                    .map(ObservedMessageRow::into_detail_message)
                    .collect(),
                false,
                false,
            )
        }
        other => return Err(format!("unsupported read_session mode: {other}")),
    };

    Ok(ReadSessionResponse {
        session: SessionObservationReadSession {
            participants,
            ..session
        },
        window: SessionObservationWindow {
            around_message_id,
            has_more_before,
            has_more_after,
        },
        messages,
    })
}

fn escaped_like_contains(query: &str) -> String {
    let mut escaped = String::with_capacity(query.len() + 2);
    escaped.push('%');
    for ch in query.chars() {
        match ch {
            '%' | '_' | '\\' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }
    escaped.push('%');
    escaped
}

fn truncate_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let keep_chars = max_chars.saturating_sub(1);
    let mut truncated = text.chars().take(keep_chars).collect::<String>();
    truncated.push('…');
    truncated
}

fn participant_names(conn: &Connection, session_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT i.display_name
             FROM session_participants sp
             JOIN identities i ON i.id = sp.identity_id
             WHERE sp.session_id = ?1 AND sp.state = 'active'
             ORDER BY sp.added_at_ms ASC, i.display_name ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![session_id], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn participants_for_read(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<SessionObservationParticipant>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT i.display_name, i.kind, sp.role
             FROM session_participants sp
             JOIN identities i ON i.id = sp.identity_id
             WHERE sp.session_id = ?1 AND sp.state = 'active'
             ORDER BY sp.added_at_ms ASC, i.display_name ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![session_id], |row| {
            Ok(SessionObservationParticipant {
                name: row.get(0)?,
                kind: row.get(1)?,
                role: row.get(2)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn session_has_message_match(
    conn: &Connection,
    session_id: &str,
    query: &str,
) -> Result<bool, String> {
    let like = escaped_like_contains(query);
    let exists: i64 = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM session_messages
                 WHERE session_id = ?1 AND lower(content_text) LIKE ?2 ESCAPE '\\'
             )",
            params![session_id, like],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    Ok(exists != 0)
}

fn message_snippets(
    conn: &Connection,
    session_id: &str,
    query: &str,
) -> Result<Vec<SessionObservationSnippet>, String> {
    let like = escaped_like_contains(query);
    let mut stmt = conn
        .prepare(
            "SELECT m.id, COALESCE(i.display_name, m.sender_role), m.content_text, m.created_at_ms
             FROM session_messages m
             LEFT JOIN identities i ON i.id = m.sender_identity_id
             WHERE m.session_id = ?1 AND lower(m.content_text) LIKE ?2 ESCAPE '\\'
             ORDER BY m.sequence_num ASC
             LIMIT 3",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![session_id, like], |row| {
            Ok(SessionObservationSnippet {
                message_id: row.get(0)?,
                sender: row.get(1)?,
                text: truncate_text(&row.get::<_, String>(2)?, MAX_SEARCH_SNIPPET_TEXT_CHARS),
                time_label: Some(row.get::<_, i64>(3)?.to_string()),
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

#[derive(Debug)]
struct ObservedMessageRow {
    message_id: String,
    sender: String,
    role: String,
    text: String,
    time_label: Option<String>,
    sequence_num: i64,
}

impl ObservedMessageRow {
    fn into_index_message(self) -> SessionObservationMessage {
        SessionObservationMessage {
            message_id: self.message_id,
            sender: self.sender,
            role: self.role,
            sequence_num: self.sequence_num,
            text: None,
            time_label: self.time_label,
        }
    }

    fn into_detail_message(self) -> SessionObservationMessage {
        SessionObservationMessage {
            message_id: self.message_id,
            sender: self.sender,
            role: self.role,
            sequence_num: self.sequence_num,
            text: Some(self.text),
            time_label: self.time_label,
        }
    }
}

fn read_message_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ObservedMessageRow> {
    Ok(ObservedMessageRow {
        message_id: row.get(0)?,
        sender: row.get(1)?,
        role: row.get(2)?,
        text: truncate_text(&row.get::<_, String>(3)?, MAX_READ_MESSAGE_TEXT_CHARS),
        time_label: Some(row.get::<_, i64>(4)?.to_string()),
        sequence_num: row.get(5)?,
    })
}

fn read_messages_from_sequence(
    conn: &Connection,
    session_id: &str,
    start_sequence: i64,
    limit: usize,
) -> Result<Vec<ObservedMessageRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT m.id, COALESCE(i.display_name, m.sender_role), m.sender_role, m.content_text, m.created_at_ms, m.sequence_num
             FROM session_messages m
             LEFT JOIN identities i ON i.id = m.sender_identity_id
             WHERE m.session_id = ?1 AND m.sequence_num >= ?2
             ORDER BY m.sequence_num ASC
             LIMIT ?3",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![session_id, start_sequence, limit], read_message_row)
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn read_messages_by_ids(
    conn: &Connection,
    session_id: &str,
    message_ids: &[String],
) -> Result<Vec<ObservedMessageRow>, String> {
    let mut rows = Vec::new();
    let mut stmt = conn
        .prepare(
            "SELECT m.id, COALESCE(i.display_name, m.sender_role), m.sender_role, m.content_text, m.created_at_ms, m.sequence_num
             FROM session_messages m
             LEFT JOIN identities i ON i.id = m.sender_identity_id
             WHERE m.session_id = ?1 AND m.id = ?2",
        )
        .map_err(|err| err.to_string())?;
    for message_id in message_ids {
        if let Some(row) = stmt
            .query_row(params![session_id, message_id], read_message_row)
            .optional()
            .map_err(|err| err.to_string())?
        {
            rows.push(row);
        }
    }
    rows.sort_by_key(|row| row.sequence_num);
    rows.dedup_by(|left, right| left.message_id == right.message_id);
    Ok(rows)
}

fn read_latest_messages(
    conn: &Connection,
    session_id: &str,
    limit: usize,
) -> Result<Vec<ObservedMessageRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT * FROM (
                 SELECT m.id, COALESCE(i.display_name, m.sender_role), m.sender_role, m.content_text, m.created_at_ms, m.sequence_num
                 FROM session_messages m
                 LEFT JOIN identities i ON i.id = m.sender_identity_id
                 WHERE m.session_id = ?1
                 ORDER BY m.sequence_num DESC
                 LIMIT ?2
             ) ORDER BY sequence_num ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![session_id, limit], read_message_row)
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn message_sequence_bounds(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<(i64, i64)>, String> {
    conn.query_row(
        "SELECT MIN(sequence_num), MAX(sequence_num) FROM session_messages WHERE session_id = ?1",
        params![session_id],
        |row| {
            let min: Option<i64> = row.get(0)?;
            let max: Option<i64> = row.get(1)?;
            Ok(min.zip(max))
        },
    )
    .map_err(|err| err.to_string())
}
