//! Runner access to the run owner's account memories (#1710).
//!
//! The runner reads and saves memories as the account that owns the run, only
//! while it holds the run's lease. Saves are limited to the run's own scopes.
//! The same guards and settings apply as for the signed-in account routes.

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

async fn leased_run(
    state: &ServerState,
    headers: &HeaderMap,
    run_id: &str,
    runner_id: Option<&str>,
) -> Result<memory_store::LeasedRun, Box<Response>> {
    if !super::runner_authorized(headers) {
        return Err(Box::new(runner_unauthorized()));
    }
    let Some(runner_id) = runner_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Err(Box::new(error_response(
            "invalid_runner_request",
            "runnerId is required.",
            StatusCode::BAD_REQUEST,
        )));
    };
    match memory_store::leased_run(state.db_pool(), run_id, runner_id).await {
        Ok(Some(run)) => Ok(run),
        Ok(None) => Err(Box::new(error_response(
            "agent_run_not_found",
            "Cloud agent run was not found for this runner.",
            StatusCode::NOT_FOUND,
        ))),
        Err(error) => Err(Box::new(error.into_response())),
    }
}

pub(super) async fn list(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Query(input): Query<RunnerMemoryQuery>,
) -> Response {
    let owner = match leased_run(&state, &headers, &run_id, input.runner_id.as_deref()).await {
        Ok(run) => run.owner_account_id,
        Err(response) => return *response,
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
    Json(mut input): Json<RunnerSaveMemoryRequest>,
) -> Response {
    let run = match leased_run(&state, &headers, &run_id, input.runner_id.as_deref()).await {
        Ok(run) => run,
        Err(response) => return *response,
    };
    // The agent saves only into the run's own conversation and group, and
    // into global only when the owner made the request.
    if let Err(error) = run.check_save_scope(&input.memory.scope, &input.memory.scope_id) {
        return error.into_response();
    }
    // Everything a cloud run saves comes from the agent, whatever it claims.
    input.memory.declared_by = Some("agent".to_owned());
    let owner = run.owner_account_id;
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
                "category": memory.category,
                "declarationType": memory.declaration_type,
                "runId": run_id,
                "via": "runner",
            }),
        )
        .await;
    }
    outcome.into_response()
}
