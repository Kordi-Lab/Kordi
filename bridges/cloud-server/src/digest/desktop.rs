//! Digest runs on the owner's Mac.
//!
//! A Mac that can run digests publishes the [`CAPABILITY`] readiness row.
//! While it is ready, [`super::store::refresh`] holds a new digest run for
//! it with `desktop_preferred_until` and tells the owner's devices with a
//! `digest.run_requested` hint. The Mac claims the run through the desktop
//! claim route ([`claim`]), reads the prompt and tools from the claim, calls
//! the tools through [`observe`], and ends the run through [`complete`],
//! which applies the same checks as the cloud runner's completion. A Mac that
//! cannot run it hands it to the cloud with [`release`]. If no Mac claims the
//! run in time, the cloud runner leases it; both move it out of `queued` with
//! a conditional update, so only one runs it.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use crate::auth::routes::CloudSession;
use crate::cloud_agent_runtime::runs::AgentRuntimeRoute;
use crate::server::ServerState;

type Result<T> = std::result::Result<T, sqlx_core::Error>;

/// The readiness row a Mac publishes when it can run digests.
pub const CAPABILITY: &str = "digest";
/// Seconds a desktop claim holds the run before it must renew, as for chat.
const LEASE_SECONDS: i64 = 45;
/// The Mac registers the observation tools under these names, because the
/// plain names belong to its own session tools.
const MAC_TOOL_PREFIX: &str = "digest_";

/// When the cloud runner may lease a new digest run of `account`: after one
/// presence timeout while a Mac of the owner can run it, otherwise now.
pub(crate) async fn preferred_until(pool: &PgPool, account: &str) -> Result<Option<DateTime<Utc>>> {
    let ready = crate::cloud_agent_runtime::agent_desktop_ready(pool, account, CAPABILITY).await?;
    Ok(ready.then(|| Utc::now() + crate::presence::presence_timeout()))
}

/// Tells the owner's devices that a digest run waits for a Mac.
pub(crate) async fn announce(
    tx: &mut sqlx_core::transaction::Transaction<'_, Postgres>,
    account: &str,
    run_id: &str,
) -> Result<()> {
    let payload = json!({"runId": run_id, "sessionId": format!("digest:{account}")});
    crate::chat_sync::store::append_account_hint(tx, account, "digest.run_requested", &payload)
        .await
        .map_err(|_| sqlx_core::Error::Protocol("Could not announce the digest run.".into()))
}

fn executor(session: &CloudSession, claim_id: Uuid) -> String {
    format!("desktop:{}:{claim_id}", session.device_id)
}

/// Admits the signed-in owner's Mac to the queued digest run `run_id`.
/// `Ok(None)` refuses the claim: the run is not the owner's current digest
/// run or this Mac is not ready to run digests. Otherwise the answer says
/// whether this claim holds the run and, when it does, what to run.
pub(crate) async fn claim(
    pool: &PgPool,
    session: &CloudSession,
    claim_id: Uuid,
    run_id: &str,
    route: Option<&AgentRuntimeRoute>,
) -> Result<Option<Value>> {
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
    let current: Option<(String,)> = query_as(
        "SELECT active_run_id FROM cloud_account_digests WHERE account_id = $1 AND active_run_id = $2",
    )
    .bind(&session.account_id)
    .bind(run_id)
    .fetch_optional(pool)
    .await?;
    if !ready || current.is_none() || !super::revalidate_run(pool, run_id).await? {
        return Ok(None);
    }
    let owner = executor(session, claim_id);
    let now = Utc::now();
    let preference = super::model_choice::preference(pool, &session.account_id).await?;
    let (trigger,): (String,) = query_as(
        "SELECT COALESCE((SELECT run_trigger FROM cloud_digest_runs WHERE run_id = $1), '')",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await?;
    let triage = trigger == "triage";
    // The Mac's hosted account, so its credentials resolve for this run, with
    // the digest's model choice kept: the Mac's chat model never replaces it.
    let claimed = crate::cloud_agent_runtime::runs::claimed_route_json(route)
        .and_then(|value| serde_json::from_value::<AgentRuntimeRoute>(value).ok())
        .map(|mac| super::model_choice::claimed_route(mac, &preference, triage));
    let changed = query(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'leased', execution_backend = 'desktop', claimed_by = $3, \
             lease_expires_at = $4, desktop_preferred_until = NULL, updated_at = $5, \
             runtime_route_json = COALESCE($6, runtime_route_json) \
         WHERE run_id = $1 AND owner_account_id = $2 AND status = 'queued' \
           AND cancel_requested_at IS NULL",
    )
    .bind(run_id)
    .bind(&session.account_id)
    .bind(&owner)
    .bind((now + chrono::Duration::seconds(LEASE_SECONDS)).to_rfc3339())
    .bind(now.to_rfc3339())
    .bind(
        claimed
            .as_ref()
            .map(|route| serde_json::to_value(route).unwrap()),
    )
    .execute(pool)
    .await?;
    if let (Some(route), 1) = (&claimed, changed.rows_affected()) {
        query("UPDATE cloud_digest_runs SET model = $2, thinking = $3 WHERE run_id = $1")
            .bind(run_id)
            .bind(&route.default_model)
            .bind(&route.thinking)
            .execute(pool)
            .await?;
    }
    let Some(prompt) = held_input(pool, run_id, &owner).await? else {
        return Ok(Some(json!({"runId": run_id, "acquired": false})));
    };
    let (system_prompt, stored): (String, Option<Value>) = query_as(
        "SELECT system_prompt, runtime_route_json FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await?;
    let Some(prompt) = super::output::prompt(&prompt) else {
        fail_held(pool, run_id, &owner, "digest_generation_failed").await?;
        return Ok(Some(json!({"runId": run_id, "acquired": false})));
    };
    // The model and thinking level the run asks for (see `model_choice`),
    // and what a Mac that runs with its own account needs to apply the same
    // choice to its provider.
    let asked: AgentRuntimeRoute = stored
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    let fast_models: serde_json::Map<String, Value> = super::model_choice::FAST_MODELS
        .iter()
        .map(|(provider, model)| (provider.to_string(), json!(model)))
        .collect();
    Ok(Some(json!({
        "runId": run_id,
        "acquired": true,
        "leaseSeconds": LEASE_SECONDS,
        "digest": {
            "systemPrompt": mac_tool_names(&system_prompt),
            "prompt": prompt,
            // A quick check answers from its prompt alone.
            "tools": if triage { json!([]) } else { mac_tools() },
            "model": asked.default_model,
            "thinking": asked.thinking,
            "provider": asked.default_auth_provider,
            "modelChoice": super::model_choice::choice_kind(&preference),
            "triage": triage,
            "fastModels": fast_models,
        },
    })))
}

fn mac_tool_names(text: &str) -> String {
    text.replace(
        "search_sessions",
        &format!("{MAC_TOOL_PREFIX}search_sessions"),
    )
    .replace("read_session", &format!("{MAC_TOOL_PREFIX}read_session"))
}

fn mac_tools() -> Value {
    let mut tools = super::output::tools();
    for tool in tools.as_array_mut().into_iter().flatten() {
        let name = format!(
            "{MAC_TOOL_PREFIX}{}",
            tool["name"].as_str().unwrap_or_default()
        );
        tool["name"] = json!(name);
    }
    tools
}

/// The frozen input of a digest run that `executor` holds.
async fn held_input(pool: &PgPool, run_id: &str, executor: &str) -> Result<Option<Value>> {
    let row: Option<(String,)> = query_as(
        "SELECT prompt FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND claimed_by = $2 AND execution_backend = 'desktop' \
           AND status IN ('leased', 'running') AND lease_expires_at::timestamptz > now()",
    )
    .bind(run_id)
    .bind(executor)
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(|(prompt,)| serde_json::from_str(&prompt).ok()))
}

async fn fail_held(pool: &PgPool, run_id: &str, executor: &str, code: &str) -> Result<()> {
    super::fail(pool, run_id, Some(executor), code).await
}

fn lease_lost() -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({"errorCode":"execution_lease_lost","message":"This runtime no longer owns the request."})),
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ObserveInput {
    claim_id: Uuid,
    tool: String,
    #[serde(default)]
    arguments: Value,
}

/// Answers one observation tool call of the Mac that holds the run. A
/// proactive evaluation runs through the same Mac command, so its
/// `search_memory` calls arrive here too.
pub(super) async fn observe(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(run_id): Path<String>,
    Json(input): Json<ObserveInput>,
) -> Response {
    if run_id.starts_with(crate::proactive::RUN_PREFIX) {
        let search = crate::proactive::memory_search::observe;
        let (tool, args) = (input.tool.as_str(), &input.arguments);
        return match search(&state, &session, &run_id, input.claim_id, tool, args).await {
            Ok(Some(answer)) => Json(answer).into_response(),
            Ok(None) => lease_lost(),
            Err(_) => super::routes::failed(),
        };
    }
    let owner = executor(&session, input.claim_id);
    match held_input(state.db_pool(), &run_id, &owner).await {
        Ok(Some(frozen)) => {
            let tool = input
                .tool
                .strip_prefix(MAC_TOOL_PREFIX)
                .unwrap_or(&input.tool);
            Json(super::output::observe(&frozen, tool, &input.arguments)).into_response()
        }
        Ok(None) => lease_lost(),
        Err(_) => super::routes::failed(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CompleteInput {
    claim_id: Uuid,
    text: String,
}

/// Ends the run with the Mac's reply, checked exactly like a cloud reply.
pub(super) async fn complete(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(run_id): Path<String>,
    Json(input): Json<CompleteInput>,
) -> Response {
    let owner = executor(&session, input.claim_id);
    if input.text.len() > 1_048_576 {
        return match fail_held(state.db_pool(), &run_id, &owner, "invalid_output").await {
            Ok(()) => Json(json!({"ok": true})).into_response(),
            Err(_) => super::routes::failed(),
        };
    }
    match super::complete(state.db_pool(), &run_id, &owner, &input.text).await {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(sqlx_core::Error::RowNotFound) => lease_lost(),
        Err(_) => super::routes::failed(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReleaseInput {
    claim_id: Uuid,
}

/// Hands the run back to the cloud runner when this Mac cannot run it, for
/// example because its provider failed. The run is never left unanswered.
pub(super) async fn release(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(run_id): Path<String>,
    Json(input): Json<ReleaseInput>,
) -> Response {
    let released = query(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'queued', execution_backend = 'cloud', claimed_by = NULL, \
             lease_expires_at = NULL, desktop_preferred_until = NULL, updated_at = $3 \
         WHERE run_id = $1 AND claimed_by = $2 AND execution_backend = 'desktop' \
           AND status IN ('leased', 'running') AND lease_expires_at::timestamptz > now()",
    )
    .bind(&run_id)
    .bind(executor(&session, input.claim_id))
    .bind(Utc::now().to_rfc3339())
    .execute(state.db_pool())
    .await;
    match released {
        Ok(result) if result.rows_affected() == 1 => Json(json!({"ok": true})).into_response(),
        Ok(_) => lease_lost(),
        Err(_) => super::routes::failed(),
    }
}
