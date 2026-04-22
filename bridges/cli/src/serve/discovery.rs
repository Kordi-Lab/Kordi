use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{middleware, Extension, Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::auth::{auth_middleware, AuthNode};
use super::ServerState;

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
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateDiscoveryReq {
    #[serde(rename = "discoveryMode")]
    pub discovery_mode: String,
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

async fn list_discoverable_peers(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
) -> Result<Json<Vec<DiscoveryResp>>, StatusCode> {
    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut stmt = db
        .prepare(
            "SELECT node_id, display_name, owner_name, runtime, human_id, agent_id, is_default_agent, discovery_mode, created_at \
             FROM registered_nodes \
             WHERE revoked_at IS NULL AND node_id != ?1 AND discovery_mode = 'open' \
             ORDER BY COALESCE(display_name, owner_name, node_id) ASC, created_at ASC",
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let peers = stmt
        .query_map(rusqlite::params![auth.0], |row| {
            Ok(DiscoveryResp {
                node_id: row.get(0)?,
                display_name: row.get(1)?,
                owner_name: row.get(2)?,
                runtime: row.get(3)?,
                human_id: row.get(4)?,
                agent_id: row.get(5)?,
                is_default_agent: row.get::<_, Option<i64>>(6)?.unwrap_or(0) != 0,
                discovery_mode: row.get(7)?,
                created_at: row.get(8)?,
            })
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .filter_map(|row| row.ok())
        .collect();
    Ok(Json(peers))
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

    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    db.execute(
        "UPDATE registered_nodes SET discovery_mode = ?1 WHERE node_id = ?2 AND revoked_at IS NULL",
        rusqlite::params![discovery_mode, auth.0],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_node(state: &Arc<ServerState>, node_id: &str, discovery_mode: &str) {
        let db = state.open_connection().unwrap();
        db.execute(
            "INSERT INTO registered_nodes (node_id, ed25519_pubkey, x25519_pubkey, display_name, owner_name, runtime, human_id, agent_id, discovery_mode, is_default_agent, api_key_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
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
                1,
                format!("hash_{node_id}"),
                chrono::Utc::now().to_rfc3339(),
            ],
        )
        .unwrap();
    }

    #[tokio::test]
    async fn list_discovery_only_returns_open_peers() {
        let state = super::super::make_test_state();
        seed_node(&state, "kd_self", "open");
        seed_node(&state, "kd_open", "open");
        seed_node(&state, "kd_private", "contacts");

        let peers =
            list_discoverable_peers(State(state), Extension(AuthNode("kd_self".to_string())))
                .await
                .unwrap()
                .0;

        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].node_id, "kd_open");
    }
}
