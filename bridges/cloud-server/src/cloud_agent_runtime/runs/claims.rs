//! Cloud fallback run claim DTOs and persistence workflow.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::cloud_agent_runtime::sandboxes::ensure_sandbox_for_run;

use super::prompt_history::fallback_prompt_for_claim;
use super::RunResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderAuthSource {
    OwnerSnapshot,
    SupportService,
}

impl ProviderAuthSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::OwnerSnapshot => "owner_snapshot",
            Self::SupportService => "support_service",
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct ClaimRunRequest {
    #[serde(rename = "requestMessageId")]
    pub request_message_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "ownerAccountId")]
    pub owner_account_id: String,
    #[serde(rename = "requesterAccountId")]
    pub requester_account_id: String,
    pub prompt: String,
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: String,
}

impl ClaimRunRequest {
    pub fn is_well_formed(&self) -> bool {
        !self.request_message_id.trim().is_empty()
            && !self.session_id.trim().is_empty()
            && !self.owner_account_id.trim().is_empty()
            && !self.requester_account_id.trim().is_empty()
            && !self.prompt.trim().is_empty()
            && !self.idempotency_key.trim().is_empty()
    }
}

#[derive(Debug, Serialize)]
pub struct CloudAgentRunResponse {
    #[serde(rename = "runId")]
    pub run_id: String,
    pub status: String,
    #[serde(rename = "sandboxId")]
    pub sandbox_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct CloudAgentRunLookupResponse {
    pub run: Option<CloudAgentRunResponse>,
}

pub async fn lookup_run_for_request(
    pool: &PgPool,
    request_message_id: &str,
    account_id: &str,
) -> RunResult<CloudAgentRunLookupResponse> {
    let row: Option<(String, String, Option<String>, String, String)> = query_as(
        "SELECT run_id, status, sandbox_id, created_at, updated_at \
         FROM cloud_agent_fallback_runs \
         WHERE request_message_id = $1 AND (owner_account_id = $2 OR requester_account_id = $2) \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(request_message_id)
    .bind(account_id)
    .fetch_optional(pool)
    .await?;

    Ok(CloudAgentRunLookupResponse {
        run: row.map(|row| CloudAgentRunResponse {
            run_id: row.0,
            status: row.1,
            sandbox_id: row.2,
            created_at: row.3,
            updated_at: row.4,
        }),
    })
}

pub async fn claim_run(pool: &PgPool, input: &ClaimRunRequest) -> RunResult<CloudAgentRunResponse> {
    claim_run_with_provider_auth_source(pool, input, ProviderAuthSource::OwnerSnapshot).await
}

pub(crate) async fn claim_run_with_provider_auth_source(
    pool: &PgPool,
    input: &ClaimRunRequest,
    provider_auth_source: ProviderAuthSource,
) -> RunResult<CloudAgentRunResponse> {
    let existing: Option<(String, String, Option<String>, String, String)> = query_as(
        "SELECT run_id, status, sandbox_id, created_at, updated_at \
         FROM cloud_agent_fallback_runs WHERE idempotency_key = $1",
    )
    .bind(&input.idempotency_key)
    .fetch_optional(pool)
    .await?;
    if let Some(row) = existing {
        return Ok(CloudAgentRunResponse {
            run_id: row.0,
            status: row.1,
            sandbox_id: row.2,
            created_at: row.3,
            updated_at: row.4,
        });
    }

    let now = Utc::now().to_rfc3339();
    let sandbox = ensure_sandbox_for_run(
        pool,
        &input.session_id,
        &input.owner_account_id,
        &input.requester_account_id,
    )
    .await?;
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let prompt = fallback_prompt_for_claim(pool, input).await?;
    let row: (String, String, Option<String>, String, String) = query_as(
        "INSERT INTO cloud_agent_fallback_runs (
            run_id, idempotency_key, request_message_id, session_id, owner_account_id,
            requester_account_id, status, prompt, sandbox_id, provider_auth_source,
            created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9, $10, $10)
         ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = cloud_agent_fallback_runs.idempotency_key
         RETURNING run_id, status, sandbox_id, created_at, updated_at",
    )
    .bind(&run_id)
    .bind(&input.idempotency_key)
    .bind(&input.request_message_id)
    .bind(&input.session_id)
    .bind(&input.owner_account_id)
    .bind(&input.requester_account_id)
    .bind(&prompt)
    .bind(&sandbox.sandbox_id)
    .bind(provider_auth_source.as_str())
    .bind(&now)
    .fetch_one(pool)
    .await?;

    Ok(CloudAgentRunResponse {
        run_id: row.0,
        status: row.1,
        sandbox_id: row.2,
        created_at: row.3,
        updated_at: row.4,
    })
}
