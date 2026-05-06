use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{middleware, Extension, Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::auth::{auth_middleware, AuthNode};
use super::{
    effective_agent_reachability_policy, effective_contact_approval_policy,
    effective_human_visibility_policy, nodes_share_human_owner,
    normalize_agent_reachability_policy, normalize_contact_approval_policy,
    normalize_human_visibility_policy, ServerState,
};

#[derive(Debug, Serialize)]
pub struct DiscoveryResp {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "ownerName")]
    pub owner_name: Option<String>,
    pub runtime: Option<String>,
    #[serde(rename = "humanId")]
    pub human_id: Option<String>,
    #[serde(rename = "agentId")]
    pub agent_id: Option<String>,
    #[serde(rename = "isDefaultAgent")]
    pub is_default_agent: bool,
    #[serde(rename = "discoveryMode")]
    pub discovery_mode: Option<String>,
    #[serde(rename = "humanVisibilityPolicy")]
    pub human_visibility_policy: String,
    #[serde(rename = "contactApprovalPolicy")]
    pub contact_approval_policy: String,
    #[serde(rename = "agentReachabilityPolicy")]
    pub agent_reachability_policy: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateDiscoveryReq {
    #[serde(rename = "discoveryMode")]
    pub discovery_mode: String,
    #[serde(rename = "humanVisibilityPolicy")]
    pub human_visibility_policy: Option<String>,
    #[serde(rename = "contactApprovalPolicy")]
    pub contact_approval_policy: Option<String>,
    #[serde(rename = "agentReachabilityPolicy")]
    pub agent_reachability_policy: Option<String>,
}

pub fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route(
            "/v1/discovery",
            get(list_discoverable_peers).put(update_my_discovery),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .with_state(state)
}

fn mask_owner_only_agent_for_viewer(peer: &mut DiscoveryResp) {
    peer.display_name = peer
        .owner_name
        .clone()
        .or_else(|| peer.display_name.clone());
    peer.runtime = Some("person".to_string());
    peer.agent_id = None;
    peer.is_default_agent = false;
}

async fn list_discoverable_peers(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
) -> Result<Json<Vec<DiscoveryResp>>, StatusCode> {
    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let peers: Vec<DiscoveryResp> = {
        let mut stmt = db
            .prepare(
                "SELECT node_id, display_name, owner_name, runtime, human_id, agent_id, is_default_agent, discovery_mode, human_visibility_policy, contact_approval_policy, agent_reachability_policy, created_at \
             FROM registered_nodes \
             WHERE revoked_at IS NULL AND node_id != ?1 \
             ORDER BY COALESCE(display_name, owner_name, node_id) ASC, created_at ASC",
            )
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let rows = stmt
            .query_map(rusqlite::params![auth.0.as_str()], |row| {
                let discovery_mode = row.get::<_, Option<String>>(7)?;
                let raw_human_visibility_policy = row.get::<_, Option<String>>(8)?;
                let raw_contact_approval_policy = row.get::<_, Option<String>>(9)?;
                let raw_agent_reachability_policy = row.get::<_, Option<String>>(10)?;
                let human_visibility_policy = effective_human_visibility_policy(
                    discovery_mode.as_deref(),
                    raw_human_visibility_policy.as_deref(),
                );
                let contact_approval_policy =
                    effective_contact_approval_policy(raw_contact_approval_policy.as_deref());
                let agent_reachability_policy =
                    effective_agent_reachability_policy(raw_agent_reachability_policy.as_deref());
                Ok(DiscoveryResp {
                    node_id: row.get(0)?,
                    display_name: row.get(1)?,
                    owner_name: row.get(2)?,
                    runtime: row.get(3)?,
                    human_id: row.get(4)?,
                    agent_id: row.get(5)?,
                    is_default_agent: row.get::<_, Option<i64>>(6)?.unwrap_or(0) != 0,
                    discovery_mode,
                    human_visibility_policy,
                    contact_approval_policy,
                    agent_reachability_policy,
                    created_at: row.get(11)?,
                })
            })
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        rows.filter_map(|row| row.ok())
            .filter(|peer| {
                matches!(
                    peer.human_visibility_policy.as_str(),
                    "server-open" | "server-approval"
                )
            })
            .collect()
    };
    let mut visible_peers = Vec::with_capacity(peers.len());
    for mut peer in peers {
        let target_is_agent = peer
            .agent_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
        let owner_only_for_viewer = target_is_agent
            && peer.agent_reachability_policy == "owner"
            && !nodes_share_human_owner(&db, &auth.0, &peer.node_id)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if owner_only_for_viewer {
            if peer.is_default_agent {
                mask_owner_only_agent_for_viewer(&mut peer);
                visible_peers.push(peer);
            }
            continue;
        }
        visible_peers.push(peer);
    }
    Ok(Json(visible_peers))
}

async fn update_my_discovery(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Json(req): Json<UpdateDiscoveryReq>,
) -> Result<StatusCode, StatusCode> {
    let discovery_mode = req.discovery_mode.trim().to_lowercase();
    if !matches!(discovery_mode.as_str(), "off" | "contacts" | "open") {
        return Err(StatusCode::BAD_REQUEST);
    }

    let human_visibility_policy = match req.human_visibility_policy.as_deref() {
        Some(policy) => normalize_human_visibility_policy(policy).ok_or(StatusCode::BAD_REQUEST)?,
        None => effective_human_visibility_policy(Some(discovery_mode.as_str()), None),
    };
    let contact_approval_policy = match req.contact_approval_policy.as_deref() {
        Some(policy) => normalize_contact_approval_policy(policy).ok_or(StatusCode::BAD_REQUEST)?,
        None => effective_contact_approval_policy(None),
    };
    let agent_reachability_policy = match req.agent_reachability_policy.as_deref() {
        Some(policy) => {
            normalize_agent_reachability_policy(policy).ok_or(StatusCode::BAD_REQUEST)?
        }
        None => effective_agent_reachability_policy(None),
    };

    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    db.execute(
        "UPDATE registered_nodes SET discovery_mode = ?1, human_visibility_policy = ?2, contact_approval_policy = ?3, agent_reachability_policy = ?4 WHERE node_id = ?5 AND revoked_at IS NULL",
        rusqlite::params![
            discovery_mode,
            human_visibility_policy,
            contact_approval_policy,
            agent_reachability_policy,
            auth.0,
        ],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_node(state: &Arc<ServerState>, node_id: &str, discovery_mode: &str) {
        seed_node_with_policy(state, node_id, discovery_mode, None);
    }

    fn seed_node_with_policy(
        state: &Arc<ServerState>,
        node_id: &str,
        discovery_mode: &str,
        human_visibility_policy: Option<&str>,
    ) {
        let db = state.open_connection().unwrap();
        db.execute(
            "INSERT INTO registered_nodes (node_id, ed25519_pubkey, x25519_pubkey, display_name, owner_name, runtime, human_id, agent_id, discovery_mode, human_visibility_policy, is_default_agent, api_key_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            rusqlite::params![
                node_id,
                format!("ed_{node_id}"),
                format!("x_{node_id}"),
                format!("display-{node_id}"),
                format!("owner-{node_id}"),
                "generic",
                format!("kh_{node_id}"),
                format!("ka_{node_id}"),
                discovery_mode,
                human_visibility_policy,
                1,
                format!("hash_{node_id}"),
                chrono::Utc::now().to_rfc3339(),
            ],
        )
        .unwrap();
    }

    #[tokio::test]
    async fn list_discovery_masks_owner_only_agents_for_other_humans() {
        let state = super::super::make_test_state();
        seed_node(&state, "kd_viewer", "open");
        seed_node_with_policy(&state, "kd_owner_agent", "open", Some("server-approval"));
        seed_node_with_policy(
            &state,
            "kd_secondary_owner_agent",
            "open",
            Some("server-approval"),
        );
        state
            .open_connection()
            .unwrap()
            .execute(
                "UPDATE registered_nodes
                 SET display_name = 'Owner Kordi', owner_name = 'Owner', runtime = 'kordi-desktop', human_id = 'kh_owner', agent_id = 'ka_owner', is_default_agent = 1, agent_reachability_policy = 'owner'
                 WHERE node_id = 'kd_owner_agent'",
                [],
            )
            .unwrap();
        state
            .open_connection()
            .unwrap()
            .execute(
                "UPDATE registered_nodes
                 SET display_name = 'Private Helper', owner_name = 'Owner', runtime = 'kordi-desktop', human_id = 'kh_owner', agent_id = 'ka_private', is_default_agent = 0, agent_reachability_policy = 'owner'
                 WHERE node_id = 'kd_secondary_owner_agent'",
                [],
            )
            .unwrap();

        let peers =
            list_discoverable_peers(State(state), Extension(AuthNode("kd_viewer".to_string())))
                .await
                .unwrap()
                .0;
        let peer = peers
            .iter()
            .find(|peer| peer.node_id == "kd_owner_agent")
            .expect("owner-only default agent remains discoverable as a person");

        assert_eq!(peer.runtime.as_deref(), Some("person"));
        assert_eq!(peer.display_name.as_deref(), Some("Owner"));
        assert_eq!(peer.owner_name.as_deref(), Some("Owner"));
        assert_eq!(peer.agent_id.as_deref(), None);
        assert!(!peer.is_default_agent);
        assert!(!peers
            .iter()
            .any(|peer| peer.node_id == "kd_secondary_owner_agent"));
    }

    #[tokio::test]
    async fn list_discovery_returns_visible_policies_and_excludes_private() {
        let state = super::super::make_test_state();
        seed_node(&state, "kd_self", "open");
        seed_node_with_policy(&state, "kd_server_open", "open", Some("server-open"));
        seed_node_with_policy(
            &state,
            "kd_server_approval",
            "open",
            Some("server-approval"),
        );
        seed_node_with_policy(&state, "kd_private", "open", Some("private"));
        seed_node(&state, "kd_legacy_open", "open");
        seed_node(&state, "kd_legacy_contacts", "contacts");

        let peers =
            list_discoverable_peers(State(state), Extension(AuthNode("kd_self".to_string())))
                .await
                .unwrap()
                .0;
        let ids = peers
            .iter()
            .map(|peer| peer.node_id.as_str())
            .collect::<Vec<_>>();

        assert!(ids.contains(&"kd_server_open"));
        assert!(ids.contains(&"kd_server_approval"));
        assert!(ids.contains(&"kd_legacy_open"));
        assert!(!ids.contains(&"kd_private"));
        assert!(!ids.contains(&"kd_legacy_contacts"));
    }
}
