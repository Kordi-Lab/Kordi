//! Comment runs on the agent owner's Mac.
//!
//! A comment run is routed like a chat run for the same agent. When the
//! owner's Mac is ready, [`prefer_desktop`] holds the run back from the
//! cloud runner for the presence timeout and the owner's devices are told
//! with `document.agent_request`. The Mac then takes the run through the
//! desktop claim route ([`claim`]) and ends it through the desktop progress
//! and interrupted routes ([`progress`], [`interrupted`]), which deliver to
//! the comment thread exactly like the cloud path. The claim and the cloud
//! lease both move the run out of `queued`, so only one of them runs it.

use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::delivery::{complete_held, fail_held, Holder};
use super::is_comment_request;
use crate::cloud_agent_runtime::runs::identity::identity_for_run;
use crate::cloud_agent_runtime::runs::{AgentRuntimeRoute, ClaimRunRequest, RunError, RunResult};

/// Seconds a desktop claim holds the run before it must renew, as for chat.
const DESKTOP_LEASE_SECONDS: i64 = 45;

/// Error code of a run its desktop reported as failed.
const DESKTOP_FAILED: &str = "desktop_execution_failed";

/// Whether the owner's Mac gets the first chance at a run of `agent_id` in
/// `session_id`: the Mac the session's project is bound to while it is
/// online, else any ready Mac of the owner. A public reader's run never
/// goes to a Mac, where its requester would read as the owner.
pub(crate) async fn prefer_desktop(
    pool: &PgPool,
    owner_account_id: &str,
    agent_id: &str,
    session_id: &str,
    public_reader: bool,
) -> Result<bool, sqlx_core::Error> {
    if public_reader {
        return Ok(false);
    }
    if let Some(binding) =
        crate::projects::project_session_binding(pool, owner_account_id, session_id).await?
    {
        return Ok(binding.device_online);
    }
    crate::cloud_agent_runtime::agent_desktop_ready(pool, owner_account_id, agent_id).await
}

/// When the cloud runner may lease a run that prefers the owner's Mac.
pub(crate) fn desktop_preferred_until() -> chrono::DateTime<Utc> {
    Utc::now() + crate::presence::presence_timeout()
}

/// What the owner's Mac needs to claim and run a comment run.
pub(crate) struct AgentRequest<'a> {
    pub comment_id: &'a str,
    pub attachment_id: &'a str,
    pub session_id: &'a str,
    pub requester_account_id: &'a str,
    pub agent_id: &'a str,
    pub prompt: &'a str,
}

pub(crate) fn agent_request_payload(request: &AgentRequest<'_>) -> Value {
    json!({
        "runRequestId": super::comment_request_id(request.comment_id),
        "commentId": request.comment_id,
        "attachmentId": request.attachment_id,
        "sessionId": request.session_id,
        "requesterAccountId": request.requester_account_id,
        "agentId": request.agent_id,
        "prompt": request.prompt,
    })
}

type ClaimableRun = (String, String, String, bool);

/// Admits the signed-in owner's desktop to the comment run behind
/// `input.request_message_id`. `Ok(None)` refuses the claim: the run does
/// not exist for this owner, session, and requester, its comment is gone or
/// was written by a public reader, or this device is not ready for the
/// agent. Otherwise the answer says whether this claim holds the run; a run
/// the cloud runner or another claim already took answers `acquired: false`.
pub(crate) async fn claim(
    pool: &PgPool,
    device_id: &str,
    executor: &str,
    input: &ClaimRunRequest,
) -> RunResult<Option<Value>> {
    let run: Option<ClaimableRun> = query_as(
        "SELECT run.run_id, run.execution_agent_id, run.requester_account_id, \
                comment.author_reader_key IS NOT NULL \
         FROM cloud_agent_fallback_runs run \
         JOIN cloud_document_comments comment ON comment.comment_id = run.document_comment_id \
         WHERE run.owner_account_id = $1 AND run.request_message_id = $2 \
           AND run.session_id = $3 AND NOT run.legacy_duplicate AND comment.deleted_at IS NULL \
         ORDER BY run.created_at DESC LIMIT 1",
    )
    .bind(input.owner_account_id.trim())
    .bind(input.request_message_id.trim())
    .bind(input.session_id.trim())
    .fetch_optional(pool)
    .await?;
    let Some((run_id, agent_id, requester, public_reader)) = run else {
        return Ok(None);
    };
    if public_reader || requester != input.requester_account_id.trim() {
        return Ok(None);
    }
    let (ready,): (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_agent_desktop_capabilities ready \
           JOIN cloud_devices device USING(device_id) \
           WHERE ready.device_id = $1 AND device.account_id = $2 AND device.revoked_at IS NULL \
             AND ready.agent_id = $3 AND ready.updated_at > now() - interval '35 seconds')",
    )
    .bind(device_id)
    .bind(input.owner_account_id.trim())
    .bind(&agent_id)
    .fetch_one(pool)
    .await?;
    if !ready {
        return Ok(None);
    }
    // As for chat, the owner's own request runs with the route their Mac
    // chose; any other request keeps the route stored with the run.
    let route = (requester == input.owner_account_id.trim())
        .then(|| owner_route(input.runtime_route.as_ref()))
        .flatten();
    let now = Utc::now();
    query(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'leased', execution_backend = 'desktop', claimed_by = $2, \
             lease_expires_at = $3, desktop_preferred_until = NULL, updated_at = $4, \
             runtime_route_json = COALESCE($5, runtime_route_json) \
         WHERE run_id = $1 AND status = 'queued' AND cancel_requested_at IS NULL",
    )
    .bind(&run_id)
    .bind(executor)
    .bind((now + chrono::Duration::seconds(DESKTOP_LEASE_SECONDS)).to_rfc3339())
    .bind(now.to_rfc3339())
    .bind(route)
    .execute(pool)
    .await?;
    let (acquired,): (bool,) = query_as(
        "SELECT execution_backend = 'desktop' AND claimed_by = $2 \
                AND status IN ('leased', 'running') AND lease_expires_at::timestamptz > now() \
         FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&run_id)
    .bind(executor)
    .fetch_one(pool)
    .await?;
    let identity = if acquired {
        Some(identity_for_run(pool, &run_id).await?)
    } else {
        None
    };
    Ok(Some(json!({
        "runId": run_id,
        "acquired": acquired,
        "leaseSeconds": DESKTOP_LEASE_SECONDS,
        "turnIdentity": identity,
    })))
}

fn owner_route(route: Option<&AgentRuntimeRoute>) -> Option<Value> {
    let route = route?;
    let model = route.default_model.as_deref().map(str::trim);
    model.filter(|model| !model.is_empty())?;
    serde_json::to_value(route).ok()
}

async fn reply_comment_id(pool: &PgPool, run_id: &str) -> RunResult<Option<String>> {
    let row: Option<(Option<String>,)> =
        query_as("SELECT response_message_id FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(run_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.and_then(|(id,)| id))
}

/// Applies a desktop's progress report to a comment run it holds.
/// `Ok(None)` for any other run, which then takes the chat path. `phase`
/// is the run status the report maps to; a completed run posts the agent's
/// reply and a failed one the short system reply, as on the cloud path. A
/// report from a desktop that no longer holds the run is
/// [`RunError::NotFound`].
pub(crate) async fn progress(
    pool: &PgPool,
    run_id: &str,
    account_id: &str,
    executor: &str,
    phase: &str,
    response: &Value,
) -> RunResult<Option<Value>> {
    let row: Option<(String,)> = query_as(
        "SELECT request_message_id FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND owner_account_id = $2",
    )
    .bind(run_id)
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    let Some(request_id) = row.map(|(id,)| id).filter(|id| is_comment_request(id)) else {
        return Ok(None);
    };
    if response.get("requestId").and_then(Value::as_str) != Some(request_id.as_str()) {
        return Err(RunError::NotFound);
    }
    let text = response
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let holder = Holder::Desktop(executor);
    match phase {
        "completed" if !text.trim().is_empty() => {
            complete_held(pool, run_id, holder, text).await?;
        }
        "completed" | "failed" => {
            fail_held(pool, run_id, holder, DESKTOP_FAILED, text).await?;
        }
        _ => {
            let updated = query(
                "UPDATE cloud_agent_fallback_runs \
                 SET status = $3, updated_at = $4, \
                     completed_at = CASE WHEN $3 = 'cancelled' THEN $4 ELSE NULL END \
                 WHERE run_id = $1 AND claimed_by = $2 AND execution_backend = 'desktop' \
                   AND status IN ('leased', 'running') \
                   AND lease_expires_at::timestamptz > now()",
            )
            .bind(run_id)
            .bind(executor)
            .bind(phase)
            .bind(Utc::now().to_rfc3339())
            .execute(pool)
            .await?;
            if updated.rows_affected() != 1 {
                return Err(RunError::NotFound);
            }
        }
    }
    let status = if phase == "completed" && text.trim().is_empty() {
        "failed"
    } else {
        phase
    };
    Ok(Some(json!({
        "runId": run_id,
        "status": status,
        "commentId": reply_comment_id(pool, run_id).await?,
    })))
}

/// Ends a comment run whose desktop turn ended without its lease. `device`
/// is the `claimed_by` pattern of the reporting device. Returns whether the
/// run was still open. A reply the desktop still has is posted; a failure
/// posts the system reply; a stop only closes the run.
pub(crate) async fn interrupted(
    pool: &PgPool,
    run_id: &str,
    device: &str,
    status: &str,
    text: Option<&str>,
) -> RunResult<bool> {
    let holder = Holder::LostDesktop(device);
    let ended = match (status, text) {
        ("completed", Some(text)) => complete_held(pool, run_id, holder, text).await,
        ("cancelled", _) => {
            let closed = query(
                "UPDATE cloud_agent_fallback_runs \
                 SET status = 'cancelled', error_code = 'desktop_interrupted', \
                     completed_at = $3, updated_at = $3 \
                 WHERE run_id = $1 AND claimed_by LIKE $2 AND execution_backend = 'desktop' \
                   AND status IN ('leased', 'running')",
            )
            .bind(run_id)
            .bind(device)
            .bind(Utc::now().to_rfc3339())
            .execute(pool)
            .await?;
            return Ok(closed.rows_affected() == 1);
        }
        _ => fail_held(pool, run_id, holder, "desktop_interrupted", "").await,
    };
    match ended {
        Ok(closed) => Ok(closed),
        Err(RunError::NotFound) => Ok(false),
        Err(error) => Err(error),
    }
}
