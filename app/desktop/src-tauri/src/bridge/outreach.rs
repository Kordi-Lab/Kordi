use kordi_tools::{ReachOutRequest, ReachOutResponse};
use tokio::time::{sleep, Duration};

use crate::chat::DesktopChatManager;

use super::constants::{
    is_agent_like_runtime, BRIDGE_MESSAGE_DIRECTION_INBOUND,
    BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE, BRIDGE_MESSAGE_DIRECTION_OUTBOUND,
};
use super::conversation_commands::desktop_bridge_create_outreach_impl;
use super::mailbox::desktop_bridge_poll_mailbox_impl;
use super::{
    build_current_bridge_state, load_conversation_store, now_ms, save_conversation_store,
    DesktopBridgeCreateOutreachRequest, DesktopBridgeManager,
};

fn normalize_outreach_target(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn outreach_target_matches(peer: &super::DesktopBridgePeer, target: &str) -> bool {
    let normalized = normalize_outreach_target(target);
    if normalized.is_empty() {
        return false;
    }
    [
        Some(peer.node_id.as_str()),
        peer.display_name.as_deref(),
        peer.owner_name.as_deref(),
        peer.human_id.as_deref(),
        peer.agent_id.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|candidate| normalize_outreach_target(candidate) == normalized)
}

fn infer_reach_out_kind(
    peer_runtime: &str,
    requested_kind: Option<&str>,
) -> Result<String, String> {
    match requested_kind.map(|value| value.trim().to_ascii_lowercase()) {
        Some(kind) if kind == "bridge-agent" => {
            if !is_agent_like_runtime(peer_runtime) {
                return Err("Selected outreach target is not a bridge agent".to_string());
            }
            Ok(kind)
        }
        Some(kind) if kind == "bridge-person" => Ok(kind),
        Some(_) => Err("reach_out targetKind must be bridge-agent or bridge-person".to_string()),
        None if is_agent_like_runtime(peer_runtime) => Ok("bridge-agent".to_string()),
        None => Ok("bridge-person".to_string()),
    }
}

fn find_outreach_response(
    conversation_id: &str,
    started_at_ms: i64,
    request_id: Option<&str>,
) -> Option<String> {
    let store = load_conversation_store();
    let conversation = store
        .conversations
        .iter()
        .find(|conversation| conversation.id == conversation_id)?;
    conversation
        .messages
        .iter()
        .rev()
        .find(|message| {
            message.timestamp_ms >= started_at_ms
                && (message.direction == BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE
                    || message.direction == BRIDGE_MESSAGE_DIRECTION_INBOUND)
                && request_id.is_none_or(|request_id| {
                    message.request_id.as_deref() == Some(request_id)
                        || message.direction == BRIDGE_MESSAGE_DIRECTION_INBOUND
                })
                && !message.text.trim().is_empty()
        })
        .map(|message| message.text.clone())
}

fn latest_outreach_request_id(conversation_id: &str, started_at_ms: i64) -> Option<String> {
    let store = load_conversation_store();
    let conversation = store
        .conversations
        .iter()
        .find(|conversation| conversation.id == conversation_id)?;
    conversation
        .messages
        .iter()
        .rev()
        .find(|message| {
            message.timestamp_ms >= started_at_ms
                && message.direction == BRIDGE_MESSAGE_DIRECTION_OUTBOUND
                && message.request_id.is_some()
        })
        .and_then(|message| message.request_id.clone())
}

pub(super) fn mark_outreach_status(
    conversation_id: &str,
    status: &str,
    completed: bool,
    error: Option<String>,
) -> Result<(), String> {
    let mut store = load_conversation_store();
    if let Some(conversation) = store
        .conversations
        .iter_mut()
        .find(|conversation| conversation.id == conversation_id)
    {
        if let Some(outreach) = conversation.outreach.as_mut() {
            outreach.status = status.to_string();
            outreach.updated_at_ms = now_ms();
            outreach.error = error;
            if completed {
                outreach.completed_at_ms = Some(now_ms());
            }
        }
    }
    save_conversation_store(&store)
}

pub(crate) async fn desktop_bridge_reach_out_impl(
    manager: &DesktopBridgeManager,
    chat_manager: &DesktopChatManager,
    request: ReachOutRequest,
) -> Result<ReachOutResponse, String> {
    let target = request.target.trim();
    let message = request.message.trim();
    if target.is_empty() {
        return Err("reach_out target is required".to_string());
    }
    if message.is_empty() {
        return Err("reach_out message is required".to_string());
    }

    let current_state = build_current_bridge_state(manager).await;
    let active_host_id = current_state.active_host_id.as_deref();
    let mut matches = current_state
        .hosts
        .iter()
        .flat_map(|host| host.visible_peers.iter().map(move |peer| (host, peer)))
        .filter(|(_, peer)| outreach_target_matches(peer, target))
        .collect::<Vec<_>>();
    matches.sort_by_key(|(host, peer)| {
        let active_rank = if Some(host.id.as_str()) == active_host_id {
            0
        } else {
            1
        };
        let exact_rank = [
            Some(peer.node_id.as_str()),
            peer.display_name.as_deref(),
            peer.owner_name.as_deref(),
            peer.human_id.as_deref(),
            peer.agent_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|candidate| normalize_outreach_target(candidate) == normalize_outreach_target(target));
        (active_rank, if exact_rank { 0 } else { 1 })
    });
    let (host, peer) = matches
        .first()
        .ok_or_else(|| format!("No visible bridge target matched '{target}'"))?;
    let target_kind = infer_reach_out_kind(&peer.runtime, request.target_kind.as_deref())?;
    let started_at_ms = now_ms();

    let project_name = request.project_name.clone().or_else(|| {
        request
            .context
            .as_deref()
            .and_then(|context| {
                context
                    .lines()
                    .find_map(|line| line.strip_prefix("Project: "))
            })
            .map(ToString::to_string)
    });

    let state = desktop_bridge_create_outreach_impl(
        manager,
        DesktopBridgeCreateOutreachRequest {
            host_id: host.id.clone(),
            target_node_id: peer.node_id.clone(),
            target_kind: target_kind.clone(),
            request_text: message.to_string(),
            target_display_name: peer
                .display_name
                .clone()
                .or_else(|| peer.owner_name.clone()),
            target_owner_name: peer.owner_name.clone(),
            target_runtime: Some(peer.runtime.clone()),
            target_human_id: peer.human_id.clone(),
            target_agent_id: peer.agent_id.clone(),
            trigger_text: None,
            context_text: request.context.clone(),
            context_policy: Some(request.context_policy.clone()),
            parent_session_id: request.parent_session_id.clone(),
            parent_session_title: None,
            parent_session_kind: None,
            parent_group_space_id: None,
            parent_session_participants: Vec::new(),
            parent_session_messages: Vec::new(),
            initiator_identity: None,
            self_target_identity: None,
            permission_policy_hash: None,
            participant_graph_hash: None,
            parent_turn_id: request.parent_turn_id.clone(),
            parent_message_id: request.parent_message_id.clone(),
            bridge_request_id: None,
            delivery_state: None,
            project_id: request.project_id.clone(),
            project_name,
            attachment_paths: Vec::new(),
            attachment_names: Vec::new(),
        },
    )
    .await?;

    let conversation = state
        .conversations
        .iter()
        .find(|conversation| {
            conversation.host_id == host.id && conversation.peer_node_id == peer.node_id
        })
        .cloned()
        .ok_or_else(|| "Outreach conversation was not created".to_string())?;
    let conversation_id = conversation.id.clone();
    let request_id = latest_outreach_request_id(&conversation_id, started_at_ms);

    if !request.wait_for_response {
        return Ok(ReachOutResponse {
            conversation_id,
            target_kind,
            target_display_name: conversation.title,
            target_owner_name: conversation.peer_owner_name,
            response_text: None,
            status: "awaitingReply".to_string(),
            timed_out: false,
        });
    }

    let timeout_seconds = request.timeout_seconds.unwrap_or(120).clamp(5, 600);
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_seconds);
    let mut response_text =
        find_outreach_response(&conversation_id, started_at_ms, request_id.as_deref());
    while response_text.is_none() && std::time::Instant::now() < deadline {
        let _ = desktop_bridge_poll_mailbox_impl(manager, chat_manager).await;
        response_text =
            find_outreach_response(&conversation_id, started_at_ms, request_id.as_deref());
        if response_text.is_some() {
            break;
        }
        sleep(Duration::from_millis(1500)).await;
    }

    let timed_out = response_text.is_none();
    if timed_out {
        mark_outreach_status(&conversation_id, "awaitingReply", false, None)?;
    } else {
        mark_outreach_status(&conversation_id, "completed", true, None)?;
    }

    Ok(ReachOutResponse {
        conversation_id,
        target_kind,
        target_display_name: conversation.title,
        target_owner_name: conversation.peer_owner_name,
        response_text,
        status: if timed_out {
            "awaitingReply"
        } else {
            "completed"
        }
        .to_string(),
        timed_out,
    })
}
