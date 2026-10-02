use super::*;

type PinSummaryRow = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<Vec<String>>,
    Option<Vec<String>>,
);

pub(super) async fn cloud_session_pin_summary(
    pool: &PgPool,
    account_id: &str,
    session_id: &str,
) -> Result<CloudSessionPinSummary, sqlx_core::error::Error> {
    let (shared_message_id, shared_updated_at, private_message_id, private_updated_at, history_updated_at, shared_message_ids, private_message_ids) = query_as::<_, PinSummaryRow>(
        "SELECT shared.message_id, shared.updated_at, private.message_id, private.updated_at, \
          (SELECT history.payload->>'updatedAt' FROM cloud_session_pin_history history \
           JOIN cloud_chat_conversations conversation ON conversation.conversation_id = history.conversation_id \
           WHERE (conversation.legacy_session_id = $2 OR conversation.conversation_id::text = $2) \
             AND (history.scope = 'shared' OR history.actor_account_id = $1) ORDER BY history.occurred_at DESC, history.sequence DESC LIMIT 1), shared.message_ids, private.message_ids \
         FROM (SELECT 1) seed \
         LEFT JOIN cloud_session_shared_pins shared ON shared.session_id = $2 \
         LEFT JOIN cloud_account_session_pins private ON private.account_id = $1 AND private.session_id = $2",
    ).bind(account_id).bind(session_id).fetch_one(pool).await?;

    Ok(CloudSessionPinSummary {
        session_id: session_id.to_string(),
        shared_message_id: shared_message_id.clone(),
        private_message_id: private_message_id.clone(),
        shared_message_ids: shared_message_ids.unwrap_or_default(),
        private_message_ids: private_message_ids.unwrap_or_default(),
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
    let action = req.action.as_deref();
    if action.is_some_and(|action| !matches!(action, "pin" | "unpin"))
        || (action.is_some() && message_id.is_none())
    {
        return err(
            "invalid_pin_action",
            "A pin or unpin action requires messageId.",
            StatusCode::BAD_REQUEST,
        );
    }
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

    let shared_ids: Vec<String> = match query_as::<_, (Vec<String>,)>(
        "SELECT message_ids FROM cloud_session_shared_pins WHERE session_id=$1",
    )
    .bind(&session_id)
    .fetch_optional(&mut *transaction)
    .await
    {
        Ok(row) => row.map(|row| row.0).unwrap_or_default(),
        Err(_) => {
            return err(
                "server_error",
                "Could not load pins.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    let private_rows: Vec<(String, Vec<String>)> = match query_as(
        "SELECT account_id, message_ids FROM cloud_account_session_pins WHERE session_id=$1 AND account_id=ANY($2)")
        .bind(&session_id).bind(&participants).fetch_all(&mut *transaction).await {
        Ok(rows) => rows,
        Err(_) => return err("server_error", "Could not load pins.", StatusCode::INTERNAL_SERVER_ERROR),
    };
    let private_ids = private_rows
        .iter()
        .find(|row| row.0 == session.account_id)
        .map(|row| row.1.clone())
        .unwrap_or_default();
    let previous_ids = if scope == "shared" {
        &shared_ids
    } else {
        &private_ids
    };
    let mut next_ids = previous_ids.clone();
    match action {
        Some("pin") => {
            let id = message_id.as_ref().unwrap();
            if !next_ids.contains(id) {
                next_ids.push(id.clone());
            }
        }
        Some("unpin") => next_ids.retain(|id| Some(id) != message_id.as_ref()),
        // Older clients still replace or clear their single-pin projection.
        _ => next_ids = message_id.iter().cloned().collect(),
    }
    let visible_count = |shared: &[String], private: &[String]| {
        shared
            .iter()
            .chain(private)
            .collect::<std::collections::HashSet<_>>()
            .len()
    };
    let exceeds_limit = next_ids.len() > 5
        || if scope == "shared" {
            participants.iter().any(|account_id| {
                let private = private_rows
                    .iter()
                    .find(|row| &row.0 == account_id)
                    .map(|row| row.1.as_slice())
                    .unwrap_or_default();
                visible_count(&next_ids, private) > 5
            })
        } else {
            visible_count(&shared_ids, &next_ids) > 5
        };
    // Removing pins remains possible if membership changes exposed older personal pins.
    let adds_target = next_ids.iter().any(|id| !previous_ids.contains(id));
    if exceeds_limit && adds_target {
        return err(
            "pin_limit_reached",
            "At most five messages can be pinned. Unpin a message before adding another.",
            StatusCode::CONFLICT,
        );
    }
    let updated_at = Utc::now().to_rfc3339();
    let write_result = if next_ids == *previous_ids {
        Ok(false)
    } else {
        let result = if scope == "shared" {
            if let Some(latest_id) = next_ids.last() {
                query("INSERT INTO cloud_session_shared_pins (session_id, message_id, message_ids, updated_by_account_id, updated_at) \
                    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (session_id) DO UPDATE SET message_id=EXCLUDED.message_id, \
                    message_ids=EXCLUDED.message_ids, updated_by_account_id=EXCLUDED.updated_by_account_id, updated_at=EXCLUDED.updated_at")
                    .bind(&session_id).bind(latest_id).bind(&next_ids).bind(&session.account_id).bind(&updated_at)
                    .execute(&mut *transaction).await
            } else {
                query("DELETE FROM cloud_session_shared_pins WHERE session_id=$1")
                    .bind(&session_id)
                    .execute(&mut *transaction)
                    .await
            }
        } else if let Some(latest_id) = next_ids.last() {
            query("INSERT INTO cloud_account_session_pins (account_id, session_id, message_id, message_ids, updated_at) \
                VALUES ($1,$2,$3,$4,$5) ON CONFLICT (account_id,session_id) DO UPDATE SET message_id=EXCLUDED.message_id, \
                message_ids=EXCLUDED.message_ids, updated_at=EXCLUDED.updated_at")
                .bind(&session.account_id).bind(&session_id).bind(latest_id).bind(&next_ids).bind(&updated_at)
                .execute(&mut *transaction).await
        } else {
            query("DELETE FROM cloud_account_session_pins WHERE account_id=$1 AND session_id=$2")
                .bind(&session.account_id)
                .bind(&session_id)
                .execute(&mut *transaction)
                .await
        };
        result.map(|result| result.rows_affected() > 0)
    };

    let changed = match write_result {
        Ok(changed) => changed,
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
        "messageId": next_ids.last(),
        "messageIds": &next_ids,
        "targetMessageId": &message_id,
        "kind": if action == Some("unpin") || message_id.is_none() { "unpinned" } else { "pinned" },
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
