use super::reaction::{add_reaction, remove_reaction};
use super::*;
use crate::chat_sync::models::{DeleteMessageQuery, MessageResponse, UpdateMessageRequest};

pub(super) fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route(
            "/v2/chat/conversations/:conversation_id/messages/:message_id/reactions",
            put(add_reaction).delete(remove_reaction),
        )
        .route(
            "/v2/chat/conversations/:conversation_id/messages/:message_id",
            patch(edit_message).delete(delete_message),
        )
}

pub(super) async fn edit_message(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((conversation_id, message_id)): Path<(Uuid, Uuid)>,
    Json(request): Json<UpdateMessageRequest>,
) -> Response {
    match store::edit_message(
        state.db_pool(),
        &session.account_id,
        conversation_id,
        message_id,
        request,
    )
    .await
    {
        Ok(message) => Json(MessageResponse { message }).into_response(),
        Err(error) => store_error("edit message", error),
    }
}

pub(super) async fn delete_message(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((conversation_id, message_id)): Path<(Uuid, Uuid)>,
    Query(request): Query<DeleteMessageQuery>,
) -> Response {
    match store::delete_message(
        state.db_pool(),
        &session.account_id,
        conversation_id,
        message_id,
        request.for_everyone,
    )
    .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => store_error("delete message", error),
    }
}
