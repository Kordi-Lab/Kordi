use super::*;
use uuid::Uuid;

async fn set_group_space_archived(
    state: Arc<ServerState>,
    session: CloudSession,
    source_group_space_id: String,
    archived: bool,
) -> Response {
    let Some(group_space_id) = normalized_source_session_id(&source_group_space_id) else {
        return err(
            "invalid_group_space",
            "groupSpaceId is required.",
            StatusCode::BAD_REQUEST,
        );
    };
    let mut transaction = match state.db_pool().begin().await {
        Ok(transaction) => transaction,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let conversations: Vec<(uuid::Uuid, Option<String>)> = match query_as(
        "SELECT conversation.conversation_id, conversation.legacy_session_id \
         FROM cloud_chat_conversations conversation \
         JOIN cloud_chat_conversation_members member \
           ON member.conversation_id = conversation.conversation_id \
         WHERE conversation.kind = 'group' AND conversation.group_space_id = $2 \
           AND member.account_id = $1 AND member.membership_state = 'active' \
         ORDER BY conversation.created_at ASC, conversation.conversation_id ASC",
    )
    .bind(&session.account_id)
    .bind(&group_space_id)
    .fetch_all(&mut *transaction)
    .await
    {
        Ok(conversations) if !conversations.is_empty() => conversations,
        Ok(_) => {
            return err(
                "not_a_participant",
                "You can only update groups you participate in.",
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
    for (conversation_id, legacy_session_id) in conversations {
        let session_id = legacy_session_id.unwrap_or_else(|| conversation_id.to_string());
        let changed = if archived {
            query(
                "INSERT INTO cloud_account_session_visibility \
                 (account_id, session_id, hidden_at, deleted_at, updated_at) \
                 VALUES ($1, $2, $3, NULL, $3) \
                 ON CONFLICT (account_id, session_id) DO UPDATE SET \
                   hidden_at = EXCLUDED.hidden_at, \
                   deleted_at = cloud_account_session_visibility.deleted_at, \
                   updated_at = EXCLUDED.updated_at \
                 WHERE cloud_account_session_visibility.hidden_at IS NULL",
            )
            .bind(&session.account_id)
            .bind(&session_id)
            .bind(&now)
            .execute(&mut *transaction)
            .await
        } else {
            query(
                "DELETE FROM cloud_account_session_visibility \
                 WHERE account_id = $1 AND session_id = $2",
            )
            .bind(&session.account_id)
            .bind(&session_id)
            .execute(&mut *transaction)
            .await
        };
        let changed = match changed {
            Ok(result) => result.rows_affected() > 0,
            Err(_) => {
                return err(
                    "server_error",
                    "Could not update group visibility.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                );
            }
        };
        if archived
            && clear_session_pin(&mut transaction, &session.account_id, conversation_id)
                .await
                .is_err()
        {
            return err(
                "server_error",
                "Could not clear pinned state.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
        if !changed {
            continue;
        }
        let (event_type, payload) = if archived {
            (
                "session.hidden",
                serde_json::json!({ "sessionId": session_id, "hiddenAt": &now }),
            )
        } else {
            (
                "session.unhidden",
                serde_json::json!({ "sessionId": session_id, "unhiddenAt": &now }),
            )
        };
        if crate::chat_sync::store::append_user_sync_events_in_transaction(
            &mut transaction,
            std::slice::from_ref(&session.account_id),
            event_type,
            Some(conversation_id),
            &payload,
        )
        .await
        .is_err()
        {
            return err(
                "server_error",
                "Could not record group visibility sync event.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }
    if archived {
        let unpinned = match query(
            "UPDATE cloud_account_group_space_preferences \
             SET pinned_at = NULL, updated_at = NOW() \
             WHERE account_id = $1 AND group_space_id = $2 AND pinned_at IS NOT NULL",
        )
        .bind(&session.account_id)
        .bind(&group_space_id)
        .execute(&mut *transaction)
        .await
        {
            Ok(result) => result.rows_affected() > 0,
            Err(_) => {
                return err(
                    "server_error",
                    "Could not clear group pinned state.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                );
            }
        };
        if unpinned
            && crate::chat_sync::store::append_user_sync_events_in_transaction(
                &mut transaction,
                std::slice::from_ref(&session.account_id),
                "group_space.unpinned",
                None,
                &serde_json::json!({ "sessionId": &group_space_id, "updatedAt": &now }),
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
    }
    match transaction.commit().await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => err(
            "server_error",
            "Could not update group visibility.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

pub(in crate::auth::routes) async fn hide_group_space(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(group_space_id): axum::extract::Path<String>,
) -> Response {
    set_group_space_archived(state, session, group_space_id, true).await
}

pub(in crate::auth::routes) async fn unhide_group_space(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(group_space_id): axum::extract::Path<String>,
) -> Response {
    set_group_space_archived(state, session, group_space_id, false).await
}

async fn set_group_space_muted(
    state: Arc<ServerState>,
    session: CloudSession,
    source_group_space_id: String,
    muted: bool,
) -> Response {
    let Some(group_space_id) = normalized_source_session_id(&source_group_space_id) else {
        return err(
            "invalid_group_space",
            "groupSpaceId is required.",
            StatusCode::BAD_REQUEST,
        );
    };
    let mut transaction = match state.db_pool().begin().await {
        Ok(transaction) => transaction,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let conversations: Vec<(Uuid, Option<String>)> = match query_as(
        "SELECT conversation.conversation_id, conversation.legacy_session_id \
         FROM cloud_chat_conversations conversation \
         JOIN cloud_chat_conversation_members member \
           ON member.conversation_id = conversation.conversation_id \
         WHERE conversation.kind = 'group' AND conversation.group_space_id = $2 \
           AND member.account_id = $1 AND member.membership_state = 'active' \
         ORDER BY conversation.created_at ASC, conversation.conversation_id ASC",
    )
    .bind(&session.account_id)
    .bind(&group_space_id)
    .fetch_all(&mut *transaction)
    .await
    {
        Ok(conversations) if !conversations.is_empty() => conversations,
        Ok(_) => {
            return err(
                "not_a_participant",
                "You can only update groups you participate in.",
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
    let event_type = if muted {
        "session.muted"
    } else {
        "session.unmuted"
    };
    let now = Utc::now().to_rfc3339();
    for (conversation_id, legacy_session_id) in conversations {
        let changed = match query(
            "UPDATE cloud_chat_conversation_members \
             SET muted_until = CASE WHEN $3 THEN 'infinity'::timestamptz ELSE NULL END \
             WHERE account_id = $1 AND conversation_id = $2 \
               AND membership_state = 'active' \
               AND ((muted_until IS NOT NULL AND muted_until > NOW()) <> $3)",
        )
        .bind(&session.account_id)
        .bind(conversation_id)
        .bind(muted)
        .execute(&mut *transaction)
        .await
        {
            Ok(result) => result.rows_affected() > 0,
            Err(_) => {
                return err(
                    "server_error",
                    "Could not update group preferences.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                );
            }
        };
        if !changed {
            continue;
        }
        let session_id = legacy_session_id.unwrap_or_else(|| conversation_id.to_string());
        if crate::chat_sync::store::append_user_sync_events_in_transaction(
            &mut transaction,
            std::slice::from_ref(&session.account_id),
            event_type,
            Some(conversation_id),
            &serde_json::json!({ "sessionId": session_id, "updatedAt": &now }),
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
    }
    match transaction.commit().await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => err(
            "server_error",
            "Could not update group preferences.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

pub(in crate::auth::routes) async fn mute_group_space(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(group_space_id): axum::extract::Path<String>,
) -> Response {
    set_group_space_muted(state, session, group_space_id, true).await
}

pub(in crate::auth::routes) async fn unmute_group_space(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(group_space_id): axum::extract::Path<String>,
) -> Response {
    set_group_space_muted(state, session, group_space_id, false).await
}
