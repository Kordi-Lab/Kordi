//! `GET|PUT /v1/cloud/agents/:agent_id/access`: an agent's Access, for its
//! owner only. `agent_id` is a Factory agent id or the owner's default agent,
//! `cloud-agent:<account_id>`. Both answer `{ "agentId", "accessScope" }`;
//! PUT takes `{ "accessScope": "private" | "participant_conversations" }`.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::json;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::{ACCESS_PARTICIPANTS, ACCESS_PRIVATE};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AccessUpdate {
    access_scope: String,
}

fn err(code: &str, message: &str, status: StatusCode) -> Response {
    (
        status,
        Json(json!({ "errorCode": code, "message": message })),
    )
        .into_response()
}

fn not_found() -> Response {
    err(
        "cloud_agent_not_found",
        "Cloud Agent definition was not found.",
        StatusCode::NOT_FOUND,
    )
}

fn db_error(error: sqlx_core::Error) -> Response {
    eprintln!("[agent-access] Database error: {error}");
    err(
        "server_error",
        "Could not update agent access. Try again.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

fn body(agent_id: &str, scope: &str) -> Response {
    (
        StatusCode::OK,
        Json(json!({ "agentId": agent_id, "accessScope": scope })),
    )
        .into_response()
}

/// The access of the caller's own active Factory agent, if it is one.
async fn definition_access(
    pool: &PgPool,
    owner: &str,
    agent_id: &str,
) -> sqlx_core::Result<Option<String>> {
    let row: Option<(String,)> = query_as(
        "SELECT access_scope FROM cloud_agent_definitions
         WHERE agent_id = $1 AND owner_account_id = $2 AND status = 'active'
           AND is_system_managed = FALSE",
    )
    .bind(agent_id)
    .bind(owner)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(scope,)| scope))
}

pub(crate) async fn read_access(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(agent_id): Path<String>,
) -> Response {
    let pool = state.db_pool();
    let owner = session.account_id.as_str();
    let agent_id = agent_id.trim();
    if agent_id == super::default_agent_id(owner) {
        return match super::default_access(pool, owner).await {
            Ok(scope) => body(agent_id, &scope),
            Err(error) => db_error(error),
        };
    }
    match definition_access(pool, owner, agent_id).await {
        Ok(Some(scope)) => body(agent_id, &scope),
        Ok(None) => not_found(),
        Err(error) => db_error(error),
    }
}

pub(crate) async fn update_access(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(agent_id): Path<String>,
    Json(input): Json<AccessUpdate>,
) -> Response {
    let pool = state.db_pool();
    let owner = session.account_id.as_str();
    let agent_id = agent_id.trim();
    let scope = input.access_scope.trim();
    if scope != ACCESS_PRIVATE && scope != ACCESS_PARTICIPANTS {
        return err(
            "invalid_cloud_agent",
            "Unsupported Cloud Agent access scope",
            StatusCode::BAD_REQUEST,
        );
    }
    if agent_id == super::default_agent_id(owner) {
        return match super::save_default_access(pool, owner, scope).await {
            Ok(refused) => {
                for run_id in refused {
                    crate::contact_permissions::publish_refusal(pool, &run_id).await;
                }
                body(agent_id, scope)
            }
            Err(error) => db_error(error),
        };
    }
    // A Factory agent changes through its definition, so the sync event and
    // the end of other people's requests follow the usual update.
    let update = serde_json::from_value(json!({ "accessScope": scope }))
        .expect("an access-only update deserializes");
    match crate::cloud_agents::store::update_agent_definition(
        pool,
        owner,
        agent_id,
        update,
        Utc::now(),
    )
    .await
    {
        Ok(Some(agent)) => {
            crate::cloud_agents::routes::after_access_saved(pool, owner, &agent).await;
            body(agent_id, &agent.access_scope)
        }
        Ok(None) => not_found(),
        Err(error) => {
            eprintln!("[agent-access] update {agent_id}: {error}");
            err(
                "server_error",
                "Could not update agent access. Try again.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}
