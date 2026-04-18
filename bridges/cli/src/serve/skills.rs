use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{middleware, Extension, Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::auth::{auth_middleware, AuthNode};
use super::ServerState;

#[derive(Deserialize)]
pub struct RegisterSkillReq {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Serialize)]
pub struct SkillResp {
    #[serde(rename = "skillId")]
    pub skill_id: String,
    #[serde(rename = "nodeId")]
    pub node_id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

pub fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/v1/projects/:id/skills", post(register_skill))
        .route("/v1/projects/:id/skills", get(list_skills))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .with_state(state)
}

async fn register_skill(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Path(project_id): Path<String>,
    Json(req): Json<RegisterSkillReq>,
) -> Result<Json<SkillResp>, StatusCode> {
    let skill_id = format!("skill_{}", uuid::Uuid::new_v4());
    let now = chrono::Utc::now().to_rfc3339();

    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    db.execute(
        "INSERT INTO server_skills (skill_id, project_id, node_id, name, description, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![skill_id, project_id, auth.0, req.name, req.description, now],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(SkillResp {
        skill_id,
        node_id: auth.0,
        name: req.name,
        description: req.description,
        created_at: now,
    }))
}

async fn list_skills(
    State(state): State<Arc<ServerState>>,
    Path(project_id): Path<String>,
) -> Result<Json<Vec<SkillResp>>, StatusCode> {
    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut stmt = db
        .prepare(
            "SELECT skill_id, node_id, name, description, created_at \
             FROM server_skills WHERE project_id = ?1",
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let skills = stmt
        .query_map(rusqlite::params![project_id], |row| {
            Ok(SkillResp {
                skill_id: row.get(0)?,
                node_id: row.get(1)?,
                name: row.get(2)?,
                description: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .filter_map(|r| r.ok())
        .collect();
    Ok(Json(skills))
}
