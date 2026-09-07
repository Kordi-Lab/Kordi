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

#[derive(serde::Deserialize)]
pub(super) struct AttentionQuery {
    after: Option<Uuid>,
}
pub(super) async fn attention(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Query(query): Query<AttentionQuery>,
) -> Response {
    match store::thread_attention(state.db_pool(), &session.account_id, query.after).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => store_error("load unread threads", error),
    }
}
#[derive(serde::Deserialize)]
pub(super) struct ThreadQuery {
    after_sequence: Option<i64>,
}
pub(super) async fn page(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((conversation, message)): Path<(Uuid, Uuid)>,
    Query(query): Query<ThreadQuery>,
) -> Response {
    match store::thread_page(
        state.db_pool(),
        &session.account_id,
        conversation,
        message,
        query.after_sequence,
    )
    .await
    {
        Ok(value) => Json(value).into_response(),
        Err(error) => store_error("load thread", error),
    }
}
