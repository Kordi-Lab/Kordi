use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

mod conversations;
mod local_server;
mod network;
mod storage;

use conversations::*;
use local_server::*;
use network::*;
use storage::*;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct LegacyBridgeClientConfig {
    coordination: String,
    #[serde(rename = "nodeId")]
    node_id: String,
    #[serde(rename = "apiKey")]
    api_key: String,
    #[serde(
        rename = "displayName",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    owner: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct DesktopBridgeStore {
    #[serde(
        rename = "activeHostId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    active_host_id: Option<String>,
    #[serde(default)]
    hosts: Vec<DesktopBridgeHostConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct DesktopBridgeSecretsStore {
    #[serde(rename = "hostApiKeys", default)]
    host_api_keys: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DesktopBridgeHostConfig {
    id: String,
    coordination: String,
    #[serde(rename = "nodeId")]
    node_id: String,
    #[serde(rename = "apiKey", default, skip_serializing)]
    api_key: String,
    #[serde(
        rename = "displayName",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    owner: Option<String>,
    #[serde(default = "default_bridge_api_style")]
    api_style: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct DesktopBridgeConversationStore {
    #[serde(default)]
    conversations: Vec<DesktopBridgeConversationRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DesktopBridgeConversationRecord {
    id: String,
    host_id: String,
    peer_node_id: String,
    peer_display_name: Option<String>,
    peer_owner_name: Option<String>,
    peer_runtime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_name: Option<String>,
    unread_count: usize,
    updated_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    peer_last_typing_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    peer_last_heartbeat_at_ms: Option<i64>,
    #[serde(default)]
    messages: Vec<DesktopBridgeConversationMessageRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DesktopBridgeConversationMessageRecord {
    id: String,
    direction: String,
    sender: Option<String>,
    text: String,
    timestamp_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    delivery_state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DesktopBridgeIdentity {
    public_key: String,
    secret_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBridgePeer {
    pub node_id: String,
    pub display_name: Option<String>,
    pub runtime: String,
    pub endpoint: String,
    pub owner_name: Option<String>,
    pub created_at: Option<String>,
    pub shared_projects: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBridgeProject {
    pub id: String,
    pub name: String,
    pub member_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBridgeHost {
    pub id: String,
    pub registered: bool,
    pub connected: bool,
    pub server_url: String,
    pub node_id: Option<String>,
    pub display_name: String,
    pub owner_name: String,
    pub endpoint: String,
    pub token_present: bool,
    pub visible_peers: Vec<DesktopBridgePeer>,
    pub visible_peer_count: usize,
    pub projects: Vec<DesktopBridgeProject>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBridgeConversationMessage {
    pub id: String,
    pub direction: String,
    pub sender: Option<String>,
    pub text: String,
    pub time_label: String,
    pub timestamp_ms: i64,
    pub delivery_state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBridgeConversation {
    pub id: String,
    pub host_id: String,
    pub peer_node_id: String,
    pub peer_display_name: Option<String>,
    pub peer_owner_name: Option<String>,
    pub peer_runtime: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub title: String,
    pub subtitle: String,
    pub unread_count: usize,
    pub updated_at_ms: i64,
    pub updated_at_label: String,
    pub awaiting_reply: bool,
    pub peer_typing: bool,
    pub peer_last_heartbeat_label: Option<String>,
    pub messages: Vec<DesktopBridgeConversationMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBridgeLocalServerStatus {
    pub running: bool,
    pub server_url: Option<String>,
    pub port: Option<u16>,
    pub db_path: Option<String>,
    pub launcher: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBridgeState {
    pub config_path: String,
    pub legacy_config_path: String,
    pub conversations_path: String,
    pub active_host_id: Option<String>,
    pub hosts: Vec<DesktopBridgeHost>,
    pub conversations: Vec<DesktopBridgeConversation>,
    pub local_server: DesktopBridgeLocalServerStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBridgeInvite {
    pub host_id: String,
    pub project_id: String,
    pub invite_id: String,
    pub invite_token: String,
    pub share_text: String,
}

#[derive(Default)]
pub struct DesktopBridgeManager {
    local_server: tokio::sync::Mutex<LocalBridgeServerRuntime>,
}

async fn health_check(base_url: &str) -> Result<(), String> {
    let url = format!("{}/health", base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|err| format!("Unable to reach bridge server: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Bridge server health check failed: HTTP {}",
            response.status()
        ));
    }
    Ok(())
}

async fn build_bridge_host_state(
    config: &DesktopBridgeHostConfig,
    local_server: &DesktopBridgeLocalServerStatus,
) -> DesktopBridgeHost {
    let mut last_error = None;
    let connected = match health_check(&config.coordination).await {
        Ok(()) => true,
        Err(err) => {
            last_error = Some(err);
            false
        }
    };

    let (visible_peers, projects) = if connected && !config.api_key.trim().is_empty() {
        if config.api_style == "registry" {
            match fetch_registry_visible_nodes(&config.coordination, &config.api_key).await {
                Ok(nodes) => (nodes, Vec::new()),
                Err(err) => {
                    last_error = Some(err);
                    (Vec::new(), Vec::new())
                }
            }
        } else {
            let mut nodes =
                if local_server.server_url.as_deref() == Some(config.coordination.as_str()) {
                    if let Some(db_path) = &local_server.db_path {
                        match fetch_local_registered_nodes(db_path, &config.node_id) {
                            Ok(nodes) => nodes,
                            Err(err) => {
                                last_error = Some(err);
                                Vec::new()
                            }
                        }
                    } else {
                        Vec::new()
                    }
                } else {
                    Vec::new()
                };
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
        visible_peer_count: visible_peers.len(),
        visible_peers,
        projects,
        last_error,
    }
}

async fn build_bridge_state(
    store: DesktopBridgeStore,
    conversation_store: DesktopBridgeConversationStore,
    local_server: DesktopBridgeLocalServerStatus,
) -> DesktopBridgeState {
    let mut store = store;
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

    let mut conversations: Vec<DesktopBridgeConversation> = conversation_store
        .conversations
        .iter()
        .map(|record| {
            let mut record = record.clone();
            if let Some(peer) =
                peer_index.get(&(record.host_id.clone(), record.peer_node_id.clone()))
            {
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
            .unwrap_or_else(|_| "~/.korde/desktop-bridges.json".to_string()),
        legacy_config_path: legacy_bridge_config_path()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| "~/.korde/config.json".to_string()),
        conversations_path: desktop_bridge_conversations_path()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| "~/.korde/desktop-bridge-conversations.json".to_string()),
        active_host_id: store.active_host_id,
        hosts,
        conversations,
        local_server,
    }
}

async fn build_current_bridge_state(manager: &DesktopBridgeManager) -> DesktopBridgeState {
    let store = load_bridge_store();
    let conversations = load_conversation_store();
    let local_server = current_local_server_status(manager).await;
    build_bridge_state(store, conversations, local_server).await
}

#[tauri::command]
pub async fn desktop_bridge_state(
    manager: State<'_, DesktopBridgeManager>,
) -> Result<DesktopBridgeState, String> {
    Ok(build_current_bridge_state(&manager).await)
}

#[tauri::command]
pub async fn desktop_save_bridge_host(
    manager: State<'_, DesktopBridgeManager>,
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
        let (api_style, node_id, api_key) = if existing.api_style == "registry"
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
        current_local_server_status(&manager).await,
    )
    .await)
}

#[tauri::command]
pub async fn desktop_remove_bridge_host(
    manager: State<'_, DesktopBridgeManager>,
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
        current_local_server_status(&manager).await,
    )
    .await)
}

#[tauri::command]
pub async fn desktop_set_active_bridge_host(
    manager: State<'_, DesktopBridgeManager>,
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
        current_local_server_status(&manager).await,
    )
    .await)
}

#[tauri::command]
pub async fn desktop_bridge_start_local_server(
    manager: State<'_, DesktopBridgeManager>,
    port: Option<u16>,
    display_name: Option<String>,
    owner_name: Option<String>,
) -> Result<DesktopBridgeState, String> {
    let port = port.unwrap_or(17080);
    let status = start_local_server(&manager, port).await?;
    let server_url = status
        .server_url
        .clone()
        .ok_or_else(|| "Local bridge server URL is unavailable".to_string())?;

    let state =
        desktop_save_bridge_host(manager, None, server_url, display_name, owner_name).await?;
    Ok(state)
}

#[tauri::command]
pub async fn desktop_bridge_stop_local_server(
    manager: State<'_, DesktopBridgeManager>,
) -> Result<DesktopBridgeState, String> {
    let _ = stop_local_server(&manager).await?;
    Ok(build_current_bridge_state(&manager).await)
}

#[tauri::command]
pub async fn desktop_bridge_create_project(
    manager: State<'_, DesktopBridgeManager>,
    host_id: String,
    slug: String,
    display_name: Option<String>,
    description: Option<String>,
) -> Result<DesktopBridgeState, String> {
    let slug = slug.trim();
    if slug.is_empty() {
        return Err("Project slug cannot be empty".to_string());
    }
    let store = load_bridge_store();
    let host = store
        .hosts
        .iter()
        .find(|host| host.id == host_id)
        .cloned()
        .ok_or_else(|| "Bridge host not found".to_string())?;
    if host.api_style != "serve" {
        return Err(
            "Project creation is currently supported on self-hosted Bridges serve hosts only"
                .to_string(),
        );
    }
    let _ = create_serve_project(
        &host.coordination,
        &host.api_key,
        slug,
        display_name.as_deref(),
        description.as_deref(),
    )
    .await?;
    Ok(build_current_bridge_state(&manager).await)
}

#[tauri::command]
pub async fn desktop_bridge_create_invite(
    manager: State<'_, DesktopBridgeManager>,
    host_id: String,
    project_id: String,
    max_uses: Option<i64>,
) -> Result<DesktopBridgeInvite, String> {
    let store = load_bridge_store();
    let host = store
        .hosts
        .iter()
        .find(|host| host.id == host_id)
        .cloned()
        .ok_or_else(|| "Bridge host not found".to_string())?;
    if host.api_style != "serve" {
        return Err(
            "Project invites are currently supported on self-hosted Bridges serve hosts only"
                .to_string(),
        );
    }
    let invite =
        create_serve_invite(&host.coordination, &host.api_key, &project_id, max_uses).await?;
    let share_text = format!(
        "Join my bridge project:\nHost: {}\nProject: {}\nInvite token: {}",
        host.coordination, invite.project_id, invite.invite_token
    );
    let _ = current_local_server_status(&manager).await;
    Ok(DesktopBridgeInvite {
        host_id,
        project_id: invite.project_id,
        invite_id: invite.invite_id,
        invite_token: invite.invite_token,
        share_text,
    })
}

#[tauri::command]
pub async fn desktop_bridge_join_project(
    manager: State<'_, DesktopBridgeManager>,
    host_id: String,
    project_id: String,
    invite_token: String,
    agent_role: Option<String>,
) -> Result<DesktopBridgeState, String> {
    let store = load_bridge_store();
    let host = store
        .hosts
        .iter()
        .find(|host| host.id == host_id)
        .cloned()
        .ok_or_else(|| "Bridge host not found".to_string())?;
    if host.api_style != "serve" {
        return Err(
            "Project joins are currently supported on self-hosted Bridges serve hosts only"
                .to_string(),
        );
    }
    join_serve_project(
        &host.coordination,
        &host.api_key,
        &project_id,
        invite_token.trim(),
        agent_role.as_deref(),
    )
    .await?;
    Ok(build_current_bridge_state(&manager).await)
}

#[tauri::command]
pub async fn desktop_bridge_open_conversation(
    manager: State<'_, DesktopBridgeManager>,
    host_id: String,
    peer_node_id: String,
    peer_display_name: Option<String>,
    peer_owner_name: Option<String>,
    peer_runtime: Option<String>,
    project_id: Option<String>,
    project_name: Option<String>,
) -> Result<DesktopBridgeState, String> {
    let mut store = load_conversation_store();
    let conversation = upsert_bridge_conversation(
        &mut store,
        &host_id,
        &peer_node_id,
        peer_display_name,
        peer_owner_name,
        peer_runtime.unwrap_or_else(|| "bridge-node".to_string()),
        project_id,
        project_name,
    );
    conversation.unread_count = 0;
    save_conversation_store(&store)?;
    Ok(build_current_bridge_state(&manager).await)
}

#[tauri::command]
pub async fn desktop_bridge_mark_conversation_read(
    manager: State<'_, DesktopBridgeManager>,
    conversation_id: String,
) -> Result<DesktopBridgeState, String> {
    let mut store = load_conversation_store();
    if let Some(conversation) = store
        .conversations
        .iter_mut()
        .find(|conversation| conversation.id == conversation_id)
    {
        conversation.unread_count = 0;
        save_conversation_store(&store)?;
    }
    Ok(build_current_bridge_state(&manager).await)
}

#[tauri::command]
pub async fn desktop_bridge_send_presence(
    manager: State<'_, DesktopBridgeManager>,
    conversation_id: String,
    kind: String,
) -> Result<DesktopBridgeState, String> {
    let presence_kind = kind.trim().to_lowercase();
    if presence_kind != "typing" && presence_kind != "heartbeat" {
        return Err("Unsupported bridge presence event".to_string());
    }

    let store = load_bridge_store();
    let conversations = load_conversation_store();
    let conversation = conversations
        .conversations
        .iter()
        .find(|conversation| conversation.id == conversation_id)
        .cloned()
        .ok_or_else(|| "Bridge conversation not found".to_string())?;
    let host = store
        .hosts
        .iter()
        .find(|host| host.id == conversation.host_id)
        .cloned()
        .ok_or_else(|| "Bridge host not found".to_string())?;

    let payload = serde_json::json!({
        "from": host.node_id,
        "projectId": conversation.project_id,
        "messageType": presence_kind,
        "payload": { "at": now_ms() },
    });
    relay_plaintext_message(
        &host.coordination,
        &host.api_key,
        &conversation.peer_node_id,
        conversation.project_id.as_deref(),
        &payload,
    )
    .await?;
    Ok(build_bridge_state(
        store,
        conversations,
        current_local_server_status(&manager).await,
    )
    .await)
}

#[tauri::command]
pub async fn desktop_bridge_send_message(
    manager: State<'_, DesktopBridgeManager>,
    conversation_id: String,
    text: String,
) -> Result<DesktopBridgeState, String> {
    let message = text.trim();
    if message.is_empty() {
        return Err("Bridge message cannot be empty".to_string());
    }

    let store = load_bridge_store();
    let mut conversations = load_conversation_store();
    let conversation = conversations
        .conversations
        .iter()
        .find(|conversation| conversation.id == conversation_id)
        .cloned()
        .ok_or_else(|| "Bridge conversation not found".to_string())?;
    let host = store
        .hosts
        .iter()
        .find(|host| host.id == conversation.host_id)
        .cloned()
        .ok_or_else(|| "Bridge host not found".to_string())?;

    let request_id = format!("bridge_req_{}", Uuid::new_v4().simple());
    let message_type = if conversation.peer_runtime.to_lowercase().contains("agent")
        || conversation.peer_runtime.to_lowercase().contains("claude")
        || conversation.peer_runtime.to_lowercase().contains("codex")
        || conversation
            .peer_runtime
            .to_lowercase()
            .contains("openclaw")
        || conversation.peer_runtime.to_lowercase().contains("pi")
        || conversation.peer_runtime.to_lowercase().contains("bot")
    {
        "ask"
    } else {
        "raw"
    };
    let payload = if message_type == "ask" {
        serde_json::json!({
            "from": host.node_id,
            "projectId": conversation.project_id,
            "messageType": "ask",
            "requestId": request_id,
            "payload": { "question": message },
        })
    } else {
        serde_json::json!({
            "from": host.node_id,
            "projectId": conversation.project_id,
            "messageType": "raw",
            "requestId": request_id,
            "payload": { "message": message },
        })
    };

    relay_plaintext_message(
        &host.coordination,
        &host.api_key,
        &conversation.peer_node_id,
        conversation.project_id.as_deref(),
        &payload,
    )
    .await?;

    append_conversation_message(
        &mut conversations,
        &conversation.host_id,
        &conversation.peer_node_id,
        conversation.peer_display_name.clone(),
        conversation.peer_owner_name.clone(),
        conversation.peer_runtime.clone(),
        conversation.project_id.clone(),
        conversation.project_name.clone(),
        "outbound",
        Some(
            host.display_name
                .clone()
                .unwrap_or_else(default_display_name),
        ),
        message.to_string(),
        Some(request_id),
        Some("sent".to_string()),
        false,
    );
    if let Some(record) = conversations
        .conversations
        .iter_mut()
        .find(|record| record.id == conversation_id)
    {
        record.unread_count = 0;
    }
    save_conversation_store(&conversations)?;
    Ok(build_bridge_state(
        store,
        conversations,
        current_local_server_status(&manager).await,
    )
    .await)
}

#[tauri::command]
pub async fn desktop_bridge_poll_mailbox(
    manager: State<'_, DesktopBridgeManager>,
) -> Result<DesktopBridgeState, String> {
    let store = load_bridge_store();
    let mut conversations = load_conversation_store();

    for host in &store.hosts {
        if host.api_key.trim().is_empty() {
            continue;
        }
        let mailbox = match fetch_mailbox(&host.coordination, &host.api_key).await {
            Ok(mailbox) => mailbox,
            Err(_) => continue,
        };
        if mailbox.is_empty() {
            continue;
        }

        for item in mailbox {
            let from_node_id = item
                .get("from")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let blob = item
                .get("blob")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if from_node_id.is_empty() || blob.trim().is_empty() {
                continue;
            }
            let Some(parsed) = parse_mailbox_payload(blob) else {
                continue;
            };
            let message_type = parsed
                .get("messageType")
                .and_then(|value| value.as_str())
                .unwrap_or("raw");
            let payload = parsed
                .get("payload")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let request_id = parsed
                .get("requestId")
                .and_then(|value| value.as_str())
                .map(ToString::to_string);
            let parsed_project_id = parsed
                .get("projectId")
                .and_then(|value| value.as_str())
                .map(ToString::to_string);

            if message_type == "delivery_event" {
                if let Some(target_request_id) =
                    payload.get("requestId").and_then(|value| value.as_str())
                {
                    let state = payload
                        .get("state")
                        .and_then(|value| value.as_str())
                        .unwrap_or("delivered");
                    update_message_delivery_state(&mut conversations, target_request_id, state);
                }
                continue;
            }
            if message_type == "typing" {
                note_peer_typing(
                    &mut conversations,
                    &host.id,
                    &from_node_id,
                    parsed_project_id.clone(),
                    None,
                );
                continue;
            }
            if message_type == "heartbeat" {
                note_peer_heartbeat(
                    &mut conversations,
                    &host.id,
                    &from_node_id,
                    parsed_project_id.clone(),
                    None,
                );
                continue;
            }

            let text = payload
                .get("message")
                .and_then(|value| value.as_str())
                .or_else(|| payload.get("question").and_then(|value| value.as_str()))
                .or_else(|| payload.get("topic").and_then(|value| value.as_str()))
                .or_else(|| payload.get("content").and_then(|value| value.as_str()))
                .map(ToString::to_string)
                .unwrap_or_else(|| payload.to_string());
            if text.trim().is_empty() {
                continue;
            }

            append_conversation_message(
                &mut conversations,
                &host.id,
                &from_node_id,
                None,
                None,
                "bridge-node".to_string(),
                parsed_project_id.clone(),
                None,
                if message_type == "response" {
                    "inbound-response"
                } else {
                    "inbound"
                },
                Some(from_node_id.clone()),
                text,
                request_id.clone(),
                None,
                true,
            );

            if message_type == "response" {
                if let Some(request_id) = request_id.as_deref() {
                    update_message_delivery_state(&mut conversations, request_id, "responded");
                }
            } else if let Some(request_id) = request_id.as_deref() {
                let ack = serde_json::json!({
                    "from": host.node_id,
                    "messageType": "delivery_event",
                    "payload": { "requestId": request_id, "state": "delivered" },
                });
                let _ = relay_plaintext_message(
                    &host.coordination,
                    &host.api_key,
                    &from_node_id,
                    parsed.get("projectId").and_then(|value| value.as_str()),
                    &ack,
                )
                .await;
            }
        }
    }

    save_conversation_store(&conversations)?;
    Ok(build_bridge_state(
        store,
        conversations,
        current_local_server_status(&manager).await,
    )
    .await)
}

#[cfg(test)]

mod tests {
    use super::*;

    #[test]
    fn bridge_store_serialization_redacts_api_keys() {
        let store = DesktopBridgeStore {
            active_host_id: Some("host-1".to_string()),
            hosts: vec![DesktopBridgeHostConfig {
                id: "host-1".to_string(),
                coordination: "https://bridge.example.com".to_string(),
                node_id: "node-1".to_string(),
                api_key: "secret-host-key".to_string(),
                display_name: Some("Kordi".to_string()),
                owner: Some("User".to_string()),
                api_style: "serve".to_string(),
            }],
        };

        let serialized = serde_json::to_value(&store).expect("serialize store");
        let host = serialized["hosts"]
            .as_array()
            .and_then(|hosts| hosts.first())
            .expect("host entry");

        assert!(host.get("apiKey").is_none());
    }

    #[test]
    fn hydrate_bridge_store_secrets_restores_redacted_config() {
        let mut store = DesktopBridgeStore {
            active_host_id: Some("host-1".to_string()),
            hosts: vec![DesktopBridgeHostConfig {
                id: "host-1".to_string(),
                coordination: "https://bridge.example.com".to_string(),
                node_id: "node-1".to_string(),
                api_key: String::new(),
                display_name: Some("Kordi".to_string()),
                owner: Some("User".to_string()),
                api_style: "serve".to_string(),
            }],
        };
        let secrets = DesktopBridgeSecretsStore {
            host_api_keys: std::collections::HashMap::from([(
                "host-1".to_string(),
                "secret-host-key".to_string(),
            )]),
        };

        assert!(!hydrate_bridge_store_secrets(&mut store, &secrets));
        assert_eq!(store.hosts[0].api_key, "secret-host-key");
    }
}
