use base64::Engine as _;
use reqwest::{Client, Response, StatusCode};
use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde::Deserialize;

use super::{
    derive_node_id, ed25519_to_x25519_public, generate_registry_node_id,
    load_or_create_bridge_identity, DesktopBridgePeer, DesktopBridgeProject,
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

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ServeCreateProjectResponse {
    project_id: String,
    slug: String,
    display_name: Option<String>,
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

pub(super) async fn register_node_registry(
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
        "runtime": "kordi-desktop",
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
    Ok(("registry".to_string(), registered.node_id, registered.token))
}

pub(super) async fn register_node_serve(
    base_url: &str,
    display_name: &str,
    owner_name: &str,
) -> Result<(String, String, String), String> {
    let url = format!("{}/v1/auth/register", trimmed_base_url(base_url));
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
    Ok(("serve".to_string(), registered.node_id, registered.api_key))
}

pub(super) async fn register_bridge_host(
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
        )
        .await;
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
    register_node_serve(base_url, display_name, owner_name).await
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
        "runtime": "kordi-desktop",
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
        })
        .collect())
}

pub(super) fn fetch_local_registered_nodes(
    db_path: &str,
    own_node_id: &str,
) -> Result<Vec<DesktopBridgePeer>, String> {
    let conn = Connection::open(db_path)
        .map_err(|err| format!("Unable to open local bridge database: {err}"))?;
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
