//! Ends a project-session request that no Mac with the project can run.
//!
//! The cloud has no project files, so it never answers such a request. The
//! request gets a failed reply at once instead of waiting with no status.

use chrono::Utc;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::envelopes::encode_cloud_agent_response_body_with_state;
use super::{ClaimRunRequest, CloudAgentRunResponse, RunError, RunResult};
use crate::connectors::models::RunTrigger;

pub const PROJECT_UNAVAILABLE_ERROR_CODE: &str = "project_unavailable";

type RunRow = (String, String, Option<String>, String, String, String);

/// Records a failed run for the request and posts `message` as its reply.
/// Repeated calls for the same request return the first run.
pub async fn fail_unavailable_project_request(
    pool: &PgPool,
    input: &ClaimRunRequest,
    message: &str,
) -> RunResult<CloudAgentRunResponse> {
    let Some((request_id, wire_id)) =
        super::request_identity(pool, &input.session_id, &input.request_message_id).await?
    else {
        return Err(RunError::NotFound);
    };
    // Only a real request from the requester in a conversation the owner is in.
    let valid: (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_chat_messages m JOIN cloud_chat_conversations c USING(conversation_id) \
         JOIN cloud_chat_conversation_members member ON member.conversation_id=c.conversation_id \
         WHERE m.message_id::text=$1 AND c.legacy_session_id=$2 AND m.sender_account_id=$3 AND m.deleted_at IS NULL \
           AND member.account_id=$4 AND member.membership_state='active')",
    )
    .bind(&wire_id)
    .bind(&input.session_id)
    .bind(&input.requester_account_id)
    .bind(&input.owner_account_id)
    .fetch_one(pool)
    .await?;
    if !valid.0 {
        return Err(RunError::NotFound);
    }
    let agent_id = super::execution_agent_id(pool, input).await?;
    let now = Utc::now().to_rfc3339();
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let inserted: Option<RunRow> = query_as(
        "INSERT INTO cloud_agent_fallback_runs (
            run_id, idempotency_key, request_message_id, session_id, owner_account_id,
            requester_account_id, status, prompt, error_code, error_message, created_at, updated_at,
            completed_at, execution_backend, execution_agent_id, run_trigger, connector_audience
         ) VALUES ($1, $2, $3, $4, $5, $6, 'failed', $7, $8, $9, $10, $10, $10, 'cloud', $11, $12, 'owner_private')
         -- Nothing runs, so the narrowest connector audience applies.
         ON CONFLICT DO NOTHING
         RETURNING run_id, status, sandbox_id, created_at, updated_at, execution_backend",
    )
    .bind(&run_id)
    .bind(&input.idempotency_key)
    .bind(&request_id)
    .bind(&input.session_id)
    .bind(&input.owner_account_id)
    .bind(&input.requester_account_id)
    .bind(&input.prompt)
    .bind(PROJECT_UNAVAILABLE_ERROR_CODE)
    .bind(message)
    .bind(&now)
    .bind(&agent_id)
    .bind(RunTrigger::for_person_message(&input.owner_account_id, &input.requester_account_id).as_str())
    .fetch_optional(pool)
    .await?;
    let Some(row) = inserted else {
        // Another device ended or claimed the request first.
        let existing: Option<RunRow> = query_as(
            "SELECT run_id, status, sandbox_id, created_at, updated_at, execution_backend \
             FROM cloud_agent_fallback_runs \
             WHERE owner_account_id=$1 AND execution_agent_id=$2 AND request_message_id=$3 AND NOT legacy_duplicate",
        )
        .bind(&input.owner_account_id)
        .bind(&agent_id)
        .bind(&request_id)
        .fetch_optional(pool)
        .await?;
        return existing.map(run_response).ok_or(RunError::NotFound);
    };
    let body = encode_cloud_agent_response_body_with_state(&request_id, message, "failed");
    crate::cloud_agent_runtime::artifacts::ensure_response_message(
        pool,
        &row.0,
        &input.owner_account_id,
        &input.requester_account_id,
        &input.session_id,
        &body,
    )
    .await?;
    Ok(run_response(row))
}

fn run_response(row: RunRow) -> CloudAgentRunResponse {
    CloudAgentRunResponse {
        run_id: row.0,
        status: row.1,
        sandbox_id: row.2,
        created_at: row.3,
        updated_at: row.4,
        execution_backend: row.5,
    }
}
