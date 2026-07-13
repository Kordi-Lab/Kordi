use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Extension, Json, Router};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::routes::{cloud_session_middleware, CloudSession};
use crate::cloud_agent_runtime::routes::runner_authorized_for_scheduled_tasks;
use crate::scheduled_tasks::models::{
    CreateScheduledTaskRequest, ScheduledTaskResponse, ScheduledTaskRunResponse,
};
use crate::scheduled_tasks::store::{
    claim_due_scheduled_task_runs, create_scheduled_task, create_scheduled_task_run_now,
    list_scheduled_task_runs, list_scheduled_tasks, pause_scheduled_task, resume_scheduled_task,
    soft_delete_scheduled_task,
};
use crate::server::ServerState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledTasksListResponse {
    tasks: Vec<ScheduledTaskResponse>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledTaskEnvelope {
    task: ScheduledTaskResponse,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledTaskRunEnvelope {
    run: ScheduledTaskRunResponse,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledTaskRunsEnvelope {
    runs: Vec<ScheduledTaskRunResponse>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimRunsRequest {
    runner_id: String,
    limit: Option<i64>,
}

pub fn routes(state: Arc<ServerState>) -> Router {
    let user_routes = Router::new()
        .route(
            "/v1/cloud/scheduled-tasks",
            get(list_tasks).post(create_task),
        )
        .route("/v1/cloud/scheduled-tasks/:task_id", delete(delete_task))
        .route("/v1/cloud/scheduled-tasks/:task_id/pause", post(pause_task))
        .route(
            "/v1/cloud/scheduled-tasks/:task_id/resume",
            post(resume_task),
        )
        .route(
            "/v1/cloud/scheduled-tasks/:task_id/run-now",
            post(run_task_now),
        )
        .route(
            "/v1/cloud/scheduled-tasks/:task_id/runs",
            get(list_task_runs),
        )
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .with_state(state.clone());

    let runner_routes = Router::new()
        .route("/v1/cloud/scheduled-task-runs/claim", post(claim_runs))
        .with_state(state);

    user_routes.merge(runner_routes)
}

fn error_response(error_code: &'static str, message: &'static str, status: StatusCode) -> Response {
    (
        status,
        Json(json!({
            "errorCode": error_code,
            "message": message,
        })),
    )
        .into_response()
}

async fn list_tasks(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match list_scheduled_tasks(state.db_pool(), &session.account_id).await {
        Ok(tasks) => Json(ScheduledTasksListResponse { tasks }).into_response(),
        Err(err) => {
            eprintln!("[scheduled_tasks] list: {err}");
            error_response(
                "server_error",
                "Could not list scheduled tasks.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

async fn create_task(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(input): Json<CreateScheduledTaskRequest>,
) -> Response {
    if !input.is_well_formed() {
        return error_response(
            "invalid_scheduled_task",
            "title and prompt are required.",
            StatusCode::BAD_REQUEST,
        );
    }
    match create_scheduled_task(
        state.db_pool(),
        &session.account_id,
        &session.account_id,
        input,
        Utc::now(),
    )
    .await
    {
        Ok(task) => Json(ScheduledTaskEnvelope { task }).into_response(),
        Err(err) => {
            eprintln!("[scheduled_tasks] create: {err}");
            error_response(
                "server_error",
                "Could not create scheduled task.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

async fn pause_task(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(task_id): Path<String>,
) -> Response {
    match pause_scheduled_task(state.db_pool(), &session.account_id, &task_id).await {
        Ok(Some(task)) => Json(ScheduledTaskEnvelope { task }).into_response(),
        Ok(None) => error_response(
            "scheduled_task_not_found",
            "Scheduled task was not found.",
            StatusCode::NOT_FOUND,
        ),
        Err(err) => {
            eprintln!("[scheduled_tasks] pause: {err}");
            error_response(
                "server_error",
                "Could not pause scheduled task.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

async fn resume_task(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(task_id): Path<String>,
) -> Response {
    match resume_scheduled_task(state.db_pool(), &session.account_id, &task_id, Utc::now()).await {
        Ok(Some(task)) => Json(ScheduledTaskEnvelope { task }).into_response(),
        Ok(None) => error_response(
            "scheduled_task_not_found",
            "Scheduled task was not found.",
            StatusCode::NOT_FOUND,
        ),
        Err(err) => {
            eprintln!("[scheduled_tasks] resume: {err}");
            error_response(
                "server_error",
                "Could not resume scheduled task.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

async fn delete_task(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(task_id): Path<String>,
) -> Response {
    match soft_delete_scheduled_task(state.db_pool(), &session.account_id, &task_id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => error_response(
            "scheduled_task_not_found",
            "Scheduled task was not found.",
            StatusCode::NOT_FOUND,
        ),
        Err(err) => {
            eprintln!("[scheduled_tasks] delete: {err}");
            error_response(
                "server_error",
                "Could not delete scheduled task.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

async fn run_task_now(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(task_id): Path<String>,
) -> Response {
    match create_scheduled_task_run_now(state.db_pool(), &session.account_id, &task_id, Utc::now())
        .await
    {
        Ok(Some(run)) => Json(ScheduledTaskRunEnvelope { run }).into_response(),
        Ok(None) => error_response(
            "scheduled_task_not_found",
            "Scheduled task was not found.",
            StatusCode::NOT_FOUND,
        ),
        Err(err) => {
            eprintln!("[scheduled_tasks] run now: {err}");
            error_response(
                "server_error",
                "Could not run scheduled task.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

async fn list_task_runs(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(task_id): Path<String>,
) -> Response {
    match list_scheduled_task_runs(state.db_pool(), &session.account_id, &task_id, 20).await {
        Ok(runs) => Json(ScheduledTaskRunsEnvelope { runs }).into_response(),
        Err(err) => {
            eprintln!("[scheduled_tasks] list runs: {err}");
            error_response(
                "server_error",
                "Could not list scheduled task runs.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

async fn claim_runs(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(input): Json<ClaimRunsRequest>,
) -> Response {
    if !runner_authorized_for_scheduled_tasks(&headers) {
        return error_response(
            "invalid_runner_token",
            "Missing or invalid Cloud runner token.",
            StatusCode::UNAUTHORIZED,
        );
    }
    if input.runner_id.trim().is_empty() {
        return error_response(
            "invalid_runner_request",
            "runnerId is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    let limit = input.limit.unwrap_or(10).clamp(1, 50);
    match claim_due_scheduled_task_runs(state.db_pool(), Utc::now(), limit).await {
        Ok(runs) => Json(ScheduledTaskRunsEnvelope { runs }).into_response(),
        Err(err) => {
            eprintln!("[scheduled_tasks] claim runs: {err}");
            error_response(
                "server_error",
                "Could not claim scheduled task runs.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}
