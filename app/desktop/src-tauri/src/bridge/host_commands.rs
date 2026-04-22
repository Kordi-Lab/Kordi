use super::constants::API_STYLE_REGISTRY;
use super::{
    build_bridge_state, build_current_bridge_state, current_local_server_status,
    default_display_name, default_endpoint, default_owner_name, generate_host_id, health_check,
    load_bridge_store, load_conversation_store, normalize_server_url, register_bridge_host,
    save_bridge_store, save_conversation_store, update_registered_registry_node,
    DesktopBridgeHostConfig, DesktopBridgeManager, DesktopBridgeState,
};

pub(super) async fn desktop_bridge_state_impl(
    manager: &DesktopBridgeManager,
) -> Result<DesktopBridgeState, String> {
    Ok(build_current_bridge_state(manager).await)
}

pub(super) async fn desktop_save_bridge_host_impl(
    manager: &DesktopBridgeManager,
    host_id: Option<String>,
    server_url: String,
    display_name: Option<String>,
    owner_name: Option<String>,
) -> Result<DesktopBridgeState, String> {
    let server_url = normalize_server_url(&server_url)?;
    health_check(&server_url).await?;

    let endpoint = default_endpoint();
    let display_name = display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(default_display_name);
    let owner_name = owner_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(default_owner_name);

    let mut store = load_bridge_store();
    let existing_index = host_id
        .as_deref()
        .and_then(|id| store.hosts.iter().position(|host| host.id == id))
        .or_else(|| {
            store
                .hosts
                .iter()
                .position(|host| host.coordination == server_url)
        });

    let saved_host = if let Some(index) = existing_index {
        let existing = store.hosts[index].clone();
        let (api_style, node_id, api_key) = if existing.api_style == API_STYLE_REGISTRY
            && existing.coordination == server_url
            && !existing.api_key.trim().is_empty()
            && !existing.node_id.trim().is_empty()
        {
            match update_registered_registry_node(
                &server_url,
                &existing.api_key,
                &existing.node_id,
                &display_name,
                &endpoint,
            )
            .await
            {
                Ok(()) => (
                    existing.api_style.clone(),
                    existing.node_id.clone(),
                    existing.api_key.clone(),
                ),
                Err(_) => {
                    register_bridge_host(
                        &server_url,
                        &display_name,
                        &owner_name,
                        &endpoint,
                        Some(existing.api_style.as_str()),
                        Some(existing.node_id.as_str()),
                    )
                    .await?
                }
            }
        } else {
            register_bridge_host(
                &server_url,
                &display_name,
                &owner_name,
                &endpoint,
                Some(existing.api_style.as_str()),
                Some(existing.node_id.as_str()),
            )
            .await?
        };

        let next = DesktopBridgeHostConfig {
            id: existing.id,
            coordination: server_url,
            node_id,
            api_key,
            display_name: Some(display_name),
            owner: Some(owner_name),
            api_style,
        };
        store.hosts[index] = next.clone();
        next
    } else {
        let (api_style, node_id, api_key) = register_bridge_host(
            &server_url,
            &display_name,
            &owner_name,
            &endpoint,
            None,
            None,
        )
        .await?;
        let next = DesktopBridgeHostConfig {
            id: generate_host_id(),
            coordination: server_url,
            node_id,
            api_key,
            display_name: Some(display_name),
            owner: Some(owner_name),
            api_style,
        };
        store.hosts.push(next.clone());
        next
    };

    store.active_host_id = Some(saved_host.id.clone());
    save_bridge_store(&store)?;
    Ok(build_bridge_state(
        store,
        load_conversation_store(),
        current_local_server_status(manager).await,
    )
    .await)
}

pub(super) async fn desktop_remove_bridge_host_impl(
    manager: &DesktopBridgeManager,
    host_id: String,
) -> Result<DesktopBridgeState, String> {
    let mut store = load_bridge_store();
    let original_len = store.hosts.len();
    store.hosts.retain(|host| host.id != host_id);
    if store.hosts.len() == original_len {
        return Err("Bridge host not found".to_string());
    }
    if store.active_host_id.as_deref() == Some(host_id.as_str()) {
        store.active_host_id = store.hosts.first().map(|host| host.id.clone());
    }
    save_bridge_store(&store)?;

    let mut conversations = load_conversation_store();
    conversations
        .conversations
        .retain(|conversation| conversation.host_id != host_id);
    save_conversation_store(&conversations)?;

    Ok(build_bridge_state(
        store,
        conversations,
        current_local_server_status(manager).await,
    )
    .await)
}

pub(super) async fn desktop_set_active_bridge_host_impl(
    manager: &DesktopBridgeManager,
    host_id: String,
) -> Result<DesktopBridgeState, String> {
    let mut store = load_bridge_store();
    if !store.hosts.iter().any(|host| host.id == host_id) {
        return Err("Bridge host not found".to_string());
    }
    store.active_host_id = Some(host_id);
    save_bridge_store(&store)?;
    Ok(build_bridge_state(
        store,
        load_conversation_store(),
        current_local_server_status(manager).await,
    )
    .await)
}
