use super::*;

/// `GET /v1/cloud/messages?peerAccountId=...&limit=...` — list the
/// caller's conversation with a single peer, oldest first.
pub(super) async fn list_messages(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Query(q): axum::extract::Query<MessagesQuery>,
) -> Response {
    let peer = q.peer_account_id.trim().to_string();
    if peer.is_empty() {
        return err(
            "invalid_account_id",
            "peerAccountId is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    let limit = q
        .limit
        .unwrap_or(MESSAGE_LIST_DEFAULT_LIMIT)
        .clamp(1, MESSAGE_LIST_MAX_LIMIT);

    let pool = state.db_pool();

    let rows: Vec<MessageRecordRow> = match query_as(
        "SELECT message_id, from_account_id, to_account_id, body, session_id, created_at, \
                delivered_at, \
                COALESCE(read_at, \
                    CASE \
                        WHEN from_account_id = $1 AND to_account_id = $1 \
                        THEN COALESCE(delivered_at, created_at) \
                    END, \
                    CASE \
                        WHEN to_account_id = $1 \
                         AND from_account_id = $2 \
                         AND peer_read_cursor IS NOT NULL \
                         AND created_at <= peer_read_cursor \
                        THEN peer_read_cursor \
                    END, \
                    CASE \
                        WHEN to_account_id = $1 \
                         AND session_read_cursor IS NOT NULL \
                         AND created_at <= session_read_cursor \
                        THEN session_read_cursor \
                    END \
                ) AS read_at \
         FROM ( \
             SELECT cm.message_id, cm.from_account_id, cm.to_account_id, cm.body, cm.session_id, cm.created_at, \
                    cm.delivered_at, cm.read_at, \
                    peer_read_cursor.read_at AS peer_read_cursor, \
                    session_read_cursor.read_at AS session_read_cursor \
             FROM cloud_messages cm \
             LEFT JOIN cloud_read_cursors peer_read_cursor \
                ON peer_read_cursor.account_id = $1 \
               AND peer_read_cursor.scope_kind = 'peer' \
               AND peer_read_cursor.scope_id = $2 \
             LEFT JOIN cloud_read_cursors session_read_cursor \
                ON session_read_cursor.account_id = $1 \
               AND session_read_cursor.scope_kind = 'session' \
               AND session_read_cursor.scope_id = cm.session_id \
             WHERE (cm.from_account_id = $1 AND cm.to_account_id = $2) \
                OR (cm.from_account_id = $2 AND cm.to_account_id = $1) \
             ORDER BY cm.created_at DESC \
             LIMIT $3 \
         ) recent_messages \
         ORDER BY created_at ASC",
    )
    .bind(&session.account_id)
    .bind(&peer)
    .bind(limit)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    let message_ids: Vec<String> = rows.iter().map(|row| row.0.clone()).collect();
    let attachment_rows: Vec<MessageAttachmentRow> = if message_ids.is_empty() {
        Vec::new()
    } else {
        match query_as(
            "SELECT cma.message_id, cma.attachment_id, cma.name, cma.kind, cma.mime_type, cma.size_bytes, cma.preview_url, ca.object_key \
             FROM cloud_message_attachments cma \
             JOIN cloud_attachments ca ON ca.attachment_id = cma.attachment_id \
             WHERE cma.message_id = ANY($1) \
             ORDER BY cma.position ASC",
        )
        .bind(&message_ids)
        .fetch_all(pool)
        .await
        {
            Ok(value) => value,
            Err(_) => {
                return err(
                    "server_error",
                    "Database error.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                );
            }
        }
    };
    let mut attachments_by_message_id: HashMap<String, Vec<MessageAttachmentSummary>> =
        HashMap::new();
    for (message_id, attachment_id, name, kind, mime_type, size_bytes, preview_url, _object_key) in
        attachment_rows
    {
        attachments_by_message_id
            .entry(message_id)
            .or_default()
            .push(MessageAttachmentSummary {
                attachment_id,
                name,
                kind,
                mime_type,
                size_bytes,
                preview_url,
                download_url: None,
            });
    }

    let me = &session.account_id;
    let messages: Vec<MessageSummary> = rows
        .into_iter()
        .map(
            |(message_id, from_id, to_id, body, session_id, created_at, delivered_at, read_at)| {
                let direction = if from_id == *me {
                    "outgoing"
                } else {
                    "incoming"
                };
                let attachments = attachments_by_message_id
                    .remove(&message_id)
                    .unwrap_or_default();
                MessageSummary {
                    message_id,
                    from_account_id: from_id,
                    to_account_id: to_id,
                    body,
                    session_id,
                    created_at,
                    delivered_at,
                    read_at,
                    direction: direction.into(),
                    attachments,
                }
            },
        )
        .collect();

    let peer_read_at: Option<String> = match query_as::<_, (String,)>(
        "SELECT read_at FROM cloud_read_cursors \
         WHERE account_id = $1 AND scope_kind = 'peer' AND scope_id = $2",
    )
    .bind(&session.account_id)
    .bind(&peer)
    .fetch_optional(pool)
    .await
    {
        Ok(row) => row.map(|(read_at,)| read_at),
        Err(_) => {
            return err(
                "server_error",
                "Could not load read cursor.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    Json(MessageListResponse {
        messages,
        peer_read_at,
    })
    .into_response()
}
