//! HTTP admission boundary for Cloud fallback run claims.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::Utc;

use crate::auth::routes::CloudSession;
use crate::cloud_agent_runtime::runs::{
    claim_has_shared_cloud_agent_target, claim_run, error_response, requester_can_target_owner,
    run_error_response, validate_agent_authored_group_handoff_claim,
    validate_shared_cloud_agent_claim, ClaimRunRequest,
};
use crate::presence::{account_presence_status, presence_timeout, AccountPresenceStatus};
use crate::server::ServerState;

pub(super) async fn claim_cloud_agent_run(
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

    let valid_agent_handoff =
        match validate_agent_authored_group_handoff_claim(state.db_pool(), &input).await {
            Ok(value) => value,
            Err(error) => {
                return run_error_response(
                    "validate agent-authored handoff",
                    "Could not validate Cloud agent run authorization.",
                    error,
                );
            }
        };
    if !valid_agent_handoff {
        return error_response(
            "agent_not_available",
            "Agent-authored group request does not target this Kordi.",
            StatusCode::FORBIDDEN,
        );
    }

    let shared_agent_target =
        match claim_has_shared_cloud_agent_target(state.db_pool(), &input).await {
            Ok(value) => value,
            Err(error) => {
                return run_error_response(
                    "inspect shared agent target",
                    "Could not validate Cloud agent run authorization.",
                    error,
                );
            }
        };
    let shared_agent_allowed = if shared_agent_target {
        match validate_shared_cloud_agent_claim(state.db_pool(), &input).await {
            Ok(value) => value,
            Err(error) => {
                return run_error_response(
                    "validate shared agent target",
                    "Could not validate Cloud agent run authorization.",
                    error,
                );
            }
        }
    } else {
        false
    };
    if shared_agent_target && !shared_agent_allowed {
        return error_response(
            "agent_not_available",
            "Shared Cloud Agent is no longer available in this conversation.",
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
        Err(error) => {
            return run_error_response(
                "check requester contact",
                "Could not validate Cloud agent run authorization.",
                error,
            );
        }
    };

    if !can_target && !shared_agent_allowed {
        return error_response(
            "agent_not_available",
            "Cloud fallback is available only to the owner, accepted contacts, or shared agents in conversations with the owner.",
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
        Err(error) => run_error_response(
            "claim run",
            "Could not claim Cloud agent fallback run.",
            error,
        ),
    }
}
