use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rand::RngCore;
use reqwest::{Client, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use super::constants::{API_STYLE_REGISTRY, API_STYLE_SERVE, DESKTOP_BRIDGE_RUNTIME};
use super::storage::{
    derive_node_id, ed25519_to_x25519_public, load_or_create_bridge_identity_for_agent,
};
use super::{
    DesktopBridgeContactRequest, DesktopBridgeHostConfig, DesktopBridgePeer, DesktopBridgeProject,
    generate_registry_node_id,
};

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
struct ServeDiscoveryItem {
    node_id: String,
    display_name: Option<String>,
    owner_name: Option<String>,
    runtime: Option<String>,
    created_at: Option<String>,
    human_id: Option<String>,
    agent_id: Option<String>,
    is_default_agent: Option<bool>,
    discovery_mode: Option<String>,
    human_visibility_policy: Option<String>,
    contact_approval_policy: Option<String>,
    agent_reachability_policy: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServeContactItem {
    node_id: String,
    display_name: Option<String>,
    owner_name: Option<String>,
    runtime: Option<String>,
    created_at: Option<String>,
    human_id: Option<String>,
    agent_id: Option<String>,
    is_default_agent: Option<bool>,
    discovery_mode: Option<String>,
    human_visibility_policy: Option<String>,
    contact_approval_policy: Option<String>,
    agent_reachability_policy: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServeContactRequestItem {
    request_id: String,
    requester_node_id: String,
    target_node_id: String,
    status: String,
    message: Option<String>,
    created_at: String,
    decided_at: Option<String>,
    direction: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServeNodeKeysResponse {
    node_id: String,
    x25519_pubkey: String,
}

const SERVE_NODE_KEY_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
static SERVE_NODE_KEY_CACHE: OnceLock<Mutex<HashMap<String, (Instant, ServeNodeKeysResponse)>>> =
    OnceLock::new();

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ServeProjectItem {
    project_id: String,
    slug: String,
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ServeProjectMemberItem {
    node_id: String,
    agent_role: Option<String>,
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ServeCreateProjectResponse {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AckedMailboxEntry {
    pub(super) message_id: String,
    pub(super) from: String,
    pub(super) blob: String,
    pub(super) project_id: Option<String>,
    pub(super) timestamp: String,
}

#[derive(Debug, Deserialize)]
struct AckedMailboxPollResponse {
    entries: Vec<AckedMailboxEntry>,
}

#[derive(Debug, Serialize)]
struct AckedMailboxPollRequest<'a> {
    after: Option<&'a str>,
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AckedMailboxAckRequest<'a> {
    message_ids: &'a [String],
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ServeCreateInviteResponse {
    pub(super) invite_id: String,
    pub(super) invite_token: String,
    pub(super) project_id: String,
}

fn bridge_client() -> Client {
    Client::new()
}

fn trimmed_base_url(base_url: &str) -> &str {
    base_url.trim_end_matches('/')
}

fn bridge_identity_id_for_host(host: &DesktopBridgeHostConfig) -> String {
    host.active_agent_id
        .clone()
        .or_else(|| {
            host.agents
                .iter()
                .find(|agent| agent.is_default)
                .map(|agent| agent.id.clone())
        })
        .or_else(|| host.agents.first().map(|agent| agent.id.clone()))
        .unwrap_or_else(|| "default-agent".to_string())
}

fn ed25519_secret_to_x25519(secret: &[u8; 32]) -> [u8; 32] {
    use sha2::{Digest, Sha512};
    let digest = Sha512::digest(secret);
    let mut scalar = [0u8; 32];
    scalar.copy_from_slice(&digest[..32]);
    scalar[0] &= 248;
    scalar[31] &= 127;
    scalar[31] |= 64;
    scalar
}

fn bridge_e2ee_key(shared: &[u8; 32], sender_node_id: &str, target_node_id: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"kordi-desktop-bridge-e2ee-v1");
    hasher.update(shared);
    hasher.update(sender_node_id.as_bytes());
    hasher.update([0]);
    hasher.update(target_node_id.as_bytes());
    hasher.finalize().into()
}

fn bridge_payload_is_encrypted(payload: &serde_json::Value) -> bool {
    payload.get("envelopeType").and_then(|value| value.as_str()) == Some("kordi_bridge_e2ee_v1")
}

async fn send_request(
    builder: reqwest::RequestBuilder,
    request_error: &str,
) -> Result<Response, String> {
    builder
        .send()
        .await
        .map_err(|err| format!("{request_error}: {err}"))
}

fn http_status_error(prefix: &str, status: StatusCode) -> String {
    format!("{prefix}: HTTP {status}")
}

fn bare_http_status_error(prefix: &str, status: StatusCode) -> String {
    format!("{prefix} HTTP {status}")
}

async fn response_error_with_body(
    response: Response,
    empty_prefix: &str,
    body_prefix: &str,
) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if body.trim().is_empty() {
        http_status_error(empty_prefix, status)
    } else {
        format!("{body_prefix}: {body}")
    }
}

async fn parse_json_response<T: DeserializeOwned>(
    response: Response,
    parse_error: &str,
) -> Result<T, String> {
    response
        .json::<T>()
        .await
        .map_err(|err| format!("{parse_error}: {err}"))
}

async fn fetch_serve_node_keys(
    base_url: &str,
    api_key: &str,
    target_node_id: &str,
    project_id: Option<&str>,
    target_kind: Option<&str>,
) -> Result<ServeNodeKeysResponse, String> {
    let trimmed_project_id = project_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let trimmed_target_kind = target_kind
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let cache_key = format!(
        "{}|{}|{}|{}",
        trimmed_base_url(base_url),
        target_node_id,
        trimmed_project_id.as_deref().unwrap_or(""),
        trimmed_target_kind.as_deref().unwrap_or("")
    );
    let cache = SERVE_NODE_KEY_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut guard) = cache.lock() {
        if let Some((cached_at, cached)) = guard.get(&cache_key) {
            if cached_at.elapsed() < SERVE_NODE_KEY_CACHE_TTL {
                return Ok(cached.clone());
            }
        }
        guard.remove(&cache_key);
    }

    let mut url = format!("{}/v1/keys/{target_node_id}", trimmed_base_url(base_url));
    let mut query_params = Vec::new();
    if let Some(project_id) = trimmed_project_id.as_deref() {
        query_params.push(format!("project={project_id}"));
    }
    if let Some(target_kind) = trimmed_target_kind.as_deref() {
        query_params.push(format!("targetKind={target_kind}"));
    }
    if !query_params.is_empty() {
        url = format!("{url}?{}", query_params.join("&"));
    }
    let response = send_request(
        bridge_client().get(url).bearer_auth(api_key),
        "Unable to fetch bridge recipient keys",
    )
    .await?;
    if !response.status().is_success() {
        return Err(http_status_error(
            "Unable to fetch bridge recipient keys",
            response.status(),
        ));
    }
    let keys = parse_json_response::<ServeNodeKeysResponse>(
        response,
        "Unable to parse bridge recipient keys",
    )
    .await?;
    if let Ok(mut guard) = cache.lock() {
        guard.insert(cache_key, (Instant::now(), keys.clone()));
    }
    Ok(keys)
}

fn encrypt_payload_for_recipient(
    sender_host: &DesktopBridgeHostConfig,
    recipient_keys: &ServeNodeKeysResponse,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let identity_id = bridge_identity_id_for_host(sender_host);
    let (signing, verifying) = load_or_create_bridge_identity_for_agent(&identity_id)?;
    let sender_secret = ed25519_secret_to_x25519(&signing.to_bytes());
    let sender_secret = x25519_dalek::StaticSecret::from(sender_secret);
    let recipient_public_bytes: [u8; 32] = hex::decode(&recipient_keys.x25519_pubkey)
        .map_err(|err| format!("Invalid bridge recipient x25519 key: {err}"))?
        .try_into()
        .map_err(|bytes: Vec<u8>| {
            format!(
                "Invalid bridge recipient x25519 key length: {}",
                bytes.len()
            )
        })?;
    let recipient_public = x25519_dalek::PublicKey::from(recipient_public_bytes);
    let shared = sender_secret.diffie_hellman(&recipient_public);
    let key_bytes = bridge_e2ee_key(
        shared.as_bytes(),
        &sender_host.node_id,
        &recipient_keys.node_id,
    );
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key_bytes));
    let mut nonce_bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let plaintext = serde_json::to_vec(payload).map_err(|err| err.to_string())?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
        .map_err(|_| "Unable to encrypt bridge payload".to_string())?;
    Ok(serde_json::json!({
        "envelopeType": "kordi_bridge_e2ee_v1",
        "alg": "x25519-chacha20poly1305",
        "from": sender_host.node_id,
        "to": recipient_keys.node_id,
        "senderEd25519Pubkey": bs58::encode(verifying.as_bytes()).into_string(),
        "nonce": base64::engine::general_purpose::STANDARD.encode(nonce_bytes),
        "ciphertext": base64::engine::general_purpose::STANDARD.encode(ciphertext),
    }))
}

pub(super) fn decrypt_bridge_payload_for_host(
    recipient_host: &DesktopBridgeHostConfig,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !bridge_payload_is_encrypted(&payload) {
        return Ok(payload);
    }
    let sender_node_id = payload
        .get("from")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Encrypted bridge payload is missing sender".to_string())?;
    let target_node_id = payload
        .get("to")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Encrypted bridge payload is missing recipient".to_string())?;
    if target_node_id != recipient_host.node_id {
        return Err("Encrypted bridge payload recipient does not match this node".to_string());
    }
    let sender_ed25519 = payload
        .get("senderEd25519Pubkey")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Encrypted bridge payload is missing sender key".to_string())?;
    let sender_ed25519_bytes: [u8; 32] = bs58::decode(sender_ed25519)
        .into_vec()
        .map_err(|err| format!("Invalid bridge sender key: {err}"))?
        .try_into()
        .map_err(|bytes: Vec<u8>| format!("Invalid bridge sender key length: {}", bytes.len()))?;
    let sender_verifying = ed25519_dalek::VerifyingKey::from_bytes(&sender_ed25519_bytes)
        .map_err(|err| format!("Invalid bridge sender key: {err}"))?;
    let derived_sender_node_id = derive_node_id(&sender_verifying);
    if derived_sender_node_id != sender_node_id {
        return Err("Encrypted bridge payload sender key does not match sender node".to_string());
    }
    let sender_x25519 = ed25519_to_x25519_public(&sender_ed25519_bytes)?;
    let sender_public = x25519_dalek::PublicKey::from(sender_x25519);
    let identity_id = bridge_identity_id_for_host(recipient_host);
    let (signing, _verifying) = load_or_create_bridge_identity_for_agent(&identity_id)?;
    let recipient_secret =
        x25519_dalek::StaticSecret::from(ed25519_secret_to_x25519(&signing.to_bytes()));
    let shared = recipient_secret.diffie_hellman(&sender_public);
    let key_bytes = bridge_e2ee_key(shared.as_bytes(), sender_node_id, target_node_id);
    let nonce = payload
        .get("nonce")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Encrypted bridge payload is missing nonce".to_string())?;
    let nonce_bytes = base64::engine::general_purpose::STANDARD
        .decode(nonce)
        .map_err(|err| format!("Invalid bridge payload nonce: {err}"))?;
    if nonce_bytes.len() != 12 {
        return Err("Invalid bridge payload nonce length".to_string());
    }
    let ciphertext = payload
        .get("ciphertext")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Encrypted bridge payload is missing ciphertext".to_string())?;
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(ciphertext)
        .map_err(|err| format!("Invalid bridge payload ciphertext: {err}"))?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key_bytes));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
        .map_err(|_| "Unable to decrypt bridge payload".to_string())?;
    serde_json::from_slice(&plaintext)
        .map_err(|err| format!("Invalid decrypted bridge payload: {err}"))
}

pub(super) async fn encrypt_bridge_payload_for_target(
    sender_host: &DesktopBridgeHostConfig,
    target_node_id: &str,
    project_id: Option<&str>,
    target_kind: Option<&str>,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let recipient_keys = fetch_serve_node_keys(
        &sender_host.coordination,
        &sender_host.api_key,
        target_node_id,
        project_id,
        target_kind,
    )
    .await?;
    encrypt_payload_for_recipient(sender_host, &recipient_keys, payload)
}

pub(super) async fn health_check(base_url: &str) -> Result<(), String> {
    let url = format!("{}/health", trimmed_base_url(base_url));
    let response = bridge_client()
        .get(url)
        .send()
        .await
        .map_err(|err| format!("Unable to reach bridge server: {err}"))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "Bridge server health check failed: HTTP {}",
            response.status()
        ))
    }
}

async fn register_node_registry(
    base_url: &str,
    node_id: &str,
    display_name: &str,
    owner_name: &str,
    endpoint: &str,
) -> Result<(String, String, String), String> {
    let url = format!("{}/auth/register", trimmed_base_url(base_url));
    let body = serde_json::json!({
        "nodeId": node_id,
        "displayName": display_name,
        "runtime": DESKTOP_BRIDGE_RUNTIME,
        "endpoint": endpoint,
        "ownerName": owner_name,
    });
    let response = send_request(
        bridge_client().post(url).json(&body),
        "Unable to register bridge node",
    )
    .await?;
    if !response.status().is_success() {
        return Err(bare_http_status_error(
            "Bridge registry registration",
            response.status(),
        ));
    }

    let registered = parse_json_response::<RegistryRegisterResponse>(
        response,
        "Unable to parse bridge registration response",
    )
    .await?;
    Ok((
        API_STYLE_REGISTRY.to_string(),
        registered.node_id,
        registered.token,
    ))
}

async fn register_node_serve(
    base_url: &str,
    display_name: &str,
    owner_name: &str,
    runtime: &str,
    human_id: Option<&str>,
    agent_id: Option<&str>,
    discovery_mode: Option<&str>,
    human_visibility_policy: Option<&str>,
    contact_approval_policy: Option<&str>,
    agent_reachability_policy: Option<&str>,
    is_default_agent: bool,
) -> Result<(String, String, String), String> {
    let url = format!("{}/v1/auth/register", trimmed_base_url(base_url));
    let agent_identity_id = agent_id.unwrap_or("default-agent");
    let (_signing, verifying) = load_or_create_bridge_identity_for_agent(agent_identity_id)?;
    let node_id = derive_node_id(&verifying);
    let x25519_pub = ed25519_to_x25519_public(verifying.as_bytes())?;
    let body = serde_json::json!({
        "nodeId": node_id,
        "ed25519Pubkey": bs58::encode(verifying.as_bytes()).into_string(),
        "x25519Pubkey": hex::encode(x25519_pub),
        "displayName": display_name,
        "ownerName": owner_name,
        "runtime": runtime,
        "humanId": human_id,
        "agentId": agent_id,
        "discoveryMode": discovery_mode,
        "humanVisibilityPolicy": human_visibility_policy,
        "contactApprovalPolicy": contact_approval_policy,
        "agentReachabilityPolicy": agent_reachability_policy,
        "isDefaultAgent": is_default_agent,
    });
    let response = send_request(
        bridge_client().post(url).json(&body),
        "Unable to register bridge node",
    )
    .await?;
    if !response.status().is_success() {
        return Err(response_error_with_body(
            response,
            "Bridge serve registration",
            "Bridge serve registration failed",
        )
        .await);
    }

    let registered = parse_json_response::<ServeRegisterResponse>(
        response,
        "Unable to parse bridge registration response",
    )
    .await?;
    Ok((
        API_STYLE_SERVE.to_string(),
        registered.node_id,
        registered.api_key,
    ))
}

pub(super) async fn register_bridge_host(
    base_url: &str,
    display_name: &str,
    owner_name: &str,
    endpoint: &str,
    runtime: &str,
    human_id: Option<&str>,
    agent_id: Option<&str>,
    discovery_mode: Option<&str>,
    human_visibility_policy: Option<&str>,
    contact_approval_policy: Option<&str>,
    agent_reachability_policy: Option<&str>,
    is_default_agent: bool,
    existing_api_style: Option<&str>,
    existing_node_id: Option<&str>,
) -> Result<(String, String, String), String> {
    let try_serve = || async {
        register_node_serve(
            base_url,
            display_name,
            owner_name,
            runtime,
            human_id,
            agent_id,
            discovery_mode,
            human_visibility_policy,
            contact_approval_policy,
            agent_reachability_policy,
            is_default_agent,
        )
        .await
    };

    if matches!(existing_api_style, Some(API_STYLE_SERVE)) {
        return try_serve().await;
    }
    if matches!(existing_api_style, Some(API_STYLE_REGISTRY)) {
        let registry_node_id = existing_node_id
            .map(ToString::to_string)
            .unwrap_or_else(generate_registry_node_id);
        return match register_node_registry(
            base_url,
            &registry_node_id,
            display_name,
            owner_name,
            endpoint,
        )
        .await
        {
            Ok(result) => Ok(result),
            Err(registry_err) => match try_serve().await {
                Ok(result) => Ok(result),
                Err(serve_err) => Err(format!(
                    "{}; fallback serve registration also failed: {}",
                    registry_err, serve_err
                )),
            },
        };
    }

    let registry_node_id = existing_node_id
        .map(ToString::to_string)
        .unwrap_or_else(generate_registry_node_id);
    if let Ok(result) = register_node_registry(
        base_url,
        &registry_node_id,
        display_name,
        owner_name,
        endpoint,
    )
    .await
    {
        return Ok(result);
    }
    try_serve().await
}

pub(super) async fn update_registered_registry_node(
    base_url: &str,
    api_key: &str,
    node_id: &str,
    display_name: &str,
    endpoint: &str,
) -> Result<(), String> {
    let url = format!("{}/nodes/{node_id}", trimmed_base_url(base_url));
    let body = serde_json::json!({
        "displayName": display_name,
        "runtime": DESKTOP_BRIDGE_RUNTIME,
        "endpoint": endpoint,
    });
    let response = send_request(
        bridge_client().patch(url).bearer_auth(api_key).json(&body),
        "Unable to update bridge node",
    )
    .await?;
    if !response.status().is_success() {
        return Err(response_error_with_body(
            response,
            "Unable to update bridge node",
            "Unable to update bridge node",
        )
        .await);
    }
    Ok(())
}

pub(super) async fn update_serve_discovery_mode(
    base_url: &str,
    api_key: &str,
    discovery_mode: &str,
    human_visibility_policy: Option<&str>,
    contact_approval_policy: Option<&str>,
    agent_reachability_policy: Option<&str>,
) -> Result<(), String> {
    let url = format!("{}/v1/discovery", trimmed_base_url(base_url));
    let response = send_request(
        bridge_client()
            .put(url)
            .bearer_auth(api_key)
            .json(&serde_json::json!({
                "discoveryMode": discovery_mode,
                "humanVisibilityPolicy": human_visibility_policy,
                "contactApprovalPolicy": contact_approval_policy,
                "agentReachabilityPolicy": agent_reachability_policy,
            })),
        "Unable to update bridge discovery mode",
    )
    .await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(response_error_with_body(
            response,
            "Bridge discovery update",
            "Unable to update bridge discovery mode",
        )
        .await)
    }
}

fn sort_peers_by_label<T>(
    peers: &mut [T],
    mut label: impl FnMut(&T) -> (&Option<String>, &Option<String>, &str),
) {
    peers.sort_by(|a, b| {
        let (a_display, a_owner, a_node) = label(a);
        let (b_display, b_owner, b_node) = label(b);
        a_display
            .as_deref()
            .or(a_owner.as_deref())
            .unwrap_or(a_node)
            .cmp(
                b_display
                    .as_deref()
                    .or(b_owner.as_deref())
                    .unwrap_or(b_node),
            )
    });
}

pub(super) async fn fetch_serve_discovery(
    base_url: &str,
    api_key: &str,
) -> Result<Vec<DesktopBridgePeer>, String> {
    let url = format!("{}/v1/discovery", trimmed_base_url(base_url));
    let response = send_request(
        bridge_client().get(url).bearer_auth(api_key),
        "Unable to list bridge discovery peers",
    )
    .await?;
    if !response.status().is_success() {
        return Err(http_status_error(
            "Unable to list bridge discovery peers",
            response.status(),
        ));
    }

    let mut peers = parse_json_response::<Vec<ServeDiscoveryItem>>(
        response,
        "Unable to parse bridge discovery peers",
    )
    .await?;
    sort_peers_by_label(&mut peers, |peer| {
        (&peer.display_name, &peer.owner_name, peer.node_id.as_str())
    });
    Ok(peers
        .into_iter()
        .map(|peer| DesktopBridgePeer {
            node_id: peer.node_id,
            display_name: peer.display_name,
            runtime: peer.runtime.unwrap_or_else(|| "bridge-agent".to_string()),
            endpoint: String::new(),
            owner_name: peer.owner_name,
            created_at: peer.created_at,
            shared_projects: Vec::new(),
            human_id: peer.human_id,
            agent_id: peer.agent_id,
            is_default_agent: peer.is_default_agent.unwrap_or(false),
            discovery_mode: peer.discovery_mode,
            human_visibility_policy: peer.human_visibility_policy,
            contact_approval_policy: peer.contact_approval_policy,
            agent_reachability_policy: peer.agent_reachability_policy,
            is_contact: false,
            contact_request_status: None,
            contact_request_direction: None,
        })
        .collect())
}

pub(super) async fn fetch_serve_contacts(
    base_url: &str,
    api_key: &str,
) -> Result<Vec<DesktopBridgePeer>, String> {
    let url = format!("{}/v1/contacts", trimmed_base_url(base_url));
    let response = send_request(
        bridge_client().get(url).bearer_auth(api_key),
        "Unable to list bridge contacts",
    )
    .await?;
    if !response.status().is_success() {
        return Err(http_status_error(
            "Unable to list bridge contacts",
            response.status(),
        ));
    }

    let mut contacts =
        parse_json_response::<Vec<ServeContactItem>>(response, "Unable to parse bridge contacts")
            .await?;
    sort_peers_by_label(&mut contacts, |contact| {
        (
            &contact.display_name,
            &contact.owner_name,
            contact.node_id.as_str(),
        )
    });
    Ok(contacts
        .into_iter()
        .map(|contact| DesktopBridgePeer {
            node_id: contact.node_id,
            display_name: contact.display_name,
            runtime: contact
                .runtime
                .unwrap_or_else(|| "bridge-contact".to_string()),
            endpoint: String::new(),
            owner_name: contact.owner_name,
            created_at: contact.created_at,
            shared_projects: Vec::new(),
            human_id: contact.human_id,
            agent_id: contact.agent_id,
            is_default_agent: contact.is_default_agent.unwrap_or(false),
            discovery_mode: contact.discovery_mode,
            human_visibility_policy: contact.human_visibility_policy,
            contact_approval_policy: contact.contact_approval_policy,
            agent_reachability_policy: contact.agent_reachability_policy,
            is_contact: true,
            contact_request_status: Some("contact".to_string()),
            contact_request_direction: None,
        })
        .collect())
}

pub(super) async fn fetch_serve_contact_requests(
    base_url: &str,
    api_key: &str,
) -> Result<Vec<DesktopBridgeContactRequest>, String> {
    let url = format!("{}/v1/contact-requests", trimmed_base_url(base_url));
    let response = send_request(
        bridge_client().get(url).bearer_auth(api_key),
        "Unable to list bridge contact requests",
    )
    .await?;
    if !response.status().is_success() {
        return Err(http_status_error(
            "Unable to list bridge contact requests",
            response.status(),
        ));
    }

    let requests = parse_json_response::<Vec<ServeContactRequestItem>>(
        response,
        "Unable to parse bridge contact requests",
    )
    .await?;
    Ok(requests
        .into_iter()
        .map(|request| DesktopBridgeContactRequest {
            request_id: request.request_id,
            requester_node_id: request.requester_node_id,
            target_node_id: request.target_node_id,
            status: request.status,
            message: request.message,
            created_at: request.created_at,
            decided_at: request.decided_at,
            direction: request.direction,
        })
        .collect())
}

pub(super) async fn approve_serve_contact_request(
    base_url: &str,
    api_key: &str,
    request_id: &str,
) -> Result<(), String> {
    let url = format!(
        "{}/v1/contact-requests/{request_id}/approve",
        trimmed_base_url(base_url)
    );
    let response = send_request(
        bridge_client().post(url).bearer_auth(api_key),
        "Unable to approve bridge contact request",
    )
    .await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(response_error_with_body(
            response,
            "Bridge contact request approval",
            "Unable to approve bridge contact request",
        )
        .await)
    }
}

pub(super) async fn reject_serve_contact_request(
    base_url: &str,
    api_key: &str,
    request_id: &str,
) -> Result<(), String> {
    let url = format!(
        "{}/v1/contact-requests/{request_id}/reject",
        trimmed_base_url(base_url)
    );
    let response = send_request(
        bridge_client().post(url).bearer_auth(api_key),
        "Unable to reject bridge contact request",
    )
    .await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(response_error_with_body(
            response,
            "Bridge contact request rejection",
            "Unable to reject bridge contact request",
        )
        .await)
    }
}

async fn fetch_serve_projects(
    base_url: &str,
    api_key: &str,
) -> Result<Vec<ServeProjectItem>, String> {
    let url = format!("{}/v1/projects", trimmed_base_url(base_url));
    let response = send_request(
        bridge_client().get(url).bearer_auth(api_key),
        "Unable to list bridge projects",
    )
    .await?;
    if !response.status().is_success() {
        return Err(http_status_error(
            "Unable to list bridge projects",
            response.status(),
        ));
    }

    parse_json_response::<Vec<ServeProjectItem>>(response, "Unable to parse bridge projects").await
}

async fn fetch_serve_project_members(
    base_url: &str,
    api_key: &str,
    project_id: &str,
) -> Result<Vec<ServeProjectMemberItem>, String> {
    let url = format!(
        "{}/v1/projects/{project_id}/members",
        trimmed_base_url(base_url)
    );
    let response = send_request(
        bridge_client().get(url).bearer_auth(api_key),
        "Unable to list bridge project members",
    )
    .await?;
    if !response.status().is_success() {
        return Err(http_status_error(
            "Unable to list bridge project members",
            response.status(),
        ));
    }

    parse_json_response::<Vec<ServeProjectMemberItem>>(
        response,
        "Unable to parse bridge project members",
    )
    .await
}

pub(super) async fn fetch_registry_visible_nodes(
    base_url: &str,
    api_key: &str,
) -> Result<Vec<DesktopBridgePeer>, String> {
    let url = format!("{}/nodes", trimmed_base_url(base_url));
    let response = send_request(
        bridge_client().get(url).bearer_auth(api_key),
        "Unable to list visible bridge nodes",
    )
    .await?;
    if !response.status().is_success() {
        return Err(http_status_error(
            "Unable to list visible bridge nodes",
            response.status(),
        ));
    }

    let mut nodes =
        parse_json_response::<Vec<NodeListItem>>(response, "Unable to parse bridge node list")
            .await?;
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
            human_id: None,
            agent_id: None,
            is_default_agent: false,
            discovery_mode: None,
            human_visibility_policy: None,
            contact_approval_policy: None,
            agent_reachability_policy: None,
            is_contact: false,
            contact_request_status: None,
            contact_request_direction: None,
        })
        .collect())
}

fn ensure_peer_index(
    peers: &mut Vec<DesktopBridgePeer>,
    index: &mut std::collections::HashMap<String, usize>,
    member: &ServeProjectMemberItem,
) -> usize {
    if let Some(existing) = index.get(&member.node_id).copied() {
        return existing;
    }

    peers.push(DesktopBridgePeer {
        node_id: member.node_id.clone(),
        display_name: member.display_name.clone(),
        runtime: member
            .agent_role
            .clone()
            .unwrap_or_else(|| "project-member".to_string()),
        endpoint: String::new(),
        owner_name: None,
        created_at: None,
        shared_projects: Vec::new(),
        human_id: None,
        agent_id: None,
        is_default_agent: false,
        discovery_mode: None,
        human_visibility_policy: None,
        contact_approval_policy: None,
        agent_reachability_policy: None,
        is_contact: false,
        contact_request_status: None,
        contact_request_direction: None,
    });
    let idx = peers.len() - 1;
    index.insert(member.node_id.clone(), idx);
    idx
}

pub(super) async fn augment_peers_with_project_membership(
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
            let idx = ensure_peer_index(peers, &mut index, &member);
            let peer = &mut peers[idx];
            if peer.display_name.is_none() {
                peer.display_name = member.display_name.clone();
            }
            if !peer
                .shared_projects
                .iter()
                .any(|name| name == &project_name)
            {
                peer.shared_projects.push(project_name.clone());
                peer.shared_projects.sort();
            }
        }
    }

    host_projects.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(host_projects)
}

pub(super) async fn create_serve_project(
    base_url: &str,
    api_key: &str,
    slug: &str,
    display_name: Option<&str>,
    description: Option<&str>,
) -> Result<ServeCreateProjectResponse, String> {
    let url = format!("{}/v1/projects", trimmed_base_url(base_url));
    let response = send_request(
        bridge_client()
            .post(url)
            .bearer_auth(api_key)
            .json(&serde_json::json!({
                "slug": slug,
                "displayName": display_name,
                "description": description,
            })),
        "Unable to create bridge project",
    )
    .await?;
    if !response.status().is_success() {
        return Err(response_error_with_body(
            response,
            "Unable to create bridge project",
            "Unable to create bridge project",
        )
        .await);
    }

    parse_json_response::<ServeCreateProjectResponse>(
        response,
        "Unable to parse bridge project response",
    )
    .await
}

pub(super) async fn create_serve_invite(
    base_url: &str,
    api_key: &str,
    project_id: &str,
    max_uses: Option<i64>,
) -> Result<ServeCreateInviteResponse, String> {
    let url = format!(
        "{}/v1/projects/{project_id}/invites",
        trimmed_base_url(base_url)
    );
    let response = send_request(
        bridge_client()
            .post(url)
            .bearer_auth(api_key)
            .json(&serde_json::json!({ "maxUses": max_uses })),
        "Unable to create bridge invite",
    )
    .await?;
    if !response.status().is_success() {
        return Err(response_error_with_body(
            response,
            "Unable to create bridge invite",
            "Unable to create bridge invite",
        )
        .await);
    }

    parse_json_response::<ServeCreateInviteResponse>(
        response,
        "Unable to parse bridge invite response",
    )
    .await
}

pub(super) async fn join_serve_project(
    base_url: &str,
    api_key: &str,
    project_id: &str,
    invite_token: &str,
    agent_role: Option<&str>,
) -> Result<(), String> {
    let url = format!(
        "{}/v1/projects/{project_id}/join",
        trimmed_base_url(base_url)
    );
    let response = send_request(
        bridge_client()
            .post(url)
            .bearer_auth(api_key)
            .json(&serde_json::json!({
                "inviteToken": invite_token,
                "agentRole": agent_role,
            })),
        "Unable to join bridge project",
    )
    .await?;
    if !response.status().is_success() {
        return Err(response_error_with_body(
            response,
            "Unable to join bridge project",
            "Unable to join bridge project",
        )
        .await);
    }
    Ok(())
}

pub(super) async fn add_serve_contact(
    base_url: &str,
    api_key: &str,
    peer_node_id: &str,
    message: Option<&str>,
) -> Result<(), String> {
    let response = if let Some(message) = message.map(str::trim).filter(|value| !value.is_empty()) {
        let url = format!(
            "{}/v1/contact-requests/{peer_node_id}",
            trimmed_base_url(base_url)
        );
        send_request(
            bridge_client()
                .post(url)
                .bearer_auth(api_key)
                .json(&serde_json::json!({ "message": message })),
            "Unable to add bridge contact",
        )
        .await?
    } else {
        let url = format!("{}/v1/contacts/{peer_node_id}", trimmed_base_url(base_url));
        send_request(
            bridge_client().put(url).bearer_auth(api_key),
            "Unable to add bridge contact",
        )
        .await?
    };
    if !response.status().is_success() {
        return Err(response_error_with_body(
            response,
            "Unable to add bridge contact",
            "Unable to add bridge contact",
        )
        .await);
    }
    Ok(())
}

pub(super) async fn remove_serve_contact(
    base_url: &str,
    api_key: &str,
    peer_node_id: &str,
) -> Result<(), String> {
    let url = format!("{}/v1/contacts/{peer_node_id}", trimmed_base_url(base_url));
    let response = send_request(
        bridge_client().delete(url).bearer_auth(api_key),
        "Unable to remove bridge contact",
    )
    .await?;
    if !response.status().is_success() {
        return Err(response_error_with_body(
            response,
            "Unable to remove bridge contact",
            "Unable to remove bridge contact",
        )
        .await);
    }
    Ok(())
}

pub(super) async fn poll_mailbox_v2(
    base_url: &str,
    api_key: &str,
    after: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<AckedMailboxEntry>, String> {
    let url = format!("{}/v1/mailbox/poll", trimmed_base_url(base_url));
    let response = send_request(
        bridge_client()
            .post(url)
            .bearer_auth(api_key)
            .json(&AckedMailboxPollRequest { after, limit }),
        "Unable to poll bridge mailbox",
    )
    .await?;
    if !response.status().is_success() {
        return Err(http_status_error(
            "Unable to poll bridge mailbox",
            response.status(),
        ));
    }

    parse_json_response::<AckedMailboxPollResponse>(response, "Unable to parse bridge mailbox poll")
        .await
        .map(|response| response.entries)
}

pub(super) async fn ack_mailbox_v2(
    base_url: &str,
    api_key: &str,
    message_ids: &[String],
) -> Result<(), String> {
    let url = format!("{}/v1/mailbox/ack", trimmed_base_url(base_url));
    let response = send_request(
        bridge_client()
            .post(url)
            .bearer_auth(api_key)
            .json(&AckedMailboxAckRequest { message_ids }),
        "Unable to acknowledge bridge mailbox",
    )
    .await?;
    if !response.status().is_success() {
        return Err(http_status_error(
            "Unable to acknowledge bridge mailbox",
            response.status(),
        ));
    }
    Ok(())
}

pub(super) async fn fetch_mailbox(
    base_url: &str,
    api_key: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("{}/v1/mailbox", trimmed_base_url(base_url));
    let response = send_request(
        bridge_client().post(url).bearer_auth(api_key),
        "Unable to fetch bridge mailbox",
    )
    .await?;
    if !response.status().is_success() {
        return Err(http_status_error(
            "Unable to fetch bridge mailbox",
            response.status(),
        ));
    }

    parse_json_response::<Vec<serde_json::Value>>(response, "Unable to parse bridge mailbox").await
}

pub(super) fn relay_target_kind_for_payload(payload: &serde_json::Value) -> Option<&'static str> {
    let message_type = payload
        .get("messageType")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let payload_body = payload.get("payload");
    let session_thread = payload_body.and_then(|value| value.get("sessionThread"));
    let group_scoped_session_thread = session_thread.is_some_and(|thread| {
        thread
            .get("parentSessionKind")
            .and_then(|value| value.as_str())
            .is_some_and(|kind| kind.eq_ignore_ascii_case("group"))
            || thread
                .get("parentGroupSpaceId")
                .and_then(|value| value.as_str())
                .is_some_and(|value| !value.trim().is_empty())
    });
    if message_type.eq_ignore_ascii_case("ask") {
        return Some("agent");
    }
    if message_type.eq_ignore_ascii_case("response") {
        return Some(if group_scoped_session_thread {
            "session-participant"
        } else {
            "person"
        });
    }
    let target_kind = session_thread
        .and_then(|value| value.get("targetKind"))
        .and_then(|value| value.as_str())
        .or_else(|| payload.get("targetKind").and_then(|value| value.as_str()))
        .unwrap_or_default();
    let context_policy = payload_body
        .and_then(|value| value.get("contextPolicy"))
        .or_else(|| session_thread.and_then(|value| value.get("contextPolicy")))
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    match (target_kind, context_policy, group_scoped_session_thread) {
        ("bridge-agent", _, _) => Some("agent"),
        ("bridge-person", "session-invite", _) => Some("person-invite"),
        ("bridge-person", _, true) => Some("session-participant"),
        ("bridge-person", _, _) => Some("person"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_session_message_payload_uses_session_participant_key_access() {
        let payload = serde_json::json!({
            "messageType": "raw",
            "payload": {
                "message": "hello group",
                "sessionThread": {
                    "targetKind": "bridge-person",
                    "contextPolicy": "session-message",
                    "parentSessionKind": "group",
                    "parentGroupSpaceId": "session:group:root"
                }
            }
        });

        assert_eq!(relay_target_kind_for_payload(&payload), Some("session-participant"));
    }

    #[test]
    fn response_payload_uses_person_key_access_even_when_original_target_was_agent() {
        let payload = serde_json::json!({
            "messageType": "response",
            "payload": {
                "message": "hello",
                "done": true,
                "sessionThread": {
                    "targetKind": "bridge-agent",
                    "contextPolicy": "session-message"
                }
            }
        });

        assert_eq!(relay_target_kind_for_payload(&payload), Some("person"));
    }
}

pub(super) async fn relay_plaintext_message(
    host: &DesktopBridgeHostConfig,
    target_node_id: &str,
    project_id: Option<&str>,
    payload: &serde_json::Value,
) -> Result<(), String> {
    let target_kind = relay_target_kind_for_payload(payload);
    let encrypted_payload =
        encrypt_bridge_payload_for_target(host, target_node_id, project_id, target_kind, payload)
            .await?;
    let blob = base64::engine::general_purpose::STANDARD
        .encode(serde_json::to_vec(&encrypted_payload).map_err(|err| err.to_string())?);
    let url = format!("{}/v1/relay", trimmed_base_url(&host.coordination));
    let body = serde_json::json!({
        "targetNodeId": target_node_id,
        "blob": blob,
        "projectId": project_id,
        "targetKind": target_kind,
    });
    let response = send_request(
        bridge_client()
            .post(url)
            .bearer_auth(&host.api_key)
            .json(&body),
        "Unable to relay bridge message",
    )
    .await?;
    if !response.status().is_success() {
        return Err(response_error_with_body(
            response,
            "Unable to relay bridge message",
            "Unable to relay bridge message",
        )
        .await);
    }
    Ok(())
}
