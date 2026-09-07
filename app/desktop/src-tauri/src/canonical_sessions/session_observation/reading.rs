use super::*;

#[derive(Debug)]
pub(super) struct ObservedMessageRow {
    message_id: String,
    sender: String,
    role: String,
    text: String,
    time_label: Option<String>,
    pub(super) sequence_num: i64,
}

impl ObservedMessageRow {
    pub(super) fn into_index_message(self) -> SessionObservationMessage {
        SessionObservationMessage {
            message_id: self.message_id,
            sender: self.sender,
            role: self.role,
            sequence_num: self.sequence_num,
            text: None,
            next_offset: None,
            time_label: self.time_label,
        }
    }

    pub(super) fn into_detail_message(self, offset: usize) -> SessionObservationMessage {
        let remainder = self.text.chars().skip(offset).collect::<String>();
        let truncated = remainder.chars().count() > MAX_READ_MESSAGE_TEXT_CHARS;
        SessionObservationMessage {
            next_offset: truncated.then(|| offset.saturating_add(MAX_READ_MESSAGE_TEXT_CHARS - 1)),
            message_id: self.message_id,
            sender: self.sender,
            role: self.role,
            sequence_num: self.sequence_num,
            text: Some(truncate_text(&remainder, MAX_READ_MESSAGE_TEXT_CHARS)),
            time_label: self.time_label,
        }
    }
}

fn read_message_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ObservedMessageRow> {
    Ok(ObservedMessageRow {
        message_id: row.get(0)?,
        sender: row.get(1)?,
        role: row.get(2)?,
        text: row.get(3)?,
        time_label: Some(row.get::<_, i64>(4)?.to_string()),
        sequence_num: row.get(5)?,
    })
}

pub(super) fn read_messages_from_sequence(
    conn: &Connection,
    session_id: &str,
    start_sequence: i64,
    limit: usize,
) -> Result<Vec<ObservedMessageRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT m.id, COALESCE(i.display_name, m.sender_role), m.sender_role, '', m.created_at_ms, m.sequence_num
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

pub(super) fn read_messages_by_ids(
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

pub(super) fn read_latest_messages(
    conn: &Connection,
    session_id: &str,
    limit: usize,
) -> Result<Vec<ObservedMessageRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT * FROM (
                 SELECT m.id, COALESCE(i.display_name, m.sender_role), m.sender_role, '', m.created_at_ms, m.sequence_num
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

pub(super) fn message_sequence_bounds(
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
