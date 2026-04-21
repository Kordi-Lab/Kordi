use base64::Engine as _;
use chrono::{Local, TimeZone};
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;
use uuid::Uuid;

use crate::workspace;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct LegacyBridgeClientConfig {
    coordination: String,
    #[serde(rename = "nodeId")]
    node_id: String,
    #[serde(rename = "apiKey")]
    api_key: String,
    #[serde(rename = "displayName", default, skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    owner: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct DesktopBridgeStore {
    #[serde(rename = "activeHostId", default, skip_serializing_if = "Option::is_none")]
    active_host_id: Option<String>,
    #[serde(default)]
    hosts: Vec<DesktopBridgeHostConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DesktopBridgeHostConfig {
    id: String,
    coordination: String,
    #[serde(rename = "nodeId")]
    node_id: String,
    #[serde(rename = "apiKey")]
    api_key: String,
    #[serde(rename = "displayName", default, skip_serializing_if = "Option::is_none")]
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

#[derive(Default)]
struct LocalBridgeServerRuntime {
    child: Option<Child>,
    status: DesktopBridgeLocalServerStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryRegisterResponse {
    token: String,
    node_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServeRegisterResponse {
    api_key: String,
    node_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeListItem {
    node_id: String,
    display_name: Option<String>,
    runtime: String,
    endpoint: String,
    owner_name: Option<String>,
    created_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServeProjectItem {
    project_id: String,
    slug: String,
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServeProjectMemberItem {
    node_id: String,
    agent_role: Option<String>,
    display_name: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServeCreateProjectResponse {
    project_id: String,
    slug: String,
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServeCreateInviteResponse {
    invite_id: String,
    invite_token: String,
    project_id: String,
}

fn default_bridge_api_style() -> String {
    "registry".to_string()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn format_time_label(timestamp_ms: i64) -> String {
    Local
        .timestamp_millis_opt(timestamp_ms)
        .single()
        .map(|value| value.format("%H:%M").to_string())
        .unwrap_or_else(|| "--:--".to_string())
}

fn format_time_label_with_seconds(timestamp_ms: i64) -> String {
    Local
        .timestamp_millis_opt(timestamp_ms)
        .single()
        .map(|value| value.format("%H:%M:%S").to_string())
        .unwrap_or_else(|| "--:--:--".to_string())
}

fn korde_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "Unable to determine home directory".to_string())?;
    Ok(PathBuf::from(home).join(".korde"))
}

fn desktop_bridge_config_path() -> Result<PathBuf, String> {
    Ok(korde_dir()?.join("desktop-bridges.json"))
}

fn desktop_bridge_conversations_path() -> Result<PathBuf, String> {
    Ok(korde_dir()?.join("desktop-bridge-conversations.json"))
}

fn legacy_bridge_config_path() -> Result<PathBuf, String> {
    Ok(korde_dir()?.join("config.json"))
}

fn desktop_bridge_identity_path() -> Result<PathBuf, String> {
    Ok(korde_dir()?.join("desktop-bridge-identity.json"))
}

fn hosted_bridge_dir() -> Result<PathBuf, String> {
    Ok(korde_dir()?.join("hosted-bridge"))
}

fn load_legacy_bridge_config() -> Option<LegacyBridgeClientConfig> {
    let path = legacy_bridge_config_path().ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn load_json_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn load_desktop_bridge_store() -> Option<DesktopBridgeStore> {
    let path = desktop_bridge_config_path().ok()?;
    load_json_file(&path)
}

fn load_bridge_store() -> DesktopBridgeStore {
    if let Some(store) = load_desktop_bridge_store() {
        return store;
    }

    if let Some(legacy) = load_legacy_bridge_config() {
        let host = DesktopBridgeHostConfig {
            id: format!("bridge_{}", Uuid::new_v4().simple()),
            coordination: legacy.coordination,
            node_id: legacy.node_id,
            api_key: legacy.api_key,
            display_name: legacy.display_name,
            owner: legacy.owner,
            api_style: default_bridge_api_style(),
        };
        return DesktopBridgeStore {
            active_host_id: Some(host.id.clone()),
            hosts: vec![host],
        };
    }

    DesktopBridgeStore::default()
}

fn save_bridge_store(store: &DesktopBridgeStore) -> Result<(), String> {
    let path = desktop_bridge_config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let raw = serde_json::to_string_pretty(store).map_err(|err| err.to_string())?;
    std::fs::write(path, raw).map_err(|err| err.to_string())
}

fn load_conversation_store() -> DesktopBridgeConversationStore {
    let Some(path) = desktop_bridge_conversations_path().ok() else {
        return DesktopBridgeConversationStore::default();
    };
    load_json_file(&path).unwrap_or_default()
}

fn save_conversation_store(store: &DesktopBridgeConversationStore) -> Result<(), String> {
    let path = desktop_bridge_conversations_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let raw = serde_json::to_string_pretty(store).map_err(|err| err.to_string())?;
    std::fs::write(path, raw).map_err(|err| err.to_string())
}

fn normalize_server_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Bridge server URL cannot be empty".to_string());
    }
    let parsed = reqwest::Url::parse(trimmed).map_err(|err| format!("Invalid bridge server URL: {err}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(trimmed.to_string()),
        _ => Err("Bridge server URL must use http or https".to_string()),
    }
}

fn default_display_name() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!("Kordi on {value}"))
        .unwrap_or_else(|| "Kordi Desktop".to_string())
}

fn default_owner_name() -> String {
    std::env::var("USER")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Kordi User".to_string())
}

fn default_endpoint() -> String {
    "http://127.0.0.1:39221/kordi-desktop".to_string()
}

fn generate_registry_node_id() -> String {
    let raw = Uuid::new_v4().simple().to_string();
    format!("kd_{}", &raw[..12])
}

fn generate_host_id() -> String {
    format!("bridge_{}", Uuid::new_v4().simple())
}

fn bridge_conversation_id(host_id: &str, peer_node_id: &str, project_id: Option<&str>) -> String {
    match project_id.filter(|value| !value.trim().is_empty()) {
        Some(project_id) => format!("bridge:{host_id}:{peer_node_id}:{project_id}"),
        None => format!("bridge:{host_id}:{peer_node_id}"),
    }
}

fn derive_node_id(public_key: &VerifyingKey) -> String {
    let mut hasher = Sha256::new();
    hasher.update(public_key.as_bytes());
    let hash = hasher.finalize();
    format!("kd_{}", bs58::encode(&hash[..20]).into_string())
}

fn ed25519_to_x25519_public(ed_pub: &[u8; 32]) -> Result<[u8; 32], String> {
    let point = curve25519_dalek::edwards::CompressedEdwardsY(*ed_pub)
        .decompress()
        .ok_or_else(|| "invalid Ed25519 public key".to_string())?;
    Ok(point.to_montgomery().to_bytes())
}

fn load_or_create_bridge_identity() -> Result<(SigningKey, VerifyingKey), String> {
    let path = desktop_bridge_identity_path()?;
    if let Some(existing) = load_json_file::<DesktopBridgeIdentity>(&path) {
        let secret = bs58::decode(existing.secret_key)
            .into_vec()
            .map_err(|err| err.to_string())?;
        let secret_bytes: [u8; 32] = secret
            .try_into()
            .map_err(|bytes: Vec<u8>| format!("Invalid bridge identity secret key length: {}", bytes.len()))?;
        let signing = SigningKey::from_bytes(&secret_bytes);
        let verifying = signing.verifying_key();
        return Ok((signing, verifying));
    }

    let signing = SigningKey::generate(&mut OsRng);
    let verifying = signing.verifying_key();
    let stored = DesktopBridgeIdentity {
        public_key: bs58::encode(verifying.as_bytes()).into_string(),
        secret_key: bs58::encode(signing.to_bytes()).into_string(),
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let raw = serde_json::to_string_pretty(&stored).map_err(|err| err.to_string())?;
    std::fs::write(path, raw).map_err(|err| err.to_string())?;
    Ok((signing, verifying))
}

async fn health_check(base_url: &str) -> Result<(), String> {
    let url = format!("{}/health", base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|err| format!("Unable to reach bridge server: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("Bridge server health check failed: HTTP {}", response.status()));
    }
    Ok(())
}

async fn register_node_registry(
    base_url: &str,
    node_id: &str,
    display_name: &str,
    owner_name: &str,
    endpoint: &str,
) -> Result<(String, String, String), String> {
    let url = format!("{}/auth/register", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "nodeId": node_id,
        "displayName": display_name,
        "runtime": "kordi-desktop",
        "endpoint": endpoint,
        "ownerName": owner_name,
    });
    let response = reqwest::Client::new()
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("Unable to register bridge node: {err}"))?;
    if response.status().is_success() {
        let registered = response
            .json::<RegistryRegisterResponse>()
            .await
            .map_err(|err| format!("Unable to parse bridge registration response: {err}"))?;
        return Ok(("registry".to_string(), registered.node_id, registered.token));
    }
    Err(format!("Bridge registry registration HTTP {}", response.status()))
}

async fn register_node_serve(
    base_url: &str,
    display_name: &str,
    owner_name: &str,
) -> Result<(String, String, String), String> {
    let url = format!("{}/v1/auth/register", base_url.trim_end_matches('/'));
    let (_signing, verifying) = load_or_create_bridge_identity()?;
    let node_id = derive_node_id(&verifying);
    let x25519_pub = ed25519_to_x25519_public(verifying.as_bytes())?;
    let body = serde_json::json!({
        "nodeId": node_id,
        "ed25519Pubkey": bs58::encode(verifying.as_bytes()).into_string(),
        "x25519Pubkey": hex::encode(x25519_pub),
        "displayName": display_name,
        "ownerName": owner_name,
    });
    let response = reqwest::Client::new()
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("Unable to register bridge node: {err}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let error_body = response.text().await.unwrap_or_default();
        return Err(if error_body.trim().is_empty() {
            format!("Bridge serve registration HTTP {status}")
        } else {
            format!("Bridge serve registration failed: {error_body}")
        });
    }
    let registered = response
        .json::<ServeRegisterResponse>()
        .await
        .map_err(|err| format!("Unable to parse bridge registration response: {err}"))?;
    Ok(("serve".to_string(), registered.node_id, registered.api_key))
}

async fn register_bridge_host(
    base_url: &str,
    display_name: &str,
    owner_name: &str,
    endpoint: &str,
    existing_api_style: Option<&str>,
    existing_node_id: Option<&str>,
) -> Result<(String, String, String), String> {
    if matches!(existing_api_style, Some("serve")) {
        return register_node_serve(base_url, display_name, owner_name).await;
    }
    if matches!(existing_api_style, Some("registry")) {
        return register_node_registry(
            base_url,
            existing_node_id.unwrap_or(&generate_registry_node_id()),
            display_name,
            owner_name,
            endpoint,
        ).await;
    }

    let registry_node_id = existing_node_id
        .map(ToString::to_string)
        .unwrap_or_else(generate_registry_node_id);
    if let Ok(result) = register_node_registry(base_url, &registry_node_id, display_name, owner_name, endpoint).await {
        return Ok(result);
    }
    register_node_serve(base_url, display_name, owner_name).await
}

async fn update_registered_registry_node(
    base_url: &str,
    api_key: &str,
    node_id: &str,
    display_name: &str,
    endpoint: &str,
) -> Result<(), String> {
    let url = format!("{}/nodes/{}", base_url.trim_end_matches('/'), node_id);
    let body = serde_json::json!({
        "displayName": display_name,
        "runtime": "kordi-desktop",
        "endpoint": endpoint,
    });
    let response = reqwest::Client::new()
        .patch(url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("Unable to update bridge node: {err}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let error_body = response.text().await.unwrap_or_default();
        return Err(if error_body.trim().is_empty() {
            format!("Unable to update bridge node: HTTP {status}")
        } else {
            format!("Unable to update bridge node: {error_body}")
        });
    }
    Ok(())
}

async fn fetch_serve_projects(base_url: &str, api_key: &str) -> Result<Vec<ServeProjectItem>, String> {
    let url = format!("{}/v1/projects", base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .get(url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|err| format!("Unable to list bridge projects: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("Unable to list bridge projects: HTTP {}", response.status()));
    }
    response
        .json::<Vec<ServeProjectItem>>()
        .await
        .map_err(|err| format!("Unable to parse bridge projects: {err}"))
}

async fn fetch_serve_project_members(base_url: &str, api_key: &str, project_id: &str) -> Result<Vec<ServeProjectMemberItem>, String> {
    let url = format!("{}/v1/projects/{}/members", base_url.trim_end_matches('/'), project_id);
    let response = reqwest::Client::new()
        .get(url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|err| format!("Unable to list bridge project members: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("Unable to list bridge project members: HTTP {}", response.status()));
    }
    response
        .json::<Vec<ServeProjectMemberItem>>()
        .await
        .map_err(|err| format!("Unable to parse bridge project members: {err}"))
}

async fn fetch_registry_visible_nodes(base_url: &str, api_key: &str) -> Result<Vec<DesktopBridgePeer>, String> {
    let url = format!("{}/nodes", base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .get(url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|err| format!("Unable to list visible bridge nodes: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("Unable to list visible bridge nodes: HTTP {}", response.status()));
    }
    let mut nodes = response
        .json::<Vec<NodeListItem>>()
        .await
        .map_err(|err| format!("Unable to parse bridge node list: {err}"))?;
    nodes.sort_by(|a, b| {
        a.display_name
            .as_deref()
            .unwrap_or(a.node_id.as_str())
            .cmp(b.display_name.as_deref().unwrap_or(b.node_id.as_str()))
    });
    Ok(nodes
        .into_iter()
        .map(|node| DesktopBridgePeer {
            node_id: node.node_id,
            display_name: node.display_name,
            runtime: node.runtime,
            endpoint: node.endpoint,
            owner_name: node.owner_name,
            created_at: node.created_at,
            shared_projects: Vec::new(),
        })
        .collect())
}

fn fetch_local_registered_nodes(db_path: &str, own_node_id: &str) -> Result<Vec<DesktopBridgePeer>, String> {
    let conn = Connection::open(db_path).map_err(|err| format!("Unable to open local bridge database: {err}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT node_id, display_name, owner_name, created_at FROM registered_nodes WHERE revoked_at IS NULL ORDER BY created_at DESC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(DesktopBridgePeer {
                node_id: row.get(0)?,
                display_name: row.get(1)?,
                runtime: "bridge-node".to_string(),
                endpoint: String::new(),
                owner_name: row.get(2)?,
                created_at: row.get(3)?,
                shared_projects: Vec::new(),
            })
        })
        .map_err(|err| err.to_string())?;

    let mut peers = Vec::new();
    for row in rows {
        let peer = row.map_err(|err| err.to_string())?;
        if peer.node_id != own_node_id {
            peers.push(peer);
        }
    }
    Ok(peers)
}

async fn augment_peers_with_project_membership(
    base_url: &str,
    api_key: &str,
    own_node_id: &str,
    peers: &mut Vec<DesktopBridgePeer>,
) -> Result<Vec<DesktopBridgeProject>, String> {
    let projects = fetch_serve_projects(base_url, api_key).await?;
    let mut host_projects = Vec::new();
    let mut index = std::collections::HashMap::<String, usize>::new();
    for (idx, peer) in peers.iter().enumerate() {
        index.insert(peer.node_id.clone(), idx);
    }

    for project in projects {
        let project_name = project.display_name.clone().unwrap_or(project.slug);
        let members = fetch_serve_project_members(base_url, api_key, &project.project_id).await?;
        host_projects.push(DesktopBridgeProject {
            id: project.project_id.clone(),
            name: project_name.clone(),
            member_count: members.len(),
        });
        for member in members {
            if member.node_id == own_node_id {
                continue;
            }
            let idx = if let Some(existing) = index.get(&member.node_id).copied() {
                existing
            } else {
                peers.push(DesktopBridgePeer {
                    node_id: member.node_id.clone(),
                    display_name: member.display_name.clone(),
                    runtime: member.agent_role.clone().unwrap_or_else(|| "project-member".to_string()),
                    endpoint: String::new(),
                    owner_name: None,
                    created_at: None,
                    shared_projects: Vec::new(),
                });
                let idx = peers.len() - 1;
                index.insert(member.node_id.clone(), idx);
                idx
            };

            let peer = &mut peers[idx];
            if peer.display_name.is_none() {
                peer.display_name = member.display_name.clone();
            }
            if !peer.shared_projects.iter().any(|name| name == &project_name) {
                peer.shared_projects.push(project_name.clone());
                peer.shared_projects.sort();
            }
        }
    }

    host_projects.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(host_projects)
}

async fn create_serve_project(
    base_url: &str,
    api_key: &str,
    slug: &str,
    display_name: Option<&str>,
    description: Option<&str>,
) -> Result<ServeCreateProjectResponse, String> {
    let url = format!("{}/v1/projects", base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(api_key)
        .json(&serde_json::json!({
            "slug": slug,
            "displayName": display_name,
            "description": description,
        }))
        .send()
        .await
        .map_err(|err| format!("Unable to create bridge project: {err}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(if body.trim().is_empty() {
            format!("Unable to create bridge project: HTTP {status}")
        } else {
            format!("Unable to create bridge project: {body}")
        });
    }
    response.json::<ServeCreateProjectResponse>().await.map_err(|err| format!("Unable to parse bridge project response: {err}"))
}

async fn create_serve_invite(
    base_url: &str,
    api_key: &str,
    project_id: &str,
    max_uses: Option<i64>,
) -> Result<ServeCreateInviteResponse, String> {
    let url = format!("{}/v1/projects/{}/invites", base_url.trim_end_matches('/'), project_id);
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(api_key)
        .json(&serde_json::json!({ "maxUses": max_uses }))
        .send()
        .await
        .map_err(|err| format!("Unable to create bridge invite: {err}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(if body.trim().is_empty() {
            format!("Unable to create bridge invite: HTTP {status}")
        } else {
            format!("Unable to create bridge invite: {body}")
        });
    }
    response.json::<ServeCreateInviteResponse>().await.map_err(|err| format!("Unable to parse bridge invite response: {err}"))
}

async fn join_serve_project(
    base_url: &str,
    api_key: &str,
    project_id: &str,
    invite_token: &str,
    agent_role: Option<&str>,
) -> Result<(), String> {
    let url = format!("{}/v1/projects/{}/join", base_url.trim_end_matches('/'), project_id);
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(api_key)
        .json(&serde_json::json!({ "inviteToken": invite_token, "agentRole": agent_role }))
        .send()
        .await
        .map_err(|err| format!("Unable to join bridge project: {err}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(if body.trim().is_empty() {
            format!("Unable to join bridge project: HTTP {status}")
        } else {
            format!("Unable to join bridge project: {body}")
        });
    }
    Ok(())
}

async fn fetch_mailbox(base_url: &str, api_key: &str) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("{}/v1/mailbox", base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|err| format!("Unable to fetch bridge mailbox: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("Unable to fetch bridge mailbox: HTTP {}", response.status()));
    }
    response
        .json::<Vec<serde_json::Value>>()
        .await
        .map_err(|err| format!("Unable to parse bridge mailbox: {err}"))
}

async fn relay_plaintext_message(
    base_url: &str,
    api_key: &str,
    target_node_id: &str,
    project_id: Option<&str>,
    payload: &serde_json::Value,
) -> Result<(), String> {
    let blob = base64::engine::general_purpose::STANDARD.encode(
        serde_json::to_vec(payload).map_err(|err| err.to_string())?,
    );
    let url = format!("{}/v1/relay", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "targetNodeId": target_node_id,
        "blob": blob,
        "projectId": project_id,
    });
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("Unable to relay bridge message: {err}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let error_body = response.text().await.unwrap_or_default();
        return Err(if error_body.trim().is_empty() {
            format!("Unable to relay bridge message: HTTP {status}")
        } else {
            format!("Unable to relay bridge message: {error_body}")
        });
    }
    Ok(())
}

fn upsert_bridge_conversation<'a>(
    store: &'a mut DesktopBridgeConversationStore,
    host_id: &str,
    peer_node_id: &str,
    peer_display_name: Option<String>,
    peer_owner_name: Option<String>,
    peer_runtime: String,
    project_id: Option<String>,
    project_name: Option<String>,
) -> &'a mut DesktopBridgeConversationRecord {
    let conversation_id = bridge_conversation_id(host_id, peer_node_id, project_id.as_deref());
    let maybe_index = store
        .conversations
        .iter()
        .position(|conversation| conversation.id == conversation_id);
    let index = if let Some(index) = maybe_index {
        index
    } else {
        store.conversations.push(DesktopBridgeConversationRecord {
            id: conversation_id,
            host_id: host_id.to_string(),
            peer_node_id: peer_node_id.to_string(),
            peer_display_name: peer_display_name.clone(),
            peer_owner_name: peer_owner_name.clone(),
            peer_runtime: peer_runtime.clone(),
            project_id: project_id.clone(),
            project_name: project_name.clone(),
            unread_count: 0,
            updated_at_ms: now_ms(),
            peer_last_typing_at_ms: None,
            peer_last_heartbeat_at_ms: None,
            messages: Vec::new(),
        });
        store.conversations.len() - 1
    };

    let conversation = &mut store.conversations[index];
    if peer_display_name.is_some() {
        conversation.peer_display_name = peer_display_name;
    }
    if peer_owner_name.is_some() {
        conversation.peer_owner_name = peer_owner_name;
    }
    if !peer_runtime.trim().is_empty() {
        conversation.peer_runtime = peer_runtime;
    }
    if project_id.is_some() {
        conversation.project_id = project_id;
    }
    if project_name.is_some() {
        conversation.project_name = project_name;
    }
    conversation
}

fn append_conversation_message(
    store: &mut DesktopBridgeConversationStore,
    host_id: &str,
    peer_node_id: &str,
    peer_display_name: Option<String>,
    peer_owner_name: Option<String>,
    peer_runtime: String,
    project_id: Option<String>,
    project_name: Option<String>,
    direction: &str,
    sender: Option<String>,
    text: String,
    request_id: Option<String>,
    delivery_state: Option<String>,
    increment_unread: bool,
) {
    let timestamp_ms = now_ms();
    let conversation = upsert_bridge_conversation(
        store,
        host_id,
        peer_node_id,
        peer_display_name,
        peer_owner_name,
        peer_runtime,
        project_id,
        project_name,
    );
    conversation.updated_at_ms = timestamp_ms;
    if direction == "inbound" || direction == "inbound-response" {
        conversation.peer_last_typing_at_ms = None;
    }
    if increment_unread {
        conversation.unread_count += 1;
    }
    conversation.messages.push(DesktopBridgeConversationMessageRecord {
        id: format!("bridge_msg_{}", Uuid::new_v4().simple()),
        direction: direction.to_string(),
        sender,
        text,
        timestamp_ms,
        request_id,
        delivery_state,
    });
}

fn update_message_delivery_state(
    store: &mut DesktopBridgeConversationStore,
    request_id: &str,
    delivery_state: &str,
) {
    for conversation in &mut store.conversations {
        if let Some(message) = conversation
            .messages
            .iter_mut()
            .find(|message| message.request_id.as_deref() == Some(request_id))
        {
            message.delivery_state = Some(delivery_state.to_string());
            conversation.updated_at_ms = now_ms();
            break;
        }
    }
}

fn note_peer_typing(store: &mut DesktopBridgeConversationStore, host_id: &str, peer_node_id: &str, project_id: Option<String>, project_name: Option<String>) {
    let conversation = upsert_bridge_conversation(
        store,
        host_id,
        peer_node_id,
        None,
        None,
        "bridge-node".to_string(),
        project_id,
        project_name,
    );
    conversation.peer_last_typing_at_ms = Some(now_ms());
}

fn note_peer_heartbeat(store: &mut DesktopBridgeConversationStore, host_id: &str, peer_node_id: &str, project_id: Option<String>, project_name: Option<String>) {
    let conversation = upsert_bridge_conversation(
        store,
        host_id,
        peer_node_id,
        None,
        None,
        "bridge-node".to_string(),
        project_id,
        project_name,
    );
    conversation.peer_last_heartbeat_at_ms = Some(now_ms());
}

fn parse_mailbox_payload(blob: &str) -> Option<serde_json::Value> {
    let decoded = base64::engine::general_purpose::STANDARD.decode(blob).ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn conversation_title(record: &DesktopBridgeConversationRecord) -> String {
    record
        .peer_display_name
        .clone()
        .or_else(|| record.peer_owner_name.clone())
        .unwrap_or_else(|| record.peer_node_id.clone())
}

fn build_conversation_state(record: &DesktopBridgeConversationRecord) -> DesktopBridgeConversation {
    let messages: Vec<DesktopBridgeConversationMessage> = record
        .messages
        .iter()
        .map(|message| DesktopBridgeConversationMessage {
            id: message.id.clone(),
            direction: message.direction.clone(),
            sender: message.sender.clone(),
            text: message.text.clone(),
            time_label: format_time_label(message.timestamp_ms),
            timestamp_ms: message.timestamp_ms,
            delivery_state: message.delivery_state.clone(),
        })
        .collect();
    let subtitle = messages.last().map(|message| message.text.clone()).unwrap_or_default();
    let awaiting_reply = record
        .messages
        .iter()
        .rev()
        .find(|message| message.direction == "outbound")
        .and_then(|message| message.delivery_state.clone())
        .map(|state| state != "responded")
        .unwrap_or(false);
    let peer_typing = record
        .peer_last_typing_at_ms
        .map(|timestamp| now_ms().saturating_sub(timestamp) <= 6000)
        .unwrap_or(false);
    let peer_last_heartbeat_label = record.peer_last_heartbeat_at_ms.map(format_time_label_with_seconds);
    DesktopBridgeConversation {
        id: record.id.clone(),
        host_id: record.host_id.clone(),
        peer_node_id: record.peer_node_id.clone(),
        peer_display_name: record.peer_display_name.clone(),
        peer_owner_name: record.peer_owner_name.clone(),
        peer_runtime: record.peer_runtime.clone(),
        project_id: record.project_id.clone(),
        project_name: record.project_name.clone(),
        title: conversation_title(record),
        subtitle,
        unread_count: record.unread_count,
        updated_at_ms: record.updated_at_ms,
        updated_at_label: format_time_label(record.updated_at_ms),
        awaiting_reply,
        peer_typing,
        peer_last_heartbeat_label,
        messages,
    }
}

fn app_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should always have a parent directory")
        .to_path_buf()
}

fn determine_bridge_launcher() -> (Option<String>, Option<PathBuf>, Option<PathBuf>) {
    let workspace_status = workspace::desktop_workspace_status();
    let binary = PathBuf::from(&workspace_status.bridges.expected_binary_path);
    if workspace_status.bridges.binary_exists {
        return (
            Some(binary.display().to_string()),
            Some(binary),
            Some(PathBuf::from(&workspace_status.bridges.repo_path)),
        );
    }

    let repo_path = PathBuf::from(&workspace_status.bridges.repo_path);
    let manifest = repo_path.join("cli").join("Cargo.toml");
    if repo_path.exists() && manifest.exists() {
        return (
            Some(format!("cargo run --manifest-path {} -- serve", manifest.display())),
            None,
            Some(repo_path),
        );
    }

    (None, None, None)
}

async fn refresh_local_server_runtime(runtime: &mut LocalBridgeServerRuntime) {
    let mut clear_child = false;
    if let Some(child) = runtime.child.as_mut() {
        match child.try_wait() {
            Ok(Some(status)) => {
                runtime.status.running = false;
                runtime.status.last_error = Some(format!("Local bridge server exited: {status}"));
                clear_child = true;
            }
            Ok(None) => {
                runtime.status.running = true;
            }
            Err(err) => {
                runtime.status.running = false;
                runtime.status.last_error = Some(format!("Unable to inspect local bridge server: {err}"));
                clear_child = true;
            }
        }
    }
    if clear_child {
        runtime.child = None;
    }
}

async fn current_local_server_status(manager: &DesktopBridgeManager) -> DesktopBridgeLocalServerStatus {
    let mut runtime = manager.local_server.lock().await;
    refresh_local_server_runtime(&mut runtime).await;
    runtime.status.clone()
}

async fn start_local_server(
    manager: &DesktopBridgeManager,
    port: u16,
) -> Result<DesktopBridgeLocalServerStatus, String> {
    let mut runtime = manager.local_server.lock().await;
    refresh_local_server_runtime(&mut runtime).await;
    if runtime.status.running {
        return Ok(runtime.status.clone());
    }

    let (launcher_label, binary_path, repo_path) = determine_bridge_launcher();
    let Some(launcher) = launcher_label else {
        return Err("Unable to find a local Bridges binary or repo to launch".to_string());
    };

    let data_dir = hosted_bridge_dir()?.join(format!("port-{port}"));
    std::fs::create_dir_all(&data_dir).map_err(|err| err.to_string())?;
    let db_path = data_dir.join("bridges-server.db");
    let log_path = data_dir.join("bridges-server.log");
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|err| err.to_string())?;
    let log_file_err = log_file.try_clone().map_err(|err| err.to_string())?;

    let mut command = if let Some(binary_path) = binary_path {
        let mut command = Command::new(binary_path);
        command.arg("serve");
        command
    } else {
        let manifest = repo_path
            .ok_or_else(|| "Unable to determine Bridges repo path".to_string())?
            .join("cli")
            .join("Cargo.toml");
        let mut command = Command::new("cargo");
        command.arg("run").arg("--manifest-path").arg(manifest).arg("--").arg("serve");
        command
    };
    command
        .arg("--port")
        .arg(port.to_string())
        .arg("--db")
        .arg(&db_path)
        .current_dir(app_root())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err));

    let child = command.spawn().map_err(|err| format!("Unable to start local bridge server: {err}"))?;
    runtime.child = Some(child);
    runtime.status = DesktopBridgeLocalServerStatus {
        running: true,
        server_url: Some(format!("http://127.0.0.1:{port}")),
        port: Some(port),
        db_path: Some(db_path.display().to_string()),
        launcher: Some(launcher),
        last_error: None,
    };
    drop(runtime);

    tokio::time::sleep(Duration::from_millis(900)).await;
    let status = current_local_server_status(manager).await;
    if let Some(url) = &status.server_url {
        health_check(url).await?;
    }
    Ok(status)
}

async fn stop_local_server(manager: &DesktopBridgeManager) -> Result<DesktopBridgeLocalServerStatus, String> {
    let mut runtime = manager.local_server.lock().await;
    if let Some(mut child) = runtime.child.take() {
        child.kill().map_err(|err| format!("Unable to stop local bridge server: {err}"))?;
        let _ = child.wait();
    }
    runtime.status.running = false;
    runtime.status.last_error = None;
    Ok(runtime.status.clone())
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
            let mut nodes = if local_server.server_url.as_deref() == Some(config.coordination.as_str()) {
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
            match augment_peers_with_project_membership(&config.coordination, &config.api_key, &config.node_id, &mut nodes).await {
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
        display_name: config.display_name.clone().unwrap_or_else(default_display_name),
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
            if let Some(peer) = peer_index.get(&(record.host_id.clone(), record.peer_node_id.clone())) {
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
pub async fn desktop_bridge_state(manager: State<'_, DesktopBridgeManager>) -> Result<DesktopBridgeState, String> {
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
        .or_else(|| store.hosts.iter().position(|host| host.coordination == server_url));

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
                Ok(()) => (existing.api_style.clone(), existing.node_id.clone(), existing.api_key.clone()),
                Err(_) => register_bridge_host(
                    &server_url,
                    &display_name,
                    &owner_name,
                    &endpoint,
                    Some(existing.api_style.as_str()),
                    Some(existing.node_id.as_str()),
                )
                .await?,
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
        let (api_style, node_id, api_key) = register_bridge_host(&server_url, &display_name, &owner_name, &endpoint, None, None).await?;
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
    Ok(build_bridge_state(store, load_conversation_store(), current_local_server_status(&manager).await).await)
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
    conversations.conversations.retain(|conversation| conversation.host_id != host_id);
    save_conversation_store(&conversations)?;

    Ok(build_bridge_state(store, conversations, current_local_server_status(&manager).await).await)
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
    Ok(build_bridge_state(store, load_conversation_store(), current_local_server_status(&manager).await).await)
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

    let state = desktop_save_bridge_host(
        manager,
        None,
        server_url,
        display_name,
        owner_name,
    )
    .await?;
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
    let host = store.hosts.iter().find(|host| host.id == host_id).cloned().ok_or_else(|| "Bridge host not found".to_string())?;
    if host.api_style != "serve" {
        return Err("Project creation is currently supported on self-hosted Bridges serve hosts only".to_string());
    }
    let _ = create_serve_project(&host.coordination, &host.api_key, slug, display_name.as_deref(), description.as_deref()).await?;
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
    let host = store.hosts.iter().find(|host| host.id == host_id).cloned().ok_or_else(|| "Bridge host not found".to_string())?;
    if host.api_style != "serve" {
        return Err("Project invites are currently supported on self-hosted Bridges serve hosts only".to_string());
    }
    let invite = create_serve_invite(&host.coordination, &host.api_key, &project_id, max_uses).await?;
    let share_text = format!("Join my bridge project:\nHost: {}\nProject: {}\nInvite token: {}", host.coordination, invite.project_id, invite.invite_token);
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
    let host = store.hosts.iter().find(|host| host.id == host_id).cloned().ok_or_else(|| "Bridge host not found".to_string())?;
    if host.api_style != "serve" {
        return Err("Project joins are currently supported on self-hosted Bridges serve hosts only".to_string());
    }
    join_serve_project(&host.coordination, &host.api_key, &project_id, invite_token.trim(), agent_role.as_deref()).await?;
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
    if let Some(conversation) = store.conversations.iter_mut().find(|conversation| conversation.id == conversation_id) {
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
    relay_plaintext_message(&host.coordination, &host.api_key, &conversation.peer_node_id, conversation.project_id.as_deref(), &payload).await?;
    Ok(build_bridge_state(store, conversations, current_local_server_status(&manager).await).await)
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
        || conversation.peer_runtime.to_lowercase().contains("openclaw")
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

    relay_plaintext_message(&host.coordination, &host.api_key, &conversation.peer_node_id, conversation.project_id.as_deref(), &payload).await?;

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
        Some(host.display_name.clone().unwrap_or_else(default_display_name)),
        message.to_string(),
        Some(request_id),
        Some("sent".to_string()),
        false,
    );
    if let Some(record) = conversations.conversations.iter_mut().find(|record| record.id == conversation_id) {
        record.unread_count = 0;
    }
    save_conversation_store(&conversations)?;
    Ok(build_bridge_state(store, conversations, current_local_server_status(&manager).await).await)
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
            let from_node_id = item.get("from").and_then(|value| value.as_str()).unwrap_or("").trim().to_string();
            let blob = item.get("blob").and_then(|value| value.as_str()).unwrap_or("");
            if from_node_id.is_empty() || blob.trim().is_empty() {
                continue;
            }
            let Some(parsed) = parse_mailbox_payload(blob) else {
                continue;
            };
            let message_type = parsed.get("messageType").and_then(|value| value.as_str()).unwrap_or("raw");
            let payload = parsed.get("payload").cloned().unwrap_or(serde_json::Value::Null);
            let request_id = parsed.get("requestId").and_then(|value| value.as_str()).map(ToString::to_string);
            let parsed_project_id = parsed.get("projectId").and_then(|value| value.as_str()).map(ToString::to_string);

            if message_type == "delivery_event" {
                if let Some(target_request_id) = payload.get("requestId").and_then(|value| value.as_str()) {
                    let state = payload.get("state").and_then(|value| value.as_str()).unwrap_or("delivered");
                    update_message_delivery_state(&mut conversations, target_request_id, state);
                }
                continue;
            }
            if message_type == "typing" {
                note_peer_typing(&mut conversations, &host.id, &from_node_id, parsed_project_id.clone(), None);
                continue;
            }
            if message_type == "heartbeat" {
                note_peer_heartbeat(&mut conversations, &host.id, &from_node_id, parsed_project_id.clone(), None);
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
                if message_type == "response" { "inbound-response" } else { "inbound" },
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
                let _ = relay_plaintext_message(&host.coordination, &host.api_key, &from_node_id, parsed.get("projectId").and_then(|value| value.as_str()), &ack).await;
            }
        }
    }

    save_conversation_store(&conversations)?;
    Ok(build_bridge_state(store, conversations, current_local_server_status(&manager).await).await)
}
