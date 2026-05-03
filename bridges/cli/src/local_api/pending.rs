use std::{collections::HashMap, sync::Arc, time::Instant};

use serde::Serialize;
use tokio::sync::Mutex;

use super::ApiState;

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
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::PendingSend => "pending_send",
            Self::HandedOffDirect => "handed_off_direct",
            Self::HandedOffMailbox => "handed_off_mailbox",
            Self::ReceivedByPeerDaemon => "received_by_peer_daemon",
            Self::ProcessingFailed => "processing_failed",
            Self::ProcessedByPeerRuntime => "processed_by_peer_runtime",
        }
    }

    pub(super) fn is_terminal(self) -> bool {
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

/// Store a pending request and return its ID.
pub(super) fn resolve_project_dir(project_id: &str) -> Option<String> {
    let conn = crate::db::open_db().ok()?;
    crate::db::init_db(&conn).ok()?;
    crate::queries::get_project_path(&conn, project_id)
}

pub(super) fn new_request_id() -> String {
    format!("req_{}", uuid::Uuid::new_v4())
}

pub(super) async fn insert_pending(
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

pub(super) async fn note_pending_stage(
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

pub(super) async fn note_pending_failure(
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

pub(super) async fn remove_pending(state: &ApiState, request_id: &str) {
    let mut responses = state.responses.lock().await;
    responses.remove(request_id);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivery_stage_parses_wire_values() {
        assert_eq!(
            DeliveryStage::from_str("pending_send"),
            Some(DeliveryStage::PendingSend),
        );
    }
}
