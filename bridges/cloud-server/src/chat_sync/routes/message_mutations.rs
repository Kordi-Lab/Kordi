use super::reaction::{add_reaction, remove_reaction};
use super::*;
use crate::chat_sync::models::{DeleteMessageQuery, MessageResponse, UpdateMessageRequest};
use std::time::{Duration, Instant};

fn mutation_timing_line(operation: &str, status: StatusCode, duration: Duration) -> String {
    format!(
        "[chat-message-mutation] operation={operation} status={} duration_ms={}",
        status.as_u16(),
        duration.as_millis(),
    )
}

fn log_mutation_timing(operation: &str, started: Instant, response: &Response) {
    eprintln!(
        "{}",
        mutation_timing_line(operation, response.status(), started.elapsed())
    );
}

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
    let started = Instant::now();
    let response = match store::edit_message(
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
    };
    log_mutation_timing("edit", started, &response);
    response
}

pub(super) async fn delete_message(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((conversation_id, message_id)): Path<(Uuid, Uuid)>,
    Query(request): Query<DeleteMessageQuery>,
) -> Response {
    let started = Instant::now();
    let response = match store::delete_message(
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
    };
    log_mutation_timing("delete", started, &response);
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutation_timing_log_contains_only_operation_status_and_duration() {
        assert_eq!(
            mutation_timing_line("edit", StatusCode::OK, Duration::from_millis(42)),
            "[chat-message-mutation] operation=edit status=200 duration_ms=42",
        );
    }
}
