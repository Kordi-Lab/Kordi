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
