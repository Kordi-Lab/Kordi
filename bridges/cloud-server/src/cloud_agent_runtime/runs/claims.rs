//! Cloud fallback run claim DTOs and persistence workflow.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::cloud_agent_runtime::sandboxes::ensure_sandbox_for_run;

use super::prompt_history::fallback_prompt_for_claim;
use super::{RunError, RunResult};

type ClaimRunRow = (
    String,
    String,
    Option<String>,
    String,
    String,
    String,
    String,
    String,
    String,
);

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

pub async fn cancel_run_for_request(
    pool: &PgPool,
    request_message_id: &str,
    account_id: &str,
) -> RunResult<CloudAgentRunLookupResponse> {
    let mut tx = pool.begin().await?;
    let existing: Option<(String, String, Option<String>, String, String)> = query_as(
        "SELECT run_id, status, sandbox_id, created_at, updated_at \
         FROM cloud_agent_fallback_runs \
         WHERE request_message_id = $1 \
           AND (owner_account_id = $2 OR requester_account_id = $2) \
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    )
    .bind(request_message_id)
    .bind(account_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(existing) = existing else {
        tx.commit().await?;
        return Ok(CloudAgentRunLookupResponse { run: None });
    };
    let row = if matches!(existing.1.as_str(), "queued" | "leased" | "running") {
        let now = Utc::now().to_rfc3339();
        let row = query_as(
            "UPDATE cloud_agent_fallback_runs \
             SET status = 'cancelled', updated_at = $2, completed_at = $2, \
                 lease_expires_at = NULL \
             WHERE run_id = $1 \
             RETURNING run_id, status, sandbox_id, created_at, updated_at",
        )
        .bind(&existing.0)
        .bind(&now)
        .fetch_one(&mut *tx)
        .await?;
        if request_message_id.starts_with("scheduled_run_") {
            sqlx_core::query::query(
                "UPDATE scheduled_tool_task_runs \
                 SET status = 'cancelled', updated_at = $2, completed_at = $2 \
                 WHERE run_id = $1 AND status IN ('queued', 'leased', 'running')",
            )
            .bind(request_message_id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        row
    } else {
        existing
    };
    tx.commit().await?;
    Ok(CloudAgentRunLookupResponse {
        run: Some(CloudAgentRunResponse {
            run_id: row.0,
            status: row.1,
            sandbox_id: row.2,
            created_at: row.3,
            updated_at: row.4,
        }),
    })
}

pub async fn claim_run(pool: &PgPool, input: &ClaimRunRequest) -> RunResult<CloudAgentRunResponse> {
    let existing: Option<ClaimRunRow> = query_as(
        "SELECT run_id, status, sandbox_id, created_at, updated_at, request_message_id, \
                session_id, owner_account_id, requester_account_id \
         FROM cloud_agent_fallback_runs WHERE idempotency_key = $1",
    )
    .bind(&input.idempotency_key)
    .fetch_optional(pool)
    .await?;
    if let Some(row) = existing {
        return claim_run_response(input, row);
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
    let row: ClaimRunRow = query_as(
        "INSERT INTO cloud_agent_fallback_runs (
            run_id, idempotency_key, request_message_id, session_id, owner_account_id,
            requester_account_id, status, prompt, sandbox_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9, $9)
         ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = cloud_agent_fallback_runs.idempotency_key
         RETURNING run_id, status, sandbox_id, created_at, updated_at, request_message_id, \
                   session_id, owner_account_id, requester_account_id",
    )
    .bind(&run_id)
    .bind(&input.idempotency_key)
    .bind(&input.request_message_id)
    .bind(&input.session_id)
    .bind(&input.owner_account_id)
    .bind(&input.requester_account_id)
    .bind(&prompt)
    .bind(&sandbox.sandbox_id)
    .bind(&now)
    .fetch_one(pool)
    .await?;

    claim_run_response(input, row)
}

fn claim_run_response(
    input: &ClaimRunRequest,
    row: ClaimRunRow,
) -> RunResult<CloudAgentRunResponse> {
    if row.5 != input.request_message_id
        || row.6 != input.session_id
        || row.7 != input.owner_account_id
        || row.8 != input.requester_account_id
    {
        return Err(RunError::IdempotencyConflict);
    }
    Ok(CloudAgentRunResponse {
        run_id: row.0,
        status: row.1,
        sandbox_id: row.2,
        created_at: row.3,
        updated_at: row.4,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idempotency_key_cannot_change_the_bound_request_identity() {
        let input = ClaimRunRequest {
            request_message_id: "request-a".to_string(),
            session_id: "session-a".to_string(),
            owner_account_id: "owner-a".to_string(),
            requester_account_id: "requester-a".to_string(),
            prompt: "help".to_string(),
            idempotency_key: "stable-key".to_string(),
        };
        let row = (
            "run-a".to_string(),
            "queued".to_string(),
            None,
            "created".to_string(),
            "updated".to_string(),
            "request-b".to_string(),
            input.session_id.clone(),
            input.owner_account_id.clone(),
            input.requester_account_id.clone(),
        );
        assert!(matches!(
            claim_run_response(&input, row),
            Err(RunError::IdempotencyConflict)
        ));
    }
}
