use super::*;
use crate::chat_sync::models::LeaveConversationRequest;

pub(super) fn routes() -> Router<Arc<ServerState>> {
    Router::new().route(
        "/v2/chat/conversations/:conversation_id/leave",
        post(leave_conversation),
    )
}

/// Leaves a group, and every channel of it when called on the group's main
/// conversation.
async fn leave_conversation(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(conversation_id): Path<Uuid>,
    Json(request): Json<LeaveConversationRequest>,
) -> Response {
    match store::leave_group(
        state.db_pool(),
        &session.account_id,
        conversation_id,
        request,
    )
    .await
    {
        Ok(response) => Json(response).into_response(),
        Err(error) => store_error("leave conversation", error),
    }
}

#[cfg(test)]
mod tests {
    use axum::{body::to_bytes, http::StatusCode};

    use super::store_error;
    use crate::chat_sync::store::{StoreError, DIRECT_REQUIRES_CONTACT};

    #[tokio::test]
    async fn missing_relationships_are_a_forbidden_response_with_their_own_code() {
        let response = store_error(
            "send message",
            StoreError::RelationshipRequired(DIRECT_REQUIRES_CONTACT),
        );
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"]["code"], "CHAT_RELATIONSHIP_REQUIRED");
        assert_eq!(body["error"]["message"], DIRECT_REQUIRES_CONTACT);
    }

    #[tokio::test]
    async fn leaving_something_other_than_a_group_is_a_bad_request() {
        let response = store_error(
            "leave conversation",
            StoreError::InvalidInput("Only groups can be left."),
        );
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"]["message"], "Only groups can be left.");
    }
}
