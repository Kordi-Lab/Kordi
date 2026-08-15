use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Extension, Json, Router};
use serde_json::json;
use uuid::Uuid;

use crate::auth::routes::{cloud_session_middleware, CloudSession};
use crate::calls::models::{
    CallMediaConnection, CallResponse, CallSessionResponse, RegisterPushTokenRequest,
    RegisterVoipPushTokenRequest, StartCallRequest,
};
use crate::calls::store::{self, CallStoreError};
use crate::server::ServerState;

pub fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route(
            "/v2/chat/conversations/:conversation_id/calls",
            post(start_call),
        )
        .route(
            "/v2/chat/conversations/:conversation_id/calls/active",
            get(active_call),
        )
        .route("/v2/calls/:call_id/join", post(join_call))
        .route("/v2/calls/:call_id/invite", post(invite_call))
        .route("/v2/calls/:call_id/decline", post(decline_call))
        .route("/v2/calls/:call_id/leave", post(leave_call))
        .route("/v2/calls/:call_id/end", post(end_call))
        .route("/v2/calls/devices/voip", put(register_voip_push_token))
        .route(
            "/v2/calls/devices/notifications",
            put(register_notification_push_token),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .with_state(state)
}

async fn register_notification_push_token(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(request): Json<RegisterPushTokenRequest>,
) -> Response {
    match store::register_notification_push_token(
        state.db_pool(),
        store::NotificationPushTokenRegistration {
            account_id: &session.account_id,
            device_id: &session.device_id,
            device_token: &request.token,
            environment: &request.environment,
            messages_enabled: request.messages_enabled,
            sound_enabled: request.sound_enabled,
            previews_enabled: request.previews_enabled,
            badge_enabled: request.badge_enabled,
        },
    )
    .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => store_error("register notification push token", error),
    }
}

async fn register_voip_push_token(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(request): Json<RegisterVoipPushTokenRequest>,
) -> Response {
    match store::register_voip_push_token(
        state.db_pool(),
        &session.account_id,
        &session.device_id,
        &request.token,
        &request.environment,
    )
    .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => store_error("register VoIP push token", error),
    }
}

async fn start_call(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(conversation_id): Path<Uuid>,
    Json(request): Json<StartCallRequest>,
) -> Response {
    let Some(media) = state.call_media() else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "CALL_MEDIA_UNAVAILABLE",
            "Calling is not configured for this Kordi environment.",
        );
    };
    match store::start(
        state.db_pool(),
        &session.account_id,
        conversation_id,
        request,
    )
    .await
    {
        Ok(started) => match media.join_token(
            &started.room_name,
            &session.account_id,
            &started.display_name,
            started.call.kind.allows_video(),
        ) {
            Ok(token) => {
                if started.inserted {
                    if let Some(push) = state.notifications().cloned() {
                        let pool = state.db_pool().clone();
                        let call = started.call.clone();
                        let caller_name = started.display_name.clone();
                        tokio::spawn(async move {
                            if call.kind.as_str() == "meeting" {
                                push.send_group_meeting(&pool, &call, &caller_name).await;
                            } else {
                                push.send_incoming_call(&pool, &call, &caller_name).await;
                            }
                        });
                    }
                }
                (
                    StatusCode::CREATED,
                    Json(CallSessionResponse {
                        call: started.call,
                        media: CallMediaConnection {
                            url: media.client_url().to_string(),
                            token,
                        },
                    }),
                )
                    .into_response()
            }
            Err(error) => {
                eprintln!("[calls] create media token: {error}");
                error_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "CALL_MEDIA_UNAVAILABLE",
                    "Calling is temporarily unavailable.",
                )
            }
        },
        Err(error) => store_error("start call", error),
    }
}

async fn active_call(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(conversation_id): Path<Uuid>,
) -> Response {
    match store::active(state.db_pool(), &session.account_id, conversation_id).await {
        Ok(call) => Json(CallResponse { call }).into_response(),
        Err(error) => store_error("load active call", error),
    }
}

async fn join_call(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(call_id): Path<Uuid>,
) -> Response {
    let Some(media) = state.call_media() else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "CALL_MEDIA_UNAVAILABLE",
            "Calling is not configured for this Kordi environment.",
        );
    };
    match store::join(state.db_pool(), &session.account_id, call_id).await {
        Ok(joinable) => match media.join_token(
            &joinable.room_name,
            &session.account_id,
            &joinable.display_name,
            joinable.call.kind.allows_video(),
        ) {
            Ok(token) => Json(CallSessionResponse {
                call: joinable.call,
                media: CallMediaConnection {
                    url: media.client_url().to_string(),
                    token,
                },
            })
            .into_response(),
            Err(error) => {
                eprintln!("[calls] create media token: {error}");
                error_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "CALL_MEDIA_UNAVAILABLE",
                    "Calling is temporarily unavailable.",
                )
            }
        },
        Err(error) => store_error("join call", error),
    }
}

async fn invite_call(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(call_id): Path<Uuid>,
) -> Response {
    match store::invite(state.db_pool(), &session.account_id, call_id).await {
        Ok(invitable) => {
            if let Some(push) = state.notifications().cloned() {
                let pool = state.db_pool().clone();
                let call = invitable.call.clone();
                let inviter_name = invitable.display_name;
                tokio::spawn(async move {
                    push.send_group_meeting(&pool, &call, &inviter_name).await;
                });
            }
            Json(CallResponse {
                call: Some(invitable.call),
            })
            .into_response()
        }
        Err(error) => store_error("invite call participants", error),
    }
}

async fn decline_call(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(call_id): Path<Uuid>,
) -> Response {
    match store::decline(state.db_pool(), &session.account_id, call_id).await {
        Ok(call) => Json(CallResponse { call: Some(call) }).into_response(),
        Err(error) => store_error("decline call", error),
    }
}

async fn leave_call(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(call_id): Path<Uuid>,
) -> Response {
    match store::leave(state.db_pool(), &session.account_id, call_id).await {
        Ok(call) => Json(CallResponse { call: Some(call) }).into_response(),
        Err(error) => store_error("leave call", error),
    }
}

async fn end_call(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(call_id): Path<Uuid>,
) -> Response {
    match store::end(state.db_pool(), &session.account_id, call_id).await {
        Ok(call) => Json(CallResponse { call: Some(call) }).into_response(),
        Err(error) => store_error("end call", error),
    }
}

fn store_error(context: &str, error: CallStoreError) -> Response {
    match error {
        CallStoreError::InvalidKind => error_response(
            StatusCode::BAD_REQUEST,
            "INVALID_CALL_KIND",
            "Start a voice or video call. Group conversations automatically create meetings.",
        ),
        CallStoreError::InvalidPushToken => error_response(
            StatusCode::BAD_REQUEST,
            "INVALID_PUSH_TOKEN",
            "The device notification token is invalid.",
        ),
        CallStoreError::NotFound => error_response(
            StatusCode::NOT_FOUND,
            "CALL_NOT_FOUND",
            "The call could not be found.",
        ),
        CallStoreError::Forbidden => error_response(
            StatusCode::FORBIDDEN,
            "CALL_FORBIDDEN",
            "You are not allowed to access this call.",
        ),
        CallStoreError::Conflict => error_response(
            StatusCode::CONFLICT,
            "CALL_STATE_CONFLICT",
            "The call has already changed state.",
        ),
        CallStoreError::Database(error) => {
            eprintln!("[calls] {context}: {error}");
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "SERVER_ERROR",
                "The call request could not be completed.",
            )
        }
        CallStoreError::Invariant(message) => {
            eprintln!("[calls] {context}: {message}");
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "SERVER_ERROR",
                "The call request could not be completed.",
            )
        }
    }
}

fn error_response(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}
