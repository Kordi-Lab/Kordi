use super::*;

// ============================================================================
// Cloud session forks
// ----------------------------------------------------------------------------
// Issue #353 / fork lineage for cloud-sync. The forker calls
// `POST /v1/cloud/sessions/:source_session_id/forks` with a client-generated
// `forkSessionId` and an optional `parentMessageId`. The server records the
// lineage in `cloud_session_forks` and emits a `session-forked` event into
// every participant's durable sync stream.
// Forker's own messages under the new fork session stay private to them; other
// participants only learn lineage, not content.
// ============================================================================

#[derive(Debug, Deserialize)]
pub struct CreateCloudSessionForkRequest {
    #[serde(rename = "forkSessionId")]
    pub fork_session_id: String,
    #[serde(rename = "parentMessageId")]
    pub parent_message_id: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct CloudSessionForkSummary {
    #[serde(rename = "forkSessionId")]
    pub fork_session_id: String,
    #[serde(rename = "parentSessionId")]
    pub parent_session_id: String,
    #[serde(rename = "parentMessageId", skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<String>,
    #[serde(rename = "createdByAccountId")]
    pub created_by_account_id: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct CreateCloudSessionForkResponse {
    pub fork: CloudSessionForkSummary,
}

#[derive(Debug, Serialize)]
pub struct ListCloudSessionForksResponse {
    pub forks: Vec<CloudSessionForkSummary>,
}

pub(crate) async fn cloud_session_participants(
    pool: &PgPool,
    session_id: &str,
) -> Result<Vec<String>, sqlx_core::error::Error> {
    let participants: Vec<(String,)> = query_as(
        "SELECT member.account_id
         FROM cloud_chat_conversations conversation
         JOIN cloud_chat_conversation_members member
           ON member.conversation_id = conversation.conversation_id
         WHERE conversation.legacy_session_id = $1
           AND member.membership_state = 'active'
         ORDER BY member.account_id ASC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    Ok(participants
        .into_iter()
        .map(|(account_id,)| account_id)
        .collect())
}

pub(super) async fn create_cloud_session_fork(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(source_session_id): axum::extract::Path<String>,
    Json(req): Json<CreateCloudSessionForkRequest>,
) -> Response {
    let parent_session_id = source_session_id.trim().to_string();
    let fork_session_id = req.fork_session_id.trim().to_string();
    let parent_message_id = req
        .parent_message_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    if parent_session_id.is_empty() {
        return err(
            "invalid_session",
            "sourceSessionId is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    if fork_session_id.is_empty() {
        return err(
            "invalid_fork",
            "forkSessionId is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    if fork_session_id == parent_session_id {
        return err(
            "invalid_fork",
            "forkSessionId must differ from sourceSessionId.",
            StatusCode::BAD_REQUEST,
        );
    }

    let pool = state.db_pool();
    let participants = match cloud_session_participants(pool, &parent_session_id).await {
        Ok(participants) => participants,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    // The caller must be a participant of the source session — otherwise they
    // shouldn't even know it exists. (Authorization gate.)
    if !participants.iter().any(|id| id == &session.account_id) {
        return err(
            "not_a_participant",
            "You can only fork sessions you participate in.",
            StatusCode::FORBIDDEN,
        );
    }

    let created_at = Utc::now().to_rfc3339();
    if query(
        "INSERT INTO cloud_session_forks \
         (fork_session_id, parent_session_id, parent_message_id, created_by_account_id, created_at) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&fork_session_id)
    .bind(&parent_session_id)
    .bind(&parent_message_id)
    .bind(&session.account_id)
    .bind(&created_at)
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "fork_exists",
            "A fork with that id already exists.",
            StatusCode::CONFLICT,
        );
    }

    let fork = CloudSessionForkSummary {
        fork_session_id: fork_session_id.clone(),
        parent_session_id: parent_session_id.clone(),
        parent_message_id: parent_message_id.clone(),
        created_by_account_id: session.account_id.clone(),
        created_at: created_at.clone(),
    };

    let _ = crate::auth::session_activity::copy_cloud_session_activity_to_fork(
        pool,
        &parent_session_id,
        &fork_session_id,
        &created_at,
    )
    .await;

    // Fan out through the per-user stream in one deterministic recipient
    // order. The fork row remains canonical if publication fails.
    let payload = serde_json::to_value(&fork).unwrap_or_else(|_| serde_json::json!({}));
    let conversation_id = crate::chat_sync::store::conversation_id_for_session(
        pool,
        &session.account_id,
        &parent_session_id,
    )
    .await
    .ok()
    .flatten();
    let _ = crate::chat_sync::store::publish_user_sync_events(
        pool,
        &participants,
        "session-forked",
        conversation_id,
        payload,
    )
    .await;

    (
        StatusCode::CREATED,
        Json(CreateCloudSessionForkResponse { fork }),
    )
        .into_response()
}

pub(super) async fn list_cloud_session_forks(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(source_session_id): axum::extract::Path<String>,
) -> Response {
    let parent_session_id = source_session_id.trim().to_string();
    if parent_session_id.is_empty() {
        return err(
            "invalid_session",
            "sourceSessionId is required.",
            StatusCode::BAD_REQUEST,
        );
    }

    let pool = state.db_pool();
    let participants = match cloud_session_participants(pool, &parent_session_id).await {
        Ok(participants) => participants,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    // Only participants of the source session can list forks.
    if !participants.iter().any(|id| id == &session.account_id) {
        return err(
            "not_a_participant",
            "You can only list forks of sessions you participate in.",
            StatusCode::FORBIDDEN,
        );
    }

    let rows: Vec<(String, String, Option<String>, String, String)> = match query_as(
        "SELECT fork_session_id, parent_session_id, parent_message_id, created_by_account_id, created_at \
         FROM cloud_session_forks WHERE parent_session_id = $1 ORDER BY created_at ASC",
    )
    .bind(&parent_session_id)
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

    let forks = rows
        .into_iter()
        .map(
            |(
                fork_session_id,
                parent_session_id,
                parent_message_id,
                created_by_account_id,
                created_at,
            )| {
                CloudSessionForkSummary {
                    fork_session_id,
                    parent_session_id,
                    parent_message_id,
                    created_by_account_id,
                    created_at,
                }
            },
        )
        .collect();

    Json(ListCloudSessionForksResponse { forks }).into_response()
}
