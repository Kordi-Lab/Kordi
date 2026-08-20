use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Extension, Json, Router};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::routes::{cloud_session_middleware, CloudSession};
use crate::cloud_agents::models::{
    CloudAgentDefinition, CreateCloudAgentRequest, SharedCloudAgentSummary, UpdateCloudAgentRequest,
};
use crate::cloud_agents::store::{
    archive_agent_definition, create_agent_definition, list_agent_definitions,
    list_shared_agent_summaries, update_agent_definition, CloudAgentStoreError,
};
use crate::server::ServerState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudAgentEnvelope {
    agent: CloudAgentDefinition,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudAgentListResponse {
    agents: Vec<CloudAgentDefinition>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedAgentsQuery {
    owner_account_ids: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedCloudAgentListResponse {
    agents: Vec<SharedCloudAgentSummary>,
}

pub fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/v1/cloud/agents", get(list_agents).post(create_agent))
        .route("/v1/cloud/agents/shared", get(list_shared_agents))
        .route(
            "/v1/cloud/agents/:agent_id",
            put(update_agent).delete(archive_agent),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .with_state(state)
}

fn error_response(error_code: &'static str, message: &str, status: StatusCode) -> Response {
    (
        status,
        Json(json!({
            "errorCode": error_code,
            "message": message,
        })),
    )
        .into_response()
}

fn store_error_response(context: &str, error: CloudAgentStoreError) -> Response {
    match error {
        CloudAgentStoreError::Invalid(message) => {
            error_response("invalid_cloud_agent", &message, StatusCode::BAD_REQUEST)
        }
        CloudAgentStoreError::Database(err) => {
            eprintln!("[cloud_agents] {context}: {err}");
            error_response(
                "server_error",
                "Could not process Cloud Agent definition.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
        CloudAgentStoreError::Sync(err) => {
            eprintln!("[cloud_agents] {context} sync publication: {err}");
            error_response(
                "server_error",
                "Could not synchronize Cloud Agent definition.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
        CloudAgentStoreError::AvatarConflict => error_response(
            "avatar_conflict",
            "Avatar changed on another device. Refresh and try again.",
            StatusCode::CONFLICT,
        ),
    }
}

async fn list_agents(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match list_agent_definitions(state.db_pool(), &session.account_id).await {
        Ok(agents) => Json(CloudAgentListResponse { agents }).into_response(),
        Err(err) => store_error_response("list", err),
    }
}

async fn list_shared_agents(
    State(state): State<Arc<ServerState>>,
    Extension(_session): Extension<CloudSession>,
    Query(query): Query<SharedAgentsQuery>,
) -> Response {
    let owner_ids = query
        .owner_account_ids
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    match list_shared_agent_summaries(state.db_pool(), &owner_ids).await {
        Ok(agents) => Json(SharedCloudAgentListResponse { agents }).into_response(),
        Err(err) => store_error_response("list_shared", err),
    }
}

async fn create_agent(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(input): Json<CreateCloudAgentRequest>,
) -> Response {
    match create_agent_definition(state.db_pool(), &session.account_id, input, Utc::now()).await {
        Ok(agent) => (StatusCode::CREATED, Json(CloudAgentEnvelope { agent })).into_response(),
        Err(err) => store_error_response("create", err),
    }
}

async fn update_agent(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(agent_id): Path<String>,
    Json(input): Json<UpdateCloudAgentRequest>,
) -> Response {
    match update_agent_definition(
        state.db_pool(),
        &session.account_id,
        &agent_id,
        input,
        Utc::now(),
    )
    .await
    {
        Ok(Some(agent)) => Json(CloudAgentEnvelope { agent }).into_response(),
        Ok(None) => error_response(
            "cloud_agent_not_found",
            "Cloud Agent definition was not found.",
            StatusCode::NOT_FOUND,
        ),
        Err(err) => store_error_response("update", err),
    }
}

async fn archive_agent(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(agent_id): Path<String>,
) -> Response {
    match archive_agent_definition(state.db_pool(), &session.account_id, &agent_id, Utc::now())
        .await
    {
        Ok(Some(agent)) => Json(CloudAgentEnvelope { agent }).into_response(),
        Ok(None) => error_response(
            "cloud_agent_not_found",
            "Cloud Agent definition was not found.",
            StatusCode::NOT_FOUND,
        ),
        Err(err) => store_error_response("archive", err),
    }
}
