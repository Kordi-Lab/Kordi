//! Runner lease DTOs, lease state transitions, and runner response projection.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use crate::cloud_agent_runtime::proactive::cancel_if_ineligible;
use crate::cloud_agent_runtime::provider_auth::{EnvProviderAuthCipher, ProviderAuthCipher};

use super::{RunError, RunResult};

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
    #[serde(rename = "ownerAccountId")]
    pub owner_account_id: String,
    #[serde(rename = "requesterAccountId")]
    pub requester_account_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "sandboxId")]
    pub sandbox_id: Option<String>,
    #[serde(rename = "providerAuthAvailable")]
    pub provider_auth_available: bool,
    #[serde(rename = "responseMessageId")]
    pub response_message_id: Option<String>,
    #[serde(rename = "errorCode")]
    pub error_code: Option<String>,
    #[serde(rename = "errorMessage")]
    pub error_message: Option<String>,
    #[serde(rename = "triggerKind")]
    pub trigger_kind: String,
    #[serde(rename = "targetAgentId")]
    pub target_agent_id: Option<String>,
    #[serde(rename = "skillPack")]
    pub skill_pack: Option<String>,
}

pub(crate) type RunnerRunRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

pub async fn lease_next_run(
    pool: &PgPool,
    runner_id: &str,
) -> RunResult<Option<RunnerRunResponse>> {
    for _ in 0..8 {
        let now = Utc::now();
        let now_text = now.to_rfc3339();
        let lease_expires_at = (now + chrono::Duration::seconds(120)).to_rfc3339();
        let row: Option<RunnerRunRow> = query_as(
            "UPDATE cloud_agent_fallback_runs AS run \
             SET status = 'leased', claimed_by = $1, lease_expires_at = $2, updated_at = $3 \
             WHERE run.run_id = ( \
                 SELECT candidate.run_id FROM cloud_agent_fallback_runs candidate \
                 WHERE candidate.status = 'queued' \
                   AND (candidate.trigger_kind <> 'proactive' OR ( \
                       candidate.not_before_at IS NOT NULL \
                       AND candidate.not_before_at <= $3 \
                       AND EXISTS ( \
                           SELECT 1 FROM cloud_agent_definitions agent \
                           WHERE agent.agent_id = candidate.target_agent_id \
                             AND agent.owner_account_id = candidate.owner_account_id \
                             AND agent.status = 'active' \
                             AND agent.access_scope = 'participant_conversations' \
                             AND agent.is_system_managed = FALSE \
                             AND agent.proactive_enabled = TRUE \
                             AND agent.proactive_skill_pack = 'proact-v1' \
                       ) \
                   )) \
                 ORDER BY candidate.created_at ASC \
                 LIMIT 1 \
                 FOR UPDATE SKIP LOCKED \
             ) \
             RETURNING run.run_id, run.status, run.prompt, run.owner_account_id, run.requester_account_id, run.session_id, run.sandbox_id, run.response_message_id, run.error_code, run.error_message",
        )
        .bind(runner_id)
        .bind(&lease_expires_at)
        .bind(&now_text)
        .fetch_optional(pool)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let response = runner_response_from_row(pool, row).await?;
        if !cancel_if_ineligible(pool, &response.run_id, &response.trigger_kind).await? {
            return Ok(Some(response));
        }
    }
    Ok(None)
}

pub async fn lease_canary_run(
    pool: &PgPool,
    runner_id: &str,
    canary_run_id: &str,
) -> RunResult<Option<RunnerRunResponse>> {
    let now = Utc::now();
    let lease_expires_at = (now + chrono::Duration::seconds(120)).to_rfc3339();
    let row: Option<RunnerRunRow> = query_as(
        "UPDATE cloud_agent_fallback_runs AS run \
         SET status = 'leased', claimed_by = $1, lease_expires_at = $2, updated_at = $3 \
         WHERE run.run_id = $4 AND run.status = 'queued' \
           AND (run.trigger_kind <> 'proactive' OR ( \
               run.not_before_at IS NOT NULL \
               AND run.not_before_at <= $3 \
               AND EXISTS ( \
                   SELECT 1 FROM cloud_agent_definitions agent \
                   WHERE agent.agent_id = run.target_agent_id \
                     AND agent.owner_account_id = run.owner_account_id \
                     AND agent.status = 'active' \
                     AND agent.access_scope = 'participant_conversations' \
                     AND agent.is_system_managed = FALSE \
                     AND agent.proactive_enabled = TRUE \
                     AND agent.proactive_skill_pack = 'proact-v1' \
               ) \
           )) \
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id, session_id, sandbox_id, response_message_id, error_code, error_message",
    )
    .bind(runner_id)
    .bind(&lease_expires_at)
    .bind(now.to_rfc3339())
    .bind(canary_run_id)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let response = runner_response_from_row(pool, row).await?;
    if cancel_if_ineligible(pool, &response.run_id, &response.trigger_kind).await? {
        return Ok(None);
    }
    Ok(Some(response))
}

pub async fn mark_run_running(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
) -> RunResult<RunnerRunResponse> {
    let row: Option<RunnerRunRow> = query_as(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'running', updated_at = $3 \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running') \
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id, session_id, sandbox_id, response_message_id, error_code, error_message",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(Utc::now().to_rfc3339())
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Err(RunError::NotFound);
    };
    let response = runner_response_from_row(pool, row).await?;
    if cancel_if_ineligible(pool, &response.run_id, &response.trigger_kind).await? {
        return Err(RunError::NotFound);
    }
    Ok(response)
}

pub(crate) async fn runner_response_from_row(
    pool: &PgPool,
    row: RunnerRunRow,
) -> RunResult<RunnerRunResponse> {
    let provider_auth_key_id = EnvProviderAuthCipher::from_env()
        .ok()
        .map(|cipher| cipher.key_id().to_string());
    let provider_auth_available: Option<(String,)> = match provider_auth_key_id {
        Some(key_id) => {
            query_as(
                "SELECT snapshot_id FROM cloud_agent_provider_auth_snapshots \
             WHERE account_id = $1 AND encryption_key_id = $2 AND revoked_at IS NULL \
             ORDER BY created_at DESC LIMIT 1",
            )
            .bind(&row.3)
            .bind(key_id)
            .fetch_optional(pool)
            .await?
        }
        None => None,
    };
    let metadata: Option<(String, Option<String>, Option<String>)> = query_as(
        "SELECT trigger_kind, target_agent_id, proactive_skill_pack
         FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&row.0)
    .fetch_optional(pool)
    .await?;
    let (trigger_kind, target_agent_id, skill_pack) =
        metadata.unwrap_or_else(|| ("mention".to_string(), None, None));
    Ok(RunnerRunResponse {
        run_id: row.0,
        status: row.1,
        prompt: row.2,
        owner_account_id: row.3,
        requester_account_id: row.4,
        session_id: row.5,
        sandbox_id: row.6,
        provider_auth_available: provider_auth_available.is_some(),
        response_message_id: row.7,
        error_code: row.8,
        error_message: row.9,
        trigger_kind,
        target_agent_id,
        skill_pack,
    })
}
