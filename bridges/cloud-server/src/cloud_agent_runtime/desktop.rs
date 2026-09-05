//! Desktop admission and publication use the same durable run as the cloud runner.
use super::runs::{
    claim_run_for_desktop, error_response, execution_agent_id, run_error_response,
    validate_shared_cloud_agent_claim, ClaimRunRequest,
};
use crate::{auth::routes::CloudSession, server::ServerState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReadyInput {
    agent_ids: Vec<String>,
}

pub(super) async fn ready(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(input): Json<ReadyInput>,
) -> Response {
    if input.agent_ids.len() > 128 {
        return denied();
    }
    let result = async {
        let mut tx = state.db_pool().begin().await?;
        let desktop: Option<(String,)> = query_as("SELECT device_id FROM cloud_devices WHERE device_id=$1 AND account_id=$2 AND device_platform IN ('macos','desktop') AND revoked_at IS NULL FOR UPDATE")
            .bind(&session.device_id).bind(&session.account_id).fetch_optional(&mut *tx).await?;
        if desktop.is_none() { return Ok::<_, sqlx_core::Error>(false); }
        query("DELETE FROM cloud_agent_desktop_capabilities WHERE device_id=$1").bind(&session.device_id).execute(&mut *tx).await?;
        for agent in &input.agent_ids {
            let own: Option<(String,)> = query_as("SELECT agent_id FROM cloud_agent_definitions WHERE agent_id=$1 AND owner_account_id=$2 AND status='active'")
                .bind(agent).bind(&session.account_id).fetch_optional(&mut *tx).await?;
            if agent != &format!("cloud-agent:{}", session.account_id) && own.is_none() { return Ok(false); }
            query("INSERT INTO cloud_agent_desktop_capabilities(device_id,agent_id) VALUES($1,$2) ON CONFLICT(device_id,agent_id) DO UPDATE SET updated_at=now()")
                .bind(&session.device_id).bind(agent).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(true)
    }.await;
    match result {
        Ok(true) => Json(json!({"ok":true})).into_response(),
        Ok(false) => denied(),
        Err(e) => run_error_response(
            "desktop readiness",
            "Could not publish runtime readiness.",
            e.into(),
        ),
    }
}

pub(super) async fn prefer_ready_desktop(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> super::runs::RunResult<bool> {
    let agent = execution_agent_id(pool, input).await?;
    // Readiness only grants a short admission window. An unresponsive desktop
    // must not block fallback forever merely because the application is online.
    let row: (bool,) = query_as("SELECT EXISTS(SELECT 1 FROM cloud_agent_desktop_capabilities r JOIN cloud_devices d USING(device_id) JOIN cloud_device_presence p USING(device_id) WHERE d.account_id=$1 AND d.revoked_at IS NULL AND r.agent_id=$2 AND r.updated_at>now()-interval '35 seconds' AND p.state='online' AND p.last_heartbeat_at::timestamptz>now()-interval '35 seconds') AND EXISTS(SELECT 1 FROM cloud_chat_messages WHERE message_id::text=$3 AND created_at>now()-interval '10 seconds')")
        .bind(&input.owner_account_id).bind(agent).bind(&input.request_message_id).fetch_one(pool).await?;
    Ok(row.0)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DesktopClaimInput {
    #[serde(flatten)]
    run: ClaimRunRequest,
    claim_id: Uuid,
}

fn executor(session: &CloudSession, claim_id: Uuid) -> String {
    format!("desktop:{}:{claim_id}", session.device_id)
}
fn denied() -> Response {
    error_response(
        "desktop_execution_denied",
        "This desktop cannot execute the requested agent run.",
        StatusCode::FORBIDDEN,
    )
}
fn expired() -> Response {
    error_response(
        "execution_lease_lost",
        "This runtime no longer owns the request.",
        StatusCode::CONFLICT,
    )
}

pub(super) async fn claim(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(input): Json<DesktopClaimInput>,
) -> Response {
    if !input.run.is_well_formed() || input.run.owner_account_id != session.account_id {
        return denied();
    }
    let result = async {
        let agent = execution_agent_id(state.db_pool(), &input.run).await?;
        let allowed: (bool,) = query_as("SELECT EXISTS(SELECT 1 FROM cloud_chat_messages m JOIN cloud_chat_conversations c USING(conversation_id) JOIN cloud_chat_conversation_members member ON member.conversation_id=c.conversation_id WHERE m.message_id::text=$1 AND c.legacy_session_id=$2 AND m.sender_account_id=$3 AND m.deleted_at IS NULL AND member.account_id=$4 AND member.membership_state='active') AND EXISTS(SELECT 1 FROM cloud_agent_desktop_capabilities r JOIN cloud_devices d USING(device_id) WHERE r.device_id=$5 AND d.account_id=$4 AND d.revoked_at IS NULL AND r.agent_id=$6 AND r.updated_at>now()-interval '35 seconds')")
            .bind(&input.run.request_message_id).bind(&input.run.session_id).bind(&input.run.requester_account_id).bind(&session.account_id).bind(&session.device_id).bind(agent).fetch_one(state.db_pool()).await?;
        if !allowed.0 || !validate_shared_cloud_agent_claim(state.db_pool(), &input.run).await? { return Ok::<_, super::runs::RunError>(None); }
        let owner = executor(&session, input.claim_id);
        let run = claim_run_for_desktop(state.db_pool(), &input.run, &owner).await?;
        let acquired: (bool,) = query_as("SELECT execution_backend='desktop' AND claimed_by=$2 AND status IN ('leased','running') AND lease_expires_at::timestamptz>now() FROM cloud_agent_fallback_runs WHERE run_id=$1")
            .bind(&run.run_id).bind(owner).fetch_one(state.db_pool()).await?;
        Ok(Some(json!({"runId":run.run_id,"acquired":acquired.0,"leaseSeconds":45})))
    }.await;
    match result {
        Ok(Some(value)) => Json(value).into_response(),
        Ok(None) => denied(),
        Err(e) => run_error_response("desktop claim", "Could not claim agent execution.", e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RenewalInput {
    claim_id: Uuid,
}

pub(super) async fn admit(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(run_id): Path<String>,
    Json(input): Json<RenewalInput>,
) -> Response {
    let result = async {
        let mut tx = state.db_pool().begin().await?;
        query("SELECT pg_advisory_xact_lock(81208411)").execute(&mut *tx).await?;
        let owned: Option<(String,String,String)> = query_as("SELECT session_id,execution_agent_id,created_at FROM cloud_agent_fallback_runs WHERE run_id=$1 AND claimed_by=$2 AND execution_backend='desktop' AND status IN ('leased','running') AND lease_expires_at::timestamptz>now() FOR UPDATE")
            .bind(&run_id).bind(executor(&session,input.claim_id)).fetch_optional(&mut *tx).await?;
        let Some((session_id,agent_id,created_at))=owned else { return Ok::<_,sqlx_core::Error>(None); };
        let blocked: (bool,) = query_as("SELECT EXISTS(SELECT 1 FROM cloud_agent_fallback_runs other JOIN cloud_chat_conversations c ON c.legacy_session_id=other.session_id WHERE c.kind='ai' AND other.session_id=$1 AND other.execution_agent_id=$2 AND other.run_id<>$3 AND other.status IN ('queued','leased','running') AND (other.created_at<$4 OR other.status='running'))")
            .bind(session_id).bind(agent_id).bind(&run_id).bind(created_at).fetch_one(&mut *tx).await?;
        if !blocked.0 { query("UPDATE cloud_agent_fallback_runs SET status='running' WHERE run_id=$1").bind(&run_id).execute(&mut *tx).await?; }
        tx.commit().await?;
        Ok(Some(!blocked.0))
    }.await;
    match result {
        Ok(Some(admitted)) => Json(json!({"admitted":admitted})).into_response(),
        Ok(None) => expired(),
        Err(e) => run_error_response(
            "desktop admission",
            "Could not admit the queued request.",
            e.into(),
        ),
    }
}

pub(super) async fn renew(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(run_id): Path<String>,
    Json(input): Json<RenewalInput>,
) -> Response {
    let result = query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=$3, updated_at=$4 WHERE run_id=$1 AND claimed_by=$2 AND execution_backend='desktop' AND status IN ('leased','running') AND lease_expires_at::timestamptz>now()")
        .bind(run_id).bind(executor(&session,input.claim_id)).bind((Utc::now()+chrono::Duration::seconds(45)).to_rfc3339()).bind(Utc::now().to_rfc3339()).execute(state.db_pool()).await;
    match result {
        Ok(r) if r.rows_affected() == 1 => Json(json!({"ok":true})).into_response(),
        Ok(_) => expired(),
        Err(e) => run_error_response("desktop lease", "Could not renew execution.", e.into()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProgressInput {
    claim_id: Uuid,
    body: String,
    client_message_id: Uuid,
}

pub(super) async fn progress(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(run_id): Path<String>,
    Json(input): Json<ProgressInput>,
) -> Response {
    let response: Option<Value> = input
        .body
        .strip_prefix("kordi-cloud-agent-response:")
        .filter(|body| body.len() <= 1_048_576)
        .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
        .and_then(|b| serde_json::from_slice(&b).ok());
    let Some(response) = response else {
        return denied();
    };
    if response.get("text").and_then(Value::as_str).is_none() { return denied(); }
    let phase = match response.get("deliveryState").and_then(Value::as_str) {
        Some("processing")
            if response.pointer("/execution/phase").and_then(Value::as_str) == Some("queued") =>
        {
            "leased"
        }
        Some("processing") => "running",
        Some("complete") => "completed",
        Some("failed") => "failed",
        Some("cancelled") => "cancelled",
        _ => return denied(),
    };
    let result = async {
        let mut tx = state.db_pool().begin().await?;
        let row: Option<(String,String,String)> = query_as("SELECT session_id,request_message_id,requester_account_id FROM cloud_agent_fallback_runs WHERE run_id=$1 AND owner_account_id=$2 AND claimed_by=$3 AND execution_backend='desktop' AND ((status IN ('leased','running') AND lease_expires_at::timestamptz>now()) OR (status=$4 AND status IN ('completed','failed','cancelled') AND EXISTS(SELECT 1 FROM cloud_chat_messages WHERE sender_account_id=$2 AND client_message_id=$5))) FOR UPDATE")
            .bind(&run_id).bind(&session.account_id).bind(executor(&session,input.claim_id)).bind(phase).bind(input.client_message_id).fetch_optional(&mut *tx).await?;
        let Some((session_id,request_id,requester))=row else { return Ok::<_,crate::chat_sync::store::StoreError>(None); };
        if response.get("requestId").and_then(Value::as_str)!=Some(request_id.as_str()) || response.get("kind").and_then(Value::as_str)!=Some("agent-response") { return Ok(None); }
        let conversation: (Uuid,) = query_as("SELECT conversation_id FROM cloud_chat_conversations WHERE legacy_session_id=$1")
            .bind(&session_id).fetch_one(&mut *tx).await?;
        let message = crate::chat_sync::store::send_message_in_transaction(&mut tx, &session.account_id, conversation.0, crate::chat_sync::models::SendMessageRequest {
            client_message_id: input.client_message_id, kind: "text".into(), content: json!({"schema":1,"blocks":[{"type":"text","text":input.body}]}), reply_to_message_id: None, attachment_ids:vec![],
        }).await?.value;
        query("UPDATE cloud_agent_fallback_runs SET status=$2, response_message_id=$3, updated_at=$4, completed_at=CASE WHEN $2 IN ('completed','failed','cancelled') THEN $4 ELSE NULL END WHERE run_id=$1")
            .bind(&run_id).bind(phase).bind(message.id.to_string()).bind(Utc::now().to_rfc3339()).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(Some(json!({"messageId":message.id,"clientMessageId":message.client_message_id,"conversationId":message.conversation_id,"conversationSequence":message.conversation_sequence,"version":message.version,"fromAccountId":session.account_id,"toAccountId":requester,"sessionId":session_id,"body":input.body,"createdAt":message.created_at,"deliveredAt":null,"readAt":null})))
    }.await;
    match result {
        Ok(Some(value)) => {
            if matches!(phase, "completed" | "failed" | "cancelled") {
                super::routes::notify_run_response(&state, value.get("messageId").and_then(Value::as_str)).await;
            }
            Json(value).into_response()
        },
        Ok(None) => expired(),
        Err(_) => error_response(
            "server_error",
            "Could not publish execution progress.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}
