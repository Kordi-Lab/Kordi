//! Plan-card actions issued by the cloud runner on behalf of a leased PiP run.
//!
//! The runner authenticates with its runner token; this module binds the
//! action to the run's owner (PiP's system account) and the run's own
//! conversation, so a run can never touch another chat's card.

use std::sync::Arc;

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use crate::server::ServerState;

use super::routes::{dispatch_row, Actor, Request};

fn error(code: &str, message: &str, status: StatusCode) -> Response {
    (status, Json(json!({"errorCode": code, "message": message}))).into_response()
}

pub async fn runner_action(
    state: &Arc<ServerState>,
    run_id: &str,
    runner_id: &str,
    request: Value,
) -> Response {
    let Some(pip) = state.pip() else {
        return error(
            "plan_card_unavailable",
            "PiP is not enabled on this server.",
            StatusCode::NOT_FOUND,
        );
    };
    let pip_account_id = pip.config().account_id.clone();
    let run: Option<(String, String)> = match query_as(
        "SELECT owner_account_id, session_id FROM cloud_agent_fallback_runs
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(state.db_pool())
    .await
    {
        Ok(run) => run,
        Err(_) => {
            return error(
                "plan_card_unavailable",
                "Could not verify this run.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    let Some((owner_account_id, session_id)) = run else {
        return error(
            "run_not_found",
            "This run is not leased by the caller.",
            StatusCode::NOT_FOUND,
        );
    };
    if owner_account_id != pip_account_id {
        return error(
            "plan_card_forbidden",
            "Only PiP runs may manage plan cards through the runner.",
            StatusCode::FORBIDDEN,
        );
    }
    let conversation_id: Option<Uuid> = crate::chat_sync::store::conversation_id_for_session(
        state.db_pool(),
        &pip_account_id,
        &session_id,
    )
    .await
    .unwrap_or_default();
    let Some(conversation_id) = conversation_id else {
        return error(
            "plan_card_forbidden",
            "PiP is not an active member of this conversation.",
            StatusCode::FORBIDDEN,
        );
    };
    let request_summary = serde_json::to_string(&request).unwrap_or_default();
    let request: Request = match serde_json::from_value(request) {
        Ok(request) => request,
        Err(err) => {
            return error(
                "invalid_plan_card_request",
                &format!("Plan card request is invalid: {err}"),
                StatusCode::BAD_REQUEST,
            )
        }
    };
    let actor = Actor {
        account_id: pip_account_id,
        on_behalf_of_conversation: Some(conversation_id),
    };
    match dispatch_row(state.db_pool(), &actor, request).await {
        // The model gets the compact card: counts and the people it may need
        // to name, never every voter of a large group.
        Ok(row) => Json(crate::pip::context::compact_card(&row)).into_response(),
        Err(response) => {
            eprintln!(
                "[pip] plan_card action rejected for run {run_id}: status {} request {}",
                response.status(),
                request_summary.chars().take(600).collect::<String>()
            );
            response
        }
    }
}
