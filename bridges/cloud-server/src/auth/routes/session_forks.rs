use super::*;

// ============================================================================
// Cloud session forks
// ----------------------------------------------------------------------------
// Issue #353 / fork lineage for cloud-sync. The forker calls
// `POST /v1/cloud/sessions/:source_session_id/forks` with a client-generated
// `forkSessionId` and an optional `parentMessageId`. The server records the
// lineage in `cloud_session_forks` and emits a `session-forked` event into
// `cloud_sync_events` for every distinct participant of the source session
// (anyone who sent or received any message with `session_id == source`).
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

#[derive(Debug, Deserialize)]
struct CloudGroupControlParticipantForAuth {
    #[serde(rename = "accountId")]
    account_id: String,
}

#[derive(Debug, Deserialize)]
struct CloudGroupControlForAuth {
    #[serde(rename = "groupId")]
    group_id: String,
    #[serde(rename = "groupSpaceId")]
    group_space_id: Option<String>,
    #[serde(rename = "createdByAccountId")]
    created_by_account_id: String,
    actor: CloudGroupControlParticipantForAuth,
    participants: Vec<CloudGroupControlParticipantForAuth>,
}

fn parse_cloud_group_control_for_auth(body: &str) -> Option<CloudGroupControlForAuth> {
    let encoded = body.strip_prefix(CLOUD_GROUP_CONTROL_PREFIX)?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    serde_json::from_slice::<CloudGroupControlForAuth>(&bytes).ok()
}

pub(crate) async fn cloud_session_participants(
    pool: &PgPool,
    session_id: &str,
) -> Result<Vec<String>, sqlx_core::error::Error> {
    let mut participants: Vec<String> = query_as::<_, (String,)>(
        "SELECT DISTINCT account_id FROM (\
            SELECT from_account_id AS account_id FROM cloud_messages WHERE session_id = $1 \
            UNION \
            SELECT to_account_id AS account_id FROM cloud_messages WHERE session_id = $1 \
         ) AS participants",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(account_id,)| account_id)
    .collect();

    let group_rows: Vec<(String, String, String)> = query_as(
        "SELECT from_account_id, to_account_id, body FROM cloud_messages WHERE body LIKE $1",
    )
    .bind(format!("{}%", CLOUD_GROUP_CONTROL_PREFIX))
    .fetch_all(pool)
    .await?;
    for (from_account_id, to_account_id, body) in group_rows {
        let Some(control) = parse_cloud_group_control_for_auth(&body) else {
            continue;
        };
        let group_space_id = control.group_space_id.as_deref().unwrap_or_default().trim();
        if control.group_id.trim() != session_id && group_space_id != session_id {
            continue;
        }
        participants.push(from_account_id);
        participants.push(to_account_id);
        participants.push(control.created_by_account_id);
        participants.push(control.actor.account_id);
        participants.extend(
            control
                .participants
                .into_iter()
                .map(|participant| participant.account_id),
        );
    }
    participants.sort();
    participants.dedup();
    Ok(participants)
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

    // Fan out a `session-forked` event to every participant of the source
    // session, including the forker themselves. Failures on individual
    // recipients shouldn't roll back the fork — the canonical row is the
    // source of truth and clients can full-resync via the existing cursor
    // fallback in cloudDiffSync if they miss the event.
    let payload = serde_json::to_value(&fork).unwrap_or_else(|_| serde_json::json!({}));
    for participant in &participants {
        let _ = append_cloud_sync_event(
            pool,
            participant,
            "session-forked",
            Some(&parent_session_id),
            None,
            payload.clone(),
            &created_at,
        )
        .await;
    }

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
