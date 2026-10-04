//! AI access settings: which messages agents may use in a conversation,
//! whether PiP is a member, and members' "Don't let AI use my messages".
//!
//! `:conversation_id` accepts the conversation UUID or the URL-encoded legacy
//! session id, so clients can address a conversation by the session they show.

use axum::extract::rejection::JsonRejection;

use super::*;
use crate::chat_sync::models::UpdateAiAccessRequest;
use crate::chat_sync::store::AiAccessError;

pub(super) fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route("/v2/chat/ai-features", get(ai_features))
        .route(
            "/v2/chat/conversations/:conversation_id/ai-access",
            get(ai_access).put(update_ai_access),
        )
}

async fn ai_features() -> Response {
    Json(json!({
        "pip": {
            "available": crate::pip::service_account_id().is_some(),
            "provider_label": crate::pip::service_provider_label(),
        }
    }))
    .into_response()
}

async fn ai_access(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(conversation_ref): Path<String>,
) -> Response {
    match store::ai_access_for(state.db_pool(), &session.account_id, &conversation_ref).await {
        Ok(view) => Json(view).into_response(),
        Err(error) => store_error("load AI access", error),
    }
}

fn invalid(message: &str) -> Response {
    error_response(StatusCode::BAD_REQUEST, "INVALID_AI_ACCESS", message, None)
}

async fn update_ai_access(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    rate_limiter: Option<Extension<Arc<CloudRateLimiter>>>,
    Path(conversation_ref): Path<String>,
    request: Result<Json<UpdateAiAccessRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(request)) = request else {
        return invalid(
            "Send a client_operation_id and exactly one of history_scope, pip_enabled, or exclude_my_messages.",
        );
    };
    // Every change posts a notice, so changes count as message sends.
    if let Some(Extension(rate_limiter)) = rate_limiter {
        if let RateLimitDecision::Limited { retry_after } = rate_limiter
            .observe_account_limit(MESSAGE_SEND_LIMIT, &session.account_id)
            .await
        {
            return rate_limited_response(retry_after);
        }
    }
    let updated = match store::update_ai_access(
        state.db_pool(),
        &session.account_id,
        &conversation_ref,
        request,
    )
    .await
    {
        Ok(updated) => updated,
        Err(AiAccessError::Invalid(message)) => return invalid(message),
        Err(AiAccessError::PipUnavailable) => {
            return error_response(
                StatusCode::CONFLICT,
                "PIP_UNAVAILABLE",
                "PiP isn't available on this server.",
                None,
            )
        }
        Err(AiAccessError::Store(error)) => return store_error("update AI access", error),
    };
    let Some((conversation_id, pip)) = updated.join_pip else {
        return Json(ConversationResponse {
            conversation: updated.conversation,
        })
        .into_response();
    };
    // PiP joins after the setting commits; members hear about it through
    // `membership.updated`, and the snapshot reports what actually happened.
    if let Err(error) =
        crate::pip::membership::join_conversation(state.db_pool(), &pip, conversation_id).await
    {
        eprintln!("[pip] Could not join a conversation that turned PiP on: {error}");
    }
    match store::conversation_snapshot(state.db_pool(), &session.account_id, conversation_id).await
    {
        Ok(conversation) => Json(ConversationResponse { conversation }).into_response(),
        Err(error) => store_error("load conversation", error),
    }
}
