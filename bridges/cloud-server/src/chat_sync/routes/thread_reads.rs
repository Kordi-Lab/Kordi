use super::*;
use crate::chat_sync::models::AdvanceThreadReadRequest;

pub(super) async fn read(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(conversation): Path<Uuid>,
) -> Response {
    match store::thread_reads(state.db_pool(), &session.account_id, conversation).await {
        Ok(reads) => Json(reads).into_response(),
        Err(error) => store_error("read thread cursors", error),
    }
}

pub(super) async fn advance(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(conversation): Path<Uuid>,
    Json(request): Json<AdvanceThreadReadRequest>,
) -> Response {
    match store::advance_thread_read(state.db_pool(), &session.account_id, conversation, request)
        .await
    {
        Ok(read) => Json(read).into_response(),
        Err(error) => store_error("advance thread read cursor", error),
    }
}
