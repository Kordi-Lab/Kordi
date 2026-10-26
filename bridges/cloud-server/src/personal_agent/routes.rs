//! Owner-only routes, mounted with the other agent routes behind the cloud
//! session: `/v1/cloud/agents/{agent_id}/personal-agent` for one agent's
//! setting (`agent_id` is a definition id or `cloud-agent:<account_id>`), and
//! `/v1/cloud/personal-agents`, which lists the caller's agents with their
//! personal sessions and creates any that are missing.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::setting::{self, PersonalAgentSetting};
use crate::auth::routes::CloudSession;
use crate::proactive::agents::{agent_owner, default_owner};
use crate::server::ServerState;

fn error(code: &str, message: &str, status: StatusCode) -> Response {
    (status, Json(json!({"errorCode": code, "message": message}))).into_response()
}

fn server_error(context: &str, err: impl std::fmt::Display) -> Response {
    eprintln!("[personal_agent] {context}: {err}");
    error(
        "server_error",
        "Could not process the personal agent request.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

fn not_found() -> Response {
    error(
        "cloud_agent_not_found",
        "Cloud Agent definition was not found.",
        StatusCode::NOT_FOUND,
    )
}

/// `Ok(())` when `account` owns `agent_id` and it is the default agent or an
/// active definition.
async fn owner_only(pool: &PgPool, account: &str, agent_id: &str) -> Result<(), Box<Response>> {
    match agent_owner(pool, agent_id).await {
        Ok(Some(owner)) if owner == account => {}
        Ok(Some(_)) => {
            return Err(Box::new(error(
                "not_agent_owner",
                "Only the agent's owner can do this.",
                StatusCode::FORBIDDEN,
            )))
        }
        Ok(None) => return Err(Box::new(not_found())),
        Err(err) => return Err(Box::new(server_error("owner check", err))),
    }
    if default_owner(agent_id).is_some() {
        return Ok(());
    }
    let active: Result<(bool,), _> = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_agent_definitions
         WHERE agent_id = $1 AND status = 'active' AND is_system_managed = FALSE)",
    )
    .bind(agent_id)
    .fetch_one(pool)
    .await;
    match active {
        Ok((true,)) => Ok(()),
        Ok((false,)) => Err(Box::new(not_found())),
        Err(err) => Err(Box::new(server_error("active check", err))),
    }
}

async fn current(pool: &PgPool, agent_id: &str) -> Response {
    match setting::stored(pool, agent_id).await {
        Ok(setting) => Json(setting.to_value()).into_response(),
        Err(err) => server_error("read setting", err),
    }
}

/// `GET /v1/cloud/agents/{agent_id}/personal-agent`: `{"proactive": bool}`.
pub(crate) async fn get_setting(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(agent_id): Path<String>,
) -> Response {
    let pool = state.db_pool();
    if let Err(response) = owner_only(pool, &session.account_id, &agent_id).await {
        return *response;
    }
    current(pool, &agent_id).await
}

/// `PUT /v1/cloud/agents/{agent_id}/personal-agent` with `{"proactive": bool}`.
/// On starts at the newest event; off cancels queued evaluations.
pub(crate) async fn put_setting(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(agent_id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let pool = state.db_pool();
    if let Err(response) = owner_only(pool, &session.account_id, &agent_id).await {
        return *response;
    }
    let requested = match PersonalAgentSetting::parse(&body) {
        Ok(requested) => requested,
        Err(message) => return error("invalid_personal_agent", &message, StatusCode::BAD_REQUEST),
    };
    if default_owner(&agent_id).is_some() {
        return match setting::set_default(pool, &session.account_id, requested).await {
            Ok(()) => current(pool, &agent_id).await,
            Err(err) => server_error("store setting", err),
        };
    }
    let stored = crate::cloud_agents::store::set_agent_personal(
        pool,
        &session.account_id,
        &agent_id,
        requested,
    )
    .await;
    match stored {
        Ok(Some(stored)) => Json(stored.to_value()).into_response(),
        Ok(None) => not_found(),
        Err(err) => server_error("store setting", err),
    }
}

/// `GET /v1/cloud/personal-agents`: the caller's agents, the default agent
/// first and then active definitions by creation time, each with its
/// personal session, created here when it is missing.
pub(crate) async fn list(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let pool = state.db_pool();
    let owner = session.account_id.as_str();
    let agents = match super::sessions::owned_agents(pool, owner).await {
        Ok(agents) => agents,
        Err(err) => return server_error("list agents", err),
    };
    let settings: Result<Vec<(String, bool)>, _> = query_as(
        "SELECT agent_id, proactive FROM cloud_personal_agent_settings WHERE owner_account_id = $1",
    )
    .bind(owner)
    .fetch_all(pool)
    .await;
    let settings: HashMap<String, bool> = match settings {
        Ok(rows) => rows.into_iter().collect(),
        Err(err) => return server_error("list settings", err),
    };
    let mut items = Vec::with_capacity(agents.len());
    for agent_id in agents {
        match super::sessions::ensure(pool, owner, &agent_id).await {
            Ok(personal) => items.push(json!({
                "agentId": agent_id,
                "conversationId": personal.conversation_id.to_string(),
                "sessionId": personal.session_id,
                "proactive": settings.get(&agent_id).copied().unwrap_or(false),
            })),
            // One agent's session must not hide the others.
            Err(err) => eprintln!("[personal_agent] personal session of {agent_id}: {err}"),
        }
    }
    Json(json!({"agents": items})).into_response()
}
