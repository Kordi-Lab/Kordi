use super::constants::{
    API_STYLE_REGISTRY, DESKTOP_BRIDGE_CONFIG_FALLBACK_PATH,
    DESKTOP_BRIDGE_CONVERSATIONS_FALLBACK_PATH, LEGACY_BRIDGE_CONFIG_FALLBACK_PATH,
};
use super::{
    augment_peers_with_project_membership, build_conversation_state, build_public_bridge_agents,
    current_local_server_status, default_display_name, default_endpoint, default_owner_name,
    fetch_registry_visible_nodes, fetch_serve_contact_requests, fetch_serve_contacts,
    fetch_serve_discovery, health_check, load_bridge_store, load_conversation_store,
    sync_realtime_connections, DesktopBridgeConversation, DesktopBridgeConversationStore,
    DesktopBridgeHost, DesktopBridgeHostConfig, DesktopBridgeLocalServerStatus,
    DesktopBridgeManager, DesktopBridgePeer, DesktopBridgeProject, DesktopBridgeState,
    DesktopBridgeStore,
};
use super::{
    desktop_bridge_config_path, desktop_bridge_conversations_path, generate_human_id,
    legacy_bridge_config_path,
};

async fn build_bridge_host_state(
    config: &DesktopBridgeHostConfig,
    _local_server: &DesktopBridgeLocalServerStatus,
) -> DesktopBridgeHost {
    let mut last_error = None;
    let connected = match health_check(&config.coordination).await {
        Ok(()) => true,
        Err(err) => {
            last_error = Some(err);
            false
        }
    };

    let mut contact_requests = Vec::new();
    let (visible_peers, projects): (Vec<DesktopBridgePeer>, Vec<DesktopBridgeProject>) =
        if connected && !config.api_key.trim().is_empty() {
            if config.api_style == API_STYLE_REGISTRY {
                match fetch_registry_visible_nodes(&config.coordination, &config.api_key).await {
                    Ok(nodes) => (nodes, Vec::new()),
                    Err(err) => {
                        last_error = Some(err);
                        (Vec::new(), Vec::new())
                    }
                }
            } else {
                let mut nodes =
                    match fetch_serve_discovery(&config.coordination, &config.api_key).await {
                        Ok(nodes) => nodes,
                        Err(err) => {
                            last_error = Some(err);
                            Vec::new()
                        }
                    };
                if let Ok(requests) =
                    fetch_serve_contact_requests(&config.coordination, &config.api_key).await
                {
                    contact_requests = requests;
                }
                if let Ok(contact_nodes) =
                    fetch_serve_contacts(&config.coordination, &config.api_key).await
                {
                    let mut seen = std::collections::HashMap::new();
                    for (index, peer) in nodes.iter().enumerate() {
                        seen.insert(peer.node_id.clone(), index);
                    }
                    for peer in contact_nodes {
                        if let Some(index) = seen.get(&peer.node_id).copied() {
                            let existing = &mut nodes[index];
                            existing.is_contact = true;
                            existing.contact_request_status = Some("contact".to_string());
                            existing.contact_request_direction = None;
                            if existing.display_name.is_none() {
                                existing.display_name = peer.display_name.clone();
                            }
                            if existing.owner_name.is_none() {
                                existing.owner_name = peer.owner_name.clone();
                            }
                            if existing.human_id.is_none() {
                                existing.human_id = peer.human_id.clone();
                            }
                            if existing.agent_id.is_none() {
                                existing.agent_id = peer.agent_id.clone();
                            }
                        } else {
                            seen.insert(peer.node_id.clone(), nodes.len());
                            nodes.push(peer);
                        }
                    }
                }
                for request in &contact_requests {
                    let peer_node_id = if request.direction == "incoming" {
                        request.requester_node_id.as_str()
                    } else {
                        request.target_node_id.as_str()
                    };
                    if let Some(peer) = nodes.iter_mut().find(|peer| peer.node_id == peer_node_id) {
                        if !peer.is_contact {
                            peer.contact_request_status = Some(request.status.clone());
                            peer.contact_request_direction = Some(request.direction.clone());
                        }
                    }
                }
                match augment_peers_with_project_membership(
                    &config.coordination,
                    &config.api_key,
                    &config.node_id,
                    &mut nodes,
                )
                .await
                {
                    Ok(projects) => (nodes, projects),
                    Err(err) => {
                        last_error = Some(err);
                        (nodes, Vec::new())
                    }
                }
            }
        } else {
            (Vec::new(), Vec::new())
        };

    DesktopBridgeHost {
        id: config.id.clone(),
        registered: !config.node_id.trim().is_empty() && !config.api_key.trim().is_empty(),
        connected,
        server_url: config.coordination.clone(),
        node_id: Some(config.node_id.clone()).filter(|value| !value.trim().is_empty()),
        display_name: config
            .display_name
            .clone()
            .unwrap_or_else(default_display_name),
        owner_name: config.owner.clone().unwrap_or_else(default_owner_name),
        endpoint: default_endpoint(),
        token_present: !config.api_key.trim().is_empty(),
        human_id: config.human_id.clone().unwrap_or_else(generate_human_id),
        discovery_mode: config.discovery_mode.clone(),
        human_visibility_policy: config.human_visibility_policy.clone(),
        contact_approval_policy: config.contact_approval_policy.clone(),
        active_agent_id: config.active_agent_id.clone(),
        agents: build_public_bridge_agents(config),
        visible_peer_count: visible_peers.len(),
        visible_peers,
        projects,
        contact_requests,
        last_error,
    }
}

pub(super) async fn build_bridge_state(
    mut store: DesktopBridgeStore,
    conversation_store: DesktopBridgeConversationStore,
    local_server: DesktopBridgeLocalServerStatus,
) -> DesktopBridgeState {
    if store.active_host_id.is_none() {
        store.active_host_id = store.hosts.first().map(|host| host.id.clone());
    }

    let mut hosts = Vec::with_capacity(store.hosts.len());
    for host in &store.hosts {
        hosts.push(build_bridge_host_state(host, &local_server).await);
    }

    let mut peer_index = std::collections::HashMap::<(String, String), DesktopBridgePeer>::new();
    for host in &hosts {
        for peer in &host.visible_peers {
            peer_index.insert((host.id.clone(), peer.node_id.clone()), peer.clone());
        }
    }

    // Conversation records are created when a user explicitly opens a bridge chat
    // or when a message/outreach exists. Keep empty, unlabeled records visible so
    // manual node-id chats remain durable before the first message.
    let mut conversations: Vec<DesktopBridgeConversation> = conversation_store
        .conversations
        .iter()
        .map(|record| {
            let mut record = record.clone();
            let is_person_conversation = record.peer_runtime.trim().eq_ignore_ascii_case("person");
            if let Some(peer) =
                peer_index.get(&(record.host_id.clone(), record.peer_node_id.clone()))
            {
                if is_person_conversation {
                    if let Some(owner_name) = peer.owner_name.clone() {
                        record.peer_owner_name = Some(owner_name.clone());
                        record.peer_display_name = Some(owner_name);
                    }
                    record.peer_runtime = "person".to_string();
                } else {
                    if peer.display_name.is_some() {
                        record.peer_display_name = peer.display_name.clone();
                    }
                    if peer.owner_name.is_some() {
                        record.peer_owner_name = peer.owner_name.clone();
                    }
                    if !peer.runtime.trim().is_empty() {
                        record.peer_runtime = peer.runtime.clone();
                    }
                }
            }
            build_conversation_state(&record)
        })
        .collect();
    conversations.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));

    let active_host_id = store.active_host_id.clone();
    hosts.sort_by(|a, b| {
        let a_active = active_host_id.as_deref() == Some(a.id.as_str());
        let b_active = active_host_id.as_deref() == Some(b.id.as_str());
        b_active
            .cmp(&a_active)
            .then_with(|| a.server_url.cmp(&b.server_url))
    });

    DesktopBridgeState {
        config_path: desktop_bridge_config_path()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| DESKTOP_BRIDGE_CONFIG_FALLBACK_PATH.to_string()),
        legacy_config_path: legacy_bridge_config_path()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| LEGACY_BRIDGE_CONFIG_FALLBACK_PATH.to_string()),
        conversations_path: desktop_bridge_conversations_path()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| DESKTOP_BRIDGE_CONVERSATIONS_FALLBACK_PATH.to_string()),
        active_host_id: store.active_host_id,
        hosts,
        conversations,
        local_server,
        local_agent_routing: store.local_agent_routing,
    }
}

pub(super) fn build_conversation_only_bridge_state(
    store: DesktopBridgeStore,
    conversation_store: DesktopBridgeConversationStore,
    local_server: DesktopBridgeLocalServerStatus,
) -> DesktopBridgeState {
    let mut conversations: Vec<DesktopBridgeConversation> = conversation_store
        .conversations
        .iter()
        .map(build_conversation_state)
        .collect();
    conversations.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));

    DesktopBridgeState {
        config_path: desktop_bridge_config_path()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| DESKTOP_BRIDGE_CONFIG_FALLBACK_PATH.to_string()),
        legacy_config_path: legacy_bridge_config_path()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| LEGACY_BRIDGE_CONFIG_FALLBACK_PATH.to_string()),
        conversations_path: desktop_bridge_conversations_path()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| DESKTOP_BRIDGE_CONVERSATIONS_FALLBACK_PATH.to_string()),
        active_host_id: store.active_host_id,
        hosts: Vec::new(),
        conversations,
        local_server,
        local_agent_routing: store.local_agent_routing,
    }
}

pub(super) async fn build_current_bridge_state(
    manager: &DesktopBridgeManager,
) -> DesktopBridgeState {
    let store = load_bridge_store();
    sync_realtime_connections(manager, &store).await;
    let conversations = load_conversation_store();
    let local_server = current_local_server_status(manager).await;
    build_bridge_state(store, conversations, local_server).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::DesktopBridgeConversationRecord;

    fn empty_unlabeled_conversation() -> DesktopBridgeConversationRecord {
        DesktopBridgeConversationRecord {
            id: "bridge:host-1:node-manual".to_string(),
            host_id: "host-1".to_string(),
            peer_node_id: "node-manual".to_string(),
            peer_display_name: None,
            peer_owner_name: None,
            peer_runtime: "bridge-node".to_string(),
            project_id: None,
            project_name: None,
            unread_count: 0,
            updated_at_ms: 42,
            peer_last_typing_at_ms: None,
            peer_last_heartbeat_at_ms: None,
            outreach: None,
            identity: None,
            messages: Vec::new(),
        }
    }

    #[test]
    fn conversation_only_state_keeps_empty_unlabeled_opened_conversation() {
        let state = build_conversation_only_bridge_state(
            DesktopBridgeStore::default(),
            DesktopBridgeConversationStore {
                conversations: vec![empty_unlabeled_conversation()],
            },
            DesktopBridgeLocalServerStatus::default(),
        );

        assert_eq!(state.conversations.len(), 1);
        assert_eq!(state.conversations[0].id, "bridge:host-1:node-manual");
        assert_eq!(state.conversations[0].title, "node-manual");
    }
}
