use super::*;

type PinSummaryRow = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

pub(super) async fn cloud_session_pin_summary(
    pool: &PgPool,
    account_id: &str,
    session_id: &str,
) -> Result<CloudSessionPinSummary, sqlx_core::error::Error> {
    let (shared_message_id, shared_updated_at, private_message_id, private_updated_at, history_updated_at) = query_as::<_, PinSummaryRow>(
        "SELECT shared.message_id, shared.updated_at, private.message_id, private.updated_at, \
          (SELECT history.payload->>'updatedAt' FROM cloud_session_pin_history history \
           JOIN cloud_chat_conversations conversation ON conversation.conversation_id = history.conversation_id \
           WHERE (conversation.legacy_session_id = $2 OR conversation.conversation_id::text = $2) \
             AND (history.scope = 'shared' OR history.actor_account_id = $1) ORDER BY history.occurred_at DESC, history.sequence DESC LIMIT 1) \
         FROM (SELECT 1) seed \
         LEFT JOIN cloud_session_shared_pins shared ON shared.session_id = $2 \
         LEFT JOIN cloud_account_session_pins private ON private.account_id = $1 AND private.session_id = $2",
    ).bind(account_id).bind(session_id).fetch_one(pool).await?;

    Ok(CloudSessionPinSummary {
        session_id: session_id.to_string(),
        shared_message_id: shared_message_id.clone(),
        private_message_id: private_message_id.clone(),
        effective_message_id: private_message_id.or(shared_message_id),
        updated_at: history_updated_at
            .or(private_updated_at)
            .or(shared_updated_at),
    })
}

pub(super) fn normalize_cloud_pin_message_id(
    value: Option<&str>,
) -> Result<Option<String>, Box<Response>> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > 512 {
        return Err(boxed_err(
            "invalid_message_id",
            "messageId is too long.",
            StatusCode::BAD_REQUEST,
        ));
    }
    Ok(Some(trimmed.to_string()))
}

pub(super) async fn get_cloud_session_pin(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(source_session_id): axum::extract::Path<String>,
) -> Response {
    let Some(session_id) = normalized_source_session_id(&source_session_id) else {
        return err(
            "invalid_session",
            "sourceSessionId is required.",
            StatusCode::BAD_REQUEST,
        );
    };
    let pool = state.db_pool();
    match crate::chat_sync::store::conversation_id_for_session(
        pool,
        &session.account_id,
        &session_id,
    )
    .await
    {
        Ok(Some(_)) => {}
        Ok(None) => {
            return err(
                "not_a_participant",
                "You can only inspect pins for sessions you participate in.",
                StatusCode::FORBIDDEN,
            );
        }
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }
    match cloud_session_pin_summary(pool, &session.account_id, &session_id).await {
        Ok(pin) => Json(CloudSessionPinResponse { pin }).into_response(),
        Err(_) => err(
            "server_error",
            "Could not load pinned message.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

#[derive(Deserialize)]
pub(super) struct PinHistoryQuery {
    before: Option<i64>,
    limit: Option<i64>,
}

pub(super) async fn get_cloud_session_pin_history(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(source_session_id): axum::extract::Path<String>,
    axum::extract::Query(page): axum::extract::Query<PinHistoryQuery>,
) -> Response {
    let Some(session_id) = normalized_source_session_id(&source_session_id) else {
        return err(
            "invalid_session",
            "A session is required.",
            StatusCode::BAD_REQUEST,
        );
    };
    if page.before.is_some_and(|before| before <= 0) {
        return err(
            "invalid_cursor",
            "History cursor must be positive.",
            StatusCode::BAD_REQUEST,
        );
    }
    let pool = state.db_pool();
    let conversation_id = match crate::chat_sync::store::conversation_id_for_session(
        pool,
        &session.account_id,
        &session_id,
    )
    .await
    {
        Ok(Some(id)) => id,
        Ok(None) => {
            return err(
                "not_a_participant",
                "Conversation membership is required.",
                StatusCode::FORBIDDEN,
            )
        }
        Err(_) => {
            return err(
                "server_error",
                "Could not load pin history.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    let limit = page.limit.unwrap_or(100).clamp(1, 100);
    let rows: Vec<(i64, serde_json::Value)> = match query_as(
        "SELECT sequence, payload FROM cloud_session_pin_history \
         WHERE conversation_id = $1 AND (scope = 'shared' OR actor_account_id = $2) \
           AND EXISTS (SELECT 1 FROM cloud_chat_conversation_members member WHERE member.conversation_id=$1 AND member.account_id=$2 AND member.membership_state='active') \
           AND ($3::bigint IS NULL OR sequence < $3) ORDER BY sequence DESC LIMIT $4",
    )
    .bind(conversation_id)
    .bind(&session.account_id)
    .bind(page.before)
    .bind(limit + 1)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => {
            return err(
                "server_error",
                "Could not load pin history.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    let next_before = (rows.len() > limit as usize).then(|| rows[limit as usize - 1].0);
    let events: Vec<_> = rows
        .into_iter()
        .take(limit as usize)
        .map(|(_, event)| event)
        .collect();
    Json(serde_json::json!({ "events": events, "nextBefore": next_before })).into_response()
}

pub(super) async fn update_cloud_session_pin(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(source_session_id): axum::extract::Path<String>,
    Json(req): Json<UpdateCloudSessionPinRequest>,
) -> Response {
    let Some(session_id) = normalized_source_session_id(&source_session_id) else {
        return err(
            "invalid_session",
            "sourceSessionId is required.",
            StatusCode::BAD_REQUEST,
        );
    };
    let scope = req.scope.trim().to_ascii_lowercase();
    if scope != "private" && scope != "shared" {
        return err(
            "invalid_pin_scope",
            "scope must be private or shared.",
            StatusCode::BAD_REQUEST,
        );
    }
    let message_id = match normalize_cloud_pin_message_id(req.message_id.as_deref()) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let pool = state.db_pool();
    let mut transaction = match pool.begin().await {
        Ok(transaction) => transaction,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let conversation_id = match conversation_id_for_session_in_transaction(
        &mut transaction,
        &session.account_id,
        &session_id,
    )
    .await
    {
        Ok(Some(conversation_id)) => conversation_id,
        Ok(None) => {
            return err(
                "not_a_participant",
                "You can only pin messages in sessions you participate in.",
                StatusCode::FORBIDDEN,
            );
        }
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    // Serialize state changes and history insertion for this conversation.
    if query("SELECT conversation_id FROM cloud_chat_conversations WHERE conversation_id = $1 FOR UPDATE")
        .bind(conversation_id).fetch_one(&mut *transaction).await.is_err() {
        return err("server_error", "Could not lock pinned message state.", StatusCode::INTERNAL_SERVER_ERROR);
    }
    let participants = match active_conversation_member_ids_in_transaction(
        &mut transaction,
        conversation_id,
    )
    .await
    {
        Ok(participants) => participants,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    if !participants.contains(&session.account_id) {
        return err(
            "not_a_participant",
            "Conversation membership is required.",
            StatusCode::FORBIDDEN,
        );
    }

    let updated_at = Utc::now().to_rfc3339();
    let write_result = if scope == "shared" {
        if let Some(message_id) = message_id.as_deref() {
            query(
                "INSERT INTO cloud_session_shared_pins (session_id, message_id, updated_by_account_id, updated_at) \
                 VALUES ($1, $2, $3, $4) \
                 ON CONFLICT (session_id) DO UPDATE SET \
                   message_id = EXCLUDED.message_id, \
                   updated_by_account_id = EXCLUDED.updated_by_account_id, \
                   updated_at = EXCLUDED.updated_at \
                 WHERE cloud_session_shared_pins.message_id IS DISTINCT FROM EXCLUDED.message_id",
            )
            .bind(&session_id)
            .bind(message_id)
            .bind(&session.account_id)
            .bind(&updated_at)
            .execute(&mut *transaction)
            .await
        } else {
            query("DELETE FROM cloud_session_shared_pins WHERE session_id = $1")
                .bind(&session_id)
                .execute(&mut *transaction)
                .await
        }
    } else if let Some(message_id) = message_id.as_deref() {
        query(
            "INSERT INTO cloud_account_session_pins (account_id, session_id, message_id, updated_at) \
             VALUES ($1, $2, $3, $4) \
             ON CONFLICT (account_id, session_id) DO UPDATE SET \
               message_id = EXCLUDED.message_id, \
               updated_at = EXCLUDED.updated_at \
             WHERE cloud_account_session_pins.message_id IS DISTINCT FROM EXCLUDED.message_id",
        )
        .bind(&session.account_id)
        .bind(&session_id)
        .bind(message_id)
        .bind(&updated_at)
        .execute(&mut *transaction)
        .await
    } else {
        query("DELETE FROM cloud_account_session_pins WHERE account_id = $1 AND session_id = $2")
            .bind(&session.account_id)
            .bind(&session_id)
            .execute(&mut *transaction)
            .await
    };

    let changed = match write_result {
        Ok(result) => result.rows_affected() > 0,
        Err(_) => {
            return err(
                "server_error",
                "Could not update pinned message.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    if !changed {
        if transaction.commit().await.is_err() {
            return err(
                "server_error",
                "Could not update pinned message.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
        return match cloud_session_pin_summary(pool, &session.account_id, &session_id).await {
            Ok(pin) => Json(CloudSessionPinResponse { pin }).into_response(),
            Err(_) => err(
                "server_error",
                "Could not load pinned message.",
                StatusCode::INTERNAL_SERVER_ERROR,
            ),
        };
    }

    let event_payload = serde_json::json!({
        "pinHistoryId": uuid::Uuid::now_v7().to_string(),
        "sessionId": &session_id,
        "messageId": &message_id,
        "scope": &scope,
        "updatedByAccountId": &session.account_id,
        "updatedAt": &updated_at,
    });
    let recipients: Vec<String> = if scope == "shared" {
        participants
    } else {
        vec![session.account_id.clone()]
    };
    if crate::chat_sync::store::append_user_sync_events_in_transaction(
        &mut transaction,
        &recipients,
        "session.pin.updated",
        Some(conversation_id),
        &event_payload,
    )
    .await
    .is_err()
        || transaction.commit().await.is_err()
    {
        return err(
            "server_error",
            "Could not record pinned message sync event.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    match cloud_session_pin_summary(pool, &session.account_id, &session_id).await {
        Ok(pin) => Json(CloudSessionPinResponse { pin }).into_response(),
        Err(_) => err(
            "server_error",
            "Could not load pinned message.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}
