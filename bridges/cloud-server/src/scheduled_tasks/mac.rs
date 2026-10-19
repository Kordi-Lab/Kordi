//! Scheduled runs on the owner's Mac.
//!
//! A Mac that can run scheduled tasks publishes the [`CAPABILITY`] readiness
//! row. Each occurrence is queued as an agent run:
//! - A `cloud` task is held for a ready Mac for one presence timeout. When no
//!   Mac claims it by then, or no Mac is ready, the cloud runner runs it once.
//! - A `local_required` task needs the Mac. Its run is held for the Mac and the
//!   cloud runner never leases it. It waits as `waiting_for_desktop` until a
//!   Mac claims it, and fails visibly after [`LOCAL_WAIT_HOURS`].
//!
//! The Mac finds held runs through [`pending`], claims one through the desktop
//! claim route ([`claim`]), runs it with its normal agent turn, and ends it
//! through [`complete`] or [`fail`]. Completion goes through the same delivery
//! as a cloud run, so the reply lands in the same conversation.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::auth::routes::CloudSession;
use crate::cloud_agent_runtime::runs::{
    claim_run, claim_run_held_for_desktop, complete_run, fail_run, ClaimRunRequest, RunError,
    RunResult,
};
use crate::scheduled_tasks::models::ScheduledTaskRunResponse;
use crate::server::ServerState;

/// The readiness row a Mac publishes when it can run scheduled tasks.
pub const CAPABILITY: &str = "scheduled";
/// How long a `local_required` run waits for a Mac before it fails.
pub const LOCAL_WAIT_HOURS: i64 = 12;
/// Seconds a desktop claim holds the run before it must renew, as for chat.
const LEASE_SECONDS: i64 = 45;
const UNAVAILABLE_CODE: &str = "desktop_unavailable";
const UNAVAILABLE_MESSAGE: &str = "Your Mac was not online to run this task.";

/// One due occurrence of a scheduled task.
pub(super) struct Occurrence<'a> {
    pub owner_account_id: &'a str,
    pub created_by_account_id: &'a str,
    pub prompt: &'a str,
    pub tool_payload: &'a Value,
    pub target_runtime: &'a str,
}

fn local(target_runtime: &str) -> bool {
    target_runtime == "local_required"
}

/// Queues the agent run of one occurrence, Mac first.
pub(super) async fn enqueue(
    pool: &PgPool,
    task: &Occurrence<'_>,
    run: &ScheduledTaskRunResponse,
) -> Result<(), sqlx_core::Error> {
    let session_id = task
        .tool_payload
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("session:scheduled:{}", task.owner_account_id));
    // A scheduled occurrence has no requesting person present, so it is a
    // background run and connector tools are read only.
    let claim = ClaimRunRequest {
        request_message_id: run.run_id.clone(),
        session_id,
        owner_account_id: task.owner_account_id.to_string(),
        requester_account_id: task.created_by_account_id.to_string(),
        prompt: task.prompt.to_string(),
        runtime_route: None,
        idempotency_key: format!("scheduled:{}", run.run_id),
    };
    let result = if local(task.target_runtime) {
        // Only a Mac runs it; the hold outlasts the wait, which ends it first.
        claim_run_held_for_desktop(pool, &claim, Utc::now() + Duration::days(3650)).await
    } else if mac_ready(pool, task.owner_account_id).await? {
        let until = Utc::now() + crate::presence::presence_timeout();
        claim_run_held_for_desktop(pool, &claim, until).await
    } else {
        claim_run(pool, &claim).await
    };
    result.map(|_| ()).map_err(RunError::into_persistence_error)
}

async fn mac_ready(pool: &PgPool, owner: &str) -> Result<bool, sqlx_core::Error> {
    crate::cloud_agent_runtime::agent_desktop_ready(pool, owner, CAPABILITY).await
}

/// Admits the signed-in owner's Mac to the scheduled run behind
/// `input.request_message_id`. `Ok(None)` refuses the claim: this Mac is not
/// ready to run scheduled tasks. Otherwise the answer says whether this claim
/// holds the run; a run the cloud runner or another Mac took answers
/// `acquired: false`.
pub(crate) async fn claim(
    pool: &PgPool,
    session: &CloudSession,
    executor: &str,
    input: &ClaimRunRequest,
) -> RunResult<Option<Value>> {
    let (ready,): (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_agent_desktop_capabilities ready \
           JOIN cloud_devices device USING(device_id) \
           WHERE ready.device_id = $1 AND device.account_id = $2 AND device.revoked_at IS NULL \
             AND ready.agent_id = $3 AND ready.updated_at > now() - interval '35 seconds')",
    )
    .bind(&session.device_id)
    .bind(&session.account_id)
    .bind(CAPABILITY)
    .fetch_one(pool)
    .await?;
    if !ready {
        return Ok(None);
    }
    let now = Utc::now();
    // A cloud task's run goes to the cloud runner if this Mac stops renewing;
    // a local task's run keeps its hold, so only a Mac takes it over.
    let taken: Option<(String,)> = query_as(
        "UPDATE cloud_agent_fallback_runs run \
         SET status = 'leased', execution_backend = 'desktop', claimed_by = $3, \
             lease_expires_at = $4, updated_at = $5, \
             desktop_preferred_until = CASE WHEN scheduled.target_runtime = 'local_required' \
               THEN run.desktop_preferred_until ELSE NULL END, \
             runtime_route_json = COALESCE($6, run.runtime_route_json) \
         FROM scheduled_tool_task_runs scheduled \
         WHERE scheduled.run_id = run.request_message_id \
           AND run.owner_account_id = $1 AND run.request_message_id = $2 \
           AND NOT run.legacy_duplicate AND run.cancel_requested_at IS NULL \
           AND (run.status = 'queued' OR (scheduled.target_runtime = 'local_required' \
             AND run.status IN ('leased', 'running') \
             AND run.lease_expires_at::timestamptz <= now())) \
         RETURNING run.run_id",
    )
    .bind(&session.account_id)
    .bind(input.request_message_id.trim())
    .bind(executor)
    .bind((now + Duration::seconds(LEASE_SECONDS)).to_rfc3339())
    .bind(now.to_rfc3339())
    // The Mac's hosted account, so its credentials resolve for this run.
    .bind(crate::cloud_agent_runtime::runs::claimed_route_json(
        input.runtime_route.as_ref(),
    ))
    .fetch_optional(pool)
    .await?;
    let Some((run_id,)) = taken else {
        let existing: Option<(String,)> = query_as(
            "SELECT run_id FROM cloud_agent_fallback_runs \
             WHERE owner_account_id = $1 AND request_message_id = $2 AND NOT legacy_duplicate",
        )
        .bind(&session.account_id)
        .bind(input.request_message_id.trim())
        .fetch_optional(pool)
        .await?;
        return Ok(existing.map(|(run_id,)| json!({"runId": run_id, "acquired": false})));
    };
    mark_running(pool, input.request_message_id.trim(), now).await?;
    let identity =
        crate::cloud_agent_runtime::runs::identity::identity_for_run(pool, &run_id).await?;
    Ok(Some(json!({
        "runId": run_id,
        "acquired": true,
        "leaseSeconds": LEASE_SECONDS,
        "turnIdentity": identity,
    })))
}

async fn mark_running(pool: &PgPool, scheduled_run: &str, now: DateTime<Utc>) -> RunResult<()> {
    query(
        "WITH updated AS ( \
            UPDATE scheduled_tool_task_runs SET status = 'running', updated_at = $2 \
             WHERE run_id = $1 AND status IN ('queued', 'waiting_for_desktop') \
             RETURNING task_id) \
         UPDATE scheduled_tool_tasks task SET last_run_status = 'running', updated_at = $2 \
           FROM updated WHERE task.task_id = updated.task_id",
    )
    .bind(scheduled_run)
    .bind(now.to_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}

/// Fails the runs of `local_required` tasks that waited too long for a Mac,
/// so a task is never left waiting without an answer.
pub async fn expire_waiting(pool: &PgPool) -> Result<usize, sqlx_core::Error> {
    let cutoff = Utc::now() - Duration::hours(LOCAL_WAIT_HOURS);
    let stale: Vec<(String,)> = query_as(
        "SELECT scheduled.run_id FROM scheduled_tool_task_runs scheduled \
         WHERE scheduled.target_runtime = 'local_required' \
           AND scheduled.status IN ('waiting_for_desktop', 'running') \
           AND scheduled.created_at::timestamptz < $1 \
           AND NOT EXISTS(SELECT 1 FROM cloud_agent_fallback_runs run \
             WHERE run.request_message_id = scheduled.run_id \
               AND run.status IN ('leased', 'running') \
               AND run.lease_expires_at::timestamptz > now()) \
         LIMIT 100",
    )
    .bind(cutoff)
    .fetch_all(pool)
    .await?;
    let now = Utc::now();
    for (scheduled_run,) in &stale {
        query(
            "UPDATE cloud_agent_fallback_runs SET status = 'failed', error_code = $2, \
               error_message = $3, updated_at = $4, completed_at = $4 \
             WHERE request_message_id = $1 AND status IN ('queued', 'leased', 'running')",
        )
        .bind(scheduled_run)
        .bind(UNAVAILABLE_CODE)
        .bind(UNAVAILABLE_MESSAGE)
        .bind(now.to_rfc3339())
        .execute(pool)
        .await?;
        super::store::mark_scheduled_task_run_failed(
            pool,
            scheduled_run,
            UNAVAILABLE_CODE,
            UNAVAILABLE_MESSAGE,
            now,
        )
        .await?;
    }
    Ok(stale.len())
}

fn executor(session: &CloudSession, claim_id: Uuid) -> String {
    format!("desktop:{}:{claim_id}", session.device_id)
}

fn lease_lost() -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({"errorCode":"execution_lease_lost","message":"This runtime no longer owns the request."})),
    )
        .into_response()
}

fn failed() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"errorCode":"server_error","message":"Could not update the scheduled run."})),
    )
        .into_response()
}

type PendingRow = (String, String, String, String, String);

/// Scheduled runs held for this account's Mac, oldest first.
pub(super) async fn pending(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let rows: Result<Vec<PendingRow>, _> = query_as(
        "SELECT run.run_id, run.request_message_id, run.session_id, run.requester_account_id, task.prompt \
         FROM cloud_agent_fallback_runs run \
         JOIN scheduled_tool_task_runs scheduled ON scheduled.run_id = run.request_message_id \
         JOIN scheduled_tool_tasks task ON task.task_id = scheduled.task_id \
         WHERE run.owner_account_id = $1 AND NOT run.legacy_duplicate \
           AND run.cancel_requested_at IS NULL AND run.desktop_preferred_until > now() \
           AND (run.status = 'queued' OR (scheduled.target_runtime = 'local_required' \
             AND run.status IN ('leased', 'running') \
             AND run.lease_expires_at::timestamptz <= now())) \
         ORDER BY run.created_at LIMIT 8",
    )
    .bind(&session.account_id)
    .fetch_all(state.db_pool())
    .await;
    match rows {
        Ok(rows) => Json(json!(rows
            .into_iter()
            .map(|(run_id, request, session_id, requester, prompt)| json!({
                "runId": run_id, "requestMessageId": request, "sessionId": session_id,
                "requesterAccountId": requester, "prompt": prompt,
            }))
            .collect::<Vec<_>>()))
        .into_response(),
        Err(_) => failed(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CompleteInput {
    claim_id: Uuid,
    text: String,
}

/// The scheduled run `run_id` of this account and whether it needs a Mac.
async fn scheduled_run(pool: &PgPool, run_id: &str, owner: &str) -> RunResult<Option<bool>> {
    let row: Option<(String,)> = query_as(
        "SELECT scheduled.target_runtime FROM cloud_agent_fallback_runs run \
         JOIN scheduled_tool_task_runs scheduled ON scheduled.run_id = run.request_message_id \
         WHERE run.run_id = $1 AND run.owner_account_id = $2",
    )
    .bind(run_id)
    .bind(owner)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(target,)| local(&target)))
}

/// Ends the run with the Mac's answer, delivered exactly like a cloud answer.
pub(super) async fn complete(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(run_id): Path<String>,
    Json(input): Json<CompleteInput>,
) -> Response {
    let pool = state.db_pool();
    match scheduled_run(pool, &run_id, &session.account_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return lease_lost(),
        Err(_) => return failed(),
    }
    let owner = executor(&session, input.claim_id);
    match complete_run(pool, &run_id, &owner, &input.text).await {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(RunError::NotFound) => lease_lost(),
        Err(_) => failed(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FailInput {
    claim_id: Uuid,
}

/// The Mac could not run it. A cloud task goes to the cloud runner at once;
/// a task that needs the Mac fails with a reply that says so.
pub(super) async fn fail(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(run_id): Path<String>,
    Json(input): Json<FailInput>,
) -> Response {
    let pool = state.db_pool();
    let owner = executor(&session, input.claim_id);
    let needs_mac = match scheduled_run(pool, &run_id, &session.account_id).await {
        Ok(Some(needs_mac)) => needs_mac,
        Ok(None) => return lease_lost(),
        Err(_) => return failed(),
    };
    if needs_mac {
        let message = "The task could not be completed on your Mac.";
        return match fail_run(
            pool,
            &run_id,
            &owner,
            "desktop_execution_failed",
            message,
            None,
        )
        .await
        {
            Ok(_) => Json(json!({"ok": true})).into_response(),
            Err(RunError::NotFound) => lease_lost(),
            Err(_) => failed(),
        };
    }
    let released = query(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'queued', execution_backend = 'cloud', claimed_by = NULL, \
             lease_expires_at = NULL, desktop_preferred_until = NULL, updated_at = $3 \
         WHERE run_id = $1 AND claimed_by = $2 AND execution_backend = 'desktop' \
           AND status IN ('leased', 'running') AND lease_expires_at::timestamptz > now()",
    )
    .bind(&run_id)
    .bind(&owner)
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await;
    match released {
        Ok(result) if result.rows_affected() == 1 => Json(json!({"ok": true})).into_response(),
        Ok(_) => lease_lost(),
        Err(_) => failed(),
    }
}
