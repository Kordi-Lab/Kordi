use super::*;
use crate::chat_sync::models::{DeleteMessageQuery, UpdateReactionRequest};

pub(super) fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route("/v2/chat/conversations/:conversation_id/messages/:message_id/attachments/:attachment_id",
               axum::routing::delete(delete_attachment))
        .route("/v2/chat/conversations/:conversation_id/messages/:message_id/attachments/:attachment_id/reactions",
               put(add_reaction).delete(remove_reaction))
}

async fn delete_attachment(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((conversation, message, attachment)): Path<(Uuid, Uuid, String)>,
    Query(request): Query<DeleteMessageQuery>,
) -> Response {
    match store::delete_attachment(
        state.db_pool(),
        &session.account_id,
        conversation,
        message,
        &attachment,
        request.for_everyone,
    )
    .await
    {
        Ok(message) => Json(json!({ "message": message })).into_response(),
        Err(error) => store_error("delete attachment", error),
    }
}

async fn add_reaction(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((conversation, message, attachment)): Path<(Uuid, Uuid, String)>,
    Json(request): Json<UpdateReactionRequest>,
) -> Response {
    reaction(
        state,
        session,
        conversation,
        message,
        attachment,
        request,
        true,
    )
    .await
}

async fn remove_reaction(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((conversation, message, attachment)): Path<(Uuid, Uuid, String)>,
    Json(request): Json<UpdateReactionRequest>,
) -> Response {
    reaction(
        state,
        session,
        conversation,
        message,
        attachment,
        request,
        false,
    )
    .await
}

async fn reaction(
    state: Arc<ServerState>,
    session: CloudSession,
    conversation: Uuid,
    message: Uuid,
    attachment: String,
    request: UpdateReactionRequest,
    active: bool,
) -> Response {
    match store::set_attachment_reaction(
        state.db_pool(),
        &session.account_id,
        conversation,
        message,
        &attachment,
        &request.reaction,
        active,
    )
    .await
    {
        Ok(message) => Json(MessageResponse { message }).into_response(),
        Err(error) => store_error("update attachment reaction", error),
    }
}
