use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use super::auth::AuthNode;
use super::ServerState;
use crate::permissions::{is_valid_join_role, role_has_capability, ProjectCapability};

#[derive(Deserialize)]
pub struct CreateInviteReq {
    #[serde(rename = "maxUses")]
    pub max_uses: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct InviteResp {
    #[serde(rename = "inviteId")]
    pub invite_id: String,
    #[serde(rename = "inviteToken")]
    pub invite_token: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
}

#[derive(Deserialize)]
pub struct JoinReq {
    #[serde(rename = "inviteToken")]
    pub invite_token: String,
    #[serde(rename = "agentRole")]
    pub agent_role: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct JoinResp {
    pub joined: bool,
    #[serde(rename = "projectId")]
    pub project_id: String,
}

#[derive(Serialize)]
pub struct InviteListItem {
    #[serde(rename = "inviteId")]
    pub invite_id: String,
    #[serde(rename = "maxUses")]
    pub max_uses: Option<i64>,
    #[serde(rename = "useCount")]
    pub use_count: i64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

fn hash_token(token: &str) -> String {
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    hex::encode(h.finalize())
}

/// Routes are registered by projects.rs to avoid axum merge conflicts.
/// These handlers are pub so projects.rs can reference them.
pub async fn create_invite_handler(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Path(project_id): Path<String>,
    Json(req): Json<CreateInviteReq>,
) -> Result<Json<InviteResp>, StatusCode> {
    let invite_id = format!("inv_{}", uuid::Uuid::new_v4());
    let token = format!("bridges_inv_{}", uuid::Uuid::new_v4());
    let token_hash = hash_token(&token);
    let now = chrono::Utc::now().to_rfc3339();

    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let role: Option<String> = db
        .query_row(
            "SELECT agent_role FROM server_members WHERE project_id = ?1 AND node_id = ?2",
            rusqlite::params![project_id, auth.0],
            |row| row.get(0),
        )
        .ok();
    let Some(role) = role else {
        return Err(StatusCode::FORBIDDEN);
    };
    if !role_has_capability(&role, ProjectCapability::ManageInvites) {
        return Err(StatusCode::FORBIDDEN);
    }
    db.execute(
        "INSERT INTO server_invites (invite_id, project_id, token_hash, created_by, max_uses, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![invite_id, project_id, token_hash, auth.0, req.max_uses, now],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(InviteResp {
        invite_id,
        invite_token: token,
        project_id,
    }))
}

pub async fn join_project_handler(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Path(project_id): Path<String>,
    Json(req): Json<JoinReq>,
) -> Result<Json<JoinResp>, StatusCode> {
    let token_hash = hash_token(&req.invite_token);
    let now = chrono::Utc::now().to_rfc3339();
    let joining_node = auth.0;
    let role = req.agent_role.unwrap_or_else(|| "member".to_string());
    if !is_valid_join_role(&role) {
        return Err(StatusCode::BAD_REQUEST);
    }

    let mut db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let tx = db
        .transaction()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let (invite_id, max_uses, use_count): (String, Option<i64>, i64) = tx
        .query_row(
            "SELECT invite_id, max_uses, use_count FROM server_invites \
             WHERE project_id = ?1 AND token_hash = ?2",
            rusqlite::params![project_id, token_hash],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| StatusCode::NOT_FOUND)?;

    let already_member = tx
        .query_row(
            "SELECT 1 FROM server_members WHERE project_id = ?1 AND node_id = ?2",
            rusqlite::params![project_id, joining_node],
            |_| Ok(()),
        )
        .optional()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .is_some();

    if already_member {
        tx.commit().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        return Ok(Json(JoinResp {
            joined: true,
            project_id,
        }));
    }

    if let Some(max) = max_uses {
        if use_count >= max {
            return Err(StatusCode::GONE);
        }
    }

    tx.execute(
        "INSERT INTO server_members (project_id, node_id, agent_role, joined_at) \
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![project_id, joining_node, role, now],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    tx.execute(
        "UPDATE server_invites SET use_count = use_count + 1 WHERE invite_id = ?1",
        rusqlite::params![invite_id],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    tx.commit().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(JoinResp {
        joined: true,
        project_id,
    }))
}

pub async fn list_invites_handler(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Path(project_id): Path<String>,
) -> Result<Json<Vec<InviteListItem>>, StatusCode> {
    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let role: Option<String> = db
        .query_row(
            "SELECT agent_role FROM server_members WHERE project_id = ?1 AND node_id = ?2",
            rusqlite::params![project_id, auth.0],
            |row| row.get(0),
        )
        .ok();
    let Some(role) = role else {
        return Err(StatusCode::FORBIDDEN);
    };
    if !role_has_capability(&role, ProjectCapability::ManageInvites) {
        return Err(StatusCode::FORBIDDEN);
    }
    let mut stmt = db
        .prepare(
            "SELECT invite_id, max_uses, use_count, created_at \
             FROM server_invites WHERE project_id = ?1",
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let invites = stmt
        .query_map(rusqlite::params![project_id], |row| {
            Ok(InviteListItem {
                invite_id: row.get(0)?,
                max_uses: row.get(1)?,
                use_count: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .filter_map(|r| r.ok())
        .collect();
    Ok(Json(invites))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::{Path, State};
    use axum::Extension;
    fn test_state() -> Arc<ServerState> {
        super::super::make_test_state()
    }

    async fn seed_project_and_invite(
        state: &Arc<ServerState>,
        project_id: &str,
        owner_node_id: &str,
        invite_token: &str,
        max_uses: Option<i64>,
        use_count: i64,
    ) {
        let db = state.open_connection().unwrap();
        db.execute(
            "INSERT INTO server_projects (project_id, slug, display_name, description, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![project_id, "proj", "proj", Option::<String>::None, owner_node_id, chrono::Utc::now().to_rfc3339()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO server_members (project_id, node_id, agent_role, joined_at) VALUES (?1, ?2, 'owner', ?3)",
            rusqlite::params![project_id, owner_node_id, chrono::Utc::now().to_rfc3339()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO server_invites (invite_id, project_id, token_hash, created_by, max_uses, use_count, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                "inv_test",
                project_id,
                hash_token(invite_token),
                owner_node_id,
                max_uses,
                use_count,
                chrono::Utc::now().to_rfc3339(),
            ],
        )
        .unwrap();
    }

    async fn read_use_count(state: &Arc<ServerState>, project_id: &str) -> i64 {
        let db = state.open_connection().unwrap();
        db.query_row(
            "SELECT use_count FROM server_invites WHERE project_id = ?1",
            rusqlite::params![project_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn duplicate_join_does_not_consume_additional_use() {
        let state = test_state();
        let project_id = "proj_test";
        let owner = "kd_owner";
        let member = "kd_member";
        let invite_token = "bridges_inv_test";
        seed_project_and_invite(&state, project_id, owner, invite_token, Some(2), 0).await;

        let req = JoinReq {
            invite_token: invite_token.to_string(),
            agent_role: Some("member".to_string()),
        };

        let _ = join_project_handler(
            State(state.clone()),
            Extension(AuthNode(member.to_string())),
            Path(project_id.to_string()),
            Json(req),
        )
        .await
        .unwrap();
        assert_eq!(read_use_count(&state, project_id).await, 1);

        let req = JoinReq {
            invite_token: invite_token.to_string(),
            agent_role: Some("member".to_string()),
        };
        let _ = join_project_handler(
            State(state.clone()),
            Extension(AuthNode(member.to_string())),
            Path(project_id.to_string()),
            Json(req),
        )
        .await
        .unwrap();
        assert_eq!(read_use_count(&state, project_id).await, 1);
    }

    #[tokio::test]
    async fn exhausted_invite_blocks_new_member() {
        let state = test_state();
        let project_id = "proj_exhausted";
        let owner = "kd_owner";
        let invite_token = "bridges_inv_test";
        seed_project_and_invite(&state, project_id, owner, invite_token, Some(1), 1).await;

        let req = JoinReq {
            invite_token: invite_token.to_string(),
            agent_role: None,
        };
        let result = join_project_handler(
            State(state),
            Extension(AuthNode("kd_new".to_string())),
            Path(project_id.to_string()),
            Json(req),
        )
        .await;

        assert_eq!(result.unwrap_err(), StatusCode::GONE);
    }

    #[tokio::test]
    async fn already_joined_member_can_repeat_request_even_if_invite_is_exhausted() {
        let state = test_state();
        let project_id = "proj_repeat";
        let owner = "kd_owner";
        let member = "kd_member";
        let invite_token = "bridges_inv_test";
        seed_project_and_invite(&state, project_id, owner, invite_token, Some(1), 1).await;

        {
            let db = state.open_connection().unwrap();
            db.execute(
                "INSERT INTO server_members (project_id, node_id, agent_role, joined_at) VALUES (?1, ?2, 'member', ?3)",
                rusqlite::params![project_id, member, chrono::Utc::now().to_rfc3339()],
            )
            .unwrap();
        }

        let req = JoinReq {
            invite_token: invite_token.to_string(),
            agent_role: None,
        };
        let result = join_project_handler(
            State(state.clone()),
            Extension(AuthNode(member.to_string())),
            Path(project_id.to_string()),
            Json(req),
        )
        .await;

        assert!(result.is_ok());
        assert_eq!(read_use_count(&state, project_id).await, 1);
    }

    #[tokio::test]
    async fn create_invite_requires_owner_role() {
        let state = test_state();
        let project_id = "proj_owner_only";
        let owner = "kd_owner";
        let invite_token = "bridges_inv_test";
        seed_project_and_invite(&state, project_id, owner, invite_token, Some(1), 0).await;
        {
            let db = state.open_connection().unwrap();
            db.execute(
                "INSERT INTO server_members (project_id, node_id, agent_role, joined_at) VALUES (?1, ?2, 'member', ?3)",
                rusqlite::params![project_id, "kd_member", chrono::Utc::now().to_rfc3339()],
            )
            .unwrap();
        }

        let result = create_invite_handler(
            State(state),
            Extension(AuthNode("kd_member".to_string())),
            Path(project_id.to_string()),
            Json(CreateInviteReq { max_uses: Some(1) }),
        )
        .await;

        assert_eq!(result.unwrap_err(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn join_rejects_owner_role_escalation() {
        let state = test_state();
        let project_id = "proj_join_role";
        let owner = "kd_owner";
        let invite_token = "bridges_inv_test";
        seed_project_and_invite(&state, project_id, owner, invite_token, Some(1), 0).await;

        let result = join_project_handler(
            State(state),
            Extension(AuthNode("kd_new".to_string())),
            Path(project_id.to_string()),
            Json(JoinReq {
                invite_token: invite_token.to_string(),
                agent_role: Some("owner".to_string()),
            }),
        )
        .await;

        assert_eq!(result.unwrap_err(), StatusCode::BAD_REQUEST);
    }
}
