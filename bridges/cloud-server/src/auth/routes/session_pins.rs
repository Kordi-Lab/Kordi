use super::*;

pub(super) async fn cloud_session_pin_summary(
    pool: &PgPool,
    account_id: &str,
    session_id: &str,
) -> Result<CloudSessionPinSummary, sqlx_core::error::Error> {
    let shared: Option<(String, String)> = query_as(
        "SELECT message_id, updated_at FROM cloud_session_shared_pins WHERE session_id = $1",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?;
    let private: Option<(String, String)> = query_as(
        "SELECT message_id, updated_at FROM cloud_account_session_pins WHERE account_id = $1 AND session_id = $2",
    )
    .bind(account_id)
    .bind(session_id)
    .fetch_optional(pool)
    .await?;

    let shared_message_id = shared.as_ref().map(|row| row.0.clone());
    let private_message_id = private.as_ref().map(|row| row.0.clone());
    let updated_at = private
        .as_ref()
        .map(|row| row.1.clone())
        .or_else(|| shared.as_ref().map(|row| row.1.clone()));
    Ok(CloudSessionPinSummary {
        session_id: session_id.to_string(),
        shared_message_id: shared_message_id.clone(),
        private_message_id: private_message_id.clone(),
        effective_message_id: private_message_id.or(shared_message_id),
        updated_at,
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
    match caller_can_access_cloud_session(pool, &session.account_id, &session_id).await {
        Ok(true) => {}
        Ok(false) => {
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
    let participants = match cloud_session_participants(pool, &session_id).await {
        Ok(participants) => participants,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    if !participants.iter().any(|id| id == &session.account_id) {
        return err(
            "not_a_participant",
            "You can only pin messages in sessions you participate in.",
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
                   updated_at = EXCLUDED.updated_at",
            )
            .bind(&session_id)
            .bind(message_id)
            .bind(&session.account_id)
            .bind(&updated_at)
            .execute(pool)
            .await
        } else {
            query("DELETE FROM cloud_session_shared_pins WHERE session_id = $1")
                .bind(&session_id)
                .execute(pool)
                .await
        }
    } else if let Some(message_id) = message_id.as_deref() {
        query(
            "INSERT INTO cloud_account_session_pins (account_id, session_id, message_id, updated_at) \
             VALUES ($1, $2, $3, $4) \
             ON CONFLICT (account_id, session_id) DO UPDATE SET \
               message_id = EXCLUDED.message_id, \
               updated_at = EXCLUDED.updated_at",
        )
        .bind(&session.account_id)
        .bind(&session_id)
        .bind(message_id)
        .bind(&updated_at)
        .execute(pool)
        .await
    } else {
        query("DELETE FROM cloud_account_session_pins WHERE account_id = $1 AND session_id = $2")
            .bind(&session.account_id)
            .bind(&session_id)
            .execute(pool)
            .await
    };

    if write_result.is_err() {
        return err(
            "server_error",
            "Could not update pinned message.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let event_payload = serde_json::json!({
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
    let conversation_id = crate::chat_sync::store::conversation_id_for_session(
        pool,
        &session.account_id,
        &session_id,
    )
    .await
    .ok()
    .flatten();
    let _ = crate::chat_sync::store::publish_user_sync_events(
        pool,
        &recipients,
        "session.pin.updated",
        conversation_id,
        event_payload,
    )
    .await;

    match cloud_session_pin_summary(pool, &session.account_id, &session_id).await {
        Ok(pin) => Json(CloudSessionPinResponse { pin }).into_response(),
        Err(_) => err(
            "server_error",
            "Could not load pinned message.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}
