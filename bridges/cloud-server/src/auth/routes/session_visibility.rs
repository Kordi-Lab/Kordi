use super::*;

mod group_spaces;
mod preferences;
pub(super) use group_spaces::{
    hide_group_space, mute_group_space, unhide_group_space, unmute_group_space,
};
use preferences::{clear_session_pin, clear_session_preferences};
pub(super) use preferences::{
    mark_cloud_session_unread, mute_cloud_session, pin_cloud_session, pin_group_space,
    unmark_cloud_session_unread, unmute_cloud_session, unpin_cloud_session, unpin_group_space,
};

pub(super) async fn list_cloud_session_visibility(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let result = async {
        let mut conn = state.db_pool().acquire().await?;
        crate::chat_sync::visibility::load(&mut conn, &session.account_id).await
    }
    .await;
    match result {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(_) => err(
            "server_error",
            "Database error.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

pub(super) async fn hide_cloud_session(
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
                "You can only hide sessions you participate in.",
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

    let now = Utc::now().to_rfc3339();
    if query(
        "INSERT INTO cloud_account_session_visibility \
         (account_id, session_id, hidden_at, deleted_at, updated_at) \
         VALUES ($1, $2, $3, NULL, $3) \
         ON CONFLICT (account_id, session_id) DO UPDATE SET \
           hidden_at = EXCLUDED.hidden_at, \
           deleted_at = cloud_account_session_visibility.deleted_at, \
           updated_at = EXCLUDED.updated_at",
    )
    .bind(&session.account_id)
    .bind(&session_id)
    .bind(&now)
    .execute(&mut *transaction)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not hide cloud session.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if clear_session_pin(&mut transaction, &session.account_id, conversation_id)
        .await
        .is_err()
    {
        return err(
            "server_error",
            "Could not clear pinned state.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if crate::chat_sync::store::append_user_sync_events_in_transaction(
        &mut transaction,
        std::slice::from_ref(&session.account_id),
        "session.hidden",
        Some(conversation_id),
        &serde_json::json!({ "sessionId": &session_id, "hiddenAt": &now }),
    )
    .await
    .is_err()
        || transaction.commit().await.is_err()
    {
        return err(
            "server_error",
            "Could not record hide sync event.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    StatusCode::NO_CONTENT.into_response()
}

pub(super) async fn unhide_cloud_session(
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
                "You can only unhide sessions you participate in.",
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

    let now = Utc::now().to_rfc3339();
    if query(
        "DELETE FROM cloud_account_session_visibility \
         WHERE account_id = $1 AND session_id = $2",
    )
    .bind(&session.account_id)
    .bind(&session_id)
    .execute(&mut *transaction)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not unhide cloud session.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if crate::chat_sync::store::append_user_sync_events_in_transaction(
        &mut transaction,
        std::slice::from_ref(&session.account_id),
        "session.unhidden",
        Some(conversation_id),
        &serde_json::json!({ "sessionId": &session_id, "unhiddenAt": &now }),
    )
    .await
    .is_err()
        || transaction.commit().await.is_err()
    {
        return err(
            "server_error",
            "Could not record unhide sync event.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    StatusCode::NO_CONTENT.into_response()
}

pub(super) async fn delete_cloud_session(
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
                "You can only remove sessions you participate in.",
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

    let now = Utc::now().to_rfc3339();
    if query(
        "INSERT INTO cloud_account_session_visibility \
         (account_id, session_id, hidden_at, deleted_at, updated_at) \
         VALUES ($1, $2, NULL, $3, $3) \
         ON CONFLICT (account_id, session_id) DO UPDATE SET \
           hidden_at = NULL, \
           deleted_at = EXCLUDED.deleted_at, \
           updated_at = EXCLUDED.updated_at",
    )
    .bind(&session.account_id)
    .bind(&session_id)
    .bind(&now)
    .execute(&mut *transaction)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not remove cloud session.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if clear_session_preferences(&mut transaction, &session.account_id, conversation_id)
        .await
        .is_err()
    {
        return err(
            "server_error",
            "Could not clear session preferences.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if crate::chat_sync::store::append_user_sync_events_in_transaction(
        &mut transaction,
        std::slice::from_ref(&session.account_id),
        "session.deleted",
        Some(conversation_id),
        &serde_json::json!({ "sessionId": &session_id, "deletedAt": &now }),
    )
    .await
    .is_err()
        || transaction.commit().await.is_err()
    {
        return err(
            "server_error",
            "Could not record remove sync event.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    StatusCode::NO_CONTENT.into_response()
}
