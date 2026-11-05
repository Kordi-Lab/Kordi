//! Organization checks for chat routes (docs/development/organization-requests.md).
//!
//! Besides the token and header check every organization-scoped route gets,
//! a request that changes a group or AI conversation is compared with that
//! conversation's organization, and a mismatch is logged. Direct chats stay
//! with their two people and per-member state (read cursors, personal
//! titles) is the member's own, so neither is checked.

use std::collections::HashMap;

use axum::extract::{Path, Request};
use axum::http::Method;
use sqlx_core::query_as::query_as;

use super::*;
use crate::chat_sync::models::ConversationKind;
use crate::organizations::requests::{
    check_new_content, check_scoped_request, RequestOrganization,
};

/// Per-member routes under a conversation, which change no shared content.
const MEMBER_STATE_SEGMENTS: [&str; 3] = ["preferences", "delivered", "read"];

fn changes_shared_content(method: &Method, path: &str) -> bool {
    let last = path.rsplit('/').next().unwrap_or_default();
    !matches!(*method, Method::GET | Method::HEAD) && !MEMBER_STATE_SEGMENTS.contains(&last)
}

/// Route layer for the chat routes, inside the session middleware.
pub(super) async fn scoped(
    State(state): State<Arc<ServerState>>,
    path: Option<Path<HashMap<String, String>>>,
    request: Request,
    next: axum::middleware::Next,
) -> Response {
    check_scoped_request(&request);
    let conversation_id = path
        .and_then(|Path(params)| params.get("conversation_id").cloned())
        .and_then(|id| Uuid::parse_str(&id).ok());
    let organization = request.extensions().get::<RequestOrganization>();
    if let (Some(conversation_id), Some(organization)) = (conversation_id, organization) {
        if changes_shared_content(request.method(), request.uri().path()) {
            let route = request.uri().path();
            check_conversation(&state, organization, conversation_id, route).await;
        }
    }
    next.run(request).await
}

async fn check_conversation(
    state: &ServerState,
    organization: &RequestOrganization,
    conversation_id: Uuid,
    route: &str,
) {
    let row: Result<Option<(String, Option<String>)>, _> = query_as(
        "SELECT kind, organization_id FROM cloud_chat_conversations WHERE conversation_id = $1",
    )
    .bind(conversation_id)
    .fetch_optional(state.db_pool())
    .await;
    match row {
        Ok(Some((kind, content))) if kind != ConversationKind::Direct.as_str() => {
            organization
                .check_content(state.db_pool(), route, content.as_deref())
                .await;
        }
        Ok(_) => {}
        Err(error) => eprintln!("[chat] check conversation organization: {error}"),
    }
}

/// A new group or AI conversation should be created in the request
/// organization: the one it names, or the creator's personal one.
pub(super) async fn creation(
    state: &ServerState,
    organization: Option<Extension<RequestOrganization>>,
    request: &CreateConversationRequest,
) {
    if request.kind == ConversationKind::Direct {
        return;
    }
    check_new_content(
        organization
            .as_ref()
            .map(|Extension(organization)| organization),
        state.db_pool(),
        "/v2/chat/conversations",
        request.organization_id.as_deref(),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_shared_changes_are_checked() {
        let base = "/v2/chat/conversations/00000000-0000-0000-0000-000000000000";
        assert!(changes_shared_content(
            &Method::POST,
            &format!("{base}/messages")
        ));
        assert!(changes_shared_content(&Method::PATCH, base));
        assert!(changes_shared_content(
            &Method::PUT,
            &format!("{base}/members")
        ));
        assert!(!changes_shared_content(
            &Method::GET,
            &format!("{base}/messages")
        ));
        for segment in MEMBER_STATE_SEGMENTS {
            assert!(!changes_shared_content(
                &Method::PUT,
                &format!("{base}/{segment}")
            ));
        }
        assert!(!changes_shared_content(
            &Method::PUT,
            &format!("{base}/threads/read")
        ));
    }
}
