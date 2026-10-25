//! Runs a Mac starts for its own account without a chat message, such as a
//! memory import ([`super::import_runs`]). The Mac renews and releases the run
//! through the ordinary desktop routes and ends it with [`complete`].

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use super::import_runs;
use super::runs::{error_response, AgentRuntimeRoute};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

const MEMORY_IMPORT: &str = "memory_import";

fn executor(session: &CloudSession, claim_id: Uuid) -> String {
    format!("desktop:{}:{claim_id}", session.device_id)
}

fn denied() -> Response {
    error_response(
        "desktop_execution_denied",
        "This desktop cannot execute the requested agent run.",
        StatusCode::FORBIDDEN,
    )
}

fn failed() -> Response {
    error_response(
        "server_error",
        "Could not update the task run.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskInput {
    kind: String,
    claim_id: Uuid,
    #[serde(default)]
    runtime_route: Option<AgentRuntimeRoute>,
}

/// Starts a run of `kind` leased to this Mac.
pub(super) async fn tasks(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(input): Json<TaskInput>,
) -> Response {
    if input.kind != MEMORY_IMPORT {
        return error_response(
            "unsupported_task",
            "This task is not supported.",
            StatusCode::BAD_REQUEST,
        );
    }
    let pool = state.db_pool();
    match import_runs::is_owner_mac(pool, &session).await {
        Ok(true) => {}
        Ok(false) => return denied(),
        Err(_) => return failed(),
    }
    let owner = executor(&session, input.claim_id);
    let started = import_runs::start(
        pool,
        &session.account_id,
        &owner,
        input.runtime_route.as_ref(),
    )
    .await;
    match started {
        Ok(value) => {
            if let Some(run_id) = value["runId"].as_str() {
                audit(&state, &session, "memory_import_started", run_id).await;
            }
            Json(value).into_response()
        }
        Err(_) => failed(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CompleteInput {
    claim_id: Uuid,
}

/// Ends a task run this Mac holds. No output is read.
pub(super) async fn complete(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(run_id): Path<String>,
    Json(input): Json<CompleteInput>,
) -> Response {
    if !import_runs::is_import_run(&run_id) {
        return denied();
    }
    let owner = executor(&session, input.claim_id);
    match import_runs::finish(state.db_pool(), &run_id, &session.account_id, &owner, true).await {
        Ok(true) => {
            audit(&state, &session, "memory_import_completed", &run_id).await;
            Json(json!({"ok": true})).into_response()
        }
        Ok(false) => error_response(
            "execution_lease_lost",
            "This runtime no longer owns the request.",
            StatusCode::CONFLICT,
        ),
        Err(_) => failed(),
    }
}

/// The audit row names the run only, never what was imported.
async fn audit(state: &ServerState, session: &CloudSession, event: &str, run_id: &str) {
    crate::memory_store::write_memory_audit(
        state.db_pool(),
        &session.account_id,
        Some(&session.device_id),
        event,
        json!({"runId": run_id}),
    )
    .await;
}
