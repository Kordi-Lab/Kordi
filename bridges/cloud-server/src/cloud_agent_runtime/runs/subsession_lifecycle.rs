//! Child execution text is durable without becoming a parent chat response.
use super::{
    leases::{runner_response_from_row, RunnerRunRow},
    RunError, RunResult, RunnerRunResponse,
};
use crate::server::ServerState;
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use std::sync::Arc;
use uuid::Uuid;

pub(super) async fn finish(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    text: &str,
    succeeded: bool,
) -> RunResult<Option<RunnerRunResponse>> {
    let exists:(bool,) = query_as("SELECT EXISTS(SELECT 1 FROM cloud_agent_fallback_runs WHERE run_id=$1 AND subsession_id IS NOT NULL)").bind(run_id).fetch_one(pool).await?;
    if !exists.0 {
        return Ok(None);
    }
    if text.trim().is_empty() || text.len() > 2 * 1024 * 1024 {
        return Err(RunError::NotFound);
    }
    let mut tx = pool.begin().await?;
    query("SELECT pg_advisory_xact_lock(81208411)")
        .execute(&mut *tx)
        .await?;
    let owned:Option<(Uuid,)> = query_as("SELECT subsession_id FROM cloud_agent_fallback_runs WHERE run_id=$1 AND claimed_by=$2 AND execution_backend='cloud' AND status IN ('leased','running') AND lease_expires_at::timestamptz>now() FOR UPDATE")
        .bind(run_id).bind(runner_id).fetch_optional(&mut *tx).await?;
    let (id,) = owned.ok_or(RunError::NotFound)?;
    let now = chrono::Utc::now();
    let message = json!([{"id":format!("result:{run_id}"),"role":"assistant","text":text,"timestampMs":now.timestamp_millis()}]);
    query("UPDATE cloud_agent_subsessions SET status=$2,messages=messages||$3,version=version+1,updated_at=now() WHERE subsession_id=$1 AND execution_backend='cloud'")
        .bind(id).bind(if succeeded {"done"} else {"failed"}).bind(message).execute(&mut *tx).await?;
    let row:RunnerRunRow=query_as("UPDATE cloud_agent_fallback_runs SET status=$3,updated_at=$4,completed_at=$4,lease_expires_at=NULL WHERE run_id=$1 AND claimed_by=$2 RETURNING run_id,status,prompt,owner_account_id,requester_account_id,session_id,sandbox_id,runtime_route_json,response_message_id,error_code,error_message,system_prompt")
        .bind(run_id).bind(runner_id).bind(if succeeded {"completed"} else {"failed"}).bind(now.to_rfc3339()).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    runner_response_from_row(pool, row).await.map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProgressInput {
    runner_id: String,
    tool_call_id: String,
    tool_name: String,
}

pub(crate) async fn progress_route(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Json(input): Json<ProgressInput>,
) -> Response {
    if !super::super::routes::runner_authorized_for_scheduled_tasks(&headers) {
        return super::runner_unauthorized();
    }
    match progress(state.db_pool(), &run_id, input).await {
        Ok(()) => Json(json!({"ok":true})).into_response(),
        Err(e) => super::run_error_response(
            "subsession progress",
            "The task no longer accepts progress.",
            e,
        ),
    }
}

async fn progress(pool: &PgPool, run_id: &str, input: ProgressInput) -> RunResult<()> {
    if input.tool_call_id.is_empty()
        || input.tool_call_id.len() > 256
        || !matches!(
            input.tool_name.as_str(),
            "web_search"
                | "web_fetch"
                | "read_session"
                | "search_sessions"
                | "read"
                | "ls"
                | "find"
                | "grep"
                | "write"
                | "edit"
        )
    {
        return Err(RunError::NotFound);
    }
    let message = json!([{"id":format!("tool:{}",input.tool_call_id),"role":"assistant","text":format!("Using {}…",input.tool_name),"timestampMs":chrono::Utc::now().timestamp_millis()}]);
    let mut tx = pool.begin().await?;
    query("SELECT pg_advisory_xact_lock(81208411)")
        .execute(&mut *tx)
        .await?;
    let owned:Option<(Uuid,)> = query_as("SELECT subsession_id FROM cloud_agent_fallback_runs WHERE run_id=$1 AND claimed_by=$2 AND execution_backend='cloud' AND subsession_id IS NOT NULL AND status IN ('leased','running') AND lease_expires_at::timestamptz>now() FOR UPDATE")
        .bind(run_id).bind(&input.runner_id).fetch_optional(&mut *tx).await?;
    let (id,) = owned.ok_or(RunError::NotFound)?;
    query("UPDATE cloud_agent_subsessions SET messages=messages||$2,version=version+1,updated_at=now() WHERE subsession_id=$1 AND status='running' AND NOT messages @> $3 AND jsonb_array_length(messages)<255")
        .bind(id).bind(message).bind(json!([{"id":format!("tool:{}",input.tool_call_id)}])).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
