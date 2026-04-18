use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;

use crate::coord_client::{CoordClient, MemberInfo, PeerKeys};
use crate::permissions::{role_has_capability, ProjectCapability};
use crate::presence::{ComponentState, ComponentStatus, PresenceState, ReachabilityStatus};
use crate::transport::Transport;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeliveryStage {
    PendingSend,
    HandedOffDirect,
    HandedOffMailbox,
    ReceivedByPeerDaemon,
    ProcessingFailed,
    ProcessedByPeerRuntime,
}

impl DeliveryStage {
    fn as_str(self) -> &'static str {
        match self {
            Self::PendingSend => "pending_send",
            Self::HandedOffDirect => "handed_off_direct",
            Self::HandedOffMailbox => "handed_off_mailbox",
            Self::ReceivedByPeerDaemon => "received_by_peer_daemon",
            Self::ProcessingFailed => "processing_failed",
            Self::ProcessedByPeerRuntime => "processed_by_peer_runtime",
        }
    }

    fn is_terminal(self) -> bool {
        matches!(self, Self::ProcessingFailed | Self::ProcessedByPeerRuntime)
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "pending_send" => Some(Self::PendingSend),
            "handed_off_direct" => Some(Self::HandedOffDirect),
            "handed_off_mailbox" => Some(Self::HandedOffMailbox),
            "received_by_peer_daemon" => Some(Self::ReceivedByPeerDaemon),
            "processing_failed" => Some(Self::ProcessingFailed),
            "processed_by_peer_runtime" => Some(Self::ProcessedByPeerRuntime),
            _ => None,
        }
    }
}

/// Pending response/outcome from a peer.
pub struct PendingResponse {
    pub response: Option<String>,
    pub from_node: Option<String>,
    pub error: Option<String>,
    pub stage: DeliveryStage,
    pub created_at: Instant,
    pub project_id: Option<String>,
    pub kind: Option<String>,
    pub prompt: Option<String>,
    pub session_id: Option<String>,
}

/// State shared with axum handlers.
pub struct ApiState {
    pub transport: Arc<Transport>,
    pub coord: Arc<dyn CoordOps>,
    pub node_id: String,
    pub my_x25519_priv: [u8; 32],
    /// Pending responses keyed by request_id.
    pub responses: Arc<Mutex<HashMap<String, PendingResponse>>>,
    pub presence: Arc<Mutex<PresenceState>>,
}

#[async_trait::async_trait]
pub trait CoordOps: Send + Sync {
    async fn get_peer_keys(&self, peer_id: &str) -> Result<PeerKeys, String>;
    async fn get_project_keys(&self, project_id: &str) -> Result<Vec<PeerKeys>, String>;
    async fn relay_message(
        &self,
        target_node_id: &str,
        blob: &str,
        project_id: Option<&str>,
    ) -> Result<(), String>;
    async fn get_project_members(&self, project_id: &str) -> Result<Vec<MemberInfo>, String>;
}

#[async_trait::async_trait]
impl CoordOps for CoordClient {
    async fn get_peer_keys(&self, peer_id: &str) -> Result<PeerKeys, String> {
        CoordClient::get_peer_keys(self, peer_id).await
    }

    async fn get_project_keys(&self, project_id: &str) -> Result<Vec<PeerKeys>, String> {
        CoordClient::get_project_keys(self, project_id).await
    }

    async fn relay_message(
        &self,
        target_node_id: &str,
        blob: &str,
        project_id: Option<&str>,
    ) -> Result<(), String> {
        CoordClient::relay_message(self, target_node_id, blob, project_id).await
    }

    async fn get_project_members(&self, project_id: &str) -> Result<Vec<MemberInfo>, String> {
        CoordClient::get_project_members(self, project_id).await
    }
}

#[derive(Debug, Deserialize)]
pub struct SendRequest {
    pub peer_id: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct SendResponse {
    pub ok: bool,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PeerInfo {
    pub peer_id: String,
    pub connection_state: String,
    pub reachability: String,
    pub session_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_inbound_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_outbound_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DaemonStatus {
    pub state: String,
    pub started_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StatusResponse {
    pub node_id: String,
    pub healthy: bool,
    pub daemon: DaemonStatus,
    pub coordination: ComponentStatus,
    pub runtime: ComponentStatus,
    pub reachability: ReachabilityStatus,
}

// ── Structured message requests ──

#[derive(Debug, Deserialize)]
pub struct AskRequest {
    pub node_id: String,
    pub question: String,
    pub project_id: String,
    #[serde(default)]
    pub new_session: bool,
}

#[derive(Debug, Deserialize)]
pub struct BroadcastRequest {
    pub message: String,
    pub project_id: String,
    #[serde(default = "default_message_type")]
    pub message_type: String,
}

fn default_message_type() -> String {
    "broadcast".to_string()
}

#[derive(Debug, Deserialize)]
pub struct DebateRequest {
    pub topic: String,
    pub project_id: String,
    #[serde(default)]
    pub new_session: bool,
}

#[derive(Debug, Deserialize)]
pub struct PublishRequest {
    pub filename: String,
    pub data: String,
    pub project_id: String,
}

#[derive(Debug, Serialize)]
pub struct BroadcastResponse {
    pub ok: bool,
    pub sent_to: Vec<String>,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_ids: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct PollResponse {
    pub ready: bool,
    pub terminal: bool,
    pub stage: String,
    pub from_node: Option<String>,
    pub response: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DeliveryHandoff {
    Direct,
    Mailbox,
}

impl DeliveryHandoff {
    fn stage(self) -> DeliveryStage {
        match self {
            Self::Direct => DeliveryStage::HandedOffDirect,
            Self::Mailbox => DeliveryStage::HandedOffMailbox,
        }
    }
}

/// Build the axum router for the local API.
pub fn router(state: Arc<ApiState>) -> Router {
    Router::new()
        .route("/send", post(handle_send))
        .route("/ask", post(handle_ask))
        .route("/broadcast", post(handle_broadcast))
        .route("/debate", post(handle_debate))
        .route("/publish", post(handle_publish))
        .route("/response/:id", get(handle_poll_response))
        .route("/peers", get(handle_peers))
        .route("/status", get(handle_status))
        .with_state(state)
}

/// Start the local API server on 127.0.0.1:<port>.
pub async fn serve(state: Arc<ApiState>, port: u16) -> Result<(), String> {
    let app = router(state);
    let addr = format!("127.0.0.1:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("bind {}: {}", addr, e))?;
    println!("Local API listening on {}", addr);
    axum::serve(listener, app)
        .await
        .map_err(|e| format!("serve: {}", e))
}

fn decode_peer_x25519_pub(hex_value: &str) -> Result<[u8; 32], String> {
    let decoded = hex::decode(hex_value).map_err(|e| format!("bad x25519 pubkey: {}", e))?;
    if decoded.len() != 32 {
        return Err("x25519 pubkey wrong length".to_string());
    }
    let mut x_pub = [0u8; 32];
    x_pub.copy_from_slice(&decoded);
    Ok(x_pub)
}

/// Ensure Noise handshake is complete with a peer, then encrypt and send.
async fn encrypt_and_send(
    state: &ApiState,
    peer_id: &str,
    project_id: Option<&str>,
    payload: &serde_json::Value,
) -> Result<DeliveryHandoff, String> {
    use crate::connmgr::SessionState;
    use crate::noise;

    let plaintext = serde_json::to_vec(payload).map_err(|e| format!("serialize: {}", e))?;

    let resolve_peer_keys = || async {
        if let Some(project_id) = project_id {
            let keys = state.coord.get_project_keys(project_id).await?;
            if let Some(keys) = keys.into_iter().find(|keys| keys.node_id == peer_id) {
                return Ok(keys);
            }
            return Err(format!(
                "peer {} not found in project {} key list",
                peer_id, project_id
            ));
        }
        state.coord.get_peer_keys(peer_id).await
    };

    let fresh_keys = match resolve_peer_keys().await {
        Ok(keys) => keys,
        Err(err) => {
            state.transport.forget_peer_identity(peer_id).await;
            return Err(err);
        }
    };
    let fresh_x_pub = decode_peer_x25519_pub(&fresh_keys.x25519_pub)?;
    state
        .transport
        .remember_peer_identity(peer_id, fresh_x_pub)
        .await;

    let relay_encrypted = || async {
        let blob = crate::crypto::encrypt_mailbox_payload(
            &state.node_id,
            peer_id,
            &state.my_x25519_priv,
            &fresh_x_pub,
            &plaintext,
        )?;
        state.coord.relay_message(peer_id, &blob, project_id).await
    };

    let needs_handshake = {
        let conn = state.transport.conn.lock().await;
        match conn.peers.get(peer_id) {
            Some(pc) => match &pc.session {
                SessionState::Established(session) => noise::needs_rekey(session),
                _ => true,
            },
            None => true,
        }
    };

    if needs_handshake {
        {
            let mut conn = state.transport.conn.lock().await;
            if let Some(pc) = conn.peers.get_mut(peer_id) {
                if let SessionState::Established(_) = pc.session {
                    let old = std::mem::replace(&mut pc.session, SessionState::None);
                    if let SessionState::Established(s) = old {
                        pc.previous_session = Some(s);
                    }
                }
            }
        }

        if let Err(e) = state.transport.handshake(peer_id, &fresh_x_pub).await {
            eprintln!(
                "  direct handshake to {} failed ({}), using server relay",
                peer_id, e
            );
            relay_encrypted().await?;
            return Ok(DeliveryHandoff::Mailbox);
        }
    }

    // Try direct transport first (Noise IK via DERP/UDP)
    match state.transport.send(peer_id, &plaintext).await {
        Ok(_) => Ok(DeliveryHandoff::Direct),
        Err(e) => {
            // Fallback: relay through coordination server mailbox
            eprintln!("  direct send failed ({}), using server relay", e);
            relay_encrypted().await?;
            Ok(DeliveryHandoff::Mailbox)
        }
    }
}

/// Store a pending request and return its ID.
fn resolve_project_dir(project_id: &str) -> Option<String> {
    let conn = crate::db::open_db().ok()?;
    crate::db::init_db(&conn).ok()?;
    crate::queries::get_project_path(&conn, project_id)
}

fn new_request_id() -> String {
    format!("req_{}", uuid::Uuid::new_v4())
}

async fn insert_pending(
    state: &ApiState,
    request_id: String,
    project_id: &str,
    kind: &str,
    prompt: &str,
    session_id: Option<String>,
) {
    let mut responses = state.responses.lock().await;
    responses.insert(
        request_id,
        PendingResponse {
            response: None,
            from_node: None,
            error: None,
            stage: DeliveryStage::PendingSend,
            created_at: Instant::now(),
            project_id: if project_id.trim().is_empty() {
                None
            } else {
                Some(project_id.to_string())
            },
            kind: Some(kind.to_string()),
            prompt: Some(prompt.to_string()),
            session_id,
        },
    );
    // Clean up old entries (>5 minutes)
    responses.retain(|_, v| v.created_at.elapsed().as_secs() < 300);
}

async fn note_pending_stage(
    responses: &Arc<Mutex<HashMap<String, PendingResponse>>>,
    request_id: &str,
    from_node: Option<&str>,
    stage: DeliveryStage,
) {
    let mut map = responses.lock().await;
    if let Some(pending) = map.get_mut(request_id) {
        if pending.stage.is_terminal() {
            return;
        }
        pending.stage = stage;
        if let Some(from_node) = from_node {
            pending.from_node = Some(from_node.to_string());
        }
    }
}

async fn note_pending_failure(
    responses: &Arc<Mutex<HashMap<String, PendingResponse>>>,
    request_id: &str,
    from_node: Option<&str>,
    error: &str,
) {
    let mut map = responses.lock().await;
    if let Some(pending) = map.get_mut(request_id) {
        if pending.stage == DeliveryStage::ProcessedByPeerRuntime {
            return;
        }
        pending.stage = DeliveryStage::ProcessingFailed;
        pending.error = Some(error.to_string());
        if let Some(from_node) = from_node {
            pending.from_node = Some(from_node.to_string());
        }
    }
}

async fn remove_pending(state: &ApiState, request_id: &str) {
    let mut responses = state.responses.lock().await;
    responses.remove(request_id);
}

fn require_non_empty(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{} is required", field))
    } else {
        Ok(())
    }
}

fn require_project_capability(
    members: &[MemberInfo],
    node_id: &str,
    capability: ProjectCapability,
) -> Result<(), String> {
    let member = members
        .iter()
        .find(|member| member.node_id == node_id)
        .ok_or_else(|| format!("node {} is not a member of this project", node_id))?;
    let role = member.role.as_deref().unwrap_or("member");
    if role_has_capability(role, capability) {
        Ok(())
    } else {
        Err(format!(
            "role {} does not have {} permission",
            role,
            capability.as_str()
        ))
    }
}

/// Called by the daemon recv loop when a delivery event arrives.
pub async fn store_delivery_event(
    responses: &Arc<Mutex<HashMap<String, PendingResponse>>>,
    request_id: &str,
    from_node: &str,
    stage: &str,
    error: Option<&str>,
) {
    match DeliveryStage::from_str(stage) {
        Some(DeliveryStage::ProcessingFailed) => {
            note_pending_failure(
                responses,
                request_id,
                Some(from_node),
                error.unwrap_or("peer runtime processing failed"),
            )
            .await;
        }
        Some(stage) => {
            note_pending_stage(responses, request_id, Some(from_node), stage).await;
        }
        None => {}
    }
}

/// Called by the daemon recv loop when a response message arrives.
pub async fn store_response(
    responses: &Arc<Mutex<HashMap<String, PendingResponse>>>,
    request_id: &str,
    from_node: &str,
    response_text: &str,
) {
    let mut exchange = None;
    let mut map = responses.lock().await;
    if let Some(pending) = map.get_mut(request_id) {
        pending.response = Some(response_text.to_string());
        pending.from_node = Some(from_node.to_string());
        pending.error = None;
        pending.stage = DeliveryStage::ProcessedByPeerRuntime;
        exchange = Some((
            pending.project_id.clone().unwrap_or_default(),
            pending.kind.clone().unwrap_or_else(|| "ask".to_string()),
            pending.prompt.clone().unwrap_or_default(),
            pending.session_id.clone(),
        ));
    }
    drop(map);

    if let Some((project_id, kind, prompt, session_id)) = exchange {
        if let Some(project_dir) = resolve_project_dir(&project_id) {
            let _ = crate::conversation_memory::append_exchange(
                &project_dir,
                from_node,
                session_id.as_deref(),
                &kind,
                &prompt,
                response_text,
            );
        }
    }
}

async fn handle_send(
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
async fn handle_ask(
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
async fn handle_broadcast(
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
async fn handle_debate(
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
async fn handle_publish(
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

/// Poll for a response or staged delivery outcome by request_id.
async fn handle_poll_response(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
) -> Json<PollResponse> {
    let mut map = state.responses.lock().await;
    if let Some(pending) = map.get(&id) {
        let result = PollResponse {
            ready: pending.response.is_some(),
            terminal: pending.stage.is_terminal(),
            stage: pending.stage.as_str().to_string(),
            from_node: pending.from_node.clone(),
            response: pending.response.clone(),
            error: pending.error.clone(),
        };
        if pending.stage.is_terminal() {
            map.remove(&id);
        }
        return Json(result);
    }
    Json(PollResponse {
        ready: false,
        terminal: false,
        stage: "unknown".to_string(),
        from_node: None,
        response: None,
        error: None,
    })
}

fn connection_state_label(state: &crate::connmgr::ConnState) -> &'static str {
    match state {
        crate::connmgr::ConnState::Idle => "idle",
        crate::connmgr::ConnState::TryingLan => "trying_lan",
        crate::connmgr::ConnState::TryingDirect => "trying_direct",
        crate::connmgr::ConnState::ConnectedLan => "connected_lan",
        crate::connmgr::ConnState::ConnectedDirect => "connected_direct",
        crate::connmgr::ConnState::ConnectedRelay => "connected_relay",
    }
}

fn peer_reachability_label(state: &crate::connmgr::ConnState) -> &'static str {
    match state {
        crate::connmgr::ConnState::ConnectedLan => "lan",
        crate::connmgr::ConnState::ConnectedDirect => "direct",
        crate::connmgr::ConnState::ConnectedRelay => "relay_only",
        crate::connmgr::ConnState::TryingLan | crate::connmgr::ConnState::TryingDirect => "probing",
        crate::connmgr::ConnState::Idle => "unknown",
    }
}

fn session_state_label(state: &crate::connmgr::SessionState) -> &'static str {
    match state {
        crate::connmgr::SessionState::None => "none",
        crate::connmgr::SessionState::HandshakePending(_) => "handshake_pending",
        crate::connmgr::SessionState::Established(_) => "established",
    }
}

async fn handle_peers(State(state): State<Arc<ApiState>>) -> Json<Vec<PeerInfo>> {
    let conn = state.transport.conn.lock().await;
    let peers: Vec<PeerInfo> = conn
        .peers
        .iter()
        .map(|(id, pc)| PeerInfo {
            peer_id: id.clone(),
            connection_state: connection_state_label(&pc.state).to_string(),
            reachability: peer_reachability_label(&pc.state).to_string(),
            session_state: session_state_label(&pc.session).to_string(),
            last_inbound_at: pc.last_inbound_at.clone(),
            last_outbound_at: pc.last_outbound_at.clone(),
        })
        .collect();
    Json(peers)
}

async fn handle_status(State(state): State<Arc<ApiState>>) -> Json<StatusResponse> {
    let snapshot = state.presence.lock().await.snapshot();
    let healthy = !matches!(snapshot.coordination.state, ComponentState::Degraded)
        && !matches!(snapshot.runtime.state, ComponentState::Degraded);
    Json(StatusResponse {
        node_id: state.node_id.clone(),
        healthy,
        daemon: DaemonStatus {
            state: "online".to_string(),
            started_at: snapshot.daemon_started_at,
        },
        coordination: snapshot.coordination,
        runtime: snapshot.runtime,
        reachability: snapshot.reachability,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connmgr::ConnManager;
    use crate::crypto;
    use crate::transport::Transport;
    use axum::body::to_bytes;
    use base64::Engine;
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;
    use std::sync::Arc;

    #[derive(Clone)]
    struct MockCoord {
        peer_x25519_pub: String,
        relayed: Arc<Mutex<Vec<RelayReq>>>,
        relay_error: Option<String>,
        relay_errors_by_target: std::collections::HashMap<String, String>,
        project_members: Vec<MemberInfo>,
    }

    #[derive(Clone, Debug)]
    struct RelayReq {
        target_node_id: String,
        blob: String,
        project_id: Option<String>,
    }

    #[async_trait::async_trait]
    impl CoordOps for MockCoord {
        async fn get_peer_keys(&self, peer_id: &str) -> Result<PeerKeys, String> {
            Ok(PeerKeys {
                node_id: peer_id.to_string(),
                ed25519_pub: "unused".to_string(),
                x25519_pub: self.peer_x25519_pub.clone(),
            })
        }

        async fn get_project_keys(&self, project_id: &str) -> Result<Vec<PeerKeys>, String> {
            if project_id == "proj_test" && !self.project_members.is_empty() {
                return Ok(self
                    .project_members
                    .iter()
                    .filter(|member| member.node_id != "kd_sender")
                    .map(|member| PeerKeys {
                        node_id: member.node_id.clone(),
                        ed25519_pub: "unused".to_string(),
                        x25519_pub: self.peer_x25519_pub.clone(),
                    })
                    .collect());
            }
            Ok(vec![PeerKeys {
                node_id: if project_id == "proj_test" {
                    "kd_peer".to_string()
                } else {
                    "kd_unknown".to_string()
                },
                ed25519_pub: "unused".to_string(),
                x25519_pub: self.peer_x25519_pub.clone(),
            }])
        }

        async fn relay_message(
            &self,
            target_node_id: &str,
            blob: &str,
            project_id: Option<&str>,
        ) -> Result<(), String> {
            self.relayed.lock().await.push(RelayReq {
                target_node_id: target_node_id.to_string(),
                blob: blob.to_string(),
                project_id: project_id.map(str::to_string),
            });
            if let Some(err) = self.relay_errors_by_target.get(target_node_id) {
                return Err(err.clone());
            }
            if let Some(err) = &self.relay_error {
                return Err(err.clone());
            }
            Ok(())
        }

        async fn get_project_members(&self, _project_id: &str) -> Result<Vec<MemberInfo>, String> {
            Ok(self.project_members.clone())
        }
    }

    fn make_test_state(coord: Arc<dyn CoordOps>) -> ApiState {
        let signing = SigningKey::generate(&mut OsRng);
        let x_priv = crypto::ed25519_to_x25519_private(&signing.to_bytes());
        let transport = Arc::new(Transport::new_for_tests(
            ConnManager::new(None),
            None,
            "kd_sender".to_string(),
            x_priv,
        ));
        ApiState {
            transport,
            coord,
            node_id: "kd_sender".to_string(),
            my_x25519_priv: x_priv,
            responses: Arc::new(Mutex::new(HashMap::new())),
            presence: Arc::new(Mutex::new(PresenceState::new(0, false))),
        }
    }

    async fn response_json(response: impl IntoResponse) -> (StatusCode, serde_json::Value) {
        let response = response.into_response();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json = serde_json::from_slice(&body).unwrap();
        (status, json)
    }

    fn member(node_id: &str) -> MemberInfo {
        member_with_role(node_id, "member")
    }

    fn member_with_role(node_id: &str, role: &str) -> MemberInfo {
        MemberInfo {
            node_id: node_id.to_string(),
            display_name: Some(format!("display-{node_id}")),
            role: Some(role.to_string()),
        }
    }

    #[tokio::test]
    async fn encrypt_and_send_relays_when_direct_handshake_is_unavailable() {
        let peer_signing = SigningKey::generate(&mut OsRng);
        let peer_x25519 =
            crypto::ed25519_to_x25519_public(peer_signing.verifying_key().as_bytes()).unwrap();
        let relayed = Arc::new(Mutex::new(Vec::new()));
        let coord = Arc::new(MockCoord {
            peer_x25519_pub: hex::encode(peer_x25519),
            relayed: relayed.clone(),
            relay_error: None,
            relay_errors_by_target: std::collections::HashMap::new(),
            project_members: Vec::new(),
        });

        let signing = SigningKey::generate(&mut OsRng);
        let x_priv = crypto::ed25519_to_x25519_private(&signing.to_bytes());
        let transport = Arc::new(Transport::new_for_tests(
            ConnManager::new(None),
            None,
            "kd_sender".to_string(),
            x_priv,
        ));
        let state = ApiState {
            transport,
            coord,
            node_id: "kd_sender".to_string(),
            my_x25519_priv: x_priv,
            responses: Arc::new(Mutex::new(HashMap::new())),
            presence: Arc::new(Mutex::new(PresenceState::new(0, false))),
        };
        let payload = serde_json::json!({
            "from": "kd_sender",
            "projectId": "proj_test",
            "messageType": "ask",
            "payload": { "question": "What is this project about?" },
        });

        let handoff = encrypt_and_send(&state, "kd_peer", Some("proj_test"), &payload)
            .await
            .unwrap();

        assert_eq!(handoff, DeliveryHandoff::Mailbox);

        let relayed = relayed.lock().await;
        assert_eq!(relayed.len(), 1);
        assert_eq!(relayed[0].target_node_id, "kd_peer");
        assert_eq!(relayed[0].project_id.as_deref(), Some("proj_test"));

        let sender_pub =
            crypto::ed25519_to_x25519_public(signing.verifying_key().as_bytes()).unwrap();
        let plaintext = crypto::decrypt_mailbox_payload(
            "kd_peer",
            "kd_sender",
            &crypto::ed25519_to_x25519_private(&peer_signing.to_bytes()),
            &sender_pub,
            &relayed[0].blob,
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&plaintext).unwrap();
        assert_eq!(parsed["messageType"], "ask");
        assert_eq!(parsed["payload"]["question"], "What is this project about?");
    }

    #[tokio::test]
    async fn store_delivery_event_updates_pending_stage_until_response_arrives() {
        let peer_signing = SigningKey::generate(&mut OsRng);
        let peer_x25519 =
            crypto::ed25519_to_x25519_public(peer_signing.verifying_key().as_bytes()).unwrap();
        let state = Arc::new(make_test_state(Arc::new(MockCoord {
            peer_x25519_pub: hex::encode(peer_x25519),
            relayed: Arc::new(Mutex::new(Vec::new())),
            relay_error: None,
            relay_errors_by_target: std::collections::HashMap::new(),
            project_members: vec![member("kd_sender"), member("kd_peer")],
        })));

        insert_pending(
            state.as_ref(),
            "req_test".to_string(),
            "proj_test",
            "ask",
            "hello",
            None,
        )
        .await;
        note_pending_stage(
            &state.responses,
            "req_test",
            None,
            DeliveryHandoff::Direct.stage(),
        )
        .await;
        store_delivery_event(
            &state.responses,
            "req_test",
            "kd_peer",
            "received_by_peer_daemon",
            None,
        )
        .await;

        let poll = handle_poll_response(State(state.clone()), Path("req_test".to_string())).await;
        assert!(!poll.ready);
        assert!(!poll.terminal);
        assert_eq!(poll.stage, "received_by_peer_daemon");
        assert_eq!(poll.from_node.as_deref(), Some("kd_peer"));

        store_response(&state.responses, "req_test", "kd_peer", "done").await;
        let poll = handle_poll_response(State(state.clone()), Path("req_test".to_string())).await;
        assert!(poll.ready);
        assert!(poll.terminal);
        assert_eq!(poll.stage, "processed_by_peer_runtime");
        assert_eq!(poll.response.as_deref(), Some("done"));
    }

    #[tokio::test]
    async fn store_delivery_event_reports_terminal_processing_failure() {
        let peer_signing = SigningKey::generate(&mut OsRng);
        let peer_x25519 =
            crypto::ed25519_to_x25519_public(peer_signing.verifying_key().as_bytes()).unwrap();
        let state = Arc::new(make_test_state(Arc::new(MockCoord {
            peer_x25519_pub: hex::encode(peer_x25519),
            relayed: Arc::new(Mutex::new(Vec::new())),
            relay_error: None,
            relay_errors_by_target: std::collections::HashMap::new(),
            project_members: vec![member("kd_sender"), member("kd_peer")],
        })));

        insert_pending(
            state.as_ref(),
            "req_fail".to_string(),
            "proj_test",
            "ask",
            "hello",
            None,
        )
        .await;
        store_delivery_event(
            &state.responses,
            "req_fail",
            "kd_peer",
            "processing_failed",
            Some("runtime rejected request"),
        )
        .await;

        let poll = handle_poll_response(State(state.clone()), Path("req_fail".to_string())).await;
        assert!(!poll.ready);
        assert!(poll.terminal);
        assert_eq!(poll.stage, "processing_failed");
        assert_eq!(poll.from_node.as_deref(), Some("kd_peer"));
        assert_eq!(poll.error.as_deref(), Some("runtime rejected request"));
    }

    #[tokio::test]
    async fn handle_send_rejects_empty_peer_id() {
        let peer_signing = SigningKey::generate(&mut OsRng);
        let peer_x25519 =
            crypto::ed25519_to_x25519_public(peer_signing.verifying_key().as_bytes()).unwrap();
        let state = Arc::new(make_test_state(Arc::new(MockCoord {
            peer_x25519_pub: hex::encode(peer_x25519),
            relayed: Arc::new(Mutex::new(Vec::new())),
            relay_error: None,
            relay_errors_by_target: std::collections::HashMap::new(),
            project_members: Vec::new(),
        })));

        let (status, json) = response_json(
            handle_send(
                State(state),
                Json(SendRequest {
                    peer_id: "   ".to_string(),
                    message: "hello".to_string(),
                }),
            )
            .await,
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["ok"], false);
        assert_eq!(json["error"], "peer_id is required");
    }

    #[tokio::test]
    async fn handle_ask_removes_pending_when_delivery_fails() {
        let peer_signing = SigningKey::generate(&mut OsRng);
        let peer_x25519 =
            crypto::ed25519_to_x25519_public(peer_signing.verifying_key().as_bytes()).unwrap();
        let state = Arc::new(make_test_state(Arc::new(MockCoord {
            peer_x25519_pub: hex::encode(peer_x25519),
            relayed: Arc::new(Mutex::new(Vec::new())),
            relay_error: Some("relay unavailable".to_string()),
            relay_errors_by_target: std::collections::HashMap::new(),
            project_members: Vec::new(),
        })));

        let (status, json) = response_json(
            handle_ask(
                State(state.clone()),
                Json(AskRequest {
                    node_id: "kd_peer".to_string(),
                    question: "hello?".to_string(),
                    project_id: "".to_string(),
                    new_session: false,
                }),
            )
            .await,
        )
        .await;

        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(json["ok"], false);
        assert_eq!(state.responses.lock().await.len(), 0);
    }

    #[tokio::test]
    async fn handle_publish_rejects_invalid_base64() {
        let peer_signing = SigningKey::generate(&mut OsRng);
        let peer_x25519 =
            crypto::ed25519_to_x25519_public(peer_signing.verifying_key().as_bytes()).unwrap();
        let state = Arc::new(make_test_state(Arc::new(MockCoord {
            peer_x25519_pub: hex::encode(peer_x25519),
            relayed: Arc::new(Mutex::new(Vec::new())),
            relay_error: None,
            relay_errors_by_target: std::collections::HashMap::new(),
            project_members: Vec::new(),
        })));

        let (status, json) = response_json(
            handle_publish(
                State(state),
                Json(PublishRequest {
                    filename: "artifact.txt".to_string(),
                    data: "%%%not-base64%%%".to_string(),
                    project_id: "proj_test".to_string(),
                }),
            )
            .await,
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["ok"], false);
        assert!(json["error"]
            .as_str()
            .unwrap_or_default()
            .starts_with("data must be valid base64:"));
    }

    #[tokio::test]
    async fn handle_broadcast_returns_partial_success_with_ok_false() {
        let peer_signing = SigningKey::generate(&mut OsRng);
        let peer_x25519 =
            crypto::ed25519_to_x25519_public(peer_signing.verifying_key().as_bytes()).unwrap();
        let mut relay_errors = std::collections::HashMap::new();
        relay_errors.insert("kd_peer_b".to_string(), "relay unavailable".to_string());
        let state = Arc::new(make_test_state(Arc::new(MockCoord {
            peer_x25519_pub: hex::encode(peer_x25519),
            relayed: Arc::new(Mutex::new(Vec::new())),
            relay_error: None,
            relay_errors_by_target: relay_errors,
            project_members: vec![
                member("kd_sender"),
                member("kd_peer_a"),
                member("kd_peer_b"),
            ],
        })));

        let (status, json) = response_json(
            handle_broadcast(
                State(state),
                Json(BroadcastRequest {
                    message: "hello team".to_string(),
                    project_id: "proj_test".to_string(),
                    message_type: "broadcast".to_string(),
                }),
            )
            .await,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["ok"], false);
        assert_eq!(json["sent_to"], serde_json::json!(["kd_peer_a"]));
        assert_eq!(json["error"], "relay unavailable");
    }

    #[tokio::test]
    async fn handle_broadcast_rejects_guest_role() {
        let peer_signing = SigningKey::generate(&mut OsRng);
        let peer_x25519 =
            crypto::ed25519_to_x25519_public(peer_signing.verifying_key().as_bytes()).unwrap();
        let state = Arc::new(make_test_state(Arc::new(MockCoord {
            peer_x25519_pub: hex::encode(peer_x25519),
            relayed: Arc::new(Mutex::new(Vec::new())),
            relay_error: None,
            relay_errors_by_target: std::collections::HashMap::new(),
            project_members: vec![
                member_with_role("kd_sender", "guest"),
                member("kd_peer_a"),
                member("kd_peer_b"),
            ],
        })));

        let (status, json) = response_json(
            handle_broadcast(
                State(state),
                Json(BroadcastRequest {
                    message: "hello team".to_string(),
                    project_id: "proj_test".to_string(),
                    message_type: "broadcast".to_string(),
                }),
            )
            .await,
        )
        .await;

        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(json["ok"], false);
        assert_eq!(
            json["error"],
            "role guest does not have broadcast permission"
        );
    }

    #[tokio::test]
    async fn handle_debate_returns_request_ids_only_for_delivered_peers() {
        let peer_signing = SigningKey::generate(&mut OsRng);
        let peer_x25519 =
            crypto::ed25519_to_x25519_public(peer_signing.verifying_key().as_bytes()).unwrap();
        let mut relay_errors = std::collections::HashMap::new();
        relay_errors.insert("kd_peer_b".to_string(), "relay unavailable".to_string());
        let state = Arc::new(make_test_state(Arc::new(MockCoord {
            peer_x25519_pub: hex::encode(peer_x25519),
            relayed: Arc::new(Mutex::new(Vec::new())),
            relay_error: None,
            relay_errors_by_target: relay_errors,
            project_members: vec![
                member("kd_sender"),
                member("kd_peer_a"),
                member("kd_peer_b"),
            ],
        })));

        let (status, json) = response_json(
            handle_debate(
                State(state.clone()),
                Json(DebateRequest {
                    topic: "What should we ship next?".to_string(),
                    project_id: "proj_test".to_string(),
                    new_session: false,
                }),
            )
            .await,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["ok"], false);
        assert_eq!(json["sent_to"], serde_json::json!(["kd_peer_a"]));
        assert_eq!(json["error"], "relay unavailable");
        assert_eq!(json["request_ids"].as_array().map(|v| v.len()), Some(1));
        assert_eq!(state.responses.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn handle_publish_returns_bad_gateway_when_nothing_delivered() {
        let peer_signing = SigningKey::generate(&mut OsRng);
        let peer_x25519 =
            crypto::ed25519_to_x25519_public(peer_signing.verifying_key().as_bytes()).unwrap();
        let state = Arc::new(make_test_state(Arc::new(MockCoord {
            peer_x25519_pub: hex::encode(peer_x25519),
            relayed: Arc::new(Mutex::new(Vec::new())),
            relay_error: Some("relay unavailable".to_string()),
            relay_errors_by_target: std::collections::HashMap::new(),
            project_members: vec![member("kd_sender"), member("kd_peer_a")],
        })));

        let (status, json) = response_json(
            handle_publish(
                State(state),
                Json(PublishRequest {
                    filename: "artifact.txt".to_string(),
                    data: base64::engine::general_purpose::STANDARD.encode("hello"),
                    project_id: "proj_test".to_string(),
                }),
            )
            .await,
        )
        .await;

        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(json["ok"], false);
        assert_eq!(json["sent_to"], serde_json::json!([]));
        assert_eq!(json["error"], "relay unavailable");
    }

    #[tokio::test]
    async fn handle_status_reports_presence_model_fields() {
        let state = Arc::new(make_test_state(Arc::new(MockCoord {
            peer_x25519_pub: "00".repeat(32),
            relayed: Arc::new(Mutex::new(Vec::new())),
            relay_error: None,
            relay_errors_by_target: std::collections::HashMap::new(),
            project_members: Vec::new(),
        })));
        {
            let mut presence = state.presence.lock().await;
            presence.set_reachability_inputs(0, true);
            presence.note_coord_ok("mailbox poll succeeded");
            presence.note_runtime_error("runtime dispatch failed");
        }

        let Json(status) = handle_status(State(state)).await;

        assert_eq!(status.node_id, "kd_sender");
        assert!(!status.healthy);
        assert_eq!(status.daemon.state, "online");
        assert_eq!(status.coordination.state, ComponentState::Healthy);
        assert_eq!(status.runtime.state, ComponentState::Degraded);
        assert_eq!(
            status.reachability.mode,
            crate::presence::ReachabilityMode::RelayOnly
        );
        assert!(status.reachability.mailbox_durable);
    }

    #[tokio::test]
    async fn handle_peers_reports_reachability_and_last_activity() {
        let state = Arc::new(make_test_state(Arc::new(MockCoord {
            peer_x25519_pub: "00".repeat(32),
            relayed: Arc::new(Mutex::new(Vec::new())),
            relay_error: None,
            relay_errors_by_target: std::collections::HashMap::new(),
            project_members: Vec::new(),
        })));
        {
            let mut conn = state.transport.conn.lock().await;
            let peer = conn.get_or_create("kd_peer");
            peer.state = crate::connmgr::ConnState::ConnectedRelay;
            peer.last_inbound_at = Some("2026-04-16T00:00:00Z".to_string());
            peer.last_outbound_at = Some("2026-04-16T00:00:05Z".to_string());
            peer.session = crate::connmgr::SessionState::None;
        }

        let Json(peers) = handle_peers(State(state)).await;

        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].peer_id, "kd_peer");
        assert_eq!(peers[0].connection_state, "connected_relay");
        assert_eq!(peers[0].reachability, "relay_only");
        assert_eq!(peers[0].session_state, "none");
        assert_eq!(
            peers[0].last_inbound_at.as_deref(),
            Some("2026-04-16T00:00:00Z")
        );
        assert_eq!(
            peers[0].last_outbound_at.as_deref(),
            Some("2026-04-16T00:00:05Z")
        );
    }
}
