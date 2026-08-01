//! Canonical message insertion, reconciliation, upsert, and row projection.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use uuid::Uuid;

use super::super::{
    clean_optional, hash_hex, json_from_db, json_to_db, now_ms, validate_status,
    AppendCanonicalMessageRequest, CanonicalSessionMessage,
};

/// Trust boundary: this helper does not authorize the (session_id, message_id)
/// tuple against any caller identity. It trusts whatever id and content the
/// renderer supplies via the canonical-sessions Tauri surface. The renderer is
/// assumed to be the sole writer; do not call this from code paths that take
/// untrusted input. If an `id` is provided and already exists, the row is
/// upserted in place — meaning a bad id could overwrite an unrelated message.
pub(crate) fn append_message_in_db(
    conn: &Connection,
    request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionMessage, String> {
    if let (Some(source_transport), Some(source_event_id)) =
        (&request.source_transport, &request.source_event_id)
    {
        if let Some(existing) = select_message_by_source(conn, source_transport, source_event_id)? {
            return Ok(existing);
        }
    }

    let id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("msg:{}", Uuid::new_v4().simple()));
    let now = now_ms();
    let created_at_ms = request.created_at_ms.unwrap_or(now);
    let sequence_num: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sequence_num), 0) + 1 FROM session_messages WHERE session_id = ?1",
            params![request.session_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    let content = json_to_db(&request.content)?;
    let content_hash = hash_hex(
        &format!(
            "{}|{}",
            request.content_text,
            content.clone().unwrap_or_default()
        ),
        16,
    );
    let status = validate_status(request.status, "sent");

    let source_transport = clean_optional(request.source_transport);
    let source_event_id = clean_optional(request.source_event_id);
    let inserted = conn.execute(
        "INSERT INTO session_messages(
             id, session_id, sender_identity_id, sender_role, message_kind, content_text, content_json,
             parent_message_id, delegated_exchange_id, status, sequence_num, created_at_ms, updated_at_ms,
             content_hash, source_transport, source_event_id
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(source_transport, source_event_id)
         WHERE source_transport IS NOT NULL AND source_event_id IS NOT NULL
         DO NOTHING",
        params![
            id,
            request.session_id,
            request.sender_identity_id,
            request.sender_role,
            request.message_kind,
            request.content_text,
            content,
            clean_optional(request.parent_message_id),
            clean_optional(request.delegated_exchange_id),
            status,
            sequence_num,
            created_at_ms,
            now,
            content_hash,
            source_transport,
            source_event_id,
        ],
    )
    .map_err(|err| err.to_string())?;
    if inserted == 0 {
        if let (Some(source_transport), Some(source_event_id)) =
            (source_transport.as_deref(), source_event_id.as_deref())
        {
            if let Some(existing) =
                select_message_by_source(conn, source_transport, source_event_id)?
            {
                return Ok(existing);
            }
        }
        return Err(
            "Unable to save canonical message after resolving a duplicate source event".to_string(),
        );
    }
    conn.execute(
        "UPDATE sessions
         SET updated_at_ms = ?1,
             last_message_at_ms = MAX(COALESCE(last_message_at_ms, 0), ?2)
         WHERE id = ?3",
        params![now, created_at_ms, request.session_id],
    )
    .map_err(|err| err.to_string())?;

    select_message(conn, &id)?.ok_or_else(|| "Unable to save canonical message".to_string())
}

fn select_cloud_self_agent_existing_echo(
    conn: &Connection,
    request: &AppendCanonicalMessageRequest,
) -> Result<Option<CanonicalSessionMessage>, String> {
    if request.source_transport.as_deref() != Some("cloud-self-agent") {
        return Ok(None);
    }
    let created_at_ms = request.created_at_ms.unwrap_or_else(now_ms);
    let message_id: Option<String> = conn
        .query_row(
            "SELECT id
             FROM session_messages
             WHERE session_id = ?1
               AND sender_role = ?2
               AND message_kind = ?3
               AND content_text = ?4
               AND source_transport IN ('desktop-chat', 'canonical-fork-snapshot')
               AND ABS(created_at_ms - ?5) <= 5_000
             ORDER BY ABS(created_at_ms - ?5) ASC, sequence_num DESC
             LIMIT 1",
            params![
                request.session_id,
                request.sender_role,
                request.message_kind,
                request.content_text,
                created_at_ms,
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    message_id
        .as_deref()
        .map(|id| select_message(conn, id))
        .transpose()
        .map(|message| message.flatten())
}

pub(crate) fn upsert_message_in_db(
    conn: &Connection,
    request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionMessage, String> {
    // Cloud replay and the local agent runner can reconcile the same stable
    // processing slot at the same time. Acquire the write lock before the
    // source/id lookups so two connections cannot both observe a missing row
    // and then race to insert the same primary key.
    let tx = rusqlite::Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(|err| err.to_string())?;
    let message = upsert_message_in_transaction(&tx, request)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(message)
}

fn upsert_message_in_transaction(
    conn: &Connection,
    mut request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionMessage, String> {
    if let (Some(source_transport), Some(source_event_id)) = (
        request.source_transport.as_deref(),
        request.source_event_id.as_deref(),
    ) {
        if let Some(existing) = select_message_by_source(conn, source_transport, source_event_id)? {
            if request.id.as_deref().map(str::trim) != Some(existing.id.as_str()) {
                request.id = Some(existing.id);
            }
        }
    }
    let Some(id) = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
    else {
        return append_message_in_db(conn, request);
    };

    if select_message(conn, &id)?.is_none() {
        if let Some(existing_echo) = select_cloud_self_agent_existing_echo(conn, &request)? {
            return Ok(existing_echo);
        }
        return append_message_in_db(conn, request);
    }

    let now = now_ms();
    let created_at_ms = request.created_at_ms.unwrap_or(now);
    let content = json_to_db(&request.content)?;
    let content_hash = hash_hex(
        &format!(
            "{}|{}",
            request.content_text,
            content.clone().unwrap_or_default()
        ),
        16,
    );
    let status = validate_status(request.status, "sent");

    conn.execute(
        "UPDATE session_messages
         SET sender_identity_id = ?1,
             sender_role = ?2,
             message_kind = ?3,
             content_text = ?4,
             content_json = ?5,
             status = ?6,
             created_at_ms = ?7,
             updated_at_ms = ?8,
             content_hash = ?9,
             parent_message_id = ?10,
             delegated_exchange_id = ?11,
             source_transport = ?12,
             source_event_id = ?13
         WHERE id = ?14",
        params![
            request.sender_identity_id.as_str(),
            request.sender_role.as_str(),
            request.message_kind.as_str(),
            request.content_text.as_str(),
            content,
            status,
            created_at_ms,
            now,
            content_hash,
            clean_optional(request.parent_message_id),
            clean_optional(request.delegated_exchange_id),
            clean_optional(request.source_transport),
            clean_optional(request.source_event_id),
            id,
        ],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "UPDATE sessions
         SET updated_at_ms = ?1,
             last_message_at_ms = MAX(COALESCE(last_message_at_ms, 0), ?2)
         WHERE id = ?3",
        params![now, created_at_ms, request.session_id],
    )
    .map_err(|err| err.to_string())?;

    select_message(conn, &id)?.ok_or_else(|| "Unable to update canonical message".to_string())
}

pub(crate) fn select_message_by_source(
    conn: &Connection,
    source_transport: &str,
    source_event_id: &str,
) -> Result<Option<CanonicalSessionMessage>, String> {
    conn.query_row(
        "SELECT id FROM session_messages WHERE source_transport = ?1 AND source_event_id = ?2",
        params![source_transport, source_event_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| err.to_string())?
    .map(|id| select_message(conn, &id))
    .transpose()
    .map(|value| value.flatten())
}

pub(crate) fn select_message(
    conn: &Connection,
    id: &str,
) -> Result<Option<CanonicalSessionMessage>, String> {
    conn.query_row(
        "SELECT id, session_id, sender_identity_id, sender_role, message_kind, content_text, content_json,
                parent_message_id, delegated_exchange_id, status, sequence_num, created_at_ms, updated_at_ms,
                content_hash, source_transport, source_event_id
         FROM session_messages WHERE id = ?1",
        params![id],
        |row| {
            Ok(CanonicalSessionMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                sender_identity_id: row.get(2)?,
                sender_role: row.get(3)?,
                message_kind: row.get(4)?,
                content_text: row.get(5)?,
                content: json_from_db(row.get(6)?),
                parent_message_id: row.get(7)?,
                delegated_exchange_id: row.get(8)?,
                status: row.get(9)?,
                sequence_num: row.get(10)?,
                created_at_ms: row.get(11)?,
                updated_at_ms: row.get(12)?,
                content_hash: row.get(13)?,
                source_transport: row.get(14)?,
                source_event_id: row.get(15)?,
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())
}
