//! Cloud fallback run claim DTOs and persistence workflow.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::cloud_agent_runtime::sandboxes::ensure_sandbox_for_run;

use super::prompt_history::fallback_prompt_for_claim;
use super::RunResult;

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
    #[serde(rename = "runtimeRoute")]
    pub runtime_route: Option<AgentRuntimeRoute>,
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct AgentRuntimeRoute {
    #[serde(rename = "defaultModel", skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(
        rename = "defaultAuthProvider",
        skip_serializing_if = "Option::is_none"
    )]
    pub default_auth_provider: Option<String>,
    #[serde(rename = "defaultAuthChoice", skip_serializing_if = "Option::is_none")]
    pub default_auth_choice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
}

impl AgentRuntimeRoute {
    pub(super) fn normalized(&self) -> Option<Self> {
        fn clean(value: &Option<String>, max_len: usize) -> Option<String> {
            value
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty() && value.len() <= max_len)
                .map(ToString::to_string)
        }
        let thinking = clean(&self.thinking, 32).filter(|value| {
            matches!(
                value.as_str(),
                "off" | "default" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
            )
        });
        let route = Self {
            default_model: clean(&self.default_model, 200),
            default_auth_provider: clean(&self.default_auth_provider, 100),
            default_auth_choice: clean(&self.default_auth_choice, 200),
            thinking,
        };
        (route.default_model.is_some()
            || route.default_auth_provider.is_some()
            || route.default_auth_choice.is_some()
            || route.thinking.is_some())
        .then_some(route)
    }
}

impl ClaimRunRequest {
    pub fn is_well_formed(&self) -> bool {
        !self.request_message_id.trim().is_empty()
            && !self.session_id.trim().is_empty()
            && !self.owner_account_id.trim().is_empty()
            && !self.requester_account_id.trim().is_empty()
            && !self.prompt.trim().is_empty()
            && self
                .runtime_route
                .as_ref()
                .is_none_or(|route| route.normalized().is_some())
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
    let runtime_route = serde_json::to_value(runtime_route_for_claim(pool, input).await?)
        .map_err(|error| sqlx_core::Error::Encode(Box::new(error)))?;
    let row: (String, String, Option<String>, String, String) = query_as(
        "INSERT INTO cloud_agent_fallback_runs (
            run_id, idempotency_key, request_message_id, session_id, owner_account_id,
            requester_account_id, status, prompt, sandbox_id, runtime_route_json, created_at, updated_at
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
    .bind(runtime_route)
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

async fn runtime_route_for_claim(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> Result<AgentRuntimeRoute, sqlx_core::Error> {
    if input.requester_account_id == input.owner_account_id {
        if let Some(route) = input
            .runtime_route
            .as_ref()
            .and_then(AgentRuntimeRoute::normalized)
        {
            return Ok(route);
        }
    }
    let Some(target) =
        super::authorization::shared_cloud_agent_target_for_claim(pool, input).await?
    else {
        return Ok(AgentRuntimeRoute::default());
    };
    let row: Option<(serde_json::Value,)> = query_as(
        "SELECT model_routing_json FROM cloud_agent_definitions
         WHERE agent_id = $1 AND owner_account_id = $2 AND status = 'active' LIMIT 1",
    )
    .bind(&target.agent_id)
    .bind(&target.owner_account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row
        .and_then(|(value,)| serde_json::from_value::<AgentRuntimeRoute>(value).ok())
        .and_then(|route| route.normalized())
        .unwrap_or_default())
}
