//! HTTP admission boundary for Cloud fallback run claims.

use std::sync::Arc;

use crate::auth::routes::CloudSession;
use crate::cloud_agent_runtime::runs::{
    claim_has_shared_cloud_agent_target, claim_run, cloud_agent_response_is_processing_for_request,
    error_response, requester_can_target_owner, run_error_response,
    validate_agent_authored_group_handoff_claim, validate_shared_cloud_agent_claim,
    ClaimRunRequest,
};
use crate::server::ServerState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::{Duration as ChronoDuration, Utc};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

async fn owner_has_fresh_desktop_execution_claim(
    pool: &PgPool,
    input: &ClaimRunRequest,
    now: chrono::DateTime<Utc>,
    timeout: ChronoDuration,
) -> Result<bool, sqlx_core::Error> {
    let cutoff = now - timeout;
    let rows: Vec<(Option<String>,)> = query_as(
        "SELECT message.content #>> '{blocks,0,text}' \
         FROM cloud_chat_messages message \
         JOIN cloud_chat_conversations conversation \
           ON conversation.conversation_id = message.conversation_id \
         WHERE conversation.legacy_session_id = $1 \
           AND message.sender_account_id = $2 \
           AND message.created_at >= $3 \
           AND message.deleted_at IS NULL \
         ORDER BY message.conversation_sequence DESC \
         LIMIT 64",
    )
    .bind(input.session_id.trim())
    .bind(input.owner_account_id.trim())
    .bind(cutoff)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().any(|(body,)| {
        let Some(body) = body else { return false };
        cloud_agent_response_is_processing_for_request(&body, &input.request_message_id)
    }))
}

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

    let now = Utc::now();
    let route_timeout = crate::presence::presence_timeout();
    let owner_desktop_online = match crate::presence::account_has_online_desktop(
        state.db_pool(),
        &input.owner_account_id,
        now,
        route_timeout,
    )
    .await
    {
        Ok(value) => value,
        Err(error) => {
            return run_error_response(
                "check owner desktop presence",
                "Could not determine the agent execution route.",
                error.into(),
            );
        }
    };
    if owner_desktop_online {
        return error_response(
            "owner_online",
            "The owner Mac is online and will handle this agent request.",
            StatusCode::CONFLICT,
        );
    }
    let request_owned_by_desktop =
        match owner_has_fresh_desktop_execution_claim(state.db_pool(), &input, now, route_timeout)
            .await
        {
            Ok(value) => value,
            Err(error) => {
                return run_error_response(
                    "check desktop execution claim",
                    "Could not determine the agent execution route.",
                    error.into(),
                );
            }
        };
    if request_owned_by_desktop {
        return error_response(
            "owner_online",
            "The owner Mac has already claimed this agent request.",
            StatusCode::CONFLICT,
        );
    }

    // The exact idempotency key is the durable Cloud admission boundary once
    // no reachable owner Mac can claim the request.
    match claim_run(state.db_pool(), &input).await {
        Ok(run) => Json(run).into_response(),
        Err(error) => run_error_response(
            "claim run",
            "Could not claim Cloud agent fallback run.",
            error,
        ),
    }
}
