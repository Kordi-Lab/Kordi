use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Extension, Json, Router};
use chrono::Utc;
use serde_json::json;

use crate::auth::routes::{cloud_session_middleware, CloudSession};
use crate::cloud_agent_runtime::runs::{claim_run, requester_can_target_owner, ClaimRunRequest};
use crate::presence::{account_presence_status, presence_timeout, AccountPresenceStatus};
use crate::server::ServerState;

pub fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/v1/cloud/agent-runs/claim", post(claim_cloud_agent_run))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .with_state(state)
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
