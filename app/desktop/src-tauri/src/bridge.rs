use serde::{Deserialize, Serialize};
use tauri::State;

mod constants;
mod conversation_commands;
mod conversations;
mod host_commands;
mod local_server;
mod network;
mod project_commands;
mod server_commands;
mod storage;

use constants::*;
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
    host_commands::desktop_bridge_state_impl(&manager).await
}

#[tauri::command]
pub async fn desktop_save_bridge_host(
    manager: State<'_, DesktopBridgeManager>,
    host_id: Option<String>,
    server_url: String,
    display_name: Option<String>,
    owner_name: Option<String>,
) -> Result<DesktopBridgeState, String> {
    host_commands::desktop_save_bridge_host_impl(
        &manager,
        host_id,
        server_url,
        display_name,
        owner_name,
    )
    .await
}

#[tauri::command]
pub async fn desktop_remove_bridge_host(
    manager: State<'_, DesktopBridgeManager>,
    host_id: String,
) -> Result<DesktopBridgeState, String> {
    host_commands::desktop_remove_bridge_host_impl(&manager, host_id).await
}

#[tauri::command]
pub async fn desktop_set_active_bridge_host(
    manager: State<'_, DesktopBridgeManager>,
    host_id: String,
) -> Result<DesktopBridgeState, String> {
    host_commands::desktop_set_active_bridge_host_impl(&manager, host_id).await
}

#[tauri::command]
pub async fn desktop_bridge_start_local_server(
    manager: State<'_, DesktopBridgeManager>,
    port: Option<u16>,
    display_name: Option<String>,
    owner_name: Option<String>,
) -> Result<DesktopBridgeState, String> {
    server_commands::desktop_bridge_start_local_server_impl(
        &manager,
        port,
        display_name,
        owner_name,
    )
    .await
}

#[tauri::command]
pub async fn desktop_bridge_stop_local_server(
    manager: State<'_, DesktopBridgeManager>,
) -> Result<DesktopBridgeState, String> {
    server_commands::desktop_bridge_stop_local_server_impl(&manager).await
}

#[tauri::command]
pub async fn desktop_bridge_create_project(
    manager: State<'_, DesktopBridgeManager>,
    host_id: String,
    slug: String,
    display_name: Option<String>,
    description: Option<String>,
) -> Result<DesktopBridgeState, String> {
    project_commands::desktop_bridge_create_project_impl(
        &manager,
        host_id,
        slug,
        display_name,
        description,
    )
    .await
}

#[tauri::command]
pub async fn desktop_bridge_create_invite(
    manager: State<'_, DesktopBridgeManager>,
    host_id: String,
    project_id: String,
    max_uses: Option<i64>,
) -> Result<DesktopBridgeInvite, String> {
    project_commands::desktop_bridge_create_invite_impl(&manager, host_id, project_id, max_uses)
        .await
}

#[tauri::command]
pub async fn desktop_bridge_join_project(
    manager: State<'_, DesktopBridgeManager>,
    host_id: String,
    project_id: String,
    invite_token: String,
    agent_role: Option<String>,
) -> Result<DesktopBridgeState, String> {
    project_commands::desktop_bridge_join_project_impl(
        &manager,
        host_id,
        project_id,
        invite_token,
        agent_role,
    )
    .await
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
    conversation_commands::desktop_bridge_open_conversation_impl(
        &manager,
        host_id,
        peer_node_id,
        peer_display_name,
        peer_owner_name,
        peer_runtime,
        project_id,
        project_name,
    )
    .await
}

#[tauri::command]
pub async fn desktop_bridge_mark_conversation_read(
    manager: State<'_, DesktopBridgeManager>,
    conversation_id: String,
) -> Result<DesktopBridgeState, String> {
    conversation_commands::desktop_bridge_mark_conversation_read_impl(&manager, conversation_id)
        .await
}

#[tauri::command]
pub async fn desktop_bridge_send_presence(
    manager: State<'_, DesktopBridgeManager>,
    conversation_id: String,
    kind: String,
) -> Result<DesktopBridgeState, String> {
    conversation_commands::desktop_bridge_send_presence_impl(&manager, conversation_id, kind).await
}

#[tauri::command]
pub async fn desktop_bridge_send_message(
    manager: State<'_, DesktopBridgeManager>,
    conversation_id: String,
    text: String,
) -> Result<DesktopBridgeState, String> {
    conversation_commands::desktop_bridge_send_message_impl(&manager, conversation_id, text).await
}

#[tauri::command]
pub async fn desktop_bridge_poll_mailbox(
    manager: State<'_, DesktopBridgeManager>,
) -> Result<DesktopBridgeState, String> {
    conversation_commands::desktop_bridge_poll_mailbox_impl(&manager).await
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
                api_style: API_STYLE_SERVE.to_string(),
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
                api_style: API_STYLE_SERVE.to_string(),
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
