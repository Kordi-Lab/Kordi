use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

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
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

pub async fn requester_can_target_owner(
    pool: &PgPool,
    requester_account_id: &str,
    owner_account_id: &str,
) -> Result<bool, sqlx_core::Error> {
    if requester_account_id == owner_account_id {
        return Ok(true);
    }
    let row: Option<(String,)> = query_as(
        "SELECT peer_account_id FROM cloud_contacts WHERE account_id = $1 AND peer_account_id = $2 LIMIT 1",
    )
    .bind(requester_account_id)
    .bind(owner_account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

pub async fn claim_run(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> Result<CloudAgentRunResponse, sqlx_core::Error> {
    let now = Utc::now().to_rfc3339();
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let row: (String, String, String, String) = query_as(
        "INSERT INTO cloud_agent_fallback_runs (
            run_id, idempotency_key, request_message_id, session_id, owner_account_id,
            requester_account_id, status, prompt, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $8)
         ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = cloud_agent_fallback_runs.idempotency_key
         RETURNING run_id, status, created_at, updated_at",
    )
    .bind(&run_id)
    .bind(&input.idempotency_key)
    .bind(&input.request_message_id)
    .bind(&input.session_id)
    .bind(&input.owner_account_id)
    .bind(&input.requester_account_id)
    .bind(&input.prompt)
    .bind(&now)
    .fetch_one(pool)
    .await?;

    Ok(CloudAgentRunResponse {
        run_id: row.0,
        status: row.1,
        created_at: row.2,
        updated_at: row.3,
    })
}

#[cfg(test)]
mod tests {
    use super::ClaimRunRequest;

    #[test]
    fn claim_request_rejects_empty_required_fields() {
        let valid = ClaimRunRequest {
            request_message_id: "msg_1".to_string(),
            session_id: "session:direct-person:a:b".to_string(),
            owner_account_id: "acct_owner".to_string(),
            requester_account_id: "acct_requester".to_string(),
            prompt: "@OwnerKordi hello".to_string(),
            idempotency_key: "session:msg:owner".to_string(),
        };
        assert!(valid.is_well_formed());

        let invalid = ClaimRunRequest {
            prompt: " ".to_string(),
            ..valid
        };
        assert!(!invalid.is_well_formed());
    }
}

#[derive(Debug, Deserialize)]
pub struct RunnerRunRequest {
    #[serde(rename = "runnerId")]
    pub runner_id: String,
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
}

#[derive(Debug, Deserialize)]
pub struct CompleteRunRequest {
    #[serde(rename = "runnerId")]
    pub runner_id: String,
    #[serde(rename = "responseText")]
    pub response_text: String,
}

impl CompleteRunRequest {
    pub fn runner_id(&self) -> Option<String> {
        let trimmed = self.runner_id.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct FailRunRequest {
    #[serde(rename = "runnerId")]
    pub runner_id: String,
    #[serde(rename = "errorCode")]
    pub error_code: String,
    pub message: String,
}

impl FailRunRequest {
    pub fn runner_id(&self) -> Option<String> {
        let trimmed = self.runner_id.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    pub fn error_code(&self) -> String {
        let trimmed = self.error_code.trim();
        if trimmed.is_empty() {
            "runner_error".to_string()
        } else {
            trimmed.to_string()
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
    #[serde(rename = "providerAuthAvailable")]
    pub provider_auth_available: bool,
    #[serde(rename = "responseMessageId")]
    pub response_message_id: Option<String>,
    #[serde(rename = "errorCode")]
    pub error_code: Option<String>,
    #[serde(rename = "errorMessage")]
    pub error_message: Option<String>,
}

pub async fn lease_next_run(
    pool: &PgPool,
    runner_id: &str,
) -> Result<Option<RunnerRunResponse>, sqlx_core::Error> {
    let now = Utc::now();
    let lease_expires_at = (now + chrono::Duration::seconds(120)).to_rfc3339();
    let row: Option<RunnerRunRow> = query_as(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'leased', claimed_by = $1, lease_expires_at = $2, updated_at = $3 \
         WHERE run_id = ( \
             SELECT run_id FROM cloud_agent_fallback_runs \
             WHERE status = 'queued' \
             ORDER BY created_at ASC \
             LIMIT 1 \
             FOR UPDATE SKIP LOCKED \
         ) \
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id, session_id, response_message_id, error_code, error_message",
    )
    .bind(runner_id)
    .bind(&lease_expires_at)
    .bind(now.to_rfc3339())
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    runner_response_from_row(pool, row).await.map(Some)
}

pub async fn mark_run_running(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
) -> Result<Option<RunnerRunResponse>, sqlx_core::Error> {
    let row: Option<RunnerRunRow> = query_as(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'running', updated_at = $3 \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running') \
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id, session_id, response_message_id, error_code, error_message",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(Utc::now().to_rfc3339())
    .fetch_optional(pool)
    .await?;
    match row {
        Some(row) => runner_response_from_row(pool, row).await.map(Some),
        None => Ok(None),
    }
}

pub async fn complete_run(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    response_text: &str,
) -> Result<Option<RunnerRunResponse>, sqlx_core::Error> {
    let now = Utc::now().to_rfc3339();
    let response_message_id = format!("cloudrunmsg_{}", Uuid::new_v4().simple());
    let row: Option<RunnerRunRow> = query_as(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'completed', response_message_id = COALESCE(response_message_id, $4), \
             error_code = NULL, error_message = NULL, updated_at = $5, completed_at = $5 \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running') AND $3 <> '' \
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id, session_id, response_message_id, error_code, error_message",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(response_text.trim())
    .bind(response_message_id)
    .bind(now)
    .fetch_optional(pool)
    .await?;
    match row {
        Some(row) => runner_response_from_row(pool, row).await.map(Some),
        None => Ok(None),
    }
}

pub async fn fail_run(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    error_code: &str,
    message: &str,
) -> Result<Option<RunnerRunResponse>, sqlx_core::Error> {
    let row: Option<RunnerRunRow> = query_as(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'failed', error_code = $3, error_message = $4, updated_at = $5, completed_at = $5 \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running') \
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id, session_id, response_message_id, error_code, error_message",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(error_code)
    .bind(message)
    .bind(Utc::now().to_rfc3339())
    .fetch_optional(pool)
    .await?;
    match row {
        Some(row) => runner_response_from_row(pool, row).await.map(Some),
        None => Ok(None),
    }
}

type RunnerRunRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);

async fn runner_response_from_row(
    pool: &PgPool,
    row: RunnerRunRow,
) -> Result<RunnerRunResponse, sqlx_core::Error> {
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
        owner_account_id: row.3,
        requester_account_id: row.4,
        session_id: row.5,
        provider_auth_available: provider_auth_available.is_some(),
        response_message_id: row.6,
        error_code: row.7,
        error_message: row.8,
    })
}
