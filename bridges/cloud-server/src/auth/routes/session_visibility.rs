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

    let preferences: Vec<(String, bool, bool, bool)> = match query_as(
        "SELECT COALESCE(conversation.legacy_session_id, conversation.conversation_id::text), \
                member.pinned_at IS NOT NULL, \
                member.muted_until IS NOT NULL AND member.muted_until > NOW(), \
                member.marked_unread_at IS NOT NULL \
         FROM cloud_chat_conversation_members member \
         JOIN cloud_chat_conversations conversation \
           ON conversation.conversation_id = member.conversation_id \
         WHERE member.account_id = $1 AND member.membership_state = 'active' \
           AND (member.pinned_at IS NOT NULL OR member.marked_unread_at IS NOT NULL OR \
                (member.muted_until IS NOT NULL AND member.muted_until > NOW())) \
         ORDER BY conversation.updated_at DESC, conversation.conversation_id ASC",
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
    let mut pinned_session_ids = Vec::new();
    let mut muted_session_ids = Vec::new();
    let mut unread_session_ids = Vec::new();
    for (session_id, pinned, muted, unread) in preferences {
        if pinned {
            pinned_session_ids.push(session_id.clone());
        }
        if muted {
            muted_session_ids.push(session_id.clone());
        }
        if unread {
            unread_session_ids.push(session_id);
        }
    }

    Json(CloudSessionVisibilityResponse {
        hidden_session_ids,
        deleted_session_ids,
        pinned_session_ids,
        muted_session_ids,
        unread_session_ids,
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

    if query(
        "UPDATE cloud_chat_conversation_members member SET pinned_at = NULL \
         FROM cloud_chat_conversations conversation \
         WHERE member.conversation_id = conversation.conversation_id \
           AND member.account_id = $1 AND member.membership_state = 'active' \
           AND (conversation.legacy_session_id = $2 OR conversation.conversation_id::text = $2)",
    )
    .bind(&session.account_id)
    .bind(&session_id)
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not clear pinned state.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if publish_chat_event(
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
         WHERE account_id = $1 AND session_id = $2",
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

    if publish_chat_event(
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

    if query(
        "UPDATE cloud_chat_conversation_members member \
         SET pinned_at = NULL, muted_until = NULL, marked_unread_at = NULL \
         FROM cloud_chat_conversations conversation \
         WHERE member.conversation_id = conversation.conversation_id \
           AND member.account_id = $1 AND member.membership_state = 'active' \
           AND (conversation.legacy_session_id = $2 OR conversation.conversation_id::text = $2)",
    )
    .bind(&session.account_id)
    .bind(&session_id)
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not clear session preferences.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
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

    if publish_chat_event(
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

#[derive(Clone, Copy)]
enum SessionListPreference {
    Pinned,
    Muted,
    Unread,
}

async fn set_cloud_session_list_preference(
    state: Arc<ServerState>,
    session: CloudSession,
    source_session_id: String,
    preference: SessionListPreference,
    enabled: bool,
) -> Response {
    let Some(session_id) = normalized_source_session_id(&source_session_id) else {
        return err(
            "invalid_session",
            "sourceSessionId is required.",
            StatusCode::BAD_REQUEST,
        );
    };
    let pool = state.db_pool();
    let result = match preference {
        SessionListPreference::Pinned => {
            query(
                "UPDATE cloud_chat_conversation_members member \
                 SET pinned_at = CASE WHEN $3 THEN NOW() ELSE NULL END \
                 FROM cloud_chat_conversations conversation \
                 WHERE member.conversation_id = conversation.conversation_id \
                   AND member.account_id = $1 AND member.membership_state = 'active' \
                   AND (conversation.legacy_session_id = $2 OR conversation.conversation_id::text = $2)",
            )
            .bind(&session.account_id)
            .bind(&session_id)
            .bind(enabled)
            .execute(pool)
            .await
        }
        SessionListPreference::Muted => {
            query(
                "UPDATE cloud_chat_conversation_members member \
                 SET muted_until = CASE WHEN $3 THEN 'infinity'::timestamptz ELSE NULL END \
                 FROM cloud_chat_conversations conversation \
                 WHERE member.conversation_id = conversation.conversation_id \
                   AND member.account_id = $1 AND member.membership_state = 'active' \
                   AND (conversation.legacy_session_id = $2 OR conversation.conversation_id::text = $2)",
            )
            .bind(&session.account_id)
            .bind(&session_id)
            .bind(enabled)
            .execute(pool)
            .await
        }
        SessionListPreference::Unread => {
            query(
                "UPDATE cloud_chat_conversation_members member \
                 SET marked_unread_at = CASE WHEN $3 THEN NOW() ELSE NULL END \
                 FROM cloud_chat_conversations conversation \
                 WHERE member.conversation_id = conversation.conversation_id \
                   AND member.account_id = $1 AND member.membership_state = 'active' \
                   AND (conversation.legacy_session_id = $2 OR conversation.conversation_id::text = $2)",
            )
            .bind(&session.account_id)
            .bind(&session_id)
            .bind(enabled)
            .execute(pool)
            .await
        }
    };
    let rows_affected = match result {
        Ok(result) => result.rows_affected(),
        Err(_) => {
            return err(
                "server_error",
                "Could not update session preferences.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    if rows_affected == 0 {
        return err(
            "not_a_participant",
            "You can only update sessions you participate in.",
            StatusCode::FORBIDDEN,
        );
    }

    let event_type = match (preference, enabled) {
        (SessionListPreference::Pinned, true) => "session.pinned",
        (SessionListPreference::Pinned, false) => "session.unpinned",
        (SessionListPreference::Muted, true) => "session.muted",
        (SessionListPreference::Muted, false) => "session.unmuted",
        (SessionListPreference::Unread, true) => "session.marked_unread",
        (SessionListPreference::Unread, false) => "session.unmarked_unread",
    };
    let now = Utc::now().to_rfc3339();
    if publish_chat_event(
        pool,
        &session.account_id,
        event_type,
        Some(&session_id),
        None,
        serde_json::json!({ "sessionId": &session_id, "updatedAt": &now }),
        &now,
    )
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not record session preference sync event.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }
    StatusCode::NO_CONTENT.into_response()
}

pub(super) async fn pin_cloud_session(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Response {
    set_cloud_session_list_preference(
        state,
        session,
        session_id,
        SessionListPreference::Pinned,
        true,
    )
    .await
}

pub(super) async fn unpin_cloud_session(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Response {
    set_cloud_session_list_preference(
        state,
        session,
        session_id,
        SessionListPreference::Pinned,
        false,
    )
    .await
}

pub(super) async fn mute_cloud_session(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Response {
    set_cloud_session_list_preference(
        state,
        session,
        session_id,
        SessionListPreference::Muted,
        true,
    )
    .await
}

pub(super) async fn unmute_cloud_session(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Response {
    set_cloud_session_list_preference(
        state,
        session,
        session_id,
        SessionListPreference::Muted,
        false,
    )
    .await
}

pub(super) async fn mark_cloud_session_unread(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Response {
    set_cloud_session_list_preference(
        state,
        session,
        session_id,
        SessionListPreference::Unread,
        true,
    )
    .await
}

pub(super) async fn unmark_cloud_session_unread(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Response {
    set_cloud_session_list_preference(
        state,
        session,
        session_id,
        SessionListPreference::Unread,
        false,
    )
    .await
}
