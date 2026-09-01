use super::*;

pub(super) struct SessionListPreferences {
    pub pinned_session_ids: Vec<String>,
    pub muted_session_ids: Vec<String>,
    pub unread_session_ids: Vec<String>,
    pub pinned_group_space_ids: Vec<String>,
}

pub(super) async fn load_session_list_preferences(
    pool: &PgPool,
    account_id: &str,
) -> Result<SessionListPreferences, sqlx_core::error::Error> {
    let rows: Vec<(String, bool, bool, bool)> = query_as(
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
    .bind(account_id)
    .fetch_all(pool)
    .await?;
    let mut preferences = SessionListPreferences {
        pinned_session_ids: Vec::new(),
        muted_session_ids: Vec::new(),
        unread_session_ids: Vec::new(),
        pinned_group_space_ids: Vec::new(),
    };
    for (session_id, pinned, muted, unread) in rows {
        if pinned {
            preferences.pinned_session_ids.push(session_id.clone());
        }
        if muted {
            preferences.muted_session_ids.push(session_id.clone());
        }
        if unread {
            preferences.unread_session_ids.push(session_id);
        }
    }
    preferences.pinned_group_space_ids = query_as::<_, (String,)>(
        "SELECT group_space_id FROM cloud_account_group_space_preferences \
         WHERE account_id = $1 AND pinned_at IS NOT NULL \
         ORDER BY updated_at DESC, group_space_id ASC",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(group_space_id,)| group_space_id)
    .collect();
    Ok(preferences)
}

pub(super) async fn clear_session_pin(
    pool: &PgPool,
    account_id: &str,
    session_id: &str,
) -> Result<(), sqlx_core::error::Error> {
    query(
        "UPDATE cloud_chat_conversation_members member SET pinned_at = NULL \
         FROM cloud_chat_conversations conversation \
         WHERE member.conversation_id = conversation.conversation_id \
           AND member.account_id = $1 AND member.membership_state = 'active' \
           AND (conversation.legacy_session_id = $2 OR conversation.conversation_id::text = $2)",
    )
    .bind(account_id)
    .bind(session_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub(super) async fn clear_session_preferences(
    pool: &PgPool,
    account_id: &str,
    session_id: &str,
) -> Result<(), sqlx_core::error::Error> {
    query(
        "UPDATE cloud_chat_conversation_members member \
         SET pinned_at = NULL, muted_until = NULL, marked_unread_at = NULL \
         FROM cloud_chat_conversations conversation \
         WHERE member.conversation_id = conversation.conversation_id \
           AND member.account_id = $1 AND member.membership_state = 'active' \
           AND (conversation.legacy_session_id = $2 OR conversation.conversation_id::text = $2)",
    )
    .bind(account_id)
    .bind(session_id)
    .execute(pool)
    .await?;
    Ok(())
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

pub(in crate::auth::routes) async fn pin_cloud_session(
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

pub(in crate::auth::routes) async fn unpin_cloud_session(
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

pub(in crate::auth::routes) async fn mute_cloud_session(
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

pub(in crate::auth::routes) async fn unmute_cloud_session(
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

pub(in crate::auth::routes) async fn mark_cloud_session_unread(
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

pub(in crate::auth::routes) async fn unmark_cloud_session_unread(
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

async fn set_group_space_pinned(
    state: Arc<ServerState>,
    session: CloudSession,
    source_group_space_id: String,
    pinned: bool,
) -> Response {
    let Some(group_space_id) = normalized_source_session_id(&source_group_space_id) else {
        return err(
            "invalid_group_space",
            "groupSpaceId is required.",
            StatusCode::BAD_REQUEST,
        );
    };
    let now = Utc::now().to_rfc3339();
    if query(
        "INSERT INTO cloud_account_group_space_preferences \
         (account_id, group_space_id, pinned_at, updated_at) \
         VALUES ($1, $2, CASE WHEN $3 THEN NOW() ELSE NULL END, NOW()) \
         ON CONFLICT (account_id, group_space_id) DO UPDATE SET \
           pinned_at = EXCLUDED.pinned_at, updated_at = EXCLUDED.updated_at",
    )
    .bind(&session.account_id)
    .bind(&group_space_id)
    .bind(pinned)
    .execute(state.db_pool())
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not update group preferences.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }
    let event_type = if pinned {
        "group_space.pinned"
    } else {
        "group_space.unpinned"
    };
    if publish_chat_event(
        state.db_pool(),
        &session.account_id,
        event_type,
        Some(&group_space_id),
        None,
        serde_json::json!({ "sessionId": &group_space_id, "updatedAt": &now }),
        &now,
    )
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not record group preference sync event.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }
    StatusCode::NO_CONTENT.into_response()
}

pub(in crate::auth::routes) async fn pin_group_space(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(group_space_id): axum::extract::Path<String>,
) -> Response {
    set_group_space_pinned(state, session, group_space_id, true).await
}

pub(in crate::auth::routes) async fn unpin_group_space(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(group_space_id): axum::extract::Path<String>,
) -> Response {
    set_group_space_pinned(state, session, group_space_id, false).await
}
