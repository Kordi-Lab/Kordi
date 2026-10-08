//! Runner access to the run owner's account memories (#1710).
//!
//! The runner reads and saves memories as the account that owns the run, only
//! while it holds the run's lease. The same guards and settings apply as for
//! the signed-in account routes.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use crate::cloud_agent_runtime::runs::{error_response, runner_unauthorized};
use crate::memory_store::{self, SaveMemoryRequest};
use crate::server::ServerState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RunnerMemoryQuery {
    #[serde(default)]
    runner_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RunnerSaveMemoryRequest {
    #[serde(default)]
    runner_id: Option<String>,
    #[serde(flatten)]
    memory: SaveMemoryRequest,
}

async fn run_owner(
    state: &ServerState,
    headers: &HeaderMap,
    run_id: &str,
    runner_id: Option<&str>,
) -> Result<String, Response> {
    if !super::runner_authorized(headers) {
        return Err(runner_unauthorized());
    }
    let Some(runner_id) = runner_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Err(error_response(
            "invalid_runner_request",
            "runnerId is required.",
            StatusCode::BAD_REQUEST,
        ));
    };
    match memory_store::leased_run_owner(state.db_pool(), run_id, runner_id).await {
        Ok(Some(owner)) => Ok(owner),
        Ok(None) => Err(error_response(
            "agent_run_not_found",
            "Cloud agent run was not found for this runner.",
            StatusCode::NOT_FOUND,
        )),
        Err(error) => Err(error.into_response()),
    }
}

pub(super) async fn list(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Query(input): Query<RunnerMemoryQuery>,
) -> Response {
    let owner = match run_owner(&state, &headers, &run_id, input.runner_id.as_deref()).await {
        Ok(owner) => owner,
        Err(response) => return response,
    };
    match memory_store::list(state.db_pool(), &owner).await {
        Ok(list) => Json(list).into_response(),
        Err(error) => error.into_response(),
    }
}

pub(super) async fn save(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Json(input): Json<RunnerSaveMemoryRequest>,
) -> Response {
    let owner = match run_owner(&state, &headers, &run_id, input.runner_id.as_deref()).await {
        Ok(owner) => owner,
        Err(response) => return response,
    };
    let outcome = match memory_store::save(state.db_pool(), &owner, &input.memory).await {
        Ok(outcome) => outcome,
        Err(error) => return error.into_response(),
    };
    if let memory_store::SaveOutcome::Created(memory) = &outcome {
        memory_store::write_memory_audit(
            state.db_pool(),
            &owner,
            None,
            "memory_saved",
            serde_json::json!({
                "memoryId": memory.memory_id,
                "scope": memory.scope,
                "source": memory.source,
                "runId": run_id,
                "via": "runner",
            }),
        )
        .await;
    }
    outcome.into_response()
}
