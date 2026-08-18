use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use axum::{Extension, Json, Router};
use serde_json::json;
use uuid::Uuid;

use crate::auth::routes::{cloud_session_middleware, CloudSession};
use crate::chat_sync::cursor::CursorCodec;
use crate::chat_sync::models::{
    AddConversationMembersRequest, AdvanceConversationCursorRequest, BootstrapResponse,
    ConversationPreferencesResponse, ConversationResponse, CreateConversationRequest,
    CursorResponse, HistoryQuery, MessageResponse, RealtimeTicketResponse, SendMessageRequest,
    SyncQuery, SyncResponse, UpdateConversationTitleRequest, UpdatePersonalTitleRequest,
};
use crate::chat_sync::realtime;
use crate::chat_sync::store::{self, StoreError};
use crate::chat_sync::PROTOCOL_VERSION;
use crate::server::ServerState;

const MAX_MESSAGE_CONTENT_BYTES: usize = 256 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE: usize = 32;

mod http;

use http::*;
#[derive(Clone)]
struct ChatSyncRuntime {
    cursor_codec: Option<CursorCodec>,
}

impl ChatSyncRuntime {
    fn from_env() -> Self {
        let cursor_codec = std::env::var("KORDI_CHAT_SYNC_CURSOR_SECRET")
            .ok()
            .and_then(|secret| CursorCodec::new(secret).ok());
        Self { cursor_codec }
    }
}

pub fn routes(state: Arc<ServerState>) -> Router {
    routes_with_runtime(state, ChatSyncRuntime::from_env())
}

fn routes_with_runtime(state: Arc<ServerState>, runtime: ChatSyncRuntime) -> Router {
    Router::new()
        .route("/v2/chat/conversations", post(create_conversation))
        .route(
            "/v2/chat/conversations/:conversation_id",
            patch(update_shared_title),
        )
        .route(
            "/v2/chat/conversations/:conversation_id/preferences",
            put(update_personal_title),
        )
        .route(
            "/v2/chat/conversations/:conversation_id/members",
            put(add_conversation_members),
        )
        .route(
            "/v2/chat/conversations/:conversation_id/messages",
            get(history).post(send_message),
        )
        .route(
            "/v2/chat/conversations/:conversation_id/delivered",
            put(advance_delivery_cursor),
        )
        .route(
            "/v2/chat/conversations/:conversation_id/read",
            put(advance_read_cursor),
        )
        .route("/v2/chat/sync", get(sync))
        .route("/v2/chat/sync/bootstrap", get(bootstrap))
        .route("/v2/chat/realtime/ticket", post(issue_realtime_ticket))
        .layer(Extension(Arc::new(runtime)))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .with_state(state)
}

async fn create_conversation(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(request): Json<CreateConversationRequest>,
) -> Response {
    let trusted_support_owner = state.support().and_then(|support| {
        let config = support.config();
        let expected_session_id = format!(
            "session:direct-system-agent:{}:{}",
            session.account_id, config.agent_id,
        );
        (request.kind == crate::chat_sync::models::ConversationKind::Direct
            && request.client_session_id.trim() == expected_session_id
            && request
                .member_account_ids
                .iter()
                .any(|member| member.trim() == config.owner_account_id))
        .then_some(config.owner_account_id.as_str())
    });
    match store::create_conversation(
        state.db_pool(),
        &session.account_id,
        request,
        trusted_support_owner,
    )
    .await
    {
        Ok(outcome) => (
            if outcome.inserted {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            },
            Json(ConversationResponse {
                conversation: outcome.value,
            }),
        )
            .into_response(),
        Err(error) => store_error("create conversation", error),
    }
}

async fn send_message(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(conversation_id): Path<Uuid>,
    Json(request): Json<SendMessageRequest>,
) -> Response {
    if let Err(error) = validate_message_request(&request) {
        return error.into_response();
    }
    match store::send_message(
        state.db_pool(),
        &session.account_id,
        conversation_id,
        request,
    )
    .await
    {
        Ok(outcome) => {
            if let Some(notifications) = state.notifications() {
                notifications
                    .send_message_attention(state.db_pool(), &outcome.value)
                    .await;
            }
            (
                if outcome.inserted {
                    StatusCode::CREATED
                } else {
                    StatusCode::OK
                },
                Json(MessageResponse {
                    message: outcome.value,
                }),
            )
                .into_response()
        }
        Err(error) => store_error("send message", error),
    }
}

async fn update_shared_title(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(conversation_id): Path<Uuid>,
    Json(request): Json<UpdateConversationTitleRequest>,
) -> Response {
    match store::update_shared_title(
        state.db_pool(),
        &session.account_id,
        conversation_id,
        request,
    )
    .await
    {
        Ok(conversation) => Json(ConversationResponse { conversation }).into_response(),
        Err(error) => store_error("update shared title", error),
    }
}

async fn update_personal_title(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(conversation_id): Path<Uuid>,
    Json(request): Json<UpdatePersonalTitleRequest>,
) -> Response {
    match store::update_personal_title(
        state.db_pool(),
        &session.account_id,
        conversation_id,
        request,
    )
    .await
    {
        Ok(preferences) => Json(ConversationPreferencesResponse { preferences }).into_response(),
        Err(error) => store_error("update personal title", error),
    }
}

async fn add_conversation_members(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(conversation_id): Path<Uuid>,
    Json(request): Json<AddConversationMembersRequest>,
) -> Response {
    match store::add_conversation_members(
        state.db_pool(),
        &session.account_id,
        conversation_id,
        request,
    )
    .await
    {
        Ok(conversation) => Json(ConversationResponse { conversation }).into_response(),
        Err(error) => store_error("add conversation members", error),
    }
}

async fn history(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(conversation_id): Path<Uuid>,
    Query(request): Query<HistoryQuery>,
) -> Response {
    match store::history(
        state.db_pool(),
        &session.account_id,
        conversation_id,
        request.before_sequence,
        request.limit,
    )
    .await
    {
        Ok(history) => Json(history).into_response(),
        Err(error) => store_error("load history", error),
    }
}

async fn advance_delivery_cursor(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(conversation_id): Path<Uuid>,
    Json(request): Json<AdvanceConversationCursorRequest>,
) -> Response {
    match store::advance_delivery_cursor(
        state.db_pool(),
        &session.account_id,
        conversation_id,
        request,
    )
    .await
    {
        Ok(cursor) => Json(CursorResponse { cursor }).into_response(),
        Err(error) => store_error("advance delivery cursor", error),
    }
}

async fn advance_read_cursor(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(conversation_id): Path<Uuid>,
    Json(request): Json<AdvanceConversationCursorRequest>,
) -> Response {
    match store::advance_read_cursor(
        state.db_pool(),
        &session.account_id,
        conversation_id,
        request,
    )
    .await
    {
        Ok(cursor) => Json(CursorResponse { cursor }).into_response(),
        Err(error) => store_error("advance read cursor", error),
    }
}

async fn sync(
    State(state): State<Arc<ServerState>>,
    Extension(runtime): Extension<Arc<ChatSyncRuntime>>,
    Extension(session): Extension<CloudSession>,
    Query(request): Query<SyncQuery>,
) -> Response {
    let codec = match require_cursor_codec(&runtime) {
        Ok(codec) => codec,
        Err(error) => return runtime_requirement_error(error),
    };
    let after_stream_seq = match request.cursor.as_deref() {
        Some(cursor) => match codec.decode(cursor, &session.account_id) {
            Ok(sequence) => sequence,
            Err(_) => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "INVALID_SYNC_CURSOR",
                    "The sync cursor is invalid for this account.",
                    None,
                );
            }
        },
        None => 0,
    };
    match store::sync_batch(
        state.db_pool(),
        &session.account_id,
        after_stream_seq,
        request.limit,
    )
    .await
    {
        Ok(batch) => Json(SyncResponse {
            protocol_version: PROTOCOL_VERSION,
            events: batch.events,
            next_cursor: codec.encode(&session.account_id, batch.next_stream_seq),
            last_stream_seq: batch.next_stream_seq,
            has_more: batch.has_more,
            server_time: chrono::Utc::now(),
        })
        .into_response(),
        Err(error) => store_error("sync", error),
    }
}

async fn bootstrap(
    State(state): State<Arc<ServerState>>,
    Extension(runtime): Extension<Arc<ChatSyncRuntime>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let codec = match require_cursor_codec(&runtime) {
        Ok(codec) => codec,
        Err(error) => return runtime_requirement_error(error),
    };
    match store::bootstrap(state.db_pool(), &session.account_id).await {
        Ok(snapshot) => Json(BootstrapResponse {
            protocol_version: PROTOCOL_VERSION,
            conversations: snapshot.conversations,
            latest_messages: snapshot.latest_messages,
            next_cursor: codec.encode(&session.account_id, snapshot.stream_seq),
            last_stream_seq: snapshot.stream_seq,
            server_time: snapshot.server_time,
        })
        .into_response(),
        Err(error) => store_error("bootstrap", error),
    }
}

async fn issue_realtime_ticket(
    State(state): State<Arc<ServerState>>,
    Extension(runtime): Extension<Arc<ChatSyncRuntime>>,
    Extension(session): Extension<CloudSession>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = require_cursor_codec(&runtime) {
        return runtime_requirement_error(error);
    }
    let origin = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    match realtime::issue_ticket(
        state.db_pool(),
        &session.account_id,
        &session.device_id,
        origin,
    )
    .await
    {
        Ok(ticket) => (
            StatusCode::CREATED,
            Json(RealtimeTicketResponse {
                ticket: ticket.plaintext,
                device_id: session.device_id,
                expires_at: ticket.expires_at,
            }),
        )
            .into_response(),
        Err(realtime::TicketError::OriginNotAllowed) => error_response(
            StatusCode::FORBIDDEN,
            "REALTIME_ORIGIN_NOT_ALLOWED",
            "The browser origin is not allowed to open realtime connections.",
            None,
        ),
        Err(realtime::TicketError::Database(error)) => {
            eprintln!("[chat-sync] issue realtime ticket: {error}");
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "SERVER_ERROR",
                "The realtime ticket could not be issued.",
                None,
            )
        }
        Err(realtime::TicketError::InvalidTicket) => error_response(
            StatusCode::BAD_REQUEST,
            "INVALID_REALTIME_TICKET",
            "The realtime ticket request is invalid.",
            None,
        ),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use uuid::Uuid;

    use super::{
        require_cursor_codec, validate_message_request, ChatSyncRuntime,
        MAX_ATTACHMENTS_PER_MESSAGE, MAX_MESSAGE_CONTENT_BYTES,
    };
    use crate::chat_sync::models::SendMessageRequest;

    #[test]
    fn signed_cursor_configuration_is_required() {
        let runtime = ChatSyncRuntime { cursor_codec: None };
        assert!(require_cursor_codec(&runtime).is_err());
    }

    #[test]
    fn request_limits_are_bounded() {
        assert_eq!(MAX_MESSAGE_CONTENT_BYTES, 256 * 1024);
        assert_eq!(MAX_ATTACHMENTS_PER_MESSAGE, 32);
    }

    #[test]
    fn durable_message_content_requires_schema_and_blocks() {
        let request = |content| SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".to_string(),
            content,
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        };

        assert!(validate_message_request(&request(json!({
            "schema": 1,
            "blocks": [{ "type": "text", "text": "hello" }]
        })))
        .is_ok());
        assert!(validate_message_request(&request(json!({ "blocks": [] }))).is_err());
        assert!(validate_message_request(&request(json!({ "schema": 1 }))).is_err());
        assert!(validate_message_request(&request(json!({
            "schema": 0,
            "blocks": []
        })))
        .is_err());
    }

    #[test]
    fn meme_attachments_require_accessible_supported_image_metadata() {
        let attachment_id = "att_meme".to_string();
        let request = |attachment| SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".to_string(),
            content: json!({
                "schema": 1,
                "blocks": [],
                "legacy_attachments": [attachment]
            }),
            reply_to_message_id: None,
            attachment_ids: vec![attachment_id.clone()],
        };
        let valid = json!({
            "attachmentId": attachment_id,
            "name": "reaction.png",
            "kind": "image",
            "subtype": "meme",
            "altText": "Surprised cat says: when the tests pass on the first try.",
            "mimeType": "image/png"
        });

        assert!(validate_message_request(&request(valid.clone())).is_ok());

        let mut missing_alt = valid.clone();
        missing_alt["altText"] = json!("  ");
        assert!(validate_message_request(&request(missing_alt)).is_err());

        let mut unsupported_type = valid;
        unsupported_type["mimeType"] = json!("image/svg+xml");
        assert!(validate_message_request(&request(unsupported_type)).is_err());
    }
}
