//! Runner lease DTOs, lease state transitions, and runner response projection.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::{AgentRuntimeRoute, RunError, RunResult};

#[derive(Debug, Deserialize)]
pub struct RunnerRunRequest {
    #[serde(rename = "runnerId")]
    pub runner_id: String,
    #[serde(rename = "canaryRunId")]
    pub canary_run_id: Option<String>,
}

impl RunnerRunRequest {
    pub fn runner_id(&self) -> Option<String> {
        let trimmed = self.runner_id.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    pub fn canary_run_id(&self) -> Option<String> {
        let trimmed = self.canary_run_id.as_deref()?.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RunnerLeaseResponse {
    pub run: Option<RunnerRunResponse>,
}

#[derive(Debug, Serialize)]
pub struct RunnerRunEnvelope {
    pub run: RunnerRunResponse,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunnerRunResponse {
    #[serde(rename = "runId")]
    pub run_id: String,
    pub status: String,
    pub prompt: String,
    #[serde(rename = "systemPrompt")]
    pub system_prompt: String,
    #[serde(rename = "ownerAccountId")]
    pub owner_account_id: String,
    #[serde(rename = "requesterAccountId")]
    pub requester_account_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "sandboxId")]
    pub sandbox_id: Option<String>,
    #[serde(rename = "runtimeRoute")]
    pub runtime_route: AgentRuntimeRoute,
    #[serde(rename = "providerAuthAvailable")]
    pub provider_auth_available: bool,
    #[serde(rename = "responseMessageId")]
    pub response_message_id: Option<String>,
    #[serde(rename = "errorCode")]
    pub error_code: Option<String>,
    #[serde(rename = "errorMessage")]
    pub error_message: Option<String>,
}

pub(super) type RunnerRunRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    serde_json::Value,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
);

pub async fn lease_next_run(
    pool: &PgPool,
    runner_id: &str,
) -> RunResult<Option<RunnerRunResponse>> {
    lease_run(pool, runner_id, None).await
}

async fn lease_run(
    pool: &PgPool,
    runner_id: &str,
    canary_run_id: Option<&str>,
) -> RunResult<Option<RunnerRunResponse>> {
    let now = Utc::now();
    let lease_expires_at = (now + chrono::Duration::seconds(120)).to_rfc3339();
    let mut tx = pool.begin().await?;
    // ponytail: serialize ownership transitions, not agent work; use per-session
    // locks if admission or terminal publication becomes a measured bottleneck.
    sqlx_core::query::query("SELECT pg_advisory_xact_lock(81208411)")
        .execute(&mut *tx)
        .await?;
    let row: Option<RunnerRunRow> = query_as(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'leased', execution_backend = 'cloud', claimed_by = $1, lease_expires_at = $2, updated_at = $3 \
         WHERE run_id = ( \
             SELECT candidate.run_id FROM cloud_agent_fallback_runs candidate \
             WHERE (status = 'queued' \
                OR ( \
                    status IN ('leased', 'running') \
                    AND lease_expires_at IS NOT NULL \
                    AND lease_expires_at::timestamptz <= $3::timestamptz \
                )) \
             AND ($4::text IS NULL OR candidate.run_id=$4) \
             AND (NOT EXISTS(SELECT 1 FROM cloud_chat_conversations c WHERE c.legacy_session_id=candidate.session_id AND c.kind='ai') \
                  OR NOT EXISTS(SELECT 1 FROM cloud_agent_fallback_runs active WHERE active.run_id<>candidate.run_id AND active.session_id=candidate.session_id AND active.execution_agent_id=candidate.execution_agent_id AND active.status IN ('queued','leased','running') AND (active.created_at<candidate.created_at OR (active.status='running' AND active.lease_expires_at::timestamptz>now())))) \
             ORDER BY created_at ASC \
             LIMIT 1 \
             FOR UPDATE SKIP LOCKED \
         ) \
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id, session_id, sandbox_id, runtime_route_json, response_message_id, error_code, error_message, system_prompt",
    )
    .bind(runner_id)
    .bind(&lease_expires_at)
    .bind(now.to_rfc3339())
    .bind(canary_run_id)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    let Some(row) = row else {
        return Ok(None);
    };
    runner_response_from_row(pool, row).await.map(Some)
}

pub async fn lease_canary_run(
    pool: &PgPool,
    runner_id: &str,
    canary_run_id: &str,
) -> RunResult<Option<RunnerRunResponse>> {
    lease_run(pool, runner_id, Some(canary_run_id)).await
}

pub async fn mark_run_running(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
) -> RunResult<RunnerRunResponse> {
    let now = Utc::now();
    let lease_expires_at = (now + chrono::Duration::seconds(120)).to_rfc3339();
    let row: Option<RunnerRunRow> = query_as(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'running', lease_expires_at = $3, updated_at = $4 \
         WHERE run_id = $1 AND claimed_by = $2 AND execution_backend='cloud' AND status IN ('leased', 'running') AND lease_expires_at::timestamptz>now() \
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id, session_id, sandbox_id, runtime_route_json, response_message_id, error_code, error_message, system_prompt",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(lease_expires_at)
    .bind(now.to_rfc3339())
    .fetch_optional(pool)
    .await?;
    match row {
        Some(row) => runner_response_from_row(pool, row).await,
        None => Err(RunError::NotFound),
    }
}

pub(super) async fn runner_response_from_row(
    pool: &PgPool,
    row: RunnerRunRow,
) -> RunResult<RunnerRunResponse> {
    let provider_auth_available: Option<(String,)> = query_as(
        "SELECT snapshot_id FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND revoked_at IS NULL \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&row.3)
    .fetch_optional(pool)
    .await?;
    Ok(RunnerRunResponse {
        run_id: row.0,
        status: row.1,
        prompt: row.2,
        system_prompt: row.11,
        owner_account_id: row.3,
        requester_account_id: row.4,
        session_id: row.5,
        sandbox_id: row.6,
        runtime_route: serde_json::from_value(row.7).unwrap_or_default(),
        provider_auth_available: provider_auth_available.is_some(),
        response_message_id: row.8,
        error_code: row.9,
        error_message: row.10,
    })
}
