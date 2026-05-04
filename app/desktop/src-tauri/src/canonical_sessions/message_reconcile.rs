use rusqlite::{params, Connection, OptionalExtension};

use super::{
    append_message_in_db, clean_optional, hash_hex, json_to_db, now_ms, select_message,
    select_message_by_source, validate_status, AppendCanonicalMessageRequest,
    CanonicalSessionMessage,
};

pub(super) fn append_or_reconcile_message_from_sync(
    conn: &Connection,
    request: AppendCanonicalMessageRequest,
    optimistic_source_transport: &str,
    match_window_ms: i64,
) -> Result<CanonicalSessionMessage, String> {
    let created_at_ms = request.created_at_ms.unwrap_or_else(now_ms);
    if let (Some(source_transport), Some(source_event_id)) = (
        request.source_transport.as_deref(),
        request.source_event_id.as_deref(),
    ) {
        if let Some(message) = select_message_by_source(conn, source_transport, source_event_id)? {
            if source_transport != optimistic_source_transport {
                if let Some(optimistic_message_id) = select_optimistic_message_id(
                    conn,
                    &request,
                    optimistic_source_transport,
                    created_at_ms,
                    match_window_ms,
                )? {
                    if optimistic_message_id != message.id {
                        delete_message(conn, &message.id)?;
                        update_optimistic_message(
                            conn,
                            &optimistic_message_id,
                            &request,
                            created_at_ms,
                        )?;
                        return select_message(conn, &optimistic_message_id)?.ok_or_else(|| {
                            "Unable to load reconciled canonical message".to_string()
                        });
                    }
                }
            }
            update_optimistic_message(conn, &message.id, &request, created_at_ms)?;
            return select_message(conn, &message.id)?
                .ok_or_else(|| "Unable to load updated canonical message".to_string());
        }
    }

    if let Some(message_id) = select_optimistic_message_id(
        conn,
        &request,
        optimistic_source_transport,
        created_at_ms,
        match_window_ms,
    )? {
        update_optimistic_message(conn, &message_id, &request, created_at_ms)?;
        return select_message(conn, &message_id)?
            .ok_or_else(|| "Unable to load reconciled canonical message".to_string());
    }

    append_message_in_db(conn, request)
}

fn select_optimistic_message_id(
    conn: &Connection,
    request: &AppendCanonicalMessageRequest,
    optimistic_source_transport: &str,
    created_at_ms: i64,
    match_window_ms: i64,
) -> Result<Option<String>, String> {
    let candidates = conn
        .prepare(
            "SELECT id, sender_identity_id
             FROM session_messages
             WHERE session_id = ?1
               AND sender_role = ?2
               AND message_kind = ?3
               AND content_text = ?4
               AND source_transport = ?5
               AND ABS(created_at_ms - ?6) <= ?7
             ORDER BY ABS(created_at_ms - ?6) ASC, sequence_num DESC",
        )
        .map_err(|err| err.to_string())?
        .query_map(
            params![
                request.session_id,
                request.sender_role,
                request.message_kind,
                request.content_text,
                optimistic_source_transport,
                created_at_ms,
                match_window_ms,
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    for (message_id, sender_identity_id) in candidates {
        if optimistic_sender_identity_matches(
            conn,
            &request.sender_identity_id,
            &sender_identity_id,
        )? {
            return Ok(Some(message_id));
        }
    }

    Ok(None)
}

fn optimistic_sender_identity_matches(
    conn: &Connection,
    request_sender_identity_id: &str,
    optimistic_sender_identity_id: &str,
) -> Result<bool, String> {
    if request_sender_identity_id == optimistic_sender_identity_id {
        return Ok(true);
    }

    conn.query_row(
        "SELECT 1
         FROM local_profile
         WHERE TRIM(COALESCE(human_identity_id, '')) = ?1
           AND ?2 = 'human:' || id
         LIMIT 1",
        params![request_sender_identity_id, optimistic_sender_identity_id],
        |_| Ok(()),
    )
    .optional()
    .map(|match_row| match_row.is_some())
    .map_err(|err| err.to_string())
}

fn delete_message(conn: &Connection, message_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM session_messages WHERE id = ?1",
        params![message_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn update_optimistic_message(
    conn: &Connection,
    message_id: &str,
    request: &AppendCanonicalMessageRequest,
    created_at_ms: i64,
) -> Result<(), String> {
    let content = json_to_db(&request.content)?;
    let content_hash = hash_hex(
        &format!(
            "{}|{}",
            request.content_text,
            content.clone().unwrap_or_default()
        ),
        16,
    );
    let now = now_ms();
    let status = validate_status(request.status.clone(), "sent");

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
            clean_optional(request.parent_message_id.clone()),
            clean_optional(request.delegated_exchange_id.clone()),
            clean_optional(request.source_transport.clone()),
            clean_optional(request.source_event_id.clone()),
            message_id,
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

    Ok(())
}
