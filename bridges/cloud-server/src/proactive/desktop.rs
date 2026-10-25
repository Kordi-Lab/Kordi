//! Proactive runs on the owner's Mac (docs/development/proactive-agent.md,
//! "Mac execution").
//!
//! A Mac that can run them publishes the [`CAPABILITY`] readiness row. While
//! it is fresh, the sweep holds a new evaluation for one presence timeout and
//! announces it with `proactive.eval_requested`; an approved run is held the
//! same way when the agent's own row is fresh too, and announced with
//! `proactive.run_requested`. The Mac claims either through the generic
//! desktop claim route with the run id as `requestMessageId`
//! ([`claim_evaluation`], [`claim_approved`]), renews and releases it through
//! the generic desktop routes, and ends it through [`complete`], which calls
//! the same completion as the cloud runner. A run no Mac claims in time is
//! leased by the cloud runner; both move it out of `queued` with a
//! conditional update, so only one runs it. Neither claim carries the
//! owner's memories: both runs look them up with `search_memory`
//! ([`super::memory_search`]). A run whose stop was requested posts nothing:
//! [`complete`] ends it as cancelled instead.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use super::{APPROVED_RUN_PREFIX, CAPABILITY, RUN_PREFIX};
use crate::auth::routes::CloudSession;
use crate::cloud_agent_runtime::runs::{
    claimed_route_json, complete_run, stop, terminal_backfill, AgentRuntimeRoute, ClaimRunRequest,
    RunError, RunResult, DESKTOP_RELEASED_ERROR_CODE,
};
use crate::server::ServerState;

type Result<T> = std::result::Result<T, sqlx_core::Error>;

/// Seconds a desktop claim holds the run before it must renew, as for chat.
const LEASE_SECONDS: i64 = 45;
/// The longest evaluation reply the server reads, as for a digest.
const MAX_EVALUATION_BYTES: usize = 1_048_576;

/// Tells the owner's devices that an evaluation waits for a Mac.
pub(super) async fn announce_evaluation(
    tx: &mut sqlx_core::transaction::Transaction<'_, Postgres>,
    owner: &str,
    run_id: &str,
    candidate: &super::snapshot::Candidate,
) -> Result<()> {
    let payload = json!({"runId": run_id, "sessionId": candidate.session_id});
    crate::chat_sync::store::append_account_hint(tx, owner, "proactive.eval_requested", &payload)
        .await
        .map_err(|_| sqlx_core::Error::Protocol("Could not announce the evaluation.".into()))
}

pub(super) fn executor(session: &CloudSession, claim_id: Uuid) -> String {
    format!("desktop:{}:{claim_id}", session.device_id)
}

/// Whether this device of the signed-in account published `capability`
/// within the readiness window.
async fn ready(pool: &PgPool, session: &CloudSession, capability: &str) -> Result<bool> {
    let (ready,): (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_agent_desktop_capabilities ready \
           JOIN cloud_devices device USING(device_id) \
           WHERE ready.device_id = $1 AND device.account_id = $2 AND device.revoked_at IS NULL \
             AND ready.agent_id = $3 AND ready.updated_at > now() - interval '35 seconds')",
    )
    .bind(&session.device_id)
    .bind(&session.account_id)
    .bind(capability)
    .fetch_one(pool)
    .await?;
    Ok(ready)
}

/// Leases the queued run `run_id` of `owner` to `executor`. Returns whether
/// this call took it. A run a Mac handed back stays with the cloud.
///
/// The Mac's hosted account route, when it sent one, is what
/// `/desktop/provider-auth` resolves for the claim holder. An approved run
/// stores it as its route. An evaluation keeps its own route, which the
/// cloud runs with after a hand-back or a takeover, and holds the Mac's
/// beside it under [`DESKTOP_ROUTE_KEY`].
async fn lease(
    pool: &PgPool,
    run_id: &str,
    owner: &str,
    executor: &str,
    route: Option<&AgentRuntimeRoute>,
) -> Result<bool> {
    let now = Utc::now();
    let taken = query(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'leased', execution_backend = 'desktop', claimed_by = $3, \
             lease_expires_at = $4, desktop_preferred_until = NULL, updated_at = $5, \
             runtime_route_json = CASE WHEN $6::jsonb IS NULL THEN runtime_route_json - $8::text \
               WHEN $7 THEN (runtime_route_json - $8::text) || jsonb_build_object($8::text, $6::jsonb) \
               ELSE $6::jsonb END \
         WHERE run_id = $1 AND owner_account_id = $2 AND status = 'queued' \
           AND cancel_requested_at IS NULL AND error_code IS DISTINCT FROM $9",
    )
    .bind(run_id)
    .bind(owner)
    .bind(executor)
    .bind((now + chrono::Duration::seconds(LEASE_SECONDS)).to_rfc3339())
    .bind(now.to_rfc3339())
    .bind(claimed_route_json(route))
    .bind(run_id.starts_with(RUN_PREFIX))
    .bind(DESKTOP_ROUTE_KEY)
    .bind(DESKTOP_RELEASED_ERROR_CODE)
    .execute(pool)
    .await?;
    Ok(taken.rows_affected() == 1)
}

/// The key under which an evaluation's route holds the claiming Mac's
/// hosted account route ([`lease`]).
pub(crate) const DESKTOP_ROUTE_KEY: &str = "desktopRoute";

/// Whether `executor` holds the run with a live desktop lease.
pub(super) async fn held(pool: &PgPool, run_id: &str, owner: &str, executor: &str) -> Result<bool> {
    let (held,): (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_agent_fallback_runs \
           WHERE run_id = $1 AND owner_account_id = $2 AND claimed_by = $3 \
             AND execution_backend = 'desktop' AND status IN ('leased', 'running') \
             AND lease_expires_at::timestamptz > now())",
    )
    .bind(run_id)
    .bind(owner)
    .bind(executor)
    .fetch_one(pool)
    .await?;
    Ok(held)
}

/// How a Mac reads the run's model, as for a digest: `named` when the agent's
/// own routing names one, else `chat`, the route the cloud filled from the
/// owner's chat.
async fn model_choice(pool: &PgPool, agent_id: &str) -> Result<&'static str> {
    if super::agents::default_owner(agent_id).is_some() {
        return Ok("chat");
    }
    let named: Option<(bool,)> = query_as(
        "SELECT COALESCE(btrim(model_routing_json->>'defaultModel'), '') <> '' \
         FROM cloud_agent_definitions WHERE agent_id = $1",
    )
    .bind(agent_id)
    .fetch_optional(pool)
    .await?;
    Ok(if named.is_some_and(|(named,)| named) {
        "named"
    } else {
        "chat"
    })
}

/// Admits the signed-in owner's Mac to the queued evaluation `run_id`.
/// `Ok(None)` refuses the claim: this Mac is not ready for proactive runs or
/// the run is not the active evaluation of its conversation. Otherwise the
/// answer says whether this claim holds the run and, when it does, what to
/// run: one model turn whose only tool is `search_memory`, answered through
/// the digest observe route.
pub(crate) async fn claim_evaluation(
    pool: &PgPool,
    session: &CloudSession,
    claim_id: Uuid,
    run_id: &str,
    route: Option<&AgentRuntimeRoute>,
) -> Result<Option<Value>> {
    let owner = &session.account_id;
    let active: Option<(Option<Value>, String)> = query_as(
        "SELECT run.runtime_route_json, run.execution_agent_id \
         FROM cloud_agent_proactive_state state \
         JOIN cloud_agent_fallback_runs run ON run.run_id = state.active_run_id \
         WHERE state.active_run_id = $1 AND state.owner_account_id = $2 \
           AND run.owner_account_id = $2",
    )
    .bind(run_id)
    .bind(owner)
    .fetch_optional(pool)
    .await?;
    let Some((asked, agent_id)) = active else {
        return Ok(None);
    };
    if !ready(pool, session, CAPABILITY).await? {
        return Ok(None);
    }
    let executor = executor(session, claim_id);
    lease(pool, run_id, owner, &executor, route).await?;
    let row: Option<(String, String)> = query_as(
        "SELECT prompt, system_prompt FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND claimed_by = $2 AND execution_backend = 'desktop' \
           AND status IN ('leased', 'running') AND lease_expires_at::timestamptz > now()",
    )
    .bind(run_id)
    .bind(&executor)
    .fetch_optional(pool)
    .await?;
    let Some((prompt, system_prompt)) = row else {
        return Ok(Some(json!({"runId": run_id, "acquired": false})));
    };
    // The model the run asks for, and what a Mac that runs with its own
    // account needs to apply it to its provider.
    let asked: AgentRuntimeRoute = asked
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    let fast_models: serde_json::Map<String, Value> = crate::digest::model_choice::FAST_MODELS
        .iter()
        .map(|(provider, model)| (provider.to_string(), json!(model)))
        .collect();
    Ok(Some(json!({
        "runId": run_id,
        "acquired": true,
        "leaseSeconds": LEASE_SECONDS,
        "proactive": {
            "kind": "evaluation",
            "systemPrompt": system_prompt.trim(),
            "prompt": prompt,
            "tools": [super::memory_search::mac_tool()],
            "model": asked.default_model,
            "thinking": asked.thinking,
            "provider": asked.default_auth_provider,
            "modelChoice": model_choice(pool, &agent_id).await?,
            "fastModels": fast_models,
        },
    })))
}

/// Admits the signed-in owner's Mac to the queued approved run named by
/// `input.request_message_id`. `Ok(None)` refuses the claim: this Mac is not
/// ready for proactive runs or for the run's agent, the claim names another
/// session, the owner left the group, the agent stopped watching, or the
/// proposal is no longer `approved`. Otherwise the answer has the scheduled
/// claim's shape plus the run's prompt and system prompt.
pub(crate) async fn claim_approved(
    pool: &PgPool,
    session: &CloudSession,
    claim_id: Uuid,
    input: &ClaimRunRequest,
) -> RunResult<Option<Value>> {
    let owner = &session.account_id;
    let run_id = input.request_message_id.trim();
    let run: Option<(String, String, String, String)> = query_as(
        "SELECT execution_agent_id, session_id, prompt, system_prompt \
         FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND owner_account_id = $2 AND requester_account_id = $2",
    )
    .bind(run_id)
    .bind(owner)
    .fetch_optional(pool)
    .await?;
    let Some((agent_id, session_id, prompt, system_prompt)) = run else {
        return Ok(None);
    };
    // The project rule ran against the claimed session, so it must be the run's.
    if session_id != input.session_id.trim()
        || !ready(pool, session, CAPABILITY).await?
        || !ready(pool, session, &agent_id).await?
    {
        return Ok(None);
    }
    let (allowed,): (bool,) = query_as(concat!(
        "SELECT EXISTS (SELECT 1 FROM cloud_agent_proactive_proposals p
             JOIN cloud_chat_conversation_members member
               ON member.conversation_id = p.conversation_id
              AND member.account_id = p.owner_account_id
              AND member.membership_state = 'active'
             JOIN ",
        super::agents::watchers_sql!(),
        " agent ON agent.agent_id = p.agent_id AND agent.owner_account_id = p.owner_account_id
             WHERE p.run_id = $1 AND p.owner_account_id = $2 AND p.status = 'approved')"
    ))
    .bind(run_id)
    .bind(owner)
    .fetch_one(pool)
    .await?;
    if !allowed {
        return Ok(None);
    }
    let executor = executor(session, claim_id);
    if !lease(pool, run_id, owner, &executor, input.runtime_route.as_ref()).await? {
        return Ok(Some(json!({"runId": run_id, "acquired": false})));
    }
    let identity =
        crate::cloud_agent_runtime::runs::identity::identity_for_run(pool, run_id).await?;
    Ok(Some(json!({
        "runId": run_id,
        "acquired": true,
        "leaseSeconds": LEASE_SECONDS,
        "turnIdentity": identity,
        "prompt": prompt,
        "systemPrompt": system_prompt,
        "proactive": {"kind": "approved"},
    })))
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
        Json(json!({"errorCode":"server_error","message":"Could not finish the proactive run."})),
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompleteInput {
    claim_id: Uuid,
    text: String,
}

/// Ends the run `run_id` that `executor` holds after a stop request, as the
/// Mac's own cancel does: `cancelled`, with the stop reply in the group for
/// an approved run. Returns whether this call ended it.
async fn end_stopped(state: &ServerState, run_id: &str, executor: &str) -> Result<bool> {
    let ended = query(
        "UPDATE cloud_agent_fallback_runs SET status = 'cancelled', completed_at = $3, updated_at = $3 \
         WHERE run_id = $1 AND claimed_by = $2 AND execution_backend = 'desktop' \
           AND status IN ('leased', 'running') AND cancel_requested_at IS NOT NULL",
    )
    .bind(run_id)
    .bind(executor)
    .bind(Utc::now().to_rfc3339())
    .execute(state.db_pool())
    .await?
    .rows_affected()
        == 1;
    if ended {
        terminal_backfill::publish_after_cancel(state, run_id).await;
    }
    Ok(ended)
}

/// Ends a proactive run with the Mac's reply, through the same completion as
/// the cloud runner: an evaluation's reply is parsed into silence or an
/// offer, an approved run's reply is delivered in the group as the agent and
/// notifies its members as a cloud reply does. A run whose stop was requested
/// posts nothing: it ends as cancelled and the Mac gets
/// `409 execution_lease_lost`, as a renewal after a stop does.
pub(crate) async fn complete(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(run_id): Path<String>,
    Json(input): Json<CompleteInput>,
) -> Response {
    let pool = state.db_pool();
    let evaluation = run_id.starts_with(RUN_PREFIX);
    if !evaluation && !run_id.starts_with(APPROVED_RUN_PREFIX) {
        return lease_lost();
    }
    let owner = executor(&session, input.claim_id);
    match held(pool, &run_id, &session.account_id, &owner).await {
        Ok(true) => {}
        Ok(false) => return lease_lost(),
        Err(_) => return failed(),
    }
    if stop::desktop_cancel_requested(pool, &run_id).await {
        return match end_stopped(&state, &run_id, &owner).await {
            Ok(_) => lease_lost(),
            Err(_) => failed(),
        };
    }
    if evaluation && input.text.len() > MAX_EVALUATION_BYTES {
        return match super::fail(pool, &run_id, Some(&owner), "invalid_output").await {
            Ok(()) => Json(json!({"ok": true})).into_response(),
            Err(_) => failed(),
        };
    }
    match complete_run(pool, &run_id, &owner, &input.text).await {
        Ok(run) => {
            // An evaluation posts nothing; its offer sends its own push.
            if !evaluation {
                let message = run.response_message_id.as_deref();
                crate::cloud_agent_runtime::routes::notify_run_response(&state, message).await;
            }
            Json(json!({"ok": true})).into_response()
        }
        Err(RunError::NotFound) => lease_lost(),
        Err(_) => failed(),
    }
}
