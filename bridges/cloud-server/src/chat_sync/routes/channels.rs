use super::*;

pub(super) async fn create(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(group_space_id): Path<String>,
    Json(request): Json<CreateConversationRequest>,
) -> Response {
    match store::create_group_channel(
        state.db_pool(),
        &session.account_id,
        &group_space_id,
        request,
    )
    .await
    {
        Ok(outcome) => {
            if outcome.inserted {
                if let Some(agent) = state
                    .system_agent()
                    .filter(|agent| agent.config().group_chat_enabled)
                {
                    if let Err(error) = crate::system_agent::membership::join_conversation(
                        state.db_pool(),
                        &agent.config().account_id,
                        outcome.value.id,
                    )
                    .await
                    {
                        eprintln!("[system-agent] Could not join a new channel: {error}");
                    }
                }
            }
            (
                if outcome.inserted {
                    StatusCode::CREATED
                } else {
                    StatusCode::OK
                },
                Json(ConversationResponse {
                    conversation: outcome.value,
                }),
            )
                .into_response()
        }
        Err(error) => store_error("create group channel", error),
    }
}

/// Dissolving a whole group, or one of its channels, is for group admins
/// only. Any member may leave a group.
pub(super) fn dissolve_routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route(
            "/v2/chat/group-spaces/:group_space_id",
            axum::routing::delete(dissolve_group),
        )
        .route(
            "/v2/chat/group-spaces/:group_space_id/channels/:conversation_id",
            axum::routing::delete(dissolve_channel),
        )
        .route(
            "/v2/chat/group-spaces/:group_space_id/members/me",
            axum::routing::delete(leave_group),
        )
}

/// The caller leaves every channel of a group. A last admin must make
/// someone else an admin first (409 `last_group_admin`), and the last person
/// dissolves the group instead (409 `last_group_member`).
pub(super) async fn leave_group(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    rate_limiter: Option<Extension<Arc<CloudRateLimiter>>>,
    Path(group_space_id): Path<String>,
) -> Response {
    if let Some(Extension(rate_limiter)) = rate_limiter {
        if let RateLimitDecision::Limited { retry_after } = rate_limiter
            .observe_account_limit(GROUP_LEAVE_LIMIT, &session.account_id)
            .await
        {
            return rate_limited_response(retry_after);
        }
    }
    match store::leave_group(state.db_pool(), &session.account_id, &group_space_id).await {
        Ok(outcome) => Json(json!({ "left": outcome })).into_response(),
        Err(error) => store_error("leave group", error),
    }
}

/// A request that conflicts with the group's state, such as a last admin
/// leaving, under the stable `code` clients read.
pub(super) fn conflict_response(code: &str, message: &str) -> Response {
    error_response(StatusCode::CONFLICT, code, message, None)
}

pub(super) async fn dissolve_group(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(group_space_id): Path<String>,
) -> Response {
    match store::dissolve_group(state.db_pool(), &session.account_id, &group_space_id).await {
        Ok(outcome) => Json(json!({ "dissolved": outcome })).into_response(),
        Err(error) => store_error("dissolve group", error),
    }
}

/// Dissolves one channel of a group, other than its first: an owner or admin only.
pub(super) async fn dissolve_channel(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((group_space_id, conversation_id)): Path<(String, Uuid)>,
) -> Response {
    match store::dissolve_group_channel(
        state.db_pool(),
        &session.account_id,
        &group_space_id,
        conversation_id,
    )
    .await
    {
        Ok(outcome) => Json(json!({ "dissolved": outcome })).into_response(),
        Err(error) => store_error("dissolve group channel", error),
    }
}
