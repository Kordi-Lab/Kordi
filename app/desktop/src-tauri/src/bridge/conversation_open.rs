use super::constants::{is_agent_like_runtime, DEFAULT_BRIDGE_RUNTIME};
use super::{
    build_conversation_only_bridge_state, build_current_bridge_state, current_local_server_status,
    load_bridge_store, load_conversation_store, now_ms, save_conversation_store,
    upsert_bridge_conversation, DesktopBridgeHost, DesktopBridgeIdentitySnapshot,
    DesktopBridgeManager, DesktopBridgePeer, DesktopBridgeState,
};

fn identity_snapshot_for_visible_peer(
    host: &DesktopBridgeHost,
    peer: &DesktopBridgePeer,
    peer_runtime: &str,
) -> DesktopBridgeIdentitySnapshot {
    let active_agent = host
        .active_agent_id
        .as_deref()
        .and_then(|active_id| host.agents.iter().find(|agent| agent.id == active_id))
        .or_else(|| host.agents.iter().find(|agent| agent.is_default))
        .or_else(|| host.agents.first());
    let is_agent = is_agent_like_runtime(peer_runtime);
    let remote_human_name = peer
        .owner_name
        .clone()
        .or_else(|| (!is_agent).then(|| peer.display_name.clone()).flatten());
    let remote_agent_name = is_agent.then(|| {
        peer.display_name
            .clone()
            .or_else(|| peer.owner_name.clone())
            .unwrap_or_else(|| peer.node_id.clone())
    });

    DesktopBridgeIdentitySnapshot {
        bridge_host_id: host.id.clone(),
        local_human_id: host.human_id.clone(),
        local_human_name: host.owner_name.clone(),
        local_agent_id: active_agent.map(|agent| agent.id.clone()),
        local_agent_name: active_agent.map(|agent| agent.label.clone()),
        local_agent_node_id: active_agent
            .and_then(|agent| agent.node_id.clone())
            .or_else(|| host.node_id.clone()),
        remote_human_id: peer.human_id.clone(),
        remote_human_name,
        remote_human_node_id: Some(peer.node_id.clone()),
        remote_agent_id: is_agent.then(|| peer.agent_id.clone()).flatten(),
        remote_agent_name,
        remote_agent_node_id: is_agent.then(|| peer.node_id.clone()),
        remote_agent_runtime: is_agent.then(|| peer_runtime.to_string()),
    }
}

pub(super) async fn desktop_bridge_open_conversation_impl(
    manager: &DesktopBridgeManager,
    host_id: String,
    peer_node_id: String,
    peer_display_name: Option<String>,
    peer_owner_name: Option<String>,
    peer_runtime: Option<String>,
    project_id: Option<String>,
    project_name: Option<String>,
) -> Result<DesktopBridgeState, String> {
    let has_display_name = peer_display_name
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    let has_owner_name = peer_owner_name
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    let has_runtime = peer_runtime
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());

    let inferred_peer = if has_display_name && has_owner_name && has_runtime {
        None
    } else {
        let current_state = build_current_bridge_state(manager).await;
        current_state
            .hosts
            .iter()
            .find(|host| host.id == host_id)
            .and_then(|host| {
                host.visible_peers
                    .iter()
                    .find(|peer| peer.node_id == peer_node_id)
            })
            .cloned()
    };

    let resolved_peer_display_name = peer_display_name
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            inferred_peer
                .as_ref()
                .and_then(|peer| peer.display_name.clone())
        });
    let resolved_peer_owner_name = peer_owner_name
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            inferred_peer
                .as_ref()
                .and_then(|peer| peer.owner_name.clone())
        });
    let resolved_peer_runtime = peer_runtime
        .filter(|value| !value.trim().is_empty())
        .or_else(|| inferred_peer.as_ref().map(|peer| peer.runtime.clone()))
        .unwrap_or_else(|| DEFAULT_BRIDGE_RUNTIME.to_string());
    let identity_snapshot = {
        let current_state = build_current_bridge_state(manager).await;
        current_state
            .hosts
            .iter()
            .find(|host| host.id == host_id)
            .and_then(|host| {
                host.visible_peers
                    .iter()
                    .find(|peer| peer.node_id == peer_node_id)
                    .map(|peer| {
                        identity_snapshot_for_visible_peer(host, peer, &resolved_peer_runtime)
                    })
            })
    };

    let mut store = load_conversation_store();
    let conversation = upsert_bridge_conversation(
        &mut store,
        &host_id,
        &peer_node_id,
        resolved_peer_display_name,
        resolved_peer_owner_name,
        resolved_peer_runtime.clone(),
        project_id,
        project_name,
    );
    if let Some(identity_snapshot) = identity_snapshot {
        conversation.identity = Some(identity_snapshot);
    }
    conversation.unread_count = 0;
    conversation.updated_at_ms = now_ms();
    save_conversation_store(&store)?;
    Ok(build_conversation_only_bridge_state(
        load_bridge_store(),
        store,
        current_local_server_status(manager).await,
    ))
}
