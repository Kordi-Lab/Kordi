use super::*;

/// `POST /v1/cloud/messages/read` — mark all messages from a peer to
/// the caller as read. This lets sender-side polling render WhatsApp-style
/// blue double-checks once the recipient has opened the conversation.
pub(super) async fn mark_messages_read(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(req): Json<MarkMessagesReadRequest>,
) -> Response {
    let peer = req.peer_account_id.trim().to_string();
    if peer.is_empty() {
        return err(
            "invalid_account_id",
            "peerAccountId is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    if peer == session.account_id {
        return StatusCode::NO_CONTENT.into_response();
    }

    let now = Utc::now().to_rfc3339();
    let pool = state.db_pool();
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => {
            return err(
                "server_error",
                "Could not start read transaction.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    if upsert_cloud_read_cursor_in_transaction(&mut tx, &session.account_id, "peer", &peer, &now)
        .await
        .is_err()
    {
        return err(
            "server_error",
            "Could not record read cursor.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }
    let read_rows: Result<Vec<(String,)>, _> = query_as(
        "UPDATE cloud_messages \
         SET read_at = COALESCE(read_at, $1), \
             delivered_at = COALESCE(delivered_at, $1) \
         WHERE from_account_id = $2 AND to_account_id = $3 AND read_at IS NULL \
         RETURNING message_id",
    )
    .bind(&now)
    .bind(&peer)
    .bind(&session.account_id)
    .fetch_all(&mut *tx)
    .await;
    let Ok(read_rows) = read_rows else {
        return err(
            "server_error",
            "Could not mark messages read.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    };

    let message_ids: Vec<String> = read_rows.into_iter().map(|row| row.0).collect();
    if !message_ids.is_empty()
        && append_cloud_sync_event_in_transaction(
            &mut tx,
            &peer,
            "message.read",
            Some(&session.account_id),
            None,
            serde_json::json!({
                "readerAccountId": &session.account_id,
                "messageIds": &message_ids,
                "readAt": &now,
            }),
            &now,
        )
        .await
        .is_err()
    {
        return err(
            "server_error",
            "Could not record sync event.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if tx.commit().await.is_err() {
        return err(
            "server_error",
            "Could not commit read transaction.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if !message_ids.is_empty() {
        let events = state.events().clone();
        let reader = session.account_id.clone();
        let sender = peer.clone();
        let occurred_at = now.clone();
        tokio::spawn(async move {
            events
                .publish_message_read(&reader, &sender, &occurred_at)
                .await;
        });
    }

    StatusCode::NO_CONTENT.into_response()
}

/// `POST /v1/cloud/sessions/:source_session_id/read` — mark all messages
/// delivered to the caller inside a Cloud/canonical session as read. Group
/// sessions are fanout into pairwise rows, so a session-level read cursor is
/// the durable source of truth for clearing grouped unread badges.
pub(super) async fn mark_session_messages_read(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(source_session_id): axum::extract::Path<String>,
) -> Response {
    let source_session_id = source_session_id.trim().to_string();
    if source_session_id.is_empty() {
        return err(
            "invalid_session_id",
            "Session id is required.",
            StatusCode::BAD_REQUEST,
        );
    }

    let now = Utc::now().to_rfc3339();
    let pool = state.db_pool();
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => {
            return err(
                "server_error",
                "Could not start read transaction.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    if upsert_cloud_read_cursor_in_transaction(
        &mut tx,
        &session.account_id,
        "session",
        &source_session_id,
        &now,
    )
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not record read cursor.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }
    let read_rows: Result<Vec<(String, String)>, _> = query_as(
        "UPDATE cloud_messages \
         SET read_at = COALESCE(read_at, $1), \
             delivered_at = COALESCE(delivered_at, $1) \
         WHERE session_id = $2 AND to_account_id = $3 AND read_at IS NULL \
         RETURNING message_id, from_account_id",
    )
    .bind(&now)
    .bind(&source_session_id)
    .bind(&session.account_id)
    .fetch_all(&mut *tx)
    .await;
    let Ok(read_rows) = read_rows else {
        return err(
            "server_error",
            "Could not mark session messages read.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    };

    let mut message_ids_by_peer = std::collections::BTreeMap::<String, Vec<String>>::new();
    for (message_id, peer_account_id) in read_rows {
        message_ids_by_peer
            .entry(peer_account_id)
            .or_default()
            .push(message_id);
    }

    for (peer, message_ids) in &message_ids_by_peer {
        if append_cloud_sync_event_in_transaction(
            &mut tx,
            peer,
            "message.read",
            Some(&session.account_id),
            Some(&source_session_id),
            serde_json::json!({
                "readerAccountId": &session.account_id,
                "messageIds": message_ids,
                "readAt": &now,
                "sessionId": &source_session_id,
            }),
            &now,
        )
        .await
        .is_err()
        {
            return err(
                "server_error",
                "Could not record sync event.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }

    if tx.commit().await.is_err() {
        return err(
            "server_error",
            "Could not commit read transaction.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    for peer in message_ids_by_peer.keys() {
        let events = state.events().clone();
        let reader = session.account_id.clone();
        let sender = peer.clone();
        let occurred_at = now.clone();
        tokio::spawn(async move {
            events
                .publish_message_read(&reader, &sender, &occurred_at)
                .await;
        });
    }

    StatusCode::NO_CONTENT.into_response()
}
