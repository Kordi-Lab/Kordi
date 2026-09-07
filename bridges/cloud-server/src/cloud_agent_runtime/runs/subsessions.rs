//! Real model tool calls create execution records, never chat conversations.
use super::{ClaimRunRequest, RunError, RunResult};
use crate::server::ServerState;
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use std::sync::Arc;
use uuid::Uuid;

type ParentRunRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    Value,
    Option<Uuid>,
);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnInput {
    task_name: String,
    task_title: Option<String>,
    message: String,
    fork_turns: Option<String>,
    #[serde(default)]
    write_scope: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ToolInput {
    pub runner_id: String,
    pub tool_call_id: String,
    pub arguments: Value,
}

pub(crate) async fn tool_route(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Json(input): Json<ToolInput>,
) -> Response {
    if !super::super::routes::runner_authorized_for_scheduled_tasks(&headers) {
        return super::runner_unauthorized();
    }
    match execute_tool(state.db_pool(), &run_id, input).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => super::run_error_response(
            "subsession tool",
            "The execution subsession is unavailable.",
            error,
        ),
    }
}

pub(crate) async fn execute_tool(
    pool: &PgPool,
    run_id: &str,
    input: ToolInput,
) -> RunResult<Value> {
    if input.runner_id.trim().is_empty()
        || input.tool_call_id.is_empty()
        || input.tool_call_id.len() > 256
    {
        return Err(RunError::NotFound);
    }
    let mut tx = pool.begin().await?;
    // Serialize a spawn with lease takeover and parent completion. A stale
    // executor must not create new work after another runtime acquired the run.
    query("SELECT pg_advisory_xact_lock(81208411)")
        .execute(&mut *tx)
        .await?;
    let parent: Option<ParentRunRow> = query_as(
        "SELECT session_id,request_message_id,owner_account_id,requester_account_id,execution_agent_id,system_prompt,runtime_route_json,subsession_id FROM cloud_agent_fallback_runs WHERE run_id=$1 AND claimed_by=$2 AND execution_backend='cloud' AND status IN ('leased','running') AND lease_expires_at::timestamptz>now() FOR UPDATE"
    ).bind(run_id).bind(&input.runner_id).fetch_optional(&mut *tx).await?;
    let (session_id, request_id, owner, requester, agent, system_prompt, route, child) =
        parent.ok_or(RunError::NotFound)?;
    // A subsession owns its work; it cannot recursively create more subsessions.
    if child.is_some() {
        return Err(RunError::NotFound);
    }
    let claim = ClaimRunRequest {
        session_id: session_id.clone(),
        request_message_id: request_id.clone(),
        owner_account_id: owner.clone(),
        requester_account_id: requester.clone(),
        prompt: String::new(),
        runtime_route: None,
        idempotency_key: String::new(),
    };
    if !super::validate_shared_cloud_agent_claim(pool, &claim).await? {
        return Err(RunError::NotFound);
    }
    let conversation: Option<(Uuid,)> = query_as(
        "SELECT c.conversation_id FROM cloud_chat_conversations c WHERE c.legacy_session_id=$1 AND EXISTS(SELECT 1 FROM cloud_chat_conversation_members m WHERE m.conversation_id=c.conversation_id AND m.account_id=$2 AND m.membership_state='active') AND EXISTS(SELECT 1 FROM cloud_chat_conversation_members m WHERE m.conversation_id=c.conversation_id AND m.account_id=$3 AND m.membership_state='active')"
    ).bind(&session_id).bind(&owner).bind(&requester).fetch_optional(&mut *tx).await?;
    let (conversation,) = conversation.ok_or(RunError::NotFound)?;
    if input.arguments["action"] == "inspect" {
        let id = input.arguments["sessionId"]
            .as_str()
            .and_then(|id| Uuid::parse_str(id).ok())
            .ok_or(RunError::NotFound)?;
        let row: Option<(String,String)> = query_as("SELECT title,status FROM cloud_agent_subsessions WHERE subsession_id=$1 AND parent_conversation_id=$2 AND owner_account_id=$3 AND agent_id=$4")
            .bind(id).bind(conversation).bind(&owner).bind(&agent).fetch_optional(&mut *tx).await?;
        let (title, status) = row.ok_or(RunError::NotFound)?;
        return Ok(json!({"sessionId":id,"title":title,"status":status}));
    }
    if input.arguments["action"] != "spawn" {
        return Err(RunError::NotFound);
    }
    let request: SpawnInput =
        serde_json::from_value(input.arguments).map_err(|_| RunError::NotFound)?;
    let title = request
        .task_title
        .as_deref()
        .unwrap_or(&request.task_name)
        .trim();
    if !valid_spawn(&request, title) {
        return Err(RunError::NotFound);
    }
    let key = format!("cloud:{run_id}:{}", request.task_name);
    if let Some((id, title, status)) = query_as::<_, (Uuid, String, String)>(
        "SELECT subsession_id,title,status FROM cloud_agent_subsessions WHERE spawn_key=$1",
    )
    .bind(&key)
    .fetch_optional(&mut *tx)
    .await?
    {
        return Ok(json!({"sessionId":id,"title":title,"status":status}));
    }
    let count: (i64,) =
        query_as("SELECT count(*) FROM cloud_agent_fallback_runs WHERE parent_run_id=$1")
            .bind(run_id)
            .fetch_one(&mut *tx)
            .await?;
    if count.0 >= 4 {
        return Err(RunError::NotFound);
    }
    let id = Uuid::new_v4();
    let child_run = format!("car_{}", Uuid::new_v4().simple());
    let now = chrono::Utc::now();
    let messages = json!([{"id":format!("task:{id}"),"role":"user","text":request.message,"timestampMs":now.timestamp_millis()}]);
    query("INSERT INTO cloud_agent_subsessions(subsession_id,parent_conversation_id,parent_session_id,parent_request_id,owner_account_id,publisher_device_id,execution_backend,spawn_key,agent_id,title,status,messages) VALUES($1,$2,$3,$4,$5,'cloud','cloud',$6,$7,$8,'running',$9)")
        .bind(id).bind(conversation).bind(&session_id).bind(&request_id).bind(&owner).bind(&key).bind(&agent).bind(title).bind(messages).execute(&mut *tx).await?;
    let sandbox = crate::cloud_agent_runtime::sandboxes::ensure_sandbox_for_run(
        pool,
        &format!("subsession:{id}"),
        &owner,
        &requester,
    )
    .await?;
    let system = format!("{system_prompt}\n\nThis is an execution subsession of the same Agent (ID: {agent}). Keep your identity and ownership. Store your progress and final answer here; do not publish them to the parent conversation. Do not create another subsession. Source session ID: {session_id}. Use scoped conversation tools for missing context. Do not access owner-local files.");
    query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,system_prompt,sandbox_id,runtime_route_json,created_at,updated_at,execution_backend,execution_agent_id,parent_run_id,subsession_id,subsession_write_scope) VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11,$11,'cloud',$12,$13,$14,$15)")
        .bind(&child_run).bind(&key).bind(format!("subsession:{id}")).bind(&session_id).bind(&owner).bind(&requester).bind(&request.message).bind(system).bind(sandbox.sandbox_id).bind(route).bind(now.to_rfc3339()).bind(&agent).bind(run_id).bind(id).bind(json!(request.write_scope)).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(json!({"sessionId":id,"title":title,"status":"running"}))
}

fn valid_spawn(request: &SpawnInput, title: &str) -> bool {
    !request.task_name.is_empty()
        && request.task_name.len() <= 80
        && request
            .task_name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        && !title.is_empty()
        && title.chars().count() <= 120
        && !request.message.trim().is_empty()
        && request.message.len() <= 32_000
        && request
            .fork_turns
            .as_deref()
            .is_none_or(|mode| mode == "none")
        && request.write_scope.len() <= 8
        && request.write_scope.iter().all(|path| {
            !path.is_empty()
                && path.len() <= 256
                && !std::path::Path::new(path).is_absolute()
                && !std::path::Path::new(path)
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir))
        })
}

/// Add links only for real records created by this run. Tool arguments and
/// the child's transcript are never copied into the parent's wire message.
pub(crate) async fn with_links(
    pool: &PgPool,
    run_id: &str,
    body: &str,
) -> Result<String, sqlx_core::Error> {
    let rows: Vec<(Uuid,String,String)> = query_as("SELECT s.subsession_id,s.title,s.status FROM cloud_agent_subsessions s JOIN cloud_agent_fallback_runs r ON r.subsession_id=s.subsession_id WHERE r.parent_run_id=$1 ORDER BY s.created_at LIMIT 4")
        .bind(run_id).fetch_all(pool).await?;
    if rows.is_empty() {
        return Ok(body.to_string());
    }
    let Some((prefix, encoded)) = body.split_once(':') else {
        return Ok(body.to_string());
    };
    let Some(mut value) = URL_SAFE_NO_PAD
        .decode(encoded)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    else {
        return Ok(body.to_string());
    };
    let sessions: Vec<Value> = rows
        .into_iter()
        .map(|(id, title, status)| json!({"sessionId":id,"title":title,"status":status}))
        .collect();
    match prefix {
        "kordi-cloud-group" => {
            value["message"]["structuredContent"]["tools"] = json!(sessions.iter().map(|session| json!({
                "id":format!("background-session:{}",session["sessionId"].as_str().unwrap_or_default()),
                "name":"task_operator","status":"completed","arguments":"{}","liveOutput":"",
                "resultText":format!("Background session: {session}"),"isError":false
            })).collect::<Vec<_>>());
        }
        "kordi-cloud-agent-response" => {
            value["backgroundSessions"] = json!(sessions);
        }
        _ => return Ok(body.to_string()),
    }
    Ok(format!(
        "{prefix}:{}",
        URL_SAFE_NO_PAD.encode(value.to_string())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn spawn_validation_bounds_tool_input_and_forbids_forks() {
        let mut request = SpawnInput {
            task_name: "research".into(),
            task_title: Some("Research".into()),
            message: "Compare sources".into(),
            fork_turns: Some("none".into()),
            write_scope: vec![],
        };
        assert!(valid_spawn(&request, "Research"));
        request.write_scope.push("../outside".into());
        assert!(!valid_spawn(&request, "Research"));
        request.write_scope.clear();
        request.fork_turns = Some("all".into());
        assert!(!valid_spawn(&request, "Research"));
    }
}
