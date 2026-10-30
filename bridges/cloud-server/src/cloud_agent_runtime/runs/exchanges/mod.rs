//! Durable agent requests. Messaging does not select the execution location:
//! each target and continuation uses the ordinary Mac-first run lease.
use super::{AgentRuntimeRoute, ClaimRunRequest, RunError, RunResult};
use crate::{auth::routes::CloudSession, server::ServerState};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use std::sync::Arc;
use uuid::Uuid;

mod lifecycle;
mod outcome;
pub(crate) use outcome::{
    is_control_response, parent_completion, parent_completion_body, separate_control_outcome,
};
mod store;
pub(crate) use lifecycle::{finish, reconcile};
use store::{authorize, directory, send};

pub(crate) const PREFIX: &str = "agent-exchange:";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Input {
    #[serde(default)]
    pub runner_id: String,
    #[serde(default)]
    pub claim_id: Option<Uuid>,
    #[serde(default)]
    pub tool_call_id: String,
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub arguments: Value,
}

pub(crate) async fn desktop_tool(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(run): Path<String>,
    Json(input): Json<Input>,
) -> Response {
    let Some(claim) = input.claim_id else {
        return super::super::desktop::denied();
    };
    let executor = format!("desktop:{}:{claim}", session.device_id);
    response(
        execute(
            state.db_pool(),
            &run,
            &executor,
            Some(&session.account_id),
            input,
        )
        .await,
    )
}

pub(crate) async fn runner_tool(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(run): Path<String>,
    Json(input): Json<Input>,
) -> Response {
    if !super::super::routes::runner_authorized_for_scheduled_tasks(&headers) {
        return super::runner_unauthorized();
    }
    let executor = input.runner_id.clone();
    response(execute(state.db_pool(), &run, &executor, None, input).await)
}

fn response(result: RunResult<Value>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => super::run_error_response(
            "agent exchange",
            "The agent request is unavailable in this conversation.",
            error,
        ),
    }
}

async fn execute(
    pool: &PgPool,
    run: &str,
    executor: &str,
    account: Option<&str>,
    input: Input,
) -> RunResult<Value> {
    let parent = authorize(pool, run, Some((executor, account))).await?;
    // Another person's agent cannot use this tool to acquire owner authority.
    if parent.owner != parent.requester {
        return Err(RunError::NotFound);
    }
    if input.action == "capabilities" {
        return Ok(json!({"available":true,"targets":directory(pool, &parent).await?}));
    }
    if input.tool_call_id.trim().is_empty() || input.tool_call_id.len() > 256 {
        return Err(RunError::NotFound);
    }
    send(
        pool,
        &parent,
        executor,
        account,
        &input.tool_call_id,
        &input.arguments,
    )
    .await
}

/// Polling is a recovery path over durable records, never a human read cursor.
pub(crate) async fn pending(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let pool = state.db_pool();
    response(async {
        reconcile(pool).await?;
        let rows: Vec<(String,String,String,String,String,String,Value)> = query_as(
            "SELECT r.run_id,r.request_message_id,r.session_id,r.requester_account_id,r.prompt,r.system_prompt,r.runtime_route_json
             FROM cloud_agent_fallback_runs r JOIN cloud_agent_exchanges e ON r.run_id=e.target_run_id OR r.run_id=e.resume_run_id
             WHERE r.owner_account_id=$1 AND r.status='queued' AND r.cancel_requested_at IS NULL
               AND r.error_code IS DISTINCT FROM 'desktop_released'
               AND EXISTS(SELECT 1 FROM cloud_agent_desktop_capabilities c WHERE c.device_id=$2 AND c.agent_id=r.execution_agent_id AND c.updated_at>now()-interval '35 seconds')
             ORDER BY r.created_at LIMIT 16"
        ).bind(&session.account_id).bind(&session.device_id).fetch_all(pool).await?;
        let mut result = Vec::new();
        for (run,request,scope,requester,prompt,system,route) in rows {
            if is_authorized(pool,&run).await? {
                result.push(json!({"runId":run,"requestMessageId":request,"sessionId":scope,"requesterAccountId":requester,"prompt":prompt,"systemPrompt":system,"runtimeRoute":route}));
            }
        }
        Ok(json!(result))
    }.await)
}

pub(crate) async fn claim(
    pool: &PgPool,
    session: &CloudSession,
    input: &ClaimRunRequest,
    executor: &str,
) -> RunResult<Option<Value>> {
    if !input.request_message_id.starts_with(PREFIX) {
        return Ok(None);
    }
    let row: Option<(String,)> = query_as("SELECT run_id FROM cloud_agent_fallback_runs WHERE request_message_id=$1 AND owner_account_id=$2 AND requester_account_id=$3 AND session_id=$4")
        .bind(&input.request_message_id).bind(&session.account_id).bind(&input.requester_account_id).bind(&input.session_id).fetch_optional(pool).await?;
    let (run,) = row.ok_or(RunError::NotFound)?;
    let parent = authorize(pool, &run, None).await?;
    let ready: (bool,) = query_as("SELECT EXISTS(SELECT 1 FROM cloud_agent_desktop_capabilities WHERE device_id=$1 AND agent_id=$2 AND updated_at>now()-interval '35 seconds')")
        .bind(&session.device_id).bind(&parent.agent).fetch_one(pool).await?;
    if !ready.0 {
        return Err(RunError::NotFound);
    }
    let claimed = super::claim_run_for_desktop(pool, input, executor).await?;
    let held: (bool,) = query_as("SELECT claimed_by=$2 AND execution_backend='desktop' AND status IN ('leased','running') AND lease_expires_at::timestamptz>now() FROM cloud_agent_fallback_runs WHERE run_id=$1")
        .bind(&run).bind(executor).fetch_one(pool).await?;
    let identity = if held.0 {
        Some(super::identity::identity_for_run(pool, &run).await?)
    } else {
        None
    };
    Ok(Some(
        json!({"runId":claimed.run_id,"acquired":held.0,"turnIdentity":identity}),
    ))
}

pub(crate) async fn validate_claim(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> RunResult<Option<bool>> {
    if !input.request_message_id.starts_with(PREFIX) {
        return Ok(None);
    }
    let row: Option<(String,)> = query_as("SELECT run_id FROM cloud_agent_fallback_runs WHERE request_message_id=$1 AND session_id=$2 AND owner_account_id=$3 AND requester_account_id=$4")
        .bind(&input.request_message_id).bind(&input.session_id).bind(&input.owner_account_id).bind(&input.requester_account_id).fetch_optional(pool).await?;
    Ok(Some(match row {
        Some((run,)) => is_authorized(pool, &run).await?,
        None => false,
    }))
}

pub(crate) async fn agent_for_claim(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> RunResult<Option<String>> {
    if !input.request_message_id.starts_with(PREFIX) {
        return Ok(None);
    }
    let row: Option<(String,)> = query_as("SELECT execution_agent_id FROM cloud_agent_fallback_runs WHERE request_message_id=$1 AND session_id=$2 AND owner_account_id=$3 AND requester_account_id=$4")
        .bind(&input.request_message_id).bind(&input.session_id).bind(&input.owner_account_id).bind(&input.requester_account_id).fetch_optional(pool).await?;
    Ok(Some(row.ok_or(RunError::NotFound)?.0))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesktopFinish {
    claim_id: Uuid,
    #[serde(default)]
    text: String,
}
pub(crate) async fn desktop_complete(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(run): Path<String>,
    Json(input): Json<DesktopFinish>,
) -> Response {
    desktop_finish(&state, &session, &run, input, true).await
}
pub(crate) async fn desktop_fail(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(run): Path<String>,
    Json(input): Json<DesktopFinish>,
) -> Response {
    desktop_finish(&state, &session, &run, input, false).await
}
async fn desktop_finish(
    state: &ServerState,
    session: &CloudSession,
    run: &str,
    input: DesktopFinish,
    success: bool,
) -> Response {
    let executor = format!("desktop:{}:{}", session.device_id, input.claim_id);
    response(async {
        // Bind even idempotent completion to this signed-in account/device.
        let owns:(bool,)=query_as("SELECT EXISTS(SELECT 1 FROM cloud_agent_fallback_runs WHERE run_id=$1 AND owner_account_id=$2 AND claimed_by=$3)")
            .bind(run).bind(&session.account_id).bind(&executor).fetch_one(state.db_pool()).await?;
        if !owns.0 || !finish(state.db_pool(),run,&executor,&input.text,success).await? {return Err(RunError::NotFound);}
        Ok(json!({"ok":true}))
    }.await)
}

/// A lease advertises the tool only when its authorization and directory exist.
pub(crate) async fn guidance(pool: &PgPool, run: &str) -> RunResult<Option<String>> {
    let parent = match authorize(pool, run, None).await {
        Ok(p) => p,
        Err(RunError::NotFound) => return Ok(None),
        Err(e) => return Err(e),
    };
    if parent.owner != parent.requester {
        return Ok(None);
    }
    let targets = directory(pool, &parent).await?;
    if targets.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!(
        "Use reach_out to contact another agent in this conversation by exact agentId or unique @handle. Send only the explicit question. The request is already visible in this conversation. Do not add an acknowledgement or waiting message. Follow the receipt to end this turn; the reply automatically resumes the original task. Do not resend or poll. Participant agent directory: {}",
        json!(targets)
    )))
}

async fn is_authorized(pool: &PgPool, run: &str) -> RunResult<bool> {
    match authorize(pool, run, None).await {
        Ok(_) => Ok(true),
        Err(RunError::NotFound) => Ok(false),
        Err(e) => Err(e),
    }
}
