use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{middleware, Extension, Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::auth::{auth_middleware, AuthNode};
use super::ServerState;

#[derive(Debug, Serialize, Deserialize)]
pub struct EndpointHint {
    pub addr: String,
    #[serde(rename = "hintType")]
    pub hint_type: String,
}

pub fn routes(state: Arc<ServerState>) -> Router {
    // All endpoint lookups require authentication
    Router::new()
        .route("/v1/endpoints/:node_id", get(get_endpoints))
        .route("/v1/endpoints", put(update_endpoints))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .with_state(state)
}

/// Get a node's endpoint hints. Requires auth — caller must share
/// at least one project with the target node.
async fn get_endpoints(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Path(node_id): Path<String>,
) -> Result<Json<Vec<EndpointHint>>, StatusCode> {
    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // Verify caller shares at least one project with the target node
    let shares_project: bool = db
        .query_row(
            "SELECT 1 FROM server_members m1 \
             JOIN server_members m2 ON m1.project_id = m2.project_id \
             WHERE m1.node_id = ?1 AND m2.node_id = ?2 LIMIT 1",
            rusqlite::params![auth.0, node_id],
            |_| Ok(()),
        )
        .is_ok();
    if !shares_project {
        return Err(StatusCode::FORBIDDEN);
    }
    let hints_json: String = db
        .query_row(
            "SELECT endpoint_hints FROM registered_nodes WHERE node_id = ?1 AND revoked_at IS NULL",
            rusqlite::params![node_id],
            |row| row.get(0),
        )
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let hints: Vec<EndpointHint> = serde_json::from_str(&hints_json).unwrap_or_default();
    Ok(Json(hints))
}

async fn update_endpoints(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Json(hints): Json<Vec<EndpointHint>>,
) -> Result<StatusCode, StatusCode> {
    let json = serde_json::to_string(&hints).map_err(|_| StatusCode::BAD_REQUEST)?;
    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    db.execute(
        "UPDATE registered_nodes SET endpoint_hints = ?1 WHERE node_id = ?2",
        rusqlite::params![json, auth.0],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::OK)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_project_membership(state: &Arc<ServerState>, project_id: &str, node_ids: &[&str]) {
        let db = state.open_connection().unwrap();
        db.execute(
            "INSERT INTO server_projects (project_id, slug, display_name, description, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![project_id, project_id, project_id, Option::<String>::None, node_ids[0], chrono::Utc::now().to_rfc3339()],
        )
        .unwrap();
        for node_id in node_ids {
            db.execute(
                "INSERT INTO server_members (project_id, node_id, agent_role, joined_at) VALUES (?1, ?2, 'member', ?3)",
                rusqlite::params![project_id, node_id, chrono::Utc::now().to_rfc3339()],
            )
            .unwrap();
        }
    }

    fn seed_endpoint_hints(state: &Arc<ServerState>, node_id: &str, hints: &[EndpointHint]) {
        let db = state.open_connection().unwrap();
        db.execute(
            "INSERT INTO registered_nodes (node_id, ed25519_pubkey, x25519_pubkey, display_name, owner_name, api_key_hash, endpoint_hints, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                node_id,
                "ed_pub",
                "x_pub",
                Option::<String>::None,
                Option::<String>::None,
                "hash",
                serde_json::to_string(hints).unwrap(),
                chrono::Utc::now().to_rfc3339(),
            ],
        )
        .unwrap();
    }

    #[tokio::test]
    async fn get_endpoints_requires_shared_project() {
        let state = super::super::make_test_state();
        seed_endpoint_hints(
            &state,
            "kd_target",
            &[EndpointHint {
                addr: "198.51.100.10:7000".to_string(),
                hint_type: "stun".to_string(),
            }],
        );

        let result = get_endpoints(
            State(state),
            Extension(AuthNode("kd_viewer".to_string())),
            Path("kd_target".to_string()),
        )
        .await;

        assert_eq!(result.unwrap_err(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn get_endpoints_hides_revoked_nodes() {
        let state = super::super::make_test_state();
        seed_project_membership(&state, "proj_privacy", &["kd_viewer", "kd_target"]);
        seed_endpoint_hints(
            &state,
            "kd_target",
            &[EndpointHint {
                addr: "198.51.100.10:7000".to_string(),
                hint_type: "stun".to_string(),
            }],
        );
        let db = state.open_connection().unwrap();
        db.execute(
            "UPDATE registered_nodes SET revoked_at = ?1 WHERE node_id = ?2",
            rusqlite::params![chrono::Utc::now().to_rfc3339(), "kd_target"],
        )
        .unwrap();

        let result = get_endpoints(
            State(state),
            Extension(AuthNode("kd_viewer".to_string())),
            Path("kd_target".to_string()),
        )
        .await;

        assert_eq!(result.unwrap_err(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn get_endpoints_returns_hints_to_shared_project_member() {
        let state = super::super::make_test_state();
        seed_project_membership(&state, "proj_privacy", &["kd_viewer", "kd_target"]);
        seed_endpoint_hints(
            &state,
            "kd_target",
            &[EndpointHint {
                addr: "198.51.100.10:7000".to_string(),
                hint_type: "stun".to_string(),
            }],
        );

        let response = get_endpoints(
            State(state),
            Extension(AuthNode("kd_viewer".to_string())),
            Path("kd_target".to_string()),
        )
        .await
        .unwrap()
        .0;

        assert_eq!(response.len(), 1);
        assert_eq!(response[0].addr, "198.51.100.10:7000");
    }
}
