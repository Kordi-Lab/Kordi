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
    // Legacy self-agent replays are collapsed after loading because their
    // original rows have no idempotency key. Over-fetch the bounded self
    // conversation so duplicates do not crowd real messages out of a page.
    let query_limit = if peer == session.account_id {
        MESSAGE_LIST_MAX_LIMIT
    } else {
        limit
    };

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
                ) AS read_at, client_message_id, server_received_at \
         FROM ( \
             SELECT cm.message_id, cm.from_account_id, cm.to_account_id, cm.body, cm.session_id, cm.created_at, \
                    cm.delivered_at, cm.read_at, cm.client_message_id, cm.server_received_at, \
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
             ORDER BY cm.created_at DESC, cm.server_received_at DESC, cm.message_id DESC \
             LIMIT $3 \
         ) recent_messages \
         ORDER BY created_at ASC, server_received_at ASC, message_id ASC",
    )
    .bind(&session.account_id)
    .bind(&peer)
    .bind(query_limit)
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

    let message_ids_with_attachments = attachments_by_message_id
        .keys()
        .cloned()
        .collect::<HashSet<_>>();
    let mut rows = collapse_legacy_self_message_replays(
        rows,
        &session.account_id,
        &message_ids_with_attachments,
    );
    if rows.len() > limit as usize {
        rows = rows.split_off(rows.len() - limit as usize);
    }

    let me = &session.account_id;
    let messages: Vec<MessageSummary> = rows
        .into_iter()
        .map(
            |(
                message_id,
                from_id,
                to_id,
                body,
                session_id,
                created_at,
                delivered_at,
                read_at,
                _client_message_id,
                _server_received_at,
            )| {
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

/// Load exact message bodies by id for authenticated recovery of durable
/// Cloud control metadata. Rows are only returned to their sender or recipient.
pub(super) async fn lookup_message_bodies(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(request): Json<MessageBodyLookupRequest>,
) -> Response {
    if request.message_ids.len() > MESSAGE_BODY_LOOKUP_MAX_IDS {
        return err(
            "too_many_message_ids",
            "At most 500 messageIds can be looked up at once.",
            StatusCode::BAD_REQUEST,
        );
    }

    let mut seen = HashSet::new();
    let mut message_ids = Vec::with_capacity(request.message_ids.len());
    for raw_message_id in request.message_ids {
        let message_id = raw_message_id.trim();
        if message_id.is_empty() || message_id.chars().count() > MESSAGE_ID_MAX_CHARS {
            return err(
                "invalid_message_id",
                "Each messageId must be between 1 and 512 characters.",
                StatusCode::BAD_REQUEST,
            );
        }
        if seen.insert(message_id.to_string()) {
            message_ids.push(message_id.to_string());
        }
    }
    if message_ids.is_empty() {
        return Json(MessageBodyLookupResponse {
            messages: Vec::new(),
        })
        .into_response();
    }

    let rows: Vec<(String, String)> = match query_as(
        "SELECT message_id, body
         FROM cloud_messages
         WHERE message_id = ANY($1)
           AND (from_account_id = $2 OR to_account_id = $2)",
    )
    .bind(&message_ids)
    .bind(&session.account_id)
    .fetch_all(state.db_pool())
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
    let bodies_by_id = rows.into_iter().collect::<HashMap<_, _>>();
    let messages = message_ids
        .into_iter()
        .filter_map(|message_id| {
            bodies_by_id
                .get(&message_id)
                .cloned()
                .map(|body| MessageBodyLookupSummary { message_id, body })
        })
        .collect();
    Json(MessageBodyLookupResponse { messages }).into_response()
}
