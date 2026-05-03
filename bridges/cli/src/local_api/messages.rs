use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};

use super::pending::{
    insert_pending, new_request_id, note_pending_stage, remove_pending, resolve_project_dir,
};
use super::{encrypt_and_send, require_non_empty, require_project_capability, ApiState};
use crate::permissions::ProjectCapability;

#[derive(Debug, Deserialize)]
pub(super) struct SendRequest {
    pub peer_id: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub(super) struct SendResponse {
    pub ok: bool,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

// ── Structured message requests ──

#[derive(Debug, Deserialize)]
pub(super) struct AskRequest {
    pub node_id: String,
    pub question: String,
    pub project_id: String,
    #[serde(default)]
    pub new_session: bool,
}

#[derive(Debug, Deserialize)]
pub(super) struct BroadcastRequest {
    pub message: String,
    pub project_id: String,
    #[serde(default = "default_message_type")]
    pub message_type: String,
}

fn default_message_type() -> String {
    "broadcast".to_string()
}

#[derive(Debug, Deserialize)]
pub(super) struct DebateRequest {
    pub topic: String,
    pub project_id: String,
    #[serde(default)]
    pub new_session: bool,
}

#[derive(Debug, Deserialize)]
pub(super) struct PublishRequest {
    pub filename: String,
    pub data: String,
    pub project_id: String,
}

#[derive(Debug, Serialize)]
pub(super) struct BroadcastResponse {
    pub ok: bool,
    pub sent_to: Vec<String>,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_ids: Option<Vec<String>>,
}

pub(super) async fn handle_send(
    State(state): State<Arc<ApiState>>,
    Json(req): Json<SendRequest>,
) -> impl IntoResponse {
    if let Err(e) = require_non_empty(&req.peer_id, "peer_id") {
        return (
            StatusCode::BAD_REQUEST,
            Json(SendResponse {
                ok: false,
                error: Some(e),
                request_id: None,
            }),
        );
    }
    if let Err(e) = require_non_empty(&req.message, "message") {
        return (
            StatusCode::BAD_REQUEST,
            Json(SendResponse {
                ok: false,
                error: Some(e),
                request_id: None,
            }),
        );
    }

    let peer_id = req.peer_id.trim();
    let payload = serde_json::json!({
        "from": state.node_id,
        "messageType": "raw",
        "payload": { "message": req.message },
    });
    match encrypt_and_send(&state, peer_id, None, &payload).await {
        Ok(_) => (
            StatusCode::OK,
            Json(SendResponse {
                ok: true,
                error: None,
                request_id: None,
            }),
        ),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(SendResponse {
                ok: false,
                error: Some(e),
                request_id: None,
            }),
        ),
    }
}

/// Delivery semantics for `ask`:
/// - single-target request/response
/// - the sender now tracks staged outcomes for the `requestId`:
///   - `handed_off_direct` / `handed_off_mailbox`
///   - `received_by_peer_daemon`
///   - `processed_by_peer_runtime` or `processing_failed`
/// - no automatic retry or deduplication is performed here yet
/// - pending entries expire locally after a short timeout
pub(super) async fn handle_ask(
    State(state): State<Arc<ApiState>>,
    Json(req): Json<AskRequest>,
) -> impl IntoResponse {
    if let Err(e) = require_non_empty(&req.node_id, "node_id") {
        return (
            StatusCode::BAD_REQUEST,
            Json(SendResponse {
                ok: false,
                error: Some(e),
                request_id: None,
            }),
        );
    }
    if let Err(e) = require_non_empty(&req.question, "question") {
        return (
            StatusCode::BAD_REQUEST,
            Json(SendResponse {
                ok: false,
                error: Some(e),
                request_id: None,
            }),
        );
    }

    let node_id = req.node_id.trim();
    let project_id = req.project_id.trim();
    if !project_id.is_empty() {
        let members = match state.coord.get_project_members(project_id).await {
            Ok(members) => members,
            Err(e) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(SendResponse {
                        ok: false,
                        error: Some(e),
                        request_id: None,
                    }),
                )
            }
        };
        if let Err(e) = require_project_capability(&members, &state.node_id, ProjectCapability::Ask)
        {
            return (
                StatusCode::FORBIDDEN,
                Json(SendResponse {
                    ok: false,
                    error: Some(e),
                    request_id: None,
                }),
            );
        }
    }
    let session_id = if project_id.is_empty() {
        None
    } else {
        resolve_project_dir(project_id).and_then(|project_dir| {
            crate::conversation_memory::resolve_session(
                &project_dir,
                node_id,
                None,
                req.new_session,
            )
            .ok()
        })
    };
    let request_id = new_request_id();
    insert_pending(
        &state,
        request_id.clone(),
        project_id,
        "ask",
        &req.question,
        session_id.clone(),
    )
    .await;
    let payload = serde_json::json!({
        "from": state.node_id,
        "projectId": project_id,
        "messageType": "ask",
        "requestId": request_id,
        "sessionId": session_id,
        "payload": { "question": req.question },
    });
    let project_ref = if project_id.is_empty() {
        None
    } else {
        Some(project_id)
    };
    match encrypt_and_send(&state, node_id, project_ref, &payload).await {
        Ok(handoff) => {
            note_pending_stage(&state.responses, &request_id, None, handoff.stage()).await;
            (
                StatusCode::OK,
                Json(SendResponse {
                    ok: true,
                    error: None,
                    request_id: Some(request_id),
                }),
            )
        }
        Err(e) => {
            remove_pending(&state, &request_id).await;
            (
                StatusCode::BAD_GATEWAY,
                Json(SendResponse {
                    ok: false,
                    error: Some(e),
                    request_id: None,
                }),
            )
        }
    }
}

/// Delivery semantics for `broadcast`:
/// - fanout to all other project members
/// - per-peer direct transport is attempted first, with mailbox relay fallback
/// - partial success returns HTTP 200 with `ok=false` and the successfully delivered `sent_to` list
/// - HTTP 502 is reserved for the case where nothing was delivered and an error occurred
/// - no retry, deduplication, or global ordering guarantee is provided
pub(super) async fn handle_broadcast(
    State(state): State<Arc<ApiState>>,
    Json(req): Json<BroadcastRequest>,
) -> impl IntoResponse {
    if let Err(e) = require_non_empty(&req.project_id, "project_id") {
        return (
            StatusCode::BAD_REQUEST,
            Json(BroadcastResponse {
                ok: false,
                sent_to: vec![],
                error: Some(e),
                request_ids: None,
            }),
        );
    }
    if let Err(e) = require_non_empty(&req.message, "message") {
        return (
            StatusCode::BAD_REQUEST,
            Json(BroadcastResponse {
                ok: false,
                sent_to: vec![],
                error: Some(e),
                request_ids: None,
            }),
        );
    }
    if let Err(e) = require_non_empty(&req.message_type, "message_type") {
        return (
            StatusCode::BAD_REQUEST,
            Json(BroadcastResponse {
                ok: false,
                sent_to: vec![],
                error: Some(e),
                request_ids: None,
            }),
        );
    }

    let project_id = req.project_id.trim();
    let members = match state.coord.get_project_members(project_id).await {
        Ok(m) => m,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(BroadcastResponse {
                    ok: false,
                    sent_to: vec![],
                    error: Some(e),
                    request_ids: None,
                }),
            )
        }
    };

    if let Err(e) =
        require_project_capability(&members, &state.node_id, ProjectCapability::Broadcast)
    {
        return (
            StatusCode::FORBIDDEN,
            Json(BroadcastResponse {
                ok: false,
                sent_to: vec![],
                error: Some(e),
                request_ids: None,
            }),
        );
    }

    let mut sent_to = Vec::new();
    let mut last_err = None;
    for member in &members {
        if member.node_id == state.node_id {
            continue;
        }
        let payload = serde_json::json!({
            "from": state.node_id,
            "projectId": project_id,
            "messageType": req.message_type,
            "payload": { "message": req.message },
        });
        match encrypt_and_send(&state, &member.node_id, Some(project_id), &payload).await {
            Ok(_) => sent_to.push(member.node_id.clone()),
            Err(e) => last_err = Some(e),
        }
    }

    let status = if sent_to.is_empty() && last_err.is_some() {
        StatusCode::BAD_GATEWAY
    } else {
        StatusCode::OK
    };

    (
        status,
        Json(BroadcastResponse {
            ok: last_err.is_none(),
            sent_to,
            error: last_err,
            request_ids: None,
        }),
    )
}

/// Delivery semantics for `debate`:
/// - fanout request/response to all other project members
/// - each successfully delivered peer gets its own `requestId`
/// - each `requestId` can now advance through staged outcomes like `ask`
/// - partial success returns HTTP 200 with `ok=false`, plus only the `request_ids` that were actually sent
/// - HTTP 502 is reserved for the case where nothing was delivered and an error occurred
/// - no retry, deduplication, or cross-peer ordering guarantee is provided yet
pub(super) async fn handle_debate(
    State(state): State<Arc<ApiState>>,
    Json(req): Json<DebateRequest>,
) -> impl IntoResponse {
    if let Err(e) = require_non_empty(&req.project_id, "project_id") {
        return (
            StatusCode::BAD_REQUEST,
            Json(BroadcastResponse {
                ok: false,
                sent_to: vec![],
                error: Some(e),
                request_ids: None,
            }),
        );
    }
    if let Err(e) = require_non_empty(&req.topic, "topic") {
        return (
            StatusCode::BAD_REQUEST,
            Json(BroadcastResponse {
                ok: false,
                sent_to: vec![],
                error: Some(e),
                request_ids: None,
            }),
        );
    }

    let project_id = req.project_id.trim();
    let members = match state.coord.get_project_members(project_id).await {
        Ok(m) => m,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(BroadcastResponse {
                    ok: false,
                    sent_to: vec![],
                    error: Some(e),
                    request_ids: None,
                }),
            )
        }
    };

    if let Err(e) = require_project_capability(&members, &state.node_id, ProjectCapability::Debate)
    {
        return (
            StatusCode::FORBIDDEN,
            Json(BroadcastResponse {
                ok: false,
                sent_to: vec![],
                error: Some(e),
                request_ids: None,
            }),
        );
    }

    let mut sent_to = Vec::new();
    let mut request_ids = Vec::new();
    let mut last_err = None;
    for member in &members {
        if member.node_id == state.node_id {
            continue;
        }
        let session_id = resolve_project_dir(project_id).and_then(|project_dir| {
            crate::conversation_memory::resolve_session(
                &project_dir,
                &member.node_id,
                None,
                req.new_session,
            )
            .ok()
        });
        let request_id = new_request_id();
        insert_pending(
            &state,
            request_id.clone(),
            project_id,
            "debate",
            &req.topic,
            session_id.clone(),
        )
        .await;
        let payload = serde_json::json!({
            "from": state.node_id,
            "projectId": project_id,
            "messageType": "debate",
            "requestId": request_id,
            "sessionId": session_id,
            "payload": { "topic": req.topic },
        });
        match encrypt_and_send(&state, &member.node_id, Some(project_id), &payload).await {
            Ok(handoff) => {
                note_pending_stage(&state.responses, &request_id, None, handoff.stage()).await;
                sent_to.push(member.node_id.clone());
                request_ids.push(request_id);
            }
            Err(e) => {
                remove_pending(&state, &request_id).await;
                last_err = Some(e);
            }
        }
    }

    let status = if sent_to.is_empty() && last_err.is_some() {
        StatusCode::BAD_GATEWAY
    } else {
        StatusCode::OK
    };

    (
        status,
        Json(BroadcastResponse {
            ok: last_err.is_none(),
            sent_to,
            error: last_err,
            request_ids: Some(request_ids),
        }),
    )
}

/// Delivery semantics for `publish`:
/// - fanout artifact delivery to all other project members
/// - success means the payload was handed to direct transport or mailbox relay for that peer
/// - partial success returns HTTP 200 with `ok=false` and the successfully delivered `sent_to` list
/// - HTTP 502 is reserved for the case where nothing was delivered and an error occurred
/// - no retry or deduplication is provided at this layer
pub(super) async fn handle_publish(
    State(state): State<Arc<ApiState>>,
    Json(req): Json<PublishRequest>,
) -> impl IntoResponse {
    use base64::Engine;

    if let Err(e) = require_non_empty(&req.project_id, "project_id") {
        return (
            StatusCode::BAD_REQUEST,
            Json(BroadcastResponse {
                ok: false,
                sent_to: vec![],
                error: Some(e),
                request_ids: None,
            }),
        );
    }
    if let Err(e) = require_non_empty(&req.filename, "filename") {
        return (
            StatusCode::BAD_REQUEST,
            Json(BroadcastResponse {
                ok: false,
                sent_to: vec![],
                error: Some(e),
                request_ids: None,
            }),
        );
    }
    if let Err(e) = require_non_empty(&req.data, "data") {
        return (
            StatusCode::BAD_REQUEST,
            Json(BroadcastResponse {
                ok: false,
                sent_to: vec![],
                error: Some(e),
                request_ids: None,
            }),
        );
    }
    if let Err(e) = base64::engine::general_purpose::STANDARD.decode(&req.data) {
        return (
            StatusCode::BAD_REQUEST,
            Json(BroadcastResponse {
                ok: false,
                sent_to: vec![],
                error: Some(format!("data must be valid base64: {}", e)),
                request_ids: None,
            }),
        );
    }

    let project_id = req.project_id.trim();
    let members = match state.coord.get_project_members(project_id).await {
        Ok(m) => m,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(BroadcastResponse {
                    ok: false,
                    sent_to: vec![],
                    error: Some(e),
                    request_ids: None,
                }),
            )
        }
    };

    if let Err(e) = require_project_capability(&members, &state.node_id, ProjectCapability::Publish)
    {
        return (
            StatusCode::FORBIDDEN,
            Json(BroadcastResponse {
                ok: false,
                sent_to: vec![],
                error: Some(e),
                request_ids: None,
            }),
        );
    }

    let mut sent_to = Vec::new();
    let mut last_err = None;
    for member in &members {
        if member.node_id == state.node_id {
            continue;
        }
        let payload = serde_json::json!({
            "from": state.node_id,
            "projectId": project_id,
            "messageType": "publish",
            "payload": { "filename": req.filename, "data": req.data },
        });
        match encrypt_and_send(&state, &member.node_id, Some(project_id), &payload).await {
            Ok(_) => sent_to.push(member.node_id.clone()),
            Err(e) => last_err = Some(e),
        }
    }

    let status = if sent_to.is_empty() && last_err.is_some() {
        StatusCode::BAD_GATEWAY
    } else {
        StatusCode::OK
    };

    (
        status,
        Json(BroadcastResponse {
            ok: last_err.is_none(),
            sent_to,
            error: last_err,
            request_ids: None,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_message_type_is_broadcast() {
        assert_eq!(default_message_type(), "broadcast");
    }
}
