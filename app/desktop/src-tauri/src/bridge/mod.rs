mod agent_jobs;
mod constants;
mod conversation_actions;
mod conversation_commands;
mod conversation_open;
mod conversations;
mod events;
mod host_commands;
mod local_server;
mod mailbox;
mod network;
mod outreach;
mod project_commands;
mod realtime;
mod server_commands;
mod state;
mod storage;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use self::constants::{BRIDGE_AGENT_ID_PREFIX, BRIDGE_HOST_ID_PREFIX, BRIDGE_HUMAN_ID_PREFIX};
use self::local_server::LocalBridgeServerRuntime;

pub(crate) use self::outreach::desktop_bridge_reach_out_impl;

#[allow(unused_imports)]
use self::conversations::{
    build_conversation_state, parse_mailbox_payload, upsert_bridge_conversation,
};
#[allow(unused_imports)]
use self::local_server::{current_local_server_status, start_local_server, stop_local_server};
#[allow(unused_imports)]
use self::network::{
    ack_mailbox_v2, add_serve_contact, augment_peers_with_project_membership, create_serve_invite,
    create_serve_project, decrypt_bridge_payload_for_host, encrypt_bridge_payload_for_target,
    fetch_mailbox, fetch_registry_visible_nodes, fetch_serve_contacts, fetch_serve_discovery,
    health_check, join_serve_project, poll_mailbox_v2, register_bridge_host,
    relay_plaintext_message, remove_serve_contact, update_registered_registry_node,
    update_serve_discovery_mode, AckedMailboxEntry,
};
#[allow(unused_imports)]
use self::realtime::{send_realtime_payload, sync_realtime_connections, BRIDGE_STATE_EVENT};
#[allow(unused_imports)]
use self::state::{
    build_bridge_state, build_conversation_only_bridge_state, build_current_bridge_state,
};
#[allow(unused_imports)]
use self::storage::{
    append_conversation_message_to_storage, bridge_conversation_id, bridge_hosts_match,
    bridge_request_is_cancelled, delete_bridge_host_secrets, delete_conversations_for_host,
    desktop_bridge_config_path, desktop_bridge_conversations_path, format_time_label,
    format_time_label_with_seconds, hosted_bridge_dir, korde_dir, legacy_bridge_config_path,
    load_bridge_store, load_conversation_store, load_legacy_bridge_config,
    mark_bridge_conversation_read_in_storage, normalize_imported_bridge_host, normalize_server_url,
    note_peer_heartbeat_in_storage, note_peer_typing_in_storage, now_ms,
    parse_imported_bridge_store, record_bridge_inbox_event_and_agent_job, save_bridge_store,
    save_conversation_store, update_message_delivery_state_in_storage, write_bridge_store_export,
    BridgeAgentJobInsert, BridgeInboxEventInsert,
};

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
    #[serde(
        rename = "localAgentRouting",
        default,
        skip_serializing_if = "DesktopBridgeAgentRouting::is_empty"
    )]
    local_agent_routing: DesktopBridgeAgentRouting,
    #[serde(default)]
    hosts: Vec<DesktopBridgeHostConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBridgeAgentRouting {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_auth_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_auth_choice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_auth_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_auth_choice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
}

impl DesktopBridgeAgentRouting {
    fn is_empty(&self) -> bool {
        self.default_model.is_none()
            && self.default_auth_provider.is_none()
            && self.default_auth_choice.is_none()
            && self.fallback_model.is_none()
            && self.fallback_auth_provider.is_none()
            && self.fallback_auth_choice.is_none()
            && self.thinking.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DesktopBridgeAgentConfig {
    id: String,
    label: String,
    #[serde(rename = "nodeId", default)]
    node_id: String,
    #[serde(rename = "apiKey", default, skip_serializing)]
    api_key: String,
    #[serde(default = "default_bridge_agent_runtime")]
    runtime: String,
    #[serde(default)]
    is_default: bool,
    #[serde(
        rename = "defaultModel",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    default_model: Option<String>,
    #[serde(
        rename = "defaultAuthProvider",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    default_auth_provider: Option<String>,
    #[serde(
        rename = "defaultAuthChoice",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    default_auth_choice: Option<String>,
    #[serde(
        rename = "fallbackModel",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    fallback_model: Option<String>,
    #[serde(
        rename = "fallbackAuthProvider",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    fallback_auth_provider: Option<String>,
    #[serde(
        rename = "fallbackAuthChoice",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    fallback_auth_choice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thinking: Option<String>,
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
    #[serde(rename = "humanId", default, skip_serializing_if = "Option::is_none")]
    human_id: Option<String>,
    #[serde(rename = "discoveryMode", default = "default_discovery_mode")]
    discovery_mode: String,
    #[serde(
        rename = "activeAgentId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    active_agent_id: Option<String>,
    #[serde(default)]
    agents: Vec<DesktopBridgeAgentConfig>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    outreach: Option<DesktopBridgeOutreachMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    identity: Option<DesktopBridgeIdentitySnapshot>,
    #[serde(default)]
    messages: Vec<DesktopBridgeConversationMessageRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBridgeMessageAttachment {
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    outreach: Option<DesktopBridgeOutreachMetadata>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    attachments: Vec<DesktopBridgeMessageAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBridgeSessionThreadMessage {
    pub role: String,
    pub sender: Option<String>,
    pub text: String,
    pub time_label: Option<String>,
    pub index: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBridgeSessionParticipant {
    pub identity_id: Option<String>,
    pub display_name: String,
    pub role: Option<String>,
    pub bridge_node_id: Option<String>,
    pub human_id: Option<String>,
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBridgeOutreachMetadata {
    pub target_kind: String,
    pub parent_session_id: Option<String>,
    pub parent_session_title: Option<String>,
    pub parent_session_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_group_space_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parent_session_participants: Vec<DesktopBridgeSessionParticipant>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parent_session_messages: Vec<DesktopBridgeSessionThreadMessage>,
    pub parent_turn_id: Option<String>,
    pub parent_message_id: Option<String>,
    pub bridge_host_id: String,
    pub bridge_conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bridge_request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_state: Option<String>,
    pub target_node_id: String,
    pub target_human_id: Option<String>,
    pub target_agent_id: Option<String>,
    pub target_display_name: String,
    pub target_owner_name: Option<String>,
    pub target_runtime: Option<String>,
    pub request_text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_text: Option<String>,
    pub context_text: Option<String>,
    pub context_policy: Option<String>,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub status: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub completed_at_ms: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBridgeIdentitySnapshot {
    pub bridge_host_id: String,
    pub local_human_id: String,
    pub local_human_name: String,
    pub local_agent_id: Option<String>,
    pub local_agent_name: Option<String>,
    pub local_agent_node_id: Option<String>,
    pub remote_human_id: Option<String>,
    pub remote_human_name: Option<String>,
    pub remote_human_node_id: Option<String>,
    pub remote_agent_id: Option<String>,
    pub remote_agent_name: Option<String>,
    pub remote_agent_node_id: Option<String>,
    pub remote_agent_runtime: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBridgeAgent {
    pub id: String,
    pub label: String,
    pub node_id: Option<String>,
    pub runtime: String,
    pub is_default: bool,
    pub is_active: bool,
    pub registered: bool,
    pub default_model: Option<String>,
    pub default_auth_provider: Option<String>,
    pub default_auth_choice: Option<String>,
    pub fallback_model: Option<String>,
    pub fallback_auth_provider: Option<String>,
    pub fallback_auth_choice: Option<String>,
    pub thinking: Option<String>,
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
    pub human_id: Option<String>,
    pub agent_id: Option<String>,
    pub is_default_agent: bool,
    pub discovery_mode: Option<String>,
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
    pub human_id: String,
    pub discovery_mode: String,
    pub active_agent_id: Option<String>,
    pub agents: Vec<DesktopBridgeAgent>,
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
    pub request_id: Option<String>,
    pub delivery_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outreach: Option<DesktopBridgeOutreachMetadata>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<DesktopBridgeMessageAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBridgeConversation {
    pub id: String,
    pub canonical_session_id: String,
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
    pub outreach: Option<DesktopBridgeOutreachMetadata>,
    pub identity: Option<DesktopBridgeIdentitySnapshot>,
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
    pub local_agent_routing: DesktopBridgeAgentRouting,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBridgeCreateOutreachRequest {
    pub host_id: String,
    pub target_node_id: String,
    pub target_kind: String,
    pub request_text: String,
    pub target_display_name: Option<String>,
    pub target_owner_name: Option<String>,
    pub target_runtime: Option<String>,
    pub target_human_id: Option<String>,
    pub target_agent_id: Option<String>,
    pub trigger_text: Option<String>,
    pub context_text: Option<String>,
    pub context_policy: Option<String>,
    pub parent_session_id: Option<String>,
    pub parent_session_title: Option<String>,
    pub parent_session_kind: Option<String>,
    pub parent_group_space_id: Option<String>,
    #[serde(default)]
    pub parent_session_participants: Vec<DesktopBridgeSessionParticipant>,
    #[serde(default)]
    pub parent_session_messages: Vec<DesktopBridgeSessionThreadMessage>,
    pub parent_turn_id: Option<String>,
    pub parent_message_id: Option<String>,
    pub bridge_request_id: Option<String>,
    pub delivery_state: Option<String>,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    #[serde(default)]
    pub attachment_paths: Vec<String>,
    #[serde(default)]
    pub attachment_names: Vec<String>,
}

#[derive(Clone)]
pub struct DesktopBridgeManager {
    local_server: Arc<tokio::sync::Mutex<LocalBridgeServerRuntime>>,
    realtime: Arc<tokio::sync::Mutex<realtime::RealtimeBridgeRuntime>>,
    app_handle: Arc<tokio::sync::RwLock<Option<tauri::AppHandle>>>,
}

pub(crate) async fn desktop_bridge_outreach_prompt_context(
    manager: &DesktopBridgeManager,
) -> Option<String> {
    let state = build_current_bridge_state(manager).await;
    let active_host_id = state.active_host_id.as_deref();
    let mut target_lines = Vec::new();

    for host in &state.hosts {
        let host_label = format!("{} / {}", host.display_name, host.owner_name);
        for peer in &host.visible_peers {
            let target_kind = if self::constants::is_agent_like_runtime(&peer.runtime) {
                "bridge-agent"
            } else {
                "bridge-person"
            };
            let name = peer
                .display_name
                .as_deref()
                .or(peer.owner_name.as_deref())
                .unwrap_or(&peer.node_id);
            let owner = peer.owner_name.as_deref().unwrap_or("unknown owner");
            let active = if Some(host.id.as_str()) == active_host_id {
                "active host"
            } else {
                "available host"
            };
            target_lines.push(format!(
                "- {target_kind}: target=\"{name}\" owner=\"{owner}\" runtime=\"{}\" nodeId=\"{}\" via=\"{host_label}\" ({active})",
                peer.runtime, peer.node_id
            ));
        }
    }

    if target_lines.is_empty() {
        return Some(
            "Bridge outreach: reach_out is available, but no bridge agents or people are currently visible. Ask the user to connect or expose a bridge target before using it."
                .to_string(),
        );
    }

    target_lines.truncate(50);
    Some(format!(
        "Bridge outreach is available through the reach_out tool only for explicit non-local @Person/@Agent mentions in the current user message. Use it only when the current user message names one of the visible bridge targets below; never use it for @Kordi/the local agent and do not proactively contact participants. Outreach is allowed without asking for approval, creates a visible/resumable bridge conversation, and returns the remote reply when possible.\n\nVisible bridge targets:\n{}",
        target_lines.join("\n")
    ))
}

impl Default for DesktopBridgeManager {
    fn default() -> Self {
        Self {
            local_server: Arc::new(tokio::sync::Mutex::new(LocalBridgeServerRuntime::default())),
            realtime: Arc::new(tokio::sync::Mutex::new(
                realtime::RealtimeBridgeRuntime::default(),
            )),
            app_handle: Arc::new(tokio::sync::RwLock::new(None)),
        }
    }
}

pub(crate) async fn set_bridge_app_handle(manager: &DesktopBridgeManager, app: tauri::AppHandle) {
    realtime::set_bridge_app_handle(manager, app).await;
}

fn default_bridge_api_style() -> String {
    constants::API_STYLE_REGISTRY.to_string()
}

fn default_bridge_agent_runtime() -> String {
    constants::DESKTOP_BRIDGE_RUNTIME.to_string()
}

fn default_discovery_mode() -> String {
    "open".to_string()
}

fn default_display_name() -> String {
    constants::DEFAULT_DISPLAY_NAME.to_string()
}

fn default_owner_name() -> String {
    constants::DEFAULT_OWNER_NAME.to_string()
}

fn default_bridge_agent_label(owner_name: &str) -> String {
    let trimmed = owner_name.trim();
    if trimmed.is_empty() {
        return default_display_name();
    }
    if trimmed.ends_with('s') || trimmed.ends_with('S') {
        format!("{trimmed}' Kordi")
    } else {
        format!("{trimmed}'s Kordi")
    }
}

fn default_endpoint() -> String {
    constants::DEFAULT_ENDPOINT.to_string()
}

fn generate_registry_node_id() -> String {
    let raw = Uuid::new_v4().simple().to_string();
    format!("{}{}", constants::BRIDGE_NODE_ID_PREFIX, &raw[..12])
}

fn generate_host_id() -> String {
    format!("{}{}", BRIDGE_HOST_ID_PREFIX, Uuid::new_v4().simple())
}

fn stable_host_id(seed: &str) -> String {
    format!("{}{}", BRIDGE_HOST_ID_PREFIX, stable_identity_suffix(seed))
}

fn generate_human_id() -> String {
    format!(
        "{}{}",
        BRIDGE_HUMAN_ID_PREFIX,
        &Uuid::new_v4().simple().to_string()[..12]
    )
}

fn generate_agent_id() -> String {
    format!(
        "{}{}",
        BRIDGE_AGENT_ID_PREFIX,
        &Uuid::new_v4().simple().to_string()[..12]
    )
}

fn stable_identity_suffix(seed: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    hex::encode(hasher.finalize())[..12].to_string()
}

fn apply_missing_agent_routing(
    agent: &mut DesktopBridgeAgentConfig,
    routing: &DesktopBridgeAgentRouting,
) {
    if agent.default_model.is_none() {
        agent.default_model = routing.default_model.clone();
    }
    if agent.default_auth_provider.is_none() {
        agent.default_auth_provider = routing.default_auth_provider.clone();
    }
    if agent.default_auth_choice.is_none() {
        agent.default_auth_choice = routing.default_auth_choice.clone();
    }
    if agent.fallback_model.is_none() {
        agent.fallback_model = routing.fallback_model.clone();
    }
    if agent.fallback_auth_provider.is_none() {
        agent.fallback_auth_provider = routing.fallback_auth_provider.clone();
    }
    if agent.fallback_auth_choice.is_none() {
        agent.fallback_auth_choice = routing.fallback_auth_choice.clone();
    }
    if agent.thinking.is_none() {
        agent.thinking = routing.thinking.clone();
    }
}

fn sync_host_active_agent_fields(host: &mut DesktopBridgeHostConfig) {
    let active_agent_index = host
        .active_agent_id
        .as_deref()
        .and_then(|active_id| host.agents.iter().position(|agent| agent.id == active_id))
        .or_else(|| host.agents.iter().position(|agent| agent.is_default))
        .or_else(|| (!host.agents.is_empty()).then_some(0));

    if let Some(index) = active_agent_index {
        let agent = host.agents[index].clone();
        host.active_agent_id = Some(agent.id.clone());
        host.node_id = agent.node_id.clone();
        host.api_key = agent.api_key.clone();
        host.display_name = Some(agent.label);
    }
}

fn ensure_host_bootstrap(
    existing: Option<&DesktopBridgeHostConfig>,
    display_name: &str,
    owner_name: &str,
) -> DesktopBridgeHostConfig {
    let mut host = existing.cloned().unwrap_or(DesktopBridgeHostConfig {
        id: generate_host_id(),
        coordination: String::new(),
        node_id: String::new(),
        api_key: String::new(),
        display_name: None,
        owner: None,
        human_id: None,
        discovery_mode: default_discovery_mode(),
        active_agent_id: None,
        agents: Vec::new(),
        api_style: default_bridge_api_style(),
    });

    host.owner = Some(owner_name.to_string());
    host.human_id = Some(host.human_id.clone().unwrap_or_else(|| {
        if !host.node_id.trim().is_empty() {
            format!(
                "{}{}",
                BRIDGE_HUMAN_ID_PREFIX,
                stable_identity_suffix(&host.node_id)
            )
        } else {
            generate_human_id()
        }
    }));
    if host.discovery_mode.trim().is_empty() {
        host.discovery_mode = default_discovery_mode();
    }

    if host.agents.is_empty() {
        host.agents.push(DesktopBridgeAgentConfig {
            id: host.active_agent_id.clone().unwrap_or_else(|| {
                if !host.node_id.trim().is_empty() {
                    format!(
                        "{}{}",
                        BRIDGE_AGENT_ID_PREFIX,
                        stable_identity_suffix(&host.node_id)
                    )
                } else {
                    generate_agent_id()
                }
            }),
            label: default_bridge_agent_label(owner_name),
            node_id: host.node_id.clone(),
            api_key: host.api_key.clone(),
            runtime: default_bridge_agent_runtime(),
            is_default: true,
            default_model: None,
            default_auth_provider: None,
            default_auth_choice: None,
            fallback_model: None,
            fallback_auth_provider: None,
            fallback_auth_choice: None,
            thinking: None,
        });
    } else {
        let active_id = host.active_agent_id.clone();
        let default_index = host
            .agents
            .iter()
            .position(|agent| active_id.as_deref() == Some(agent.id.as_str()))
            .or_else(|| host.agents.iter().position(|agent| agent.is_default))
            .unwrap_or(0);
        for (index, agent) in host.agents.iter_mut().enumerate() {
            if agent.id.trim().is_empty() {
                agent.id = generate_agent_id();
            }
            if index == default_index {
                if agent.label.trim().is_empty()
                    || agent.label == default_display_name()
                    || agent.label == display_name
                {
                    agent.label = default_bridge_agent_label(owner_name);
                }
            } else if agent.label.trim().is_empty() {
                agent.label = format!("{} {}", owner_name, index + 1);
            }
            if agent.runtime.trim().is_empty() {
                agent.runtime = default_bridge_agent_runtime();
            }
            agent.is_default = index == default_index;
        }
    }

    host.active_agent_id = host
        .agents
        .iter()
        .find(|agent| agent.is_default)
        .map(|agent| agent.id.clone())
        .or_else(|| host.agents.first().map(|agent| agent.id.clone()));
    sync_host_active_agent_fields(&mut host);
    host
}

fn build_public_bridge_agents(host: &DesktopBridgeHostConfig) -> Vec<DesktopBridgeAgent> {
    let active_id = host.active_agent_id.as_deref();
    host.agents
        .iter()
        .map(|agent| DesktopBridgeAgent {
            id: agent.id.clone(),
            label: agent.label.clone(),
            node_id: Some(agent.node_id.clone()).filter(|value| !value.trim().is_empty()),
            runtime: agent.runtime.clone(),
            is_default: agent.is_default,
            is_active: active_id == Some(agent.id.as_str()),
            registered: !agent.node_id.trim().is_empty() && !agent.api_key.trim().is_empty(),
            default_model: agent.default_model.clone(),
            default_auth_provider: agent.default_auth_provider.clone(),
            default_auth_choice: agent.default_auth_choice.clone(),
            fallback_model: agent.fallback_model.clone(),
            fallback_auth_provider: agent.fallback_auth_provider.clone(),
            fallback_auth_choice: agent.fallback_auth_choice.clone(),
            thinking: agent.thinking.clone(),
        })
        .collect()
}

#[tauri::command]
pub async fn desktop_bridge_state(
    manager: State<'_, DesktopBridgeManager>,
) -> Result<DesktopBridgeState, String> {
    host_commands::desktop_bridge_state_impl(&manager).await
}

#[tauri::command]
pub async fn desktop_bridge_open_config_folder() -> Result<String, String> {
    host_commands::desktop_bridge_open_config_folder_impl().await
}

#[tauri::command]
pub async fn desktop_bridge_reveal_storage_file(kind: String) -> Result<String, String> {
    host_commands::desktop_bridge_reveal_storage_file_impl(kind).await
}

#[tauri::command]
pub async fn desktop_bridge_export_hosts_config() -> Result<String, String> {
    host_commands::desktop_bridge_export_hosts_config_impl().await
}

#[tauri::command]
pub async fn desktop_bridge_import_hosts_config(
    manager: State<'_, DesktopBridgeManager>,
    raw: String,
) -> Result<DesktopBridgeState, String> {
    host_commands::desktop_bridge_import_hosts_config_impl(&manager, raw).await
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
pub async fn desktop_bridge_set_discovery_mode(
    manager: State<'_, DesktopBridgeManager>,
    host_id: String,
    discovery_mode: String,
) -> Result<DesktopBridgeState, String> {
    host_commands::desktop_bridge_set_discovery_mode_impl(&manager, host_id, discovery_mode).await
}

#[tauri::command]
pub async fn desktop_bridge_create_agent(
    manager: State<'_, DesktopBridgeManager>,
    host_id: String,
    label: Option<String>,
    runtime: Option<String>,
) -> Result<DesktopBridgeState, String> {
    host_commands::desktop_bridge_create_agent_impl(&manager, host_id, label, runtime).await
}

#[tauri::command]
pub async fn desktop_bridge_activate_agent(
    manager: State<'_, DesktopBridgeManager>,
    host_id: String,
    agent_id: String,
) -> Result<DesktopBridgeState, String> {
    host_commands::desktop_bridge_activate_agent_impl(&manager, host_id, agent_id).await
}

#[tauri::command]
pub async fn desktop_bridge_rename_agent(
    manager: State<'_, DesktopBridgeManager>,
    host_id: String,
    agent_id: String,
    label: String,
) -> Result<DesktopBridgeState, String> {
    host_commands::desktop_bridge_rename_agent_impl(&manager, host_id, agent_id, label).await
}

#[tauri::command]
pub async fn desktop_bridge_update_agent_model_routing(
    manager: State<'_, DesktopBridgeManager>,
    host_id: String,
    agent_id: String,
    default_model: Option<String>,
    fallback_model: Option<String>,
    thinking: Option<String>,
    default_auth_provider: Option<String>,
    default_auth_choice: Option<String>,
    fallback_auth_provider: Option<String>,
    fallback_auth_choice: Option<String>,
) -> Result<DesktopBridgeState, String> {
    host_commands::desktop_bridge_update_agent_model_routing_impl(
        &manager,
        host_id,
        agent_id,
        default_model,
        fallback_model,
        thinking,
        default_auth_provider,
        default_auth_choice,
        fallback_auth_provider,
        fallback_auth_choice,
    )
    .await
}

#[tauri::command]
pub async fn desktop_bridge_update_local_agent_model_routing(
    manager: State<'_, DesktopBridgeManager>,
    default_model: Option<String>,
    fallback_model: Option<String>,
    thinking: Option<String>,
    default_auth_provider: Option<String>,
    default_auth_choice: Option<String>,
    fallback_auth_provider: Option<String>,
    fallback_auth_choice: Option<String>,
) -> Result<DesktopBridgeState, String> {
    host_commands::desktop_bridge_update_local_agent_model_routing_impl(
        &manager,
        default_model,
        fallback_model,
        thinking,
        default_auth_provider,
        default_auth_choice,
        fallback_auth_provider,
        fallback_auth_choice,
    )
    .await
}

#[tauri::command]
pub async fn desktop_bridge_set_default_agent(
    manager: State<'_, DesktopBridgeManager>,
    host_id: String,
    agent_id: String,
) -> Result<DesktopBridgeState, String> {
    host_commands::desktop_bridge_set_default_agent_impl(&manager, host_id, agent_id).await
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
pub async fn desktop_bridge_add_contact(
    manager: State<'_, DesktopBridgeManager>,
    host_id: String,
    peer_node_id: String,
) -> Result<DesktopBridgeState, String> {
    host_commands::desktop_bridge_add_contact_impl(&manager, host_id, peer_node_id).await
}

#[tauri::command]
pub async fn desktop_bridge_remove_contact(
    manager: State<'_, DesktopBridgeManager>,
    host_id: String,
    peer_node_id: String,
) -> Result<DesktopBridgeState, String> {
    host_commands::desktop_bridge_remove_contact_impl(&manager, host_id, peer_node_id).await
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
    conversation_open::desktop_bridge_open_conversation_impl(
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
    conversation_actions::desktop_bridge_mark_conversation_read_impl(&manager, conversation_id)
        .await
}

#[tauri::command]
pub async fn desktop_bridge_send_message(
    manager: State<'_, DesktopBridgeManager>,
    conversation_id: String,
    text: String,
    attachment_paths: Option<Vec<String>>,
    attachment_names: Option<Vec<String>>,
) -> Result<DesktopBridgeState, String> {
    conversation_actions::desktop_bridge_send_message_impl(
        &manager,
        conversation_id,
        text,
        attachment_paths.unwrap_or_default(),
        attachment_names.unwrap_or_default(),
    )
    .await
}

#[tauri::command]
pub async fn desktop_bridge_create_outreach(
    manager: State<'_, DesktopBridgeManager>,
    request: DesktopBridgeCreateOutreachRequest,
) -> Result<DesktopBridgeState, String> {
    conversation_commands::desktop_bridge_create_outreach_impl(&manager, request).await
}

#[tauri::command]
pub async fn desktop_bridge_cancel_outreach(
    manager: State<'_, DesktopBridgeManager>,
    conversation_id: String,
    request_id: Option<String>,
) -> Result<DesktopBridgeState, String> {
    conversation_actions::desktop_bridge_cancel_outreach_impl(&manager, conversation_id, request_id)
        .await
}

#[tauri::command]
pub async fn desktop_bridge_send_presence(
    manager: State<'_, DesktopBridgeManager>,
    conversation_id: String,
    kind: String,
) -> Result<DesktopBridgeState, String> {
    conversation_actions::desktop_bridge_send_presence_impl(&manager, conversation_id, kind).await
}

#[tauri::command]
pub async fn desktop_bridge_poll_mailbox(
    manager: State<'_, DesktopBridgeManager>,
    chat_manager: State<'_, crate::chat::DesktopChatManager>,
) -> Result<DesktopBridgeState, String> {
    mailbox::desktop_bridge_poll_mailbox_impl(&manager, &chat_manager).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_agent() -> DesktopBridgeAgentConfig {
        DesktopBridgeAgentConfig {
            id: "agent-1".to_string(),
            label: "Kordi".to_string(),
            node_id: String::new(),
            api_key: String::new(),
            runtime: "kordi".to_string(),
            is_default: true,
            default_model: None,
            default_auth_provider: None,
            default_auth_choice: None,
            fallback_model: None,
            fallback_auth_provider: None,
            fallback_auth_choice: None,
            thinking: None,
        }
    }

    #[test]
    fn bridge_agent_routing_template_seeds_empty_agent_without_overwriting_explicit_values() {
        let template = DesktopBridgeAgentRouting {
            default_model: Some("openai/gpt-5.5".to_string()),
            default_auth_provider: Some("openai-codex".to_string()),
            default_auth_choice: Some("profile:chatgpt".to_string()),
            fallback_model: Some("anthropic/claude-sonnet-4.5".to_string()),
            fallback_auth_provider: Some("anthropic".to_string()),
            fallback_auth_choice: Some("env:api-key".to_string()),
            thinking: Some("high".to_string()),
        };

        let mut empty = empty_agent();
        apply_missing_agent_routing(&mut empty, &template);
        assert_eq!(empty.default_model.as_deref(), Some("openai/gpt-5.5"));
        assert_eq!(
            empty.fallback_model.as_deref(),
            Some("anthropic/claude-sonnet-4.5")
        );
        assert_eq!(empty.thinking.as_deref(), Some("high"));

        let mut explicit = empty_agent();
        explicit.default_model = Some("openai/gpt-4.1".to_string());
        explicit.fallback_model = Some("anthropic/claude-opus-4.1".to_string());
        explicit.thinking = Some("medium".to_string());
        apply_missing_agent_routing(&mut explicit, &template);
        assert_eq!(explicit.default_model.as_deref(), Some("openai/gpt-4.1"));
        assert_eq!(
            explicit.fallback_model.as_deref(),
            Some("anthropic/claude-opus-4.1")
        );
        assert_eq!(explicit.thinking.as_deref(), Some("medium"));
    }
}
