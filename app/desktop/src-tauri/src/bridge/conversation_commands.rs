use super::constants::{is_agent_like_runtime, DEFAULT_BRIDGE_RUNTIME};
#[cfg(test)]
use super::constants::{
    API_STYLE_SERVE, BRIDGE_MESSAGE_TYPE_ASK, BRIDGE_MESSAGE_TYPE_RAW, BRIDGE_MESSAGE_TYPE_RESPONSE,
};
use super::conversation_actions::desktop_bridge_send_message_impl;
#[cfg(test)]
use super::conversation_actions::outbound_message_type;
#[cfg(test)]
use super::events::{mailbox_payload_agent_prompt_text, mailbox_payload_text};
#[cfg(test)]
use super::mailbox::parse_mailbox_event;
#[cfg(test)]
use super::outreach::outreach_target_matches;
#[cfg(test)]
use super::DesktopBridgeHostConfig;
use super::{
    build_current_bridge_state, default_owner_name, generate_human_id, load_bridge_store,
    load_conversation_store, now_ms, save_conversation_store, upsert_bridge_conversation,
    DesktopBridgeCreateOutreachRequest, DesktopBridgeIdentitySnapshot, DesktopBridgeManager,
    DesktopBridgeOutreachMetadata, DesktopBridgePeer, DesktopBridgeState,
};

pub(super) async fn desktop_bridge_create_outreach_impl(
    manager: &DesktopBridgeManager,
    request: DesktopBridgeCreateOutreachRequest,
) -> Result<DesktopBridgeState, String> {
    let message = request.request_text.trim();
    if message.is_empty() {
        return Err("Outreach request cannot be empty".to_string());
    }

    let target_kind = request.target_kind.trim().to_ascii_lowercase();
    if target_kind != "bridge-agent" && target_kind != "bridge-person" {
        return Err("Outreach target kind must be bridge-agent or bridge-person".to_string());
    }

    let clean = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    };
    let request_target_display_name = clean(&request.target_display_name);
    let request_target_owner_name = clean(&request.target_owner_name);
    let request_target_runtime = clean(&request.target_runtime);
    let request_target_human_id = clean(&request.target_human_id);
    let request_target_agent_id = clean(&request.target_agent_id);

    let bridge_store = load_bridge_store();
    let host = bridge_store
        .hosts
        .iter()
        .find(|host| host.id == request.host_id)
        .cloned()
        .ok_or_else(|| "Bridge host not found".to_string())?;

    let peer = if request_target_runtime.is_some()
        || request_target_display_name.is_some()
        || request_target_owner_name.is_some()
        || request_target_human_id.is_some()
        || request_target_agent_id.is_some()
    {
        DesktopBridgePeer {
            node_id: request.target_node_id.clone(),
            display_name: request_target_display_name.clone(),
            runtime: request_target_runtime
                .clone()
                .unwrap_or_else(|| DEFAULT_BRIDGE_RUNTIME.to_string()),
            endpoint: String::new(),
            owner_name: request_target_owner_name.clone(),
            created_at: None,
            shared_projects: Vec::new(),
            human_id: request_target_human_id.clone(),
            agent_id: request_target_agent_id.clone(),
            is_default_agent: false,
            discovery_mode: None,
        }
    } else {
        let current_state = build_current_bridge_state(manager).await;
        current_state
            .hosts
            .iter()
            .find(|host| host.id == request.host_id)
            .and_then(|host| {
                host.visible_peers
                    .iter()
                    .find(|peer| peer.node_id == request.target_node_id)
            })
            .cloned()
            .ok_or_else(|| "Bridge outreach target is not visible on this host".to_string())?
    };

    let peer_runtime = if target_kind == "bridge-person" {
        "person".to_string()
    } else {
        peer.runtime.clone()
    };
    if target_kind == "bridge-agent" && !is_agent_like_runtime(&peer_runtime) {
        return Err("Selected outreach target is not a bridge agent".to_string());
    }

    let now = now_ms();
    let target_owner_name = request_target_owner_name
        .clone()
        .or_else(|| peer.owner_name.clone());
    let target_display_name = request_target_display_name
        .clone()
        .or_else(|| {
            if target_kind == "bridge-person" {
                target_owner_name.clone()
            } else {
                peer.display_name.clone()
            }
        })
        .or_else(|| peer.display_name.clone())
        .or_else(|| target_owner_name.clone())
        .unwrap_or_else(|| peer.node_id.clone());
    let target_human_id = request_target_human_id
        .clone()
        .or_else(|| peer.human_id.clone());
    let target_agent_id = (target_kind == "bridge-agent")
        .then(|| {
            request_target_agent_id
                .clone()
                .or_else(|| peer.agent_id.clone())
        })
        .flatten();

    let mut store = load_conversation_store();
    let conversation = upsert_bridge_conversation(
        &mut store,
        &request.host_id,
        &request.target_node_id,
        Some(target_display_name.clone()),
        target_owner_name.clone(),
        peer_runtime.clone(),
        request.project_id.clone(),
        request.project_name.clone(),
    );
    let active_agent = host
        .active_agent_id
        .as_deref()
        .and_then(|active_id| host.agents.iter().find(|agent| agent.id == active_id))
        .or_else(|| host.agents.iter().find(|agent| agent.is_default))
        .or_else(|| host.agents.first());
    let local_human_id = host.human_id.clone().unwrap_or_else(generate_human_id);
    let local_human_name = host.owner.clone().unwrap_or_else(default_owner_name);

    let is_session_transport = request
        .context_policy
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("session-relay")
                || value.eq_ignore_ascii_case("session-message")
        });
    conversation.outreach = Some(DesktopBridgeOutreachMetadata {
        target_kind: target_kind.clone(),
        parent_session_id: request.parent_session_id.clone(),
        parent_session_title: request.parent_session_title.clone(),
        parent_session_messages: request.parent_session_messages.clone(),
        parent_turn_id: request.parent_turn_id.clone(),
        parent_message_id: request.parent_message_id.clone(),
        bridge_host_id: request.host_id.clone(),
        bridge_conversation_id: Some(conversation.id.clone()),
        bridge_request_id: None,
        target_node_id: request.target_node_id.clone(),
        target_human_id: target_human_id.clone(),
        target_agent_id: target_agent_id.clone(),
        target_display_name: target_display_name.clone(),
        target_owner_name: target_owner_name.clone(),
        target_runtime: Some(peer_runtime.clone()),
        request_text: message.to_string(),
        trigger_text: request.trigger_text.clone(),
        context_text: request.context_text.clone(),
        context_policy: request.context_policy.clone(),
        project_id: request.project_id.clone(),
        project_name: request.project_name.clone(),
        status: if is_session_transport {
            "completed"
        } else {
            "awaitingReply"
        }
        .to_string(),
        created_at_ms: now,
        updated_at_ms: now,
        completed_at_ms: is_session_transport.then_some(now),
        error: None,
    });
    conversation.identity = Some(DesktopBridgeIdentitySnapshot {
        bridge_host_id: request.host_id.clone(),
        local_human_id,
        local_human_name,
        local_agent_id: active_agent.map(|agent| agent.id.clone()),
        local_agent_name: active_agent.map(|agent| agent.label.clone()),
        local_agent_node_id: Some(host.node_id.clone()).filter(|value| !value.trim().is_empty()),
        remote_human_id: target_human_id,
        remote_human_name: target_owner_name.clone(),
        remote_human_node_id: (target_kind == "bridge-person").then(|| peer.node_id.clone()),
        remote_agent_id: target_agent_id,
        remote_agent_name: (target_kind == "bridge-agent").then_some(target_display_name),
        remote_agent_node_id: (target_kind == "bridge-agent").then(|| peer.node_id.clone()),
        remote_agent_runtime: (target_kind == "bridge-agent").then_some(peer_runtime),
    });
    conversation.updated_at_ms = now;
    let conversation_id = conversation.id.clone();
    save_conversation_store(&store)?;

    desktop_bridge_send_message_impl(manager, conversation_id, message.to_string()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    #[test]
    fn outbound_message_type_uses_ask_for_agent_like_runtimes() {
        assert_eq!(
            outbound_message_type("claude-code"),
            BRIDGE_MESSAGE_TYPE_ASK
        );
        assert_eq!(outbound_message_type("codex"), BRIDGE_MESSAGE_TYPE_ASK);
        assert_eq!(
            outbound_message_type("plain-terminal"),
            BRIDGE_MESSAGE_TYPE_RAW
        );
    }

    #[test]
    fn mailbox_payload_keeps_display_text_separate_from_agent_context() {
        let payload = serde_json::json!({
            "question": "hiu",
            "contextText": "Recent session messages:\nAlice: hello",
        });

        assert_eq!(mailbox_payload_text(&payload), "hiu");
        assert_eq!(
            mailbox_payload_agent_prompt_text(&payload),
            "Context:\nRecent session messages:\nAlice: hello\n\nRequest:\nhiu"
        );
    }

    #[test]
    fn reach_out_target_matching_does_not_treat_generic_kordi_as_remote_agent() {
        let peer = DesktopBridgePeer {
            node_id: "kd_peer".to_string(),
            display_name: Some("Shenzhehere's Kordi".to_string()),
            runtime: DEFAULT_BRIDGE_RUNTIME.to_string(),
            endpoint: "http://127.0.0.1:17080".to_string(),
            owner_name: Some("Shenzhehere".to_string()),
            created_at: None,
            shared_projects: Vec::new(),
            human_id: Some("kh_peer".to_string()),
            agent_id: Some("ka_peer".to_string()),
            is_default_agent: true,
            discovery_mode: None,
        };

        assert!(!outreach_target_matches(&peer, "Kordi"));
        assert!(outreach_target_matches(&peer, "Shenzhehere's Kordi"));
        assert!(outreach_target_matches(&peer, "Shenzhehere"));
        assert!(outreach_target_matches(&peer, "ka_peer"));
    }

    #[test]
    fn parse_mailbox_event_decodes_valid_payload() {
        let payload = serde_json::json!({
            "messageType": BRIDGE_MESSAGE_TYPE_RESPONSE,
            "requestId": "req-1",
            "projectId": "proj-1",
            "payload": { "message": "hello" },
        });
        let blob = base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_vec(&payload).expect("serialize payload"));
        let item = serde_json::json!({
            "from": "kd_peer",
            "blob": blob,
        });

        let host = DesktopBridgeHostConfig {
            id: "host-1".to_string(),
            coordination: "http://127.0.0.1:17080".to_string(),
            node_id: "kd_self".to_string(),
            api_key: "secret".to_string(),
            display_name: Some("Self".to_string()),
            owner: Some("Owner".to_string()),
            human_id: Some("kh_self".to_string()),
            discovery_mode: "open".to_string(),
            active_agent_id: None,
            agents: Vec::new(),
            api_style: API_STYLE_SERVE.to_string(),
        };
        let event = parse_mailbox_event(&host, &item).expect("parse mailbox event");

        assert_eq!(event.from_node_id, "kd_peer");
        assert_eq!(event.message_type, BRIDGE_MESSAGE_TYPE_RESPONSE);
        assert_eq!(event.request_id.as_deref(), Some("req-1"));
        assert_eq!(event.project_id.as_deref(), Some("proj-1"));
        assert_eq!(mailbox_payload_text(&event.payload), "hello");
    }
}
