use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Extension, Json, Router};
use chrono::Utc;
use serde_json::json;

use crate::auth::routes::{cloud_session_middleware, CloudSession};
use crate::cloud_agent_runtime::artifacts::{
    export_run_artifact, ExportArtifactEnvelope, ExportArtifactRequest,
};
use crate::cloud_agent_runtime::provider_auth::{
    current_snapshot, publish_snapshot, revoke_snapshot, CurrentProviderAuthSnapshotQuery,
    CurrentProviderAuthSnapshotResponse, EnvProviderAuthCipher, PublishProviderAuthSnapshotRequest,
};
use crate::cloud_agent_runtime::runs::{
    claim_run, complete_run, fail_run, lease_next_run, mark_run_running,
    requester_can_target_owner, ClaimRunRequest, CompleteRunRequest, FailRunRequest,
    RunnerLeaseResponse, RunnerRunEnvelope, RunnerRunRequest,
};
use crate::presence::{account_presence_status, presence_timeout, AccountPresenceStatus};
use crate::server::ServerState;

pub fn routes(state: Arc<ServerState>) -> Router {
    let user_routes = Router::new()
        .route("/v1/cloud/agent-runs/claim", post(claim_cloud_agent_run))
        .route(
            "/v1/cloud/agent-provider-auth/snapshots",
            post(publish_provider_auth_snapshot),
        )
        .route(
            "/v1/cloud/agent-provider-auth/snapshots/current",
            get(current_provider_auth_snapshot),
        )
        .route(
            "/v1/cloud/agent-provider-auth/snapshots/:snapshot_id",
            delete(revoke_provider_auth_snapshot),
        )
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .with_state(state.clone());

    let runner_routes = Router::new()
        .route("/v1/cloud/agent-runs/lease", post(lease_runner_run))
        .route(
            "/v1/cloud/agent-runs/:run_id/running",
            post(mark_runner_run_running),
        )
        .route(
            "/v1/cloud/agent-runs/:run_id/complete",
            post(complete_runner_run),
        )
        .route("/v1/cloud/agent-runs/:run_id/fail", post(fail_runner_run))
        .route(
            "/v1/cloud/agent-runs/:run_id/artifacts",
            post(export_runner_artifact),
        )
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

fn runner_authorized(headers: &HeaderMap) -> bool {
    let Ok(expected) = std::env::var("KORDI_CLOUD_RUNNER_TOKEN") else {
        return false;
    };
    if expected.trim().is_empty() {
        return false;
    }
    let Some(raw) = headers.get(axum::http::header::AUTHORIZATION) else {
        return false;
    };
    let Ok(value) = raw.to_str() else {
        return false;
    };
    value == format!("Bearer {expected}")
}

fn runner_unauthorized() -> Response {
    error_response(
        "invalid_runner_token",
        "Missing or invalid Cloud runner token.",
        StatusCode::UNAUTHORIZED,
    )
}

async fn lease_runner_run(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(input): Json<RunnerRunRequest>,
) -> Response {
    if !runner_authorized(&headers) {
        return runner_unauthorized();
    }
    let Some(runner_id) = input.runner_id() else {
        return error_response(
            "invalid_runner_request",
            "runnerId is required.",
            StatusCode::BAD_REQUEST,
        );
    };
    match lease_next_run(state.db_pool(), &runner_id).await {
        Ok(run) => Json(RunnerLeaseResponse { run }).into_response(),
        Err(err) => {
            eprintln!("[cloud_agent_runtime] lease run: {err}");
            error_response(
                "server_error",
                "Could not lease Cloud agent fallback run.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

async fn mark_runner_run_running(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Json(input): Json<RunnerRunRequest>,
) -> Response {
    if !runner_authorized(&headers) {
        return runner_unauthorized();
    }
    let Some(runner_id) = input.runner_id() else {
        return error_response(
            "invalid_runner_request",
            "runnerId is required.",
            StatusCode::BAD_REQUEST,
        );
    };
    match mark_run_running(state.db_pool(), &run_id, &runner_id).await {
        Ok(Some(run)) => Json(RunnerRunEnvelope { run }).into_response(),
        Ok(None) => error_response(
            "agent_run_not_found",
            "Cloud agent run was not found for this runner.",
            StatusCode::NOT_FOUND,
        ),
        Err(err) => {
            eprintln!("[cloud_agent_runtime] mark running: {err}");
            error_response(
                "server_error",
                "Could not mark run running.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

async fn complete_runner_run(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Json(input): Json<CompleteRunRequest>,
) -> Response {
    if !runner_authorized(&headers) {
        return runner_unauthorized();
    }
    let Some(runner_id) = input.runner_id() else {
        return error_response(
            "invalid_runner_request",
            "runnerId is required.",
            StatusCode::BAD_REQUEST,
        );
    };
    match complete_run(state.db_pool(), &run_id, &runner_id, &input.response_text).await {
        Ok(Some(run)) => Json(RunnerRunEnvelope { run }).into_response(),
        Ok(None) => error_response(
            "agent_run_not_found",
            "Cloud agent run was not found for this runner.",
            StatusCode::NOT_FOUND,
        ),
        Err(err) => {
            eprintln!("[cloud_agent_runtime] complete run: {err}");
            error_response(
                "server_error",
                "Could not complete run.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

async fn fail_runner_run(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Json(input): Json<FailRunRequest>,
) -> Response {
    if !runner_authorized(&headers) {
        return runner_unauthorized();
    }
    let Some(runner_id) = input.runner_id() else {
        return error_response(
            "invalid_runner_request",
            "runnerId is required.",
            StatusCode::BAD_REQUEST,
        );
    };
    match fail_run(
        state.db_pool(),
        &run_id,
        &runner_id,
        &input.error_code(),
        &input.message,
    )
    .await
    {
        Ok(Some(run)) => Json(RunnerRunEnvelope { run }).into_response(),
        Ok(None) => error_response(
            "agent_run_not_found",
            "Cloud agent run was not found for this runner.",
            StatusCode::NOT_FOUND,
        ),
        Err(err) => {
            eprintln!("[cloud_agent_runtime] fail run: {err}");
            error_response(
                "server_error",
                "Could not fail run.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

async fn export_runner_artifact(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Json(input): Json<ExportArtifactRequest>,
) -> Response {
    if !runner_authorized(&headers) {
        return runner_unauthorized();
    }
    let Some(runner_id) = input.runner_id() else {
        return error_response(
            "invalid_runner_request",
            "runnerId is required.",
            StatusCode::BAD_REQUEST,
        );
    };
    let Some(s3) = state.s3() else {
        return error_response(
            "attachments_unavailable",
            "Object storage is not configured on this server.",
            StatusCode::SERVICE_UNAVAILABLE,
        );
    };
    match export_run_artifact(state.db_pool(), s3, &run_id, &runner_id, input).await {
        Ok(artifact) => (
            StatusCode::CREATED,
            Json(ExportArtifactEnvelope { artifact }),
        )
            .into_response(),
        Err(err) => error_response(err.code, err.message, err.status),
    }
}

async fn publish_provider_auth_snapshot(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(input): Json<PublishProviderAuthSnapshotRequest>,
) -> Response {
    let Some(input) = input.normalized() else {
        return error_response(
            "invalid_provider_auth_snapshot",
            "Provider, authChoice, and payload are required.",
            StatusCode::BAD_REQUEST,
        );
    };
    let cipher = match EnvProviderAuthCipher::from_env() {
        Ok(cipher) => cipher,
        Err(err) => {
            eprintln!("[cloud_agent_runtime] provider auth cipher unavailable: {err}");
            return error_response(
                "provider_auth_not_configured",
                "Cloud provider-auth snapshots are not configured on this server.",
                StatusCode::SERVICE_UNAVAILABLE,
            );
        }
    };
    match publish_snapshot(
        state.db_pool(),
        &cipher,
        &session.account_id,
        &session.device_id,
        input,
    )
    .await
    {
        Ok(snapshot) => (StatusCode::CREATED, Json(snapshot)).into_response(),
        Err(err) => {
            eprintln!("[cloud_agent_runtime] publish provider auth snapshot: {err}");
            error_response(
                "server_error",
                "Could not publish Cloud provider-auth snapshot.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

async fn current_provider_auth_snapshot(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Query(query): Query<CurrentProviderAuthSnapshotQuery>,
) -> Response {
    match current_snapshot(state.db_pool(), &session.account_id, &query).await {
        Ok(snapshot) => Json(CurrentProviderAuthSnapshotResponse { snapshot }).into_response(),
        Err(err) => {
            eprintln!("[cloud_agent_runtime] current provider auth snapshot: {err}");
            error_response(
                "server_error",
                "Could not load Cloud provider-auth snapshot.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

async fn revoke_provider_auth_snapshot(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(snapshot_id): Path<String>,
) -> Response {
    match revoke_snapshot(state.db_pool(), &session.account_id, &snapshot_id).await {
        Ok(Some(snapshot)) => Json(snapshot).into_response(),
        Ok(None) => error_response(
            "provider_auth_snapshot_not_found",
            "Cloud provider-auth snapshot was not found.",
            StatusCode::NOT_FOUND,
        ),
        Err(err) => {
            eprintln!("[cloud_agent_runtime] revoke provider auth snapshot: {err}");
            error_response(
                "server_error",
                "Could not revoke Cloud provider-auth snapshot.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

async fn claim_cloud_agent_run(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(input): Json<ClaimRunRequest>,
) -> Response {
    if !input.is_well_formed() {
        return error_response(
            "invalid_agent_run",
            "Cloud agent run claim is missing required fields.",
            StatusCode::BAD_REQUEST,
        );
    }

    if session.account_id != input.requester_account_id {
        return error_response(
            "requester_mismatch",
            "Cloud agent run requester must match the authenticated session.",
            StatusCode::FORBIDDEN,
        );
    }

    let can_target = match requester_can_target_owner(
        state.db_pool(),
        &input.requester_account_id,
        &input.owner_account_id,
    )
    .await
    {
        Ok(value) => value,
        Err(err) => {
            eprintln!("[cloud_agent_runtime] check requester contact: {err}");
            return error_response(
                "server_error",
                "Could not validate Cloud agent run authorization.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    if !can_target {
        return error_response(
            "agent_not_available",
            "Cloud fallback is available only to the owner or accepted contacts.",
            StatusCode::FORBIDDEN,
        );
    }

    let owner_presence = match account_presence_status(
        state.db_pool(),
        &input.owner_account_id,
        Utc::now(),
        presence_timeout(),
    )
    .await
    {
        Ok(summary) => summary,
        Err(err) => {
            eprintln!("[cloud_agent_runtime] load owner presence: {err}");
            return error_response(
                "server_error",
                "Could not validate owner presence for Cloud fallback.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    if owner_presence.status == AccountPresenceStatus::Online {
        return error_response(
            "owner_online",
            "The owner device is online, so Cloud fallback did not claim this run.",
            StatusCode::CONFLICT,
        );
    }

    match claim_run(state.db_pool(), &input).await {
        Ok(run) => Json(run).into_response(),
        Err(err) => {
            eprintln!("[cloud_agent_runtime] claim run: {err}");
            error_response(
                "server_error",
                "Could not claim Cloud agent fallback run.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}
