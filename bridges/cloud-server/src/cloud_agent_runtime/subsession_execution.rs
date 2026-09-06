//! Continue shared subsessions through the existing execution lease contract.
use super::runs::{ClaimRunRequest, RunError, RunResult};
use crate::{auth::routes::CloudSession, server::ServerState};
use axum::{extract::State, Extension, Json};
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use std::sync::Arc;
use uuid::Uuid;

pub(super) async fn pending(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Result<Json<Vec<Value>>, axum::http::StatusCode> {
    let rows:Vec<(String,Uuid,String,String,String)>=query_as("SELECT r.run_id,s.subsession_id,c.message_id::text,c.sender_account_id,c.text FROM cloud_agent_subsession_chat c JOIN cloud_agent_fallback_runs r ON r.run_id=c.run_id JOIN cloud_agent_subsessions s ON s.subsession_id=c.subsession_id JOIN cloud_chat_conversation_members m ON m.conversation_id=s.parent_conversation_id AND m.account_id=c.sender_account_id AND m.membership_state='active' WHERE EXISTS(SELECT 1 FROM cloud_chat_conversation_members owner_member WHERE owner_member.conversation_id=s.parent_conversation_id AND owner_member.account_id=s.owner_account_id AND owner_member.membership_state='active') AND s.owner_account_id=$1 AND s.publisher_device_id=$2 AND s.execution_backend='desktop' AND r.status='queued' ORDER BY c.sequence LIMIT 16")
        .bind(&session.account_id).bind(&session.device_id).fetch_all(state.db_pool()).await.map_err(|_|axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut pending = Vec::new();
    for (run, id, message, actor, text) in rows {
        let ordinary:Vec<(String,String,String,i64)>=query_as("SELECT c.message_id::text,a.display_name,c.text,(extract(epoch from c.created_at)*1000)::bigint FROM cloud_agent_subsession_chat c JOIN cloud_accounts a ON a.account_id=c.sender_account_id WHERE c.subsession_id=$1 AND c.run_id IS NULL AND c.sequence<(SELECT sequence FROM cloud_agent_subsession_chat WHERE message_id::text=$2) ORDER BY c.sequence DESC LIMIT 64")
            .bind(id).bind(&message).fetch_all(state.db_pool()).await.map_err(|_|axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
        let mut context:Vec<Value>=ordinary.into_iter().rev().map(|(id,name,text,time)|json!({"id":id,"authorName":name,"authorKind":"person","text":text,"createdAtMs":time})).collect();
        context.push(json!({"id":format!("requester:{message}"),"authorName":"Current requester","authorKind":"agent","contextRole":"system","text":format!("The current follow-up requester has account ID {}. This does not change the Agent identity or owner.",json!(actor))}));
        pending.push(json!({"runId":run,"subsessionId":id,"messageId":message,"senderAccountId":actor,"text":text,"contextMessages":context}));
    }
    Ok(Json(pending))
}

pub(super) async fn claim(
    pool: &PgPool,
    session: &CloudSession,
    input: &ClaimRunRequest,
    executor: &str,
) -> RunResult<Option<Value>> {
    let Some(message) = Uuid::parse_str(&input.request_message_id).ok() else {
        return Ok(None);
    };
    let found:Option<(String,Uuid)>=query_as("SELECT c.run_id,c.subsession_id FROM cloud_agent_subsession_chat c JOIN cloud_agent_subsessions s ON s.subsession_id=c.subsession_id WHERE c.message_id=$1 AND c.run_id IS NOT NULL AND s.owner_account_id=$2")
        .bind(message).bind(&session.account_id).fetch_optional(pool).await?;
    let Some((run, id)) = found else {
        return Ok(None);
    };
    if !revalidate(pool, &run).await? {
        return Err(RunError::NotFound);
    }
    if input.session_id != id.to_string() {
        return Err(RunError::NotFound);
    };
    let mut tx = pool.begin().await?;
    query("SELECT pg_advisory_xact_lock(81208411)")
        .execute(&mut *tx)
        .await?;
    let eligible:(bool,)=query_as("SELECT EXISTS(SELECT 1 FROM cloud_agent_subsessions s JOIN cloud_agent_subsession_chat c ON c.subsession_id=s.subsession_id JOIN cloud_agent_fallback_runs r ON r.run_id=c.run_id WHERE s.subsession_id=$1 AND c.message_id=$2 AND s.owner_account_id=$3 AND s.publisher_device_id=$4 AND s.execution_backend='desktop' AND r.status='queued' AND s.status<>'running' AND EXISTS(SELECT 1 FROM cloud_chat_conversation_members m WHERE m.conversation_id=s.parent_conversation_id AND m.account_id=c.sender_account_id AND m.membership_state='active') AND EXISTS(SELECT 1 FROM cloud_chat_conversation_members m WHERE m.conversation_id=s.parent_conversation_id AND m.account_id=s.owner_account_id AND m.membership_state='active') AND EXISTS(SELECT 1 FROM cloud_agent_desktop_capabilities ready WHERE ready.device_id=$4 AND ready.agent_id=s.agent_id AND ready.updated_at>now()-interval '35 seconds') AND NOT EXISTS(SELECT 1 FROM cloud_agent_subsession_chat earlier JOIN cloud_agent_fallback_runs e ON e.run_id=earlier.run_id WHERE earlier.subsession_id=s.subsession_id AND earlier.sequence<c.sequence AND e.status IN ('queued','leased','running')))")
        .bind(id).bind(message).bind(&session.account_id).bind(&session.device_id).fetch_one(&mut *tx).await?;
    if eligible.0 {
        query("UPDATE cloud_agent_fallback_runs SET execution_backend='desktop',status='leased',claimed_by=$2,lease_expires_at=(now()+interval '45 seconds')::text,updated_at=now()::text WHERE run_id=$1 AND status='queued'")
            .bind(&run).bind(executor).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Some(
        json!({"runId":run,"acquired":eligible.0,"leaseSeconds":45}),
    ))
}

pub(super) async fn mark_active(pool: &PgPool, run: &str, backend: &str) -> RunResult<()> {
    query("UPDATE cloud_agent_subsessions s SET status='running',execution_backend=$2,execution_started_at=CASE WHEN s.status<>'running' THEN now() ELSE COALESCE(s.execution_started_at,now()) END,execution_finished_at=NULL,heartbeat_at=now(),version=version+1,updated_at=now() FROM cloud_agent_fallback_runs r WHERE r.subsession_id=s.subsession_id AND r.run_id=$1 AND r.status='running' AND (s.status<>'running' OR s.execution_backend<>$2 OR s.execution_started_at IS NULL)")
        .bind(run).bind(backend).execute(pool).await?;
    Ok(())
}

pub(crate) async fn revalidate(pool: &PgPool, run: &str) -> RunResult<bool> {
    let valid: Option<(bool,)> = query_as("SELECT EXISTS(SELECT 1 FROM cloud_chat_conversation_members m WHERE m.conversation_id=s.parent_conversation_id AND m.account_id=r.owner_account_id AND m.membership_state='active') AND EXISTS(SELECT 1 FROM cloud_chat_conversation_members m WHERE m.conversation_id=s.parent_conversation_id AND m.account_id=r.requester_account_id AND m.membership_state='active') AND (s.agent_id='cloud-agent:'||s.owner_account_id OR EXISTS(SELECT 1 FROM cloud_agent_definitions d WHERE d.agent_id=s.agent_id AND d.owner_account_id=s.owner_account_id AND d.status='active' AND (d.access_scope='participant_conversations' OR s.owner_account_id=r.requester_account_id))) FROM cloud_agent_fallback_runs r JOIN cloud_agent_subsessions s ON s.subsession_id=r.subsession_id WHERE r.run_id=$1")
        .bind(run).fetch_optional(pool).await?;
    if valid.is_some_and(|value| !value.0) {
        let mut tx = pool.begin().await?;
        query("SELECT pg_advisory_xact_lock(81208411)")
            .execute(&mut *tx)
            .await?;
        query("UPDATE cloud_agent_subsessions s SET status='stopped',execution_finished_at=COALESCE(execution_finished_at,now()),version=version+1,updated_at=now() FROM cloud_agent_fallback_runs r WHERE r.run_id=$1 AND s.subsession_id=r.subsession_id AND r.status IN ('leased','running')")
            .bind(run).execute(&mut *tx).await?;
        query("UPDATE cloud_agent_fallback_runs SET status='cancelled',completed_at=now()::text,updated_at=now()::text WHERE run_id=$1 AND status IN ('queued','leased','running')")
            .bind(run).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(false);
    }
    Ok(true)
}

pub(super) async fn cancelled(pool: &PgPool, run: &str) -> RunResult<()> {
    query("UPDATE cloud_agent_subsessions s SET status='stopped',execution_finished_at=COALESCE(execution_finished_at,now()),version=version+1,updated_at=now() FROM cloud_agent_subsession_chat c JOIN cloud_agent_fallback_runs r ON r.run_id=c.run_id WHERE c.subsession_id=s.subsession_id AND r.run_id=$1 AND r.status='cancelled' AND NOT EXISTS(SELECT 1 FROM cloud_agent_fallback_runs other WHERE other.subsession_id=s.subsession_id AND other.run_id<>r.run_id AND other.status='running')")
        .bind(run).execute(pool).await?;
    Ok(())
}

pub(super) async fn publish(
    pool: &PgPool,
    run: &str,
    executor: &str,
    response: &Value,
    phase: &str,
) -> RunResult<Option<Value>> {
    let follow: (bool,) =
        query_as("SELECT EXISTS(SELECT 1 FROM cloud_agent_subsession_chat WHERE run_id=$1)")
            .bind(run)
            .fetch_one(pool)
            .await?;
    if !follow.0 {
        return Ok(None);
    };
    if !revalidate(pool, run).await? {
        return Err(RunError::NotFound);
    }
    let mut tx = pool.begin().await?;
    query("SELECT pg_advisory_xact_lock(81208411)")
        .execute(&mut *tx)
        .await?;
    let owned:Option<(Uuid,Uuid,String,String,String)>=query_as("SELECT c.message_id,c.subsession_id,r.owner_account_id,r.requester_account_id,r.status FROM cloud_agent_subsession_chat c JOIN cloud_agent_fallback_runs r ON r.run_id=c.run_id WHERE r.run_id=$1 AND r.claimed_by=$2 AND r.execution_backend='desktop' AND (r.status IN ('leased','running') AND r.lease_expires_at::timestamptz>now() OR r.status=$3 AND r.status IN ('completed','failed','cancelled') AND c.response_text=$4) FOR UPDATE OF r")
        .bind(run).bind(executor).bind(phase).bind(response["text"].as_str().unwrap_or_default()).fetch_optional(&mut *tx).await?;
    let (message, id, owner, requester, stored_status) = owned.ok_or(RunError::NotFound)?;
    if response["requestId"].as_str() != Some(message.to_string().as_str()) {
        return Err(RunError::NotFound);
    };
    let receipt = json!({"messageId":message,"fromAccountId":owner,"toAccountId":requester,"sessionId":id,"body":"","createdAt":chrono::Utc::now().to_rfc3339(),"deliveredAt":null,"readAt":null});
    if matches!(stored_status.as_str(), "completed" | "failed" | "cancelled") {
        tx.commit().await?;
        return Ok(Some(receipt));
    }
    let text = response["text"].as_str().unwrap_or_default();
    let activity = public_activity(&response["execution"]);
    query("UPDATE cloud_agent_subsession_chat SET response_text=$2,activity=$3,updated_at=now() WHERE message_id=$1")
        .bind(message).bind(text).bind(&activity).execute(&mut *tx).await?;
    let terminal = matches!(phase, "completed" | "failed" | "cancelled");
    query("UPDATE cloud_agent_fallback_runs SET status=$2,updated_at=now()::text,completed_at=CASE WHEN $3 THEN now()::text ELSE NULL END WHERE run_id=$1")
        .bind(run).bind(phase).bind(terminal).execute(&mut *tx).await?;
    let status = match phase {
        "completed" => "done",
        "failed" => "failed",
        "cancelled" => "stopped",
        _ => "running",
    };
    query("UPDATE cloud_agent_subsessions SET status=$2,execution_finished_at=CASE WHEN $2<>'running' THEN COALESCE(execution_finished_at,now()) ELSE NULL END,heartbeat_at=now(),version=version+1,updated_at=now() WHERE subsession_id=$1")
        .bind(id).bind(status).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Some(receipt))
}

pub(crate) fn public_activity(value: &Value) -> Value {
    let tools:Vec<Value>=value["tools"].as_array().into_iter().flatten().take(24).map(|tool|json!({
        "id":tool["id"].as_str().unwrap_or_default().chars().take(128).collect::<String>(),
        "name":tool["name"].as_str().unwrap_or_default().chars().filter(|c|c.is_ascii_alphanumeric()||*c=='_').take(64).collect::<String>(),
        "status":match tool["status"].as_str() {Some("completed"|"done")=>"completed",Some("failed"|"error")=>"failed",Some("cancelled")=>"cancelled",_=>"running"},"arguments":"","liveOutput":"","isError":tool["isError"].as_bool().unwrap_or(false)
    })).collect();
    json!({"tools":tools})
}

pub(crate) async fn history(pool: &PgPool, run: &str) -> RunResult<Vec<Value>> {
    let source:Option<(Uuid,i64,Value)>=query_as("SELECT c.subsession_id,c.sequence,s.messages FROM cloud_agent_subsession_chat c JOIN cloud_agent_subsessions s ON s.subsession_id=c.subsession_id WHERE c.run_id=$1")
        .bind(run).fetch_optional(pool).await?;
    let Some((id, sequence, initial)) = source else {
        return Ok(Vec::new());
    };
    let mut result: Vec<Value> = initial
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| Some(json!({"role":m["role"].as_str()?,"content":m["text"].as_str()?})))
        .collect();
    let rows:Vec<(String,String,String)>=query_as("SELECT a.display_name,c.text,c.response_text FROM cloud_agent_subsession_chat c JOIN cloud_accounts a ON a.account_id=c.sender_account_id WHERE c.subsession_id=$1 AND c.sequence<$2 ORDER BY c.sequence DESC LIMIT 128")
        .bind(id).bind(sequence).fetch_all(pool).await?;
    for (name, text, response) in rows.into_iter().rev() {
        result.push(json!({"role":"user","content":format!("Participant {}: {text}",json!(name))}));
        if !response.is_empty() {
            result.push(json!({"role":"assistant","content":response}));
        }
    }
    Ok(result)
}
