//! Stop requests for chat agent runs.
//!
//! The requester or the owner can ask to stop a run from any device. A queued
//! run is cancelled here and gets its terminal reply at once. A leased or
//! running run records the request; its executor reads it from the lease
//! renewal or heartbeat it already sends, stops the turn, and ends the run as
//! cancelled. Background-session runs keep their own stop route.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::Utc;
use serde::Serialize;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::leases::{runner_response_from_row, RunnerRunRow};
use super::{error_response, run_error_response, RunResult, RunnerRunResponse};
use crate::{auth::routes::CloudSession, server::ServerState};

/// The terminal reply text of a run its requester or owner stopped.
pub const STOPPED_TEXT: &str = "Request stopped.";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoppedRun {
    run_id: String,
    status: String,
    execution_backend: String,
    cancel_requested: bool,
}

enum StopOutcome {
    NotFound,
    Forbidden,
    Finished,
    Stopped(Vec<StoppedRun>),
}

/// `(run_id, owner_account_id, requester_account_id, status, execution_backend)`
type StopCandidate = (String, String, String, String, String);

async fn stop(
    state: &ServerState,
    account_id: &str,
    run_id: Option<&str>,
    request_message_id: Option<&str>,
) -> RunResult<StopOutcome> {
    let pool = state.db_pool();
    let candidates: Vec<StopCandidate> = query_as(
        "SELECT run_id, owner_account_id, requester_account_id, status, execution_backend \
         FROM cloud_agent_fallback_runs run \
         WHERE ($1::text IS NULL OR run_id = $1) \
           AND ($2::text IS NULL OR request_message_id = $2) \
           AND NOT legacy_duplicate AND subsession_id IS NULL \
           AND NOT EXISTS(SELECT 1 FROM cloud_agent_subsession_chat chat WHERE chat.run_id = run.run_id) \
         ORDER BY created_at",
    )
    .bind(run_id)
    .bind(request_message_id)
    .fetch_all(pool)
    .await?;
    if candidates.is_empty() {
        return Ok(StopOutcome::NotFound);
    }
    let allowed: Vec<_> = candidates
        .into_iter()
        .filter(|(_, owner, requester, ..)| owner == account_id || requester == account_id)
        .collect();
    if allowed.is_empty() {
        return Ok(StopOutcome::Forbidden);
    }
    let mut stopped = Vec::new();
    for (run_id, _, _, status, backend) in allowed {
        if !matches!(status.as_str(), "queued" | "leased" | "running") {
            continue;
        }
        let now = Utc::now().to_rfc3339();
        // Nobody executes a queued run or one whose lease has lapsed, so the
        // server ends it and publishes its reply.
        let ended = query(
            "UPDATE cloud_agent_fallback_runs SET status = 'cancelled', \
               cancel_requested_at = COALESCE(cancel_requested_at, now()), \
               completed_at = $2, updated_at = $2 \
             WHERE run_id = $1 AND (status = 'queued' OR (status IN ('leased', 'running') \
               AND lease_expires_at IS NOT NULL AND lease_expires_at::timestamptz <= now()))",
        )
        .bind(&run_id)
        .bind(&now)
        .execute(pool)
        .await?
        .rows_affected()
            == 1;
        if ended {
            super::terminal_backfill::publish_after_cancel(state, &run_id).await;
            stopped.push(StoppedRun {
                run_id,
                status: "cancelled".into(),
                execution_backend: backend,
                cancel_requested: true,
            });
            continue;
        }
        let flagged: Option<(String,)> = query_as(
            "UPDATE cloud_agent_fallback_runs \
             SET cancel_requested_at = COALESCE(cancel_requested_at, now()), updated_at = $2 \
             WHERE run_id = $1 AND status IN ('leased', 'running') RETURNING status",
        )
        .bind(&run_id)
        .bind(&now)
        .fetch_optional(pool)
        .await?;
        if let Some((status,)) = flagged {
            stopped.push(StoppedRun {
                run_id,
                status,
                execution_backend: backend,
                cancel_requested: true,
            });
        }
    }
    Ok(if stopped.is_empty() {
        StopOutcome::Finished
    } else {
        StopOutcome::Stopped(stopped)
    })
}

fn stop_response(outcome: RunResult<StopOutcome>, single: bool) -> Response {
    match outcome {
        Ok(StopOutcome::Stopped(mut runs)) => {
            if single {
                Json(serde_json::json!({ "run": runs.remove(0) })).into_response()
            } else {
                Json(serde_json::json!({ "runs": runs })).into_response()
            }
        }
        Ok(StopOutcome::NotFound) => error_response(
            "agent_run_not_found",
            "This request has no agent run.",
            StatusCode::NOT_FOUND,
        ),
        Ok(StopOutcome::Forbidden) => error_response(
            "agent_run_stop_denied",
            "Only the requester or the agent owner can stop this request.",
            StatusCode::FORBIDDEN,
        ),
        Ok(StopOutcome::Finished) => error_response(
            "agent_run_finished",
            "This request already finished.",
            StatusCode::CONFLICT,
        ),
        Err(error) => run_error_response("stop run", "Could not stop the request.", error),
    }
}

/// `POST /v1/cloud/agent-runs/:run_id/stop`
pub(crate) async fn stop_run_route(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(run_id): Path<String>,
) -> Response {
    let outcome = stop(&state, &session.account_id, Some(run_id.trim()), None).await;
    stop_response(outcome, true)
}

/// `POST /v1/cloud/agent-runs/request/:request_message_id/stop` stops every
/// run of the request the caller may stop, such as each mentioned agent.
pub(crate) async fn stop_request_route(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(request_message_id): Path<String>,
) -> Response {
    let request_message_id = request_message_id.trim();
    if request_message_id.is_empty() {
        return error_response(
            "missing_request_message_id",
            "Request message id is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    let outcome = stop(&state, &session.account_id, None, Some(request_message_id)).await;
    stop_response(outcome, false)
}

/// Ends a Cloud runner's run whose stop was requested, publishes its terminal
/// reply, and returns the cancelled run so the runner stops working on it.
pub(crate) async fn acknowledge_runner_stop(
    state: &ServerState,
    run_id: &str,
    runner_id: &str,
) -> RunResult<Option<RunnerRunResponse>> {
    let now = Utc::now().to_rfc3339();
    let row: Option<RunnerRunRow> = query_as(
        "UPDATE cloud_agent_fallback_runs SET status = 'cancelled', completed_at = $3, updated_at = $3 \
         WHERE run_id = $1 AND claimed_by = $2 AND execution_backend = 'cloud' \
           AND status IN ('leased', 'running') AND cancel_requested_at IS NOT NULL \
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id, session_id, sandbox_id, runtime_route_json, response_message_id, error_code, error_message, system_prompt",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(&now)
    .fetch_optional(state.db_pool())
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    super::terminal_backfill::publish_after_cancel(state, run_id).await;
    runner_response_from_row(state.db_pool(), row)
        .await
        .map(Some)
}

/// Whether a desktop executor holding `run_id` was asked to stop it. Errors
/// read as no request: the renewal itself already succeeded.
pub(crate) async fn desktop_cancel_requested(pool: &PgPool, run_id: &str) -> bool {
    query_as::<_, (bool,)>(
        "SELECT cancel_requested_at IS NOT NULL FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .is_some_and(|(requested,)| requested)
}

/// Ends stop-requested runs whose executor let the lease lapse and publishes
/// their terminal replies.
pub async fn release_stopped_runs(pool: &PgPool) -> RunResult<()> {
    let runs: Vec<(String,)> = query_as(
        "UPDATE cloud_agent_fallback_runs SET status = 'cancelled', \
           completed_at = now()::text, updated_at = now()::text \
         WHERE cancel_requested_at IS NOT NULL AND status IN ('leased', 'running') \
           AND lease_expires_at IS NOT NULL AND lease_expires_at::timestamptz <= now() \
         RETURNING run_id",
    )
    .fetch_all(pool)
    .await?;
    for (run_id,) in runs {
        if let Err(error) =
            super::terminal_backfill::publish_missing_terminal_response(pool, &run_id).await
        {
            eprintln!("[cloud_agent_runtime] terminal reply for stopped {run_id}: {error}");
        }
    }
    Ok(())
}
