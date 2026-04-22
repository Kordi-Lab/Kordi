use base64::Engine as _;
use reqwest::{Client, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde::Deserialize;

use super::constants::{API_STYLE_REGISTRY, API_STYLE_SERVE, DESKTOP_BRIDGE_RUNTIME};
use super::storage::{
    derive_node_id, ed25519_to_x25519_public, load_or_create_bridge_identity_for_agent,
};
use super::{generate_registry_node_id, DesktopBridgePeer, DesktopBridgeProject};

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
}

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
) -> Result<(), String> {
    let url = format!("{}/v1/discovery", trimmed_base_url(base_url));
    let response = send_request(
        bridge_client()
            .put(url)
            .bearer_auth(api_key)
            .json(&serde_json::json!({
                "discoveryMode": discovery_mode,
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
        })
        .collect())
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
) -> Result<(), String> {
    let url = format!("{}/v1/contacts/{peer_node_id}", trimmed_base_url(base_url));
    let response = send_request(
        bridge_client().put(url).bearer_auth(api_key),
        "Unable to add bridge contact",
    )
    .await?;
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

pub(super) async fn relay_plaintext_message(
    base_url: &str,
    api_key: &str,
    target_node_id: &str,
    project_id: Option<&str>,
    payload: &serde_json::Value,
) -> Result<(), String> {
    let blob = base64::engine::general_purpose::STANDARD
        .encode(serde_json::to_vec(payload).map_err(|err| err.to_string())?);
    let url = format!("{}/v1/relay", trimmed_base_url(base_url));
    let body = serde_json::json!({
        "targetNodeId": target_node_id,
        "blob": blob,
        "projectId": project_id,
    });
    let response = send_request(
        bridge_client().post(url).bearer_auth(api_key).json(&body),
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
