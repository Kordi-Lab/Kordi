use base64::Engine as _;
use rusqlite::Connection;
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

pub(super) async fn register_node_registry(
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
    Err(format!(
        "Bridge registry registration HTTP {}",
        response.status()
    ))
}

pub(super) async fn register_node_serve(
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

async fn fetch_serve_projects(
    base_url: &str,
    api_key: &str,
) -> Result<Vec<ServeProjectItem>, String> {
    let url = format!("{}/v1/projects", base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .get(url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|err| format!("Unable to list bridge projects: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Unable to list bridge projects: HTTP {}",
            response.status()
        ));
    }
    response
        .json::<Vec<ServeProjectItem>>()
        .await
        .map_err(|err| format!("Unable to parse bridge projects: {err}"))
}

async fn fetch_serve_project_members(
    base_url: &str,
    api_key: &str,
    project_id: &str,
) -> Result<Vec<ServeProjectMemberItem>, String> {
    let url = format!(
        "{}/v1/projects/{}/members",
        base_url.trim_end_matches('/'),
        project_id
    );
    let response = reqwest::Client::new()
        .get(url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|err| format!("Unable to list bridge project members: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Unable to list bridge project members: HTTP {}",
            response.status()
        ));
    }
    response
        .json::<Vec<ServeProjectMemberItem>>()
        .await
        .map_err(|err| format!("Unable to parse bridge project members: {err}"))
}

pub(super) async fn fetch_registry_visible_nodes(
    base_url: &str,
    api_key: &str,
) -> Result<Vec<DesktopBridgePeer>, String> {
    let url = format!("{}/nodes", base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .get(url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|err| format!("Unable to list visible bridge nodes: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Unable to list visible bridge nodes: HTTP {}",
            response.status()
        ));
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
            let idx = if let Some(existing) = index.get(&member.node_id).copied() {
                existing
            } else {
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
            };

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
    response
        .json::<ServeCreateProjectResponse>()
        .await
        .map_err(|err| format!("Unable to parse bridge project response: {err}"))
}

pub(super) async fn create_serve_invite(
    base_url: &str,
    api_key: &str,
    project_id: &str,
    max_uses: Option<i64>,
) -> Result<ServeCreateInviteResponse, String> {
    let url = format!(
        "{}/v1/projects/{}/invites",
        base_url.trim_end_matches('/'),
        project_id
    );
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
    response
        .json::<ServeCreateInviteResponse>()
        .await
        .map_err(|err| format!("Unable to parse bridge invite response: {err}"))
}

pub(super) async fn join_serve_project(
    base_url: &str,
    api_key: &str,
    project_id: &str,
    invite_token: &str,
    agent_role: Option<&str>,
) -> Result<(), String> {
    let url = format!(
        "{}/v1/projects/{}/join",
        base_url.trim_end_matches('/'),
        project_id
    );
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

pub(super) async fn fetch_mailbox(
    base_url: &str,
    api_key: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("{}/v1/mailbox", base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|err| format!("Unable to fetch bridge mailbox: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Unable to fetch bridge mailbox: HTTP {}",
            response.status()
        ));
    }
    response
        .json::<Vec<serde_json::Value>>()
        .await
        .map_err(|err| format!("Unable to parse bridge mailbox: {err}"))
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
