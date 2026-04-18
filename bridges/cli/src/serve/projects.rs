use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{middleware, Extension, Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::auth::{auth_middleware, AuthNode};
use super::ServerState;
use crate::permissions::{role_capabilities, role_has_capability, ProjectCapability};

#[derive(Deserialize)]
pub struct CreateProjectReq {
    pub slug: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ProjectResp {
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub slug: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    pub description: Option<String>,
    #[serde(rename = "createdBy")]
    pub created_by: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct MemberResp {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "agentRole")]
    pub agent_role: Option<String>,
    pub capabilities: Vec<String>,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "ed25519Pubkey")]
    pub ed25519_pubkey: Option<String>,
    #[serde(rename = "joinedAt")]
    pub joined_at: String,
}

pub fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/v1/projects", post(create_project))
        .route("/v1/projects", get(list_projects))
        .route("/v1/projects/:id", get(get_project))
        .route("/v1/projects/:id/members", get(list_members))
        .route(
            "/v1/projects/:id/invites",
            axum::routing::post(super::invites::create_invite_handler)
                .get(super::invites::list_invites_handler),
        )
        .route(
            "/v1/projects/:id/join",
            axum::routing::post(super::invites::join_project_handler),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .with_state(state)
}

async fn create_project(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Json(req): Json<CreateProjectReq>,
) -> Result<Json<ProjectResp>, StatusCode> {
    let project_id = format!("proj_{}", uuid::Uuid::new_v4());
    let now = chrono::Utc::now().to_rfc3339();

    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    db.execute(
        "INSERT INTO server_projects (project_id, slug, display_name, description, created_by, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![project_id, req.slug, req.display_name, req.description, auth.0, now],
    )
    .map_err(|_| StatusCode::CONFLICT)?;

    db.execute(
        "INSERT INTO server_members (project_id, node_id, agent_role, joined_at) \
         VALUES (?1, ?2, 'owner', ?3)",
        rusqlite::params![project_id, auth.0, now],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(ProjectResp {
        project_id,
        slug: req.slug,
        display_name: req.display_name,
        description: req.description,
        created_by: auth.0,
        created_at: now,
    }))
}

async fn list_projects(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
) -> Result<Json<Vec<ProjectResp>>, StatusCode> {
    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut stmt = db
        .prepare(
            "SELECT p.project_id, p.slug, p.display_name, p.description, p.created_by, p.created_at \
             FROM server_projects p \
             JOIN server_members m ON p.project_id = m.project_id \
             WHERE m.node_id = ?1",
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let projects = stmt
        .query_map(rusqlite::params![auth.0], |row| {
            Ok(ProjectResp {
                project_id: row.get(0)?,
                slug: row.get(1)?,
                display_name: row.get(2)?,
                description: row.get(3)?,
                created_by: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .filter_map(|r| r.ok())
        .collect();
    Ok(Json(projects))
}

async fn get_project(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Path(id): Path<String>,
) -> Result<Json<ProjectResp>, StatusCode> {
    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let is_member: bool = db
        .query_row(
            "SELECT 1 FROM server_members WHERE project_id = ?1 AND node_id = ?2",
            rusqlite::params![id, auth.0],
            |_| Ok(()),
        )
        .is_ok();
    if !is_member {
        return Err(StatusCode::FORBIDDEN);
    }
    db.query_row(
        "SELECT project_id, slug, display_name, description, created_by, created_at \
         FROM server_projects WHERE project_id = ?1",
        rusqlite::params![id],
        |row| {
            Ok(ProjectResp {
                project_id: row.get(0)?,
                slug: row.get(1)?,
                display_name: row.get(2)?,
                description: row.get(3)?,
                created_by: row.get(4)?,
                created_at: row.get(5)?,
            })
        },
    )
    .map(Json)
    .map_err(|_| StatusCode::NOT_FOUND)
}

async fn list_members(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Path(id): Path<String>,
) -> Result<Json<Vec<MemberResp>>, StatusCode> {
    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let viewer_role: Option<String> = db
        .query_row(
            "SELECT agent_role FROM server_members WHERE project_id = ?1 AND node_id = ?2",
            rusqlite::params![id, auth.0],
            |row| row.get(0),
        )
        .ok();
    let Some(viewer_role) = viewer_role else {
        return Err(StatusCode::FORBIDDEN);
    };
    if !role_has_capability(&viewer_role, ProjectCapability::ViewMembers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let mut stmt = db
        .prepare(
            "SELECT m.node_id, m.agent_role, r.display_name, r.ed25519_pubkey, m.joined_at \
             FROM server_members m \
             LEFT JOIN registered_nodes r ON m.node_id = r.node_id \
             WHERE m.project_id = ?1",
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let members = stmt
        .query_map(rusqlite::params![id], |row| {
            let agent_role: Option<String> = row.get(1)?;
            Ok(MemberResp {
                node_id: row.get(0)?,
                capabilities: role_capabilities(agent_role.as_deref()),
                agent_role,
                display_name: row.get(2)?,
                ed25519_pubkey: row.get(3)?,
                joined_at: row.get(4)?,
            })
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .filter_map(|r| r.ok())
        .collect();
    Ok(Json(members))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_project(state: &Arc<ServerState>, project_id: &str, members: &[(&str, &str)]) {
        let db = state.open_connection().unwrap();
        db.execute(
            "INSERT INTO server_projects (project_id, slug, display_name, description, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![project_id, project_id, project_id, Option::<String>::None, members[0].0, chrono::Utc::now().to_rfc3339()],
        )
        .unwrap();
        for (node_id, role) in members {
            db.execute(
                "INSERT INTO server_members (project_id, node_id, agent_role, joined_at) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![project_id, node_id, role, chrono::Utc::now().to_rfc3339()],
            )
            .unwrap();
            db.execute(
                "INSERT INTO registered_nodes (node_id, ed25519_pubkey, x25519_pubkey, display_name, owner_name, api_key_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    node_id,
                    format!("ed_{}", node_id),
                    format!("x_{}", node_id),
                    format!("display-{}", node_id),
                    Option::<String>::None,
                    format!("hash_{}", node_id),
                    chrono::Utc::now().to_rfc3339(),
                ],
            )
            .unwrap();
        }
    }

    #[tokio::test]
    async fn list_members_requires_project_membership() {
        let state = super::super::make_test_state();
        seed_project(
            &state,
            "proj_members",
            &[("kd_owner", "owner"), ("kd_member", "member")],
        );

        let result = list_members(
            State(state),
            Extension(AuthNode("kd_outsider".to_string())),
            Path("proj_members".to_string()),
        )
        .await;

        assert_eq!(result.unwrap_err(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn list_members_returns_member_metadata_and_capabilities() {
        let state = super::super::make_test_state();
        seed_project(
            &state,
            "proj_members",
            &[
                ("kd_owner", "owner"),
                ("kd_member", "member"),
                ("kd_guest", "guest"),
            ],
        );

        let members = list_members(
            State(state),
            Extension(AuthNode("kd_owner".to_string())),
            Path("proj_members".to_string()),
        )
        .await
        .unwrap()
        .0;

        let member = members
            .iter()
            .find(|member| member.node_id == "kd_member")
            .unwrap();
        assert_eq!(member.agent_role.as_deref(), Some("member"));
        assert_eq!(member.display_name.as_deref(), Some("display-kd_member"));
        assert_eq!(member.ed25519_pubkey.as_deref(), Some("ed_kd_member"));
        assert!(member.capabilities.contains(&"broadcast".to_string()));
        assert!(!member.capabilities.contains(&"manage_invites".to_string()));

        let guest = members
            .iter()
            .find(|member| member.node_id == "kd_guest")
            .unwrap();
        assert_eq!(guest.agent_role.as_deref(), Some("guest"));
        assert!(guest.capabilities.contains(&"ask".to_string()));
        assert!(!guest.capabilities.contains(&"publish".to_string()));
    }
}
