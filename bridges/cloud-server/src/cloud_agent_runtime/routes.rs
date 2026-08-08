use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Extension, Json, Router};

use crate::auth::routes::{cloud_session_middleware, CloudSession};
use crate::cloud_agent_runtime::artifacts::{
    export_run_artifact, ExportArtifactEnvelope, ExportArtifactRequest,
};
use crate::cloud_agent_runtime::claim_route::claim_cloud_agent_run;
use crate::cloud_agent_runtime::provider_auth::{
    current_snapshot, provider_auth_for_run, publish_snapshot, revoke_snapshot,
    CurrentProviderAuthSnapshotQuery, CurrentProviderAuthSnapshotResponse, EnvProviderAuthCipher,
    ProviderAuthCipher, ProviderAuthForRunResult, PublishProviderAuthSnapshotRequest,
    RunnerProviderAuthMaterialEnvelope, ServiceProviderAuth,
};
use crate::cloud_agent_runtime::runs::{
    complete_run, error_response, fail_run, lease_canary_run, lease_next_run,
    lookup_run_for_request, mark_run_running, run_error_response, runner_unauthorized,
    CompleteRunRequest, FailRunRequest, RunnerLeaseResponse, RunnerRunEnvelope, RunnerRunRequest,
};
use crate::server::ServerState;

pub fn routes(state: Arc<ServerState>) -> Router {
    let user_routes = Router::new()
        .route("/v1/cloud/agent-runs/claim", post(claim_cloud_agent_run))
        .route(
            "/v1/cloud/agent-runs/request/:request_message_id",
            get(lookup_cloud_agent_run_for_request),
        )
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
            "/v1/cloud/agent-runs/:run_id/provider-auth",
            post(fetch_runner_provider_auth),
        )
        .route(
            "/v1/cloud/agent-runs/:run_id/artifacts",
            post(export_runner_artifact),
        )
        .with_state(state);

    user_routes.merge(runner_routes)
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

pub fn runner_authorized_for_scheduled_tasks(headers: &HeaderMap) -> bool {
    runner_authorized(headers)
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
    let lease_result = match input.canary_run_id() {
        Some(canary_run_id) => lease_canary_run(state.db_pool(), &runner_id, &canary_run_id).await,
        None => lease_next_run(state.db_pool(), &runner_id).await,
    };
    match lease_result {
        Ok(run) => Json(RunnerLeaseResponse { run }).into_response(),
        Err(error) => run_error_response(
            "lease run",
            "Could not lease Cloud agent fallback run.",
            error,
        ),
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
        Ok(run) => Json(RunnerRunEnvelope { run }).into_response(),
        Err(error) => run_error_response("mark running", "Could not mark run running.", error),
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
        Ok(run) => Json(RunnerRunEnvelope { run }).into_response(),
        Err(error) => run_error_response("complete run", "Could not complete run.", error),
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
        Ok(run) => Json(RunnerRunEnvelope { run }).into_response(),
        Err(error) => run_error_response("fail run", "Could not fail run.", error),
    }
}

async fn fetch_runner_provider_auth(
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
    let cipher = EnvProviderAuthCipher::from_env().ok();
    let service_auth = state.support().map(|support| {
        let config = support.config();
        let provider_auth = config.provider_auth();
        ServiceProviderAuth {
            owner_account_id: &config.owner_account_id,
            snapshot_id: provider_auth.snapshot_id(),
            provider: provider_auth.provider(),
            auth_choice: provider_auth.auth_choice(),
            api_key: provider_auth.api_key(),
            base_url: provider_auth.base_url(),
            model: provider_auth.model(),
        }
    });

    match provider_auth_for_run(
        state.db_pool(),
        cipher
            .as_ref()
            .map(|cipher| cipher as &dyn ProviderAuthCipher),
        service_auth,
        &run_id,
        &runner_id,
    )
    .await
    {
        Ok(ProviderAuthForRunResult::Found(provider_auth)) => {
            Json(RunnerProviderAuthMaterialEnvelope { provider_auth }).into_response()
        }
        Ok(ProviderAuthForRunResult::RunNotFound) => error_response(
            "agent_run_not_found",
            "Cloud agent run was not found for this runner.",
            StatusCode::NOT_FOUND,
        ),
        Ok(ProviderAuthForRunResult::ProviderAuthNotFound) => error_response(
            "provider_auth_not_found",
            "Cloud provider-auth snapshot was not found for this run.",
            StatusCode::NOT_FOUND,
        ),
        Ok(ProviderAuthForRunResult::ProviderAuthCipherUnavailable) => {
            eprintln!("[cloud_agent_runtime] provider auth cipher unavailable");
            error_response(
                "provider_auth_not_configured",
                "Cloud provider-auth snapshots are not configured on this server.",
                StatusCode::SERVICE_UNAVAILABLE,
            )
        }
        Err(err) => {
            eprintln!("[cloud_agent_runtime] fetch provider auth for run: {err}");
            error_response(
                "server_error",
                "Could not load Cloud provider-auth material.",
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

async fn lookup_cloud_agent_run_for_request(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(request_message_id): Path<String>,
) -> Response {
    let trimmed = request_message_id.trim();
    if trimmed.is_empty() {
        return error_response(
            "missing_request_message_id",
            "Request message id is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    match lookup_run_for_request(state.db_pool(), trimmed, &session.account_id).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => run_error_response(
            "lookup run for request",
            "Could not load Cloud fallback status.",
            error,
        ),
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
