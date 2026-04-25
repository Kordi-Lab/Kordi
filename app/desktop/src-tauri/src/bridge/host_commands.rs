use chrono::Local;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::constants::{API_STYLE_REGISTRY, API_STYLE_SERVE};
use super::{
    add_serve_contact, bridge_hosts_match, build_bridge_state, build_current_bridge_state,
    current_local_server_status, default_bridge_agent_label, default_bridge_agent_runtime,
    default_bridge_api_style, default_display_name, default_endpoint, default_owner_name,
    delete_bridge_host_secrets, delete_conversations_for_host, ensure_host_bootstrap,
    generate_agent_id, health_check, legacy_bridge_config_path, load_bridge_store,
    load_conversation_store, load_legacy_bridge_config, normalize_imported_bridge_host,
    normalize_server_url, parse_imported_bridge_store, register_bridge_host, remove_serve_contact,
    save_bridge_store, save_conversation_store, sync_host_active_agent_fields,
    update_registered_registry_node, update_serve_discovery_mode, write_bridge_store_export,
    DesktopBridgeAgentConfig, DesktopBridgeHostConfig, DesktopBridgeManager, DesktopBridgeState,
    DesktopBridgeStore,
};
use super::{desktop_bridge_config_path, desktop_bridge_conversations_path, korde_dir};

const SERVE_ONLY_CONTACTS_MESSAGE: &str =
    "Direct contacts are currently supported on self-hosted Bridges serve hosts only";

pub(super) async fn desktop_bridge_state_impl(
    manager: &DesktopBridgeManager,
) -> Result<DesktopBridgeState, String> {
    let state = build_current_bridge_state(manager).await;
    if let Err(error) = crate::canonical_sessions::sync_bridge_state_identities(&state) {
        eprintln!("Unable to sync bridge identities into canonical sessions: {error}");
    }
    Ok(state)
}

fn run_file_manager_command(command: &mut Command) -> Result<(), String> {
    let status = command.status().map_err(|err| err.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("File manager command failed with status {status}"))
    }
}

fn open_path_in_file_manager(path: &Path) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        return run_file_manager_command(Command::new("open").arg(path));
    }
    if cfg!(target_os = "windows") {
        return run_file_manager_command(Command::new("explorer").arg(path));
    }
    run_file_manager_command(Command::new("xdg-open").arg(path))
}

fn reveal_path_in_file_manager(path: &Path) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        return run_file_manager_command(Command::new("open").arg("-R").arg(path));
    }
    if cfg!(target_os = "windows") {
        return run_file_manager_command(
            Command::new("explorer").arg(format!("/select,{}", path.display())),
        );
    }
    let parent = path.parent().unwrap_or(path);
    run_file_manager_command(Command::new("xdg-open").arg(parent))
}

fn bridge_storage_path(kind: &str) -> Result<PathBuf, String> {
    match kind {
        "config" => desktop_bridge_config_path(),
        "conversations" => desktop_bridge_conversations_path(),
        "legacy" => legacy_bridge_config_path(),
        "folder" => korde_dir(),
        _ => Err("Unknown bridge storage target".to_string()),
    }
}

fn ensure_bridge_storage_path(kind: &str) -> Result<PathBuf, String> {
    let path = bridge_storage_path(kind)?;
    match kind {
        "config" => {
            if !path.exists() {
                save_bridge_store(&load_bridge_store())?;
            }
        }
        "conversations" => {
            if !path.exists() {
                save_conversation_store(&load_conversation_store())?;
            }
        }
        "folder" => {
            std::fs::create_dir_all(&path).map_err(|err| err.to_string())?;
        }
        "legacy" => {
            if !path.exists() {
                return Err("Legacy bridge config does not exist on this desktop.".to_string());
            }
        }
        _ => {}
    }
    Ok(path)
}

fn bridge_config_export_dir() -> Result<PathBuf, String> {
    let home =
        std::env::var("HOME").map_err(|_| "Unable to determine home directory".to_string())?;
    let downloads = PathBuf::from(&home).join("Downloads");
    if downloads.exists() {
        return Ok(downloads);
    }
    let desktop = PathBuf::from(&home).join("Desktop");
    if desktop.exists() {
        return Ok(desktop);
    }
    korde_dir()
}

fn normalize_discovery_mode(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_lowercase();
    if matches!(normalized.as_str(), "off" | "contacts" | "open") {
        Ok(normalized)
    } else {
        Err("Discovery mode must be off, contacts, or open".to_string())
    }
}

async fn sync_registered_agent(
    host: &mut DesktopBridgeHostConfig,
    agent_index: usize,
) -> Result<(), String> {
    if agent_index >= host.agents.len() {
        return Err("Bridge agent not found".to_string());
    }

    let agent = host.agents[agent_index].clone();
    if host.api_style == API_STYLE_REGISTRY {
        let is_active = host.active_agent_id.as_deref() == Some(agent.id.as_str());
        if is_active && !host.api_key.trim().is_empty() && !host.node_id.trim().is_empty() {
            update_registered_registry_node(
                &host.coordination,
                &host.api_key,
                &host.node_id,
                &agent.label,
                &default_endpoint(),
            )
            .await?;
        }
        return Ok(());
    }

    let (api_style, node_id, api_key) = register_bridge_host(
        &host.coordination,
        &agent.label,
        host.owner.as_deref().unwrap_or("Kordi User"),
        &default_endpoint(),
        &agent.runtime,
        host.human_id.as_deref(),
        Some(agent.id.as_str()),
        Some(host.discovery_mode.as_str()),
        agent.is_default,
        Some(host.api_style.as_str()),
        Some(agent.node_id.as_str()),
    )
    .await?;
    host.api_style = api_style;
    host.agents[agent_index].node_id = node_id;
    host.agents[agent_index].api_key = api_key;
    Ok(())
}

fn require_host<'a>(
    store: &'a DesktopBridgeStore,
    host_id: &str,
) -> Result<&'a DesktopBridgeHostConfig, String> {
    store
        .hosts
        .iter()
        .find(|host| host.id == host_id)
        .ok_or_else(|| "Bridge host not found".to_string())
}

fn require_serve_host<'a>(
    store: &'a DesktopBridgeStore,
    host_id: &str,
    unsupported_message: &str,
) -> Result<&'a DesktopBridgeHostConfig, String> {
    let host = require_host(store, host_id)?;
    if host.api_style != API_STYLE_SERVE {
        return Err(unsupported_message.to_string());
    }
    Ok(host)
}

pub(super) async fn desktop_bridge_open_config_folder_impl() -> Result<String, String> {
    let path = ensure_bridge_storage_path("folder")?;
    open_path_in_file_manager(&path)?;
    Ok(path.display().to_string())
}

pub(super) async fn desktop_bridge_reveal_storage_file_impl(
    kind: String,
) -> Result<String, String> {
    let path = ensure_bridge_storage_path(&kind)?;
    reveal_path_in_file_manager(&path)?;
    Ok(path.display().to_string())
}

pub(super) async fn desktop_bridge_export_hosts_config_impl() -> Result<String, String> {
    let store = load_bridge_store();
    let export_dir = bridge_config_export_dir()?;
    std::fs::create_dir_all(&export_dir).map_err(|err| err.to_string())?;
    let export_path = export_dir.join(format!(
        "kordi-bridge-hosts-{}.json",
        Local::now().format("%Y%m%d-%H%M%S")
    ));
    write_bridge_store_export(&export_path, &store)?;
    reveal_path_in_file_manager(&export_path)?;
    Ok(export_path.display().to_string())
}

pub(super) async fn desktop_bridge_import_hosts_config_impl(
    manager: &DesktopBridgeManager,
    raw: String,
) -> Result<DesktopBridgeState, String> {
    let imported = parse_imported_bridge_store(&raw)?;
    if imported.hosts.is_empty() {
        return Err("Imported bridge config did not contain any hosts.".to_string());
    }

    let mut store = load_bridge_store();
    let normalized_hosts: Vec<DesktopBridgeHostConfig> = imported
        .hosts
        .into_iter()
        .map(normalize_imported_bridge_host)
        .collect();

    for imported_host in &normalized_hosts {
        if let Some(index) = store
            .hosts
            .iter()
            .position(|existing| bridge_hosts_match(existing, imported_host))
        {
            store.hosts[index] = imported_host.clone();
        } else {
            store.hosts.push(imported_host.clone());
        }
    }

    let imported_active_host_id = imported
        .active_host_id
        .as_deref()
        .and_then(|active_id| normalized_hosts.iter().find(|host| host.id == active_id))
        .map(|host| host.id.clone())
        .or_else(|| normalized_hosts.first().map(|host| host.id.clone()));

    if imported_active_host_id.is_some() {
        store.active_host_id = imported_active_host_id;
    } else if store.active_host_id.is_none() {
        store.active_host_id = store.hosts.first().map(|host| host.id.clone());
    }

    save_bridge_store(&store)?;
    Ok(build_bridge_state(
        store,
        load_conversation_store(),
        current_local_server_status(manager).await,
    )
    .await)
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

    let existing = existing_index
        .and_then(|index| store.hosts.get(index))
        .cloned();
    let mut next = ensure_host_bootstrap(existing.as_ref(), &display_name, &owner_name);
    next.coordination = server_url.clone();
    next.owner = Some(owner_name.clone());
    next.api_style = existing
        .as_ref()
        .map(|host| host.api_style.clone())
        .unwrap_or_else(default_bridge_api_style);

    let active_agent_index = next
        .active_agent_id
        .as_deref()
        .and_then(|active_id| next.agents.iter().position(|agent| agent.id == active_id))
        .or_else(|| next.agents.iter().position(|agent| agent.is_default))
        .unwrap_or(0);
    next.agents[active_agent_index].label = if next.agents[active_agent_index].is_default {
        default_bridge_agent_label(&owner_name)
    } else {
        display_name.clone()
    };
    let agent = next.agents[active_agent_index].clone();

    let (api_style, node_id, api_key) = if next.api_style == API_STYLE_REGISTRY
        && next.coordination == server_url
        && !next.api_key.trim().is_empty()
        && !next.node_id.trim().is_empty()
    {
        match update_registered_registry_node(
            &server_url,
            &next.api_key,
            &next.node_id,
            &display_name,
            &endpoint,
        )
        .await
        {
            Ok(()) => (
                next.api_style.clone(),
                next.node_id.clone(),
                next.api_key.clone(),
            ),
            Err(_) => {
                register_bridge_host(
                    &server_url,
                    &agent.label,
                    &owner_name,
                    &endpoint,
                    &agent.runtime,
                    next.human_id.as_deref(),
                    Some(agent.id.as_str()),
                    Some(next.discovery_mode.as_str()),
                    agent.is_default,
                    Some(next.api_style.as_str()),
                    Some(next.node_id.as_str()),
                )
                .await?
            }
        }
    } else {
        register_bridge_host(
            &server_url,
            &agent.label,
            &owner_name,
            &endpoint,
            &agent.runtime,
            next.human_id.as_deref(),
            Some(agent.id.as_str()),
            Some(next.discovery_mode.as_str()),
            agent.is_default,
            Some(next.api_style.as_str()),
            Some(next.node_id.as_str()),
        )
        .await?
    };

    next.api_style = api_style;
    next.node_id = node_id.clone();
    next.api_key = api_key.clone();
    next.display_name = Some(display_name);
    next.agents[active_agent_index].node_id = node_id;
    next.agents[active_agent_index].api_key = api_key;
    sync_host_active_agent_fields(&mut next);

    if let Some(index) = existing_index {
        store.hosts[index] = next.clone();
    } else {
        store.hosts.push(next.clone());
    }

    store.active_host_id = Some(next.id.clone());
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
    let removed_host = store.hosts.iter().find(|host| host.id == host_id).cloned();
    store.hosts.retain(|host| host.id != host_id);
    if store.hosts.len() == original_len {
        return Err("Bridge host not found".to_string());
    }
    if store.active_host_id.as_deref() == Some(host_id.as_str()) {
        store.active_host_id = store.hosts.first().map(|host| host.id.clone());
    }
    save_bridge_store(&store)?;

    if let Some(removed_host) = removed_host {
        let _ = delete_bridge_host_secrets(&removed_host);
        if let Some(legacy) = load_legacy_bridge_config() {
            let matches_legacy = legacy.coordination == removed_host.coordination
                || (!removed_host.node_id.trim().is_empty()
                    && legacy.node_id == removed_host.node_id)
                || (!removed_host.api_key.trim().is_empty()
                    && legacy.api_key == removed_host.api_key);
            if matches_legacy {
                if let Ok(path) = legacy_bridge_config_path() {
                    match std::fs::remove_file(path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error.to_string()),
                    }
                }
            }
        }
    }

    delete_conversations_for_host(&host_id)?;
    let conversations = load_conversation_store();

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

pub(super) async fn desktop_bridge_set_discovery_mode_impl(
    manager: &DesktopBridgeManager,
    host_id: String,
    discovery_mode: String,
) -> Result<DesktopBridgeState, String> {
    let normalized = normalize_discovery_mode(&discovery_mode)?;
    let mut store = load_bridge_store();
    let host = store
        .hosts
        .iter_mut()
        .find(|host| host.id == host_id)
        .ok_or_else(|| "Bridge host not found".to_string())?;

    if host.api_style == API_STYLE_SERVE {
        for agent in &host.agents {
            if agent.api_key.trim().is_empty() {
                continue;
            }
            update_serve_discovery_mode(&host.coordination, &agent.api_key, &normalized).await?;
        }
    }

    host.discovery_mode = normalized;
    sync_host_active_agent_fields(host);
    save_bridge_store(&store)?;
    Ok(build_bridge_state(
        store,
        load_conversation_store(),
        current_local_server_status(manager).await,
    )
    .await)
}

pub(super) async fn desktop_bridge_create_agent_impl(
    manager: &DesktopBridgeManager,
    host_id: String,
    label: Option<String>,
    runtime: Option<String>,
) -> Result<DesktopBridgeState, String> {
    let mut store = load_bridge_store();
    let host = store
        .hosts
        .iter_mut()
        .find(|host| host.id == host_id)
        .ok_or_else(|| "Bridge host not found".to_string())?;

    let agent_label = label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            format!(
                "{} Agent {}",
                host.owner.clone().unwrap_or_else(default_owner_name),
                host.agents.len() + 1
            )
        });
    let agent_runtime = runtime
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(default_bridge_agent_runtime);

    let agent_id = generate_agent_id();
    let (api_style, node_id, api_key) = register_bridge_host(
        &host.coordination,
        &agent_label,
        host.owner.as_deref().unwrap_or("Kordi User"),
        &default_endpoint(),
        &agent_runtime,
        host.human_id.as_deref(),
        Some(agent_id.as_str()),
        Some(host.discovery_mode.as_str()),
        false,
        Some(host.api_style.as_str()),
        None,
    )
    .await?;

    host.api_style = api_style;
    host.agents.push(DesktopBridgeAgentConfig {
        id: agent_id.clone(),
        label: agent_label,
        node_id,
        api_key,
        runtime: agent_runtime,
        is_default: false,
    });
    host.active_agent_id = Some(agent_id);
    sync_host_active_agent_fields(host);
    save_bridge_store(&store)?;
    Ok(build_bridge_state(
        store,
        load_conversation_store(),
        current_local_server_status(manager).await,
    )
    .await)
}

pub(super) async fn desktop_bridge_activate_agent_impl(
    manager: &DesktopBridgeManager,
    host_id: String,
    agent_id: String,
) -> Result<DesktopBridgeState, String> {
    let mut store = load_bridge_store();
    let host = store
        .hosts
        .iter_mut()
        .find(|host| host.id == host_id)
        .ok_or_else(|| "Bridge host not found".to_string())?;
    let agent_index = host
        .agents
        .iter()
        .position(|agent| agent.id == agent_id)
        .ok_or_else(|| "Bridge agent not found".to_string())?;

    let needs_registration = host.agents[agent_index].node_id.trim().is_empty()
        || host.agents[agent_index].api_key.trim().is_empty();
    if needs_registration {
        sync_registered_agent(host, agent_index).await?;
    }

    host.active_agent_id = Some(agent_id);
    sync_registered_agent(host, agent_index).await?;
    sync_host_active_agent_fields(host);
    save_bridge_store(&store)?;
    Ok(build_bridge_state(
        store,
        load_conversation_store(),
        current_local_server_status(manager).await,
    )
    .await)
}

pub(super) async fn desktop_bridge_rename_agent_impl(
    manager: &DesktopBridgeManager,
    host_id: String,
    agent_id: String,
    label: String,
) -> Result<DesktopBridgeState, String> {
    let next_label = label.trim();
    if next_label.is_empty() {
        return Err("Bridge agent name cannot be empty".to_string());
    }

    let mut store = load_bridge_store();
    let host = store
        .hosts
        .iter_mut()
        .find(|host| host.id == host_id)
        .ok_or_else(|| "Bridge host not found".to_string())?;
    let agent_index = host
        .agents
        .iter()
        .position(|agent| agent.id == agent_id)
        .ok_or_else(|| "Bridge agent not found".to_string())?;

    host.agents[agent_index].label = next_label.to_string();
    sync_registered_agent(host, agent_index).await?;
    sync_host_active_agent_fields(host);
    save_bridge_store(&store)?;
    Ok(build_bridge_state(
        store,
        load_conversation_store(),
        current_local_server_status(manager).await,
    )
    .await)
}

pub(super) async fn desktop_bridge_set_default_agent_impl(
    manager: &DesktopBridgeManager,
    host_id: String,
    agent_id: String,
) -> Result<DesktopBridgeState, String> {
    let mut store = load_bridge_store();
    let host = store
        .hosts
        .iter_mut()
        .find(|host| host.id == host_id)
        .ok_or_else(|| "Bridge host not found".to_string())?;
    let target_index = host
        .agents
        .iter()
        .position(|agent| agent.id == agent_id)
        .ok_or_else(|| "Bridge agent not found".to_string())?;

    let previous_default_index = host.agents.iter().position(|agent| agent.is_default);
    for (index, agent) in host.agents.iter_mut().enumerate() {
        agent.is_default = index == target_index;
    }
    host.active_agent_id = Some(agent_id);

    if let Some(index) = previous_default_index.filter(|index| *index != target_index) {
        sync_registered_agent(host, index).await?;
    }
    sync_registered_agent(host, target_index).await?;
    sync_host_active_agent_fields(host);
    save_bridge_store(&store)?;
    Ok(build_bridge_state(
        store,
        load_conversation_store(),
        current_local_server_status(manager).await,
    )
    .await)
}

pub(super) async fn desktop_bridge_add_contact_impl(
    manager: &DesktopBridgeManager,
    host_id: String,
    peer_node_id: String,
) -> Result<DesktopBridgeState, String> {
    let peer_node_id = peer_node_id.trim();
    if peer_node_id.is_empty() {
        return Err("Contact node ID cannot be empty".to_string());
    }
    let store = load_bridge_store();
    let host = require_serve_host(&store, &host_id, SERVE_ONLY_CONTACTS_MESSAGE)?;
    add_serve_contact(&host.coordination, &host.api_key, peer_node_id).await?;
    Ok(build_current_bridge_state(manager).await)
}

pub(super) async fn desktop_bridge_remove_contact_impl(
    manager: &DesktopBridgeManager,
    host_id: String,
    peer_node_id: String,
) -> Result<DesktopBridgeState, String> {
    let peer_node_id = peer_node_id.trim();
    if peer_node_id.is_empty() {
        return Err("Contact node ID cannot be empty".to_string());
    }
    let store = load_bridge_store();
    let host = require_serve_host(&store, &host_id, SERVE_ONLY_CONTACTS_MESSAGE)?;
    remove_serve_contact(&host.coordination, &host.api_key, peer_node_id).await?;
    Ok(build_current_bridge_state(manager).await)
}
