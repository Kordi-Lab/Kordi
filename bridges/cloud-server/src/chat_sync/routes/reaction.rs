use super::*;

pub(super) async fn add_reaction(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((conversation_id, message_id)): Path<(Uuid, Uuid)>,
    Json(request): Json<UpdateReactionRequest>,
) -> Response {
    update_reaction(state, session, conversation_id, message_id, request, true).await
}

pub(super) async fn remove_reaction(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((conversation_id, message_id)): Path<(Uuid, Uuid)>,
    Json(request): Json<UpdateReactionRequest>,
) -> Response {
    update_reaction(state, session, conversation_id, message_id, request, false).await
}

async fn update_reaction(
    state: Arc<ServerState>,
    session: CloudSession,
    conversation_id: Uuid,
    message_id: Uuid,
    request: UpdateReactionRequest,
    active: bool,
) -> Response {
    match store::set_reaction(
        state.db_pool(),
        &session.account_id,
        conversation_id,
        message_id,
        &request.reaction,
        active,
    )
    .await
    {
        Ok(message) => Json(MessageResponse { message }).into_response(),
        Err(error) => store_error("update reaction", error),
    }
}
