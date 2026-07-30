use super::*;

pub(super) async fn list_cloud_session_visibility(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let rows: Vec<(String, Option<String>, Option<String>)> = match query_as(
        "SELECT session_id, hidden_at, deleted_at \
         FROM cloud_account_session_visibility \
         WHERE account_id = $1 AND (hidden_at IS NOT NULL OR deleted_at IS NOT NULL) \
         ORDER BY updated_at ASC",
    )
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

    let mut hidden_session_ids = Vec::new();
    let mut deleted_session_ids = Vec::new();
    for (session_id, hidden_at, deleted_at) in rows {
        if deleted_at.is_some() {
            deleted_session_ids.push(session_id);
        } else if hidden_at.is_some() {
            hidden_session_ids.push(session_id);
        }
    }

    Json(CloudSessionVisibilityResponse {
        hidden_session_ids,
        deleted_session_ids,
    })
    .into_response()
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
    match caller_can_access_cloud_session(pool, &session.account_id, &session_id).await {
        Ok(true) => {}
        Ok(false) => {
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
    }

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
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not hide cloud session.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if append_cloud_sync_event(
        pool,
        &session.account_id,
        "session.hidden",
        Some(&session_id),
        None,
        serde_json::json!({ "sessionId": &session_id, "hiddenAt": &now }),
        &now,
    )
    .await
    .is_err()
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
    match caller_can_access_cloud_session(pool, &session.account_id, &session_id).await {
        Ok(true) => {}
        Ok(false) => {
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
    }

    let now = Utc::now().to_rfc3339();
    if query(
        "DELETE FROM cloud_account_session_visibility \
         WHERE account_id = $1 AND session_id = $2 AND deleted_at IS NULL",
    )
    .bind(&session.account_id)
    .bind(&session_id)
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not unhide cloud session.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if query(
        "UPDATE cloud_account_session_visibility \
         SET hidden_at = NULL, updated_at = $3 \
         WHERE account_id = $1 AND session_id = $2 AND deleted_at IS NOT NULL",
    )
    .bind(&session.account_id)
    .bind(&session_id)
    .bind(&now)
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not unhide cloud session.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if append_cloud_sync_event(
        pool,
        &session.account_id,
        "session.unhidden",
        Some(&session_id),
        None,
        serde_json::json!({ "sessionId": &session_id, "unhiddenAt": &now }),
        &now,
    )
    .await
    .is_err()
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
    match caller_can_access_cloud_session(pool, &session.account_id, &session_id).await {
        Ok(true) => {}
        Ok(false) => {
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
    }

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
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not remove cloud session.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if append_cloud_sync_event(
        pool,
        &session.account_id,
        "session.deleted",
        Some(&session_id),
        None,
        serde_json::json!({ "sessionId": &session_id, "deletedAt": &now }),
        &now,
    )
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not record remove sync event.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    StatusCode::NO_CONTENT.into_response()
}
