use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{middleware, Extension, Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::auth::{auth_middleware, AuthNode};
use super::{nodes_can_directly_reach, DirectAccessKind, ServerState};

#[derive(Debug, Serialize)]
pub struct KeysResp {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "ed25519Pubkey")]
    pub ed25519_pubkey: String,
    #[serde(rename = "x25519Pubkey")]
    pub x25519_pubkey: String,
}

#[derive(Deserialize)]
pub struct UpdateKeysReq {
    #[serde(rename = "ed25519Pubkey")]
    pub ed25519_pubkey: String,
    #[serde(rename = "x25519Pubkey")]
    pub x25519_pubkey: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeysQuery {
    pub project: Option<String>,
    pub target_kind: Option<String>,
}

pub fn routes(state: Arc<ServerState>) -> Router {
    // All key endpoints require authentication
    Router::new()
        .route("/v1/keys/:node_id", get(get_keys))
        .route("/v1/keys", get(list_keys))
        .route("/v1/keys", put(update_keys))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .with_state(state)
}

fn direct_access_kind_from_target_kind(target_kind: Option<&str>) -> DirectAccessKind {
    match target_kind
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "agent" | "bridge-agent" | "ask" => DirectAccessKind::Agent,
        "person-invite" | "bridge-person-invite" | "session-invite" | "group-invite" => {
            DirectAccessKind::GroupInvite
        }
        "session-participant" | "group-session" | "session-message" | "session-relay" => {
            DirectAccessKind::SessionParticipant
        }
        "person" | "bridge-person" | "human" => DirectAccessKind::Person,
        _ => DirectAccessKind::Any,
    }
}

/// Get a specific node's public keys. Requires auth — caller must either
/// share a project with the target node or have a permitted direct relationship.
async fn get_keys(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Query(q): Query<KeysQuery>,
    Path(node_id): Path<String>,
) -> Result<Json<KeysResp>, StatusCode> {
    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let target_exists = db
        .query_row(
            "SELECT 1 FROM registered_nodes WHERE node_id = ?1 AND revoked_at IS NULL",
            rusqlite::params![node_id.as_str()],
            |_| Ok(()),
        )
        .is_ok();
    if !target_exists {
        return Err(StatusCode::NOT_FOUND);
    }
    let allowed = if let Some(project_id) = q.project {
        db.query_row(
            "SELECT 1 FROM server_members m1 \
             JOIN server_members m2 ON m1.project_id = m2.project_id \
             WHERE m1.project_id = ?1 AND m1.node_id = ?2 AND m2.node_id = ?3 LIMIT 1",
            rusqlite::params![project_id, auth.0, node_id],
            |_| Ok(()),
        )
        .is_ok()
    } else {
        nodes_can_directly_reach(
            &db,
            &auth.0,
            &node_id,
            direct_access_kind_from_target_kind(q.target_kind.as_deref()),
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    };
    if !allowed {
        return Err(StatusCode::FORBIDDEN);
    }
    db.query_row(
        "SELECT node_id, ed25519_pubkey, x25519_pubkey FROM registered_nodes WHERE node_id = ?1 AND revoked_at IS NULL",
        rusqlite::params![node_id],
        |row| {
            Ok(KeysResp {
                node_id: row.get(0)?,
                ed25519_pubkey: row.get(1)?,
                x25519_pubkey: row.get(2)?,
            })
        },
    )
    .map(Json)
    .map_err(|_| StatusCode::NOT_FOUND)
}

/// List keys for all members of a project. Requires auth + membership.
async fn list_keys(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Query(q): Query<KeysQuery>,
) -> Result<Json<Vec<KeysResp>>, StatusCode> {
    let project_id = q.project.ok_or(StatusCode::BAD_REQUEST)?;
    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // Verify caller is a member of the project
    let is_member: bool = db
        .query_row(
            "SELECT 1 FROM server_members WHERE project_id = ?1 AND node_id = ?2",
            rusqlite::params![project_id, auth.0],
            |_| Ok(()),
        )
        .is_ok();
    if !is_member {
        return Err(StatusCode::FORBIDDEN);
    }
    let mut stmt = db
        .prepare(
            "SELECT r.node_id, r.ed25519_pubkey, r.x25519_pubkey \
             FROM registered_nodes r \
             JOIN server_members m ON r.node_id = m.node_id \
             WHERE m.project_id = ?1 AND r.revoked_at IS NULL",
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let keys = stmt
        .query_map(rusqlite::params![project_id], |row| {
            Ok(KeysResp {
                node_id: row.get(0)?,
                ed25519_pubkey: row.get(1)?,
                x25519_pubkey: row.get(2)?,
            })
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .filter_map(|r| r.ok())
        .collect();
    Ok(Json(keys))
}

async fn update_keys(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Json(req): Json<UpdateKeysReq>,
) -> Result<StatusCode, StatusCode> {
    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    db.execute(
        "UPDATE registered_nodes SET ed25519_pubkey = ?1, x25519_pubkey = ?2 WHERE node_id = ?3",
        rusqlite::params![req.ed25519_pubkey, req.x25519_pubkey, auth.0],
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

    fn seed_registered_node(state: &Arc<ServerState>, node_id: &str, ed25519_pubkey: &str) {
        seed_registered_node_with_policy(state, node_id, ed25519_pubkey, None, None, None);
    }

    fn seed_registered_node_with_policy(
        state: &Arc<ServerState>,
        node_id: &str,
        ed25519_pubkey: &str,
        human_id: Option<&str>,
        human_visibility_policy: Option<&str>,
        agent_reachability_policy: Option<&str>,
    ) {
        let db = state.open_connection().unwrap();
        db.execute(
            "INSERT INTO registered_nodes (node_id, ed25519_pubkey, x25519_pubkey, display_name, owner_name, human_id, human_visibility_policy, agent_reachability_policy, api_key_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                node_id,
                ed25519_pubkey,
                "x25519_pub",
                Option::<String>::None,
                Option::<String>::None,
                human_id,
                human_visibility_policy,
                agent_reachability_policy,
                "hash",
                chrono::Utc::now().to_rfc3339(),
            ],
        )
        .unwrap();
    }

    #[tokio::test]
    async fn get_keys_requires_shared_project() {
        let state = super::super::make_test_state();
        seed_registered_node(&state, "kd_target", "ed_target");

        let result = get_keys(
            State(state),
            Extension(AuthNode("kd_viewer".to_string())),
            Query(KeysQuery {
                project: None,
                target_kind: None,
            }),
            Path("kd_target".to_string()),
        )
        .await;

        assert_eq!(result.unwrap_err(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn get_keys_allows_server_open_target_without_contact() {
        let state = super::super::make_test_state();
        seed_registered_node(&state, "kd_viewer", "ed_viewer");
        seed_registered_node_with_policy(
            &state,
            "kd_target",
            "ed_target",
            Some("human-target"),
            Some("server-open"),
            None,
        );

        let keys = get_keys(
            State(state),
            Extension(AuthNode("kd_viewer".to_string())),
            Query(KeysQuery {
                project: None,
                target_kind: None,
            }),
            Path("kd_target".to_string()),
        )
        .await
        .unwrap()
        .0;

        assert_eq!(keys.node_id, "kd_target");
        assert_eq!(keys.ed25519_pubkey, "ed_target");
    }

    #[tokio::test]
    async fn get_keys_allows_contacted_owner_only_default_agent_when_requesting_person_keys() {
        let state = super::super::make_test_state();
        seed_registered_node_with_policy(
            &state,
            "kd_viewer",
            "ed_viewer",
            Some("human-viewer"),
            Some("server-approval"),
            None,
        );
        let db = state.open_connection().unwrap();
        db.execute(
            "INSERT INTO registered_nodes (node_id, ed25519_pubkey, x25519_pubkey, display_name, owner_name, runtime, human_id, agent_id, is_default_agent, human_visibility_policy, agent_reachability_policy, api_key_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10, ?11, ?12)",
            rusqlite::params![
                "kd_target",
                "ed_target",
                "x25519_target",
                "Target's Kordi",
                "Target",
                "kordi-desktop",
                "human-target",
                "agent-target",
                "server-approval",
                "owner",
                "hash-target",
                chrono::Utc::now().to_rfc3339(),
            ],
        )
        .unwrap();
        db.execute(
            "INSERT INTO server_contacts (node_id, contact_node_id, created_at) VALUES (?1, ?2, ?3)",
            rusqlite::params!["kd_viewer", "kd_target", chrono::Utc::now().to_rfc3339()],
        )
        .unwrap();

        let keys = get_keys(
            State(state.clone()),
            Extension(AuthNode("kd_viewer".to_string())),
            Query(KeysQuery {
                project: None,
                target_kind: Some("person".to_string()),
            }),
            Path("kd_target".to_string()),
        )
        .await
        .unwrap()
        .0;

        assert_eq!(keys.node_id, "kd_target");
        assert_eq!(keys.ed25519_pubkey, "ed_target");

        let agent_result = get_keys(
            State(state),
            Extension(AuthNode("kd_viewer".to_string())),
            Query(KeysQuery {
                project: None,
                target_kind: Some("agent".to_string()),
            }),
            Path("kd_target".to_string()),
        )
        .await;
        assert_eq!(agent_result.unwrap_err(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn get_keys_allows_session_participant_without_contact() {
        let state = super::super::make_test_state();
        seed_registered_node_with_policy(
            &state,
            "kd_viewer",
            "ed_viewer",
            Some("human-viewer"),
            Some("server-approval"),
            None,
        );
        seed_registered_node_with_policy(
            &state,
            "kd_target",
            "ed_target",
            Some("human-target"),
            Some("server-approval"),
            None,
        );

        let keys = get_keys(
            State(state),
            Extension(AuthNode("kd_viewer".to_string())),
            Query(KeysQuery {
                project: None,
                target_kind: Some("session-participant".to_string()),
            }),
            Path("kd_target".to_string()),
        )
        .await
        .unwrap()
        .0;

        assert_eq!(keys.node_id, "kd_target");
        assert_eq!(keys.ed25519_pubkey, "ed_target");
    }

    #[tokio::test]
    async fn get_keys_hides_revoked_nodes() {
        let state = super::super::make_test_state();
        seed_project_membership(&state, "proj_keys", &["kd_viewer", "kd_target"]);
        seed_registered_node(&state, "kd_target", "ed_target");
        let db = state.open_connection().unwrap();
        db.execute(
            "UPDATE registered_nodes SET revoked_at = ?1 WHERE node_id = ?2",
            rusqlite::params![chrono::Utc::now().to_rfc3339(), "kd_target"],
        )
        .unwrap();

        let result = get_keys(
            State(state),
            Extension(AuthNode("kd_viewer".to_string())),
            Query(KeysQuery {
                project: None,
                target_kind: None,
            }),
            Path("kd_target".to_string()),
        )
        .await;

        assert_eq!(result.unwrap_err(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn list_keys_requires_project_membership() {
        let state = super::super::make_test_state();
        seed_project_membership(&state, "proj_keys", &["kd_target"]);
        seed_registered_node(&state, "kd_target", "ed_target");

        let result = list_keys(
            State(state),
            Extension(AuthNode("kd_viewer".to_string())),
            Query(KeysQuery {
                project: Some("proj_keys".to_string()),
                target_kind: None,
            }),
        )
        .await;

        assert_eq!(result.unwrap_err(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn list_keys_returns_member_keys_for_project_member() {
        let state = super::super::make_test_state();
        seed_project_membership(&state, "proj_keys", &["kd_viewer", "kd_target"]);
        seed_registered_node(&state, "kd_target", "ed_target");

        let keys = list_keys(
            State(state),
            Extension(AuthNode("kd_viewer".to_string())),
            Query(KeysQuery {
                project: Some("proj_keys".to_string()),
                target_kind: None,
            }),
        )
        .await
        .unwrap()
        .0;

        assert!(keys
            .iter()
            .any(|key| { key.node_id == "kd_target" && key.ed25519_pubkey == "ed_target" }));
    }

    #[tokio::test]
    async fn list_keys_excludes_revoked_members() {
        let state = super::super::make_test_state();
        seed_project_membership(&state, "proj_keys", &["kd_viewer", "kd_target"]);
        seed_registered_node(&state, "kd_target", "ed_target");
        let db = state.open_connection().unwrap();
        db.execute(
            "UPDATE registered_nodes SET revoked_at = ?1 WHERE node_id = ?2",
            rusqlite::params![chrono::Utc::now().to_rfc3339(), "kd_target"],
        )
        .unwrap();

        let keys = list_keys(
            State(state),
            Extension(AuthNode("kd_viewer".to_string())),
            Query(KeysQuery {
                project: Some("proj_keys".to_string()),
                target_kind: None,
            }),
        )
        .await
        .unwrap()
        .0;

        assert!(keys.is_empty());
    }
}
