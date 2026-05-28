use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx_core::query_as::query_as;

use crate::cloud_agent_runtime::sandboxes::ensure_sandbox_for_run;
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
    #[serde(rename = "sandboxId")]
    pub sandbox_id: Option<String>,
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

const CLOUD_AGENT_RESPONSE_PREFIX: &str = "kordi-cloud-agent-response:";
const MAX_CLOUD_FALLBACK_HISTORY_MESSAGES: i64 = 12;

#[derive(Debug, Clone)]
struct CloudFallbackHistoryMessage {
    from_account_id: String,
    body: String,
}

fn strip_leading_agent_mention(text: &str) -> String {
    let trimmed = text.trim();
    if !trimmed.starts_with('@') {
        return trimmed.to_string();
    }
    let Some((_, rest)) = trimmed.split_once(char::is_whitespace) else {
        return trimmed.to_string();
    };
    rest.trim().to_string()
}

fn cloud_agent_response_text(body: &str) -> Option<String> {
    let encoded = body.trim().strip_prefix(CLOUD_AGENT_RESPONSE_PREFIX)?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value
        .get("text")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

fn fallback_prompt_history_line(
    requester_account_id: &str,
    owner_account_id: &str,
    message: &CloudFallbackHistoryMessage,
) -> Option<String> {
    let (label, text) = if let Some(text) = cloud_agent_response_text(&message.body) {
        ("Owner's Kordi", text)
    } else if message.from_account_id == requester_account_id {
        ("Requester", strip_leading_agent_mention(&message.body))
    } else if message.from_account_id == owner_account_id {
        ("Owner", message.body.trim().to_string())
    } else {
        return None;
    };
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some(format!("{label}: {text}"))
}

fn fallback_prompt_with_history(
    requester_account_id: &str,
    owner_account_id: &str,
    current_prompt: &str,
    history: &[CloudFallbackHistoryMessage],
) -> String {
    let current_prompt = current_prompt.trim();
    let lines = history
        .iter()
        .filter_map(|message| {
            fallback_prompt_history_line(requester_account_id, owner_account_id, message)
        })
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return current_prompt.to_string();
    }
    format!(
        "Conversation history:\n{}\n\nCurrent request:\n{}",
        lines.join("\n"),
        current_prompt
    )
}

async fn fallback_prompt_for_claim(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> Result<String, sqlx_core::Error> {
    let Some((request_created_at,)) = query_as::<_, (String,)>(
        "SELECT created_at FROM cloud_messages WHERE message_id = $1 AND session_id = $2",
    )
    .bind(&input.request_message_id)
    .bind(&input.session_id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(input.prompt.trim().to_string());
    };

    let mut history = query_as::<_, (String, String)>(
        "SELECT from_account_id, body FROM cloud_messages \
         WHERE session_id = $1 AND created_at < $2 \
         ORDER BY created_at DESC LIMIT $3",
    )
    .bind(&input.session_id)
    .bind(&request_created_at)
    .bind(MAX_CLOUD_FALLBACK_HISTORY_MESSAGES)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(from_account_id, body)| CloudFallbackHistoryMessage {
        from_account_id,
        body,
    })
    .collect::<Vec<_>>();
    history.reverse();

    Ok(fallback_prompt_with_history(
        &input.requester_account_id,
        &input.owner_account_id,
        &input.prompt,
        &history,
    ))
}

pub async fn claim_run(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> Result<CloudAgentRunResponse, sqlx_core::Error> {
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
            requester_account_id, status, prompt, sandbox_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9, $9)
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

#[cfg(test)]
mod tests {
    use super::ClaimRunRequest;

    #[test]
    fn runner_request_accepts_optional_canary_run_id() {
        let request = super::RunnerRunRequest {
            runner_id: "runner-a".to_string(),
            canary_run_id: Some(" car_canary ".to_string()),
        };
        assert_eq!(request.canary_run_id().as_deref(), Some("car_canary"));

        let empty = super::RunnerRunRequest {
            runner_id: "runner-a".to_string(),
            canary_run_id: Some(" ".to_string()),
        };
        assert_eq!(empty.canary_run_id(), None);
    }

    #[test]
    fn fallback_prompt_includes_prior_direct_chat_history() {
        let prompt = super::fallback_prompt_with_history(
            "acct_requester",
            "acct_owner",
            "check ahain",
            &[
                super::CloudFallbackHistoryMessage {
                    from_account_id: "acct_requester".to_string(),
                    body: "@111sKordi what is xuzhu city weather".to_string(),
                },
                super::CloudFallbackHistoryMessage {
                    from_account_id: "acct_owner".to_string(),
                    body: super::encode_cloud_agent_response_body(
                        "msg_weather",
                        "I think you mean Xuzhou city, China.",
                    ),
                },
            ],
        );

        assert!(prompt.contains("Conversation history:\nRequester: what is xuzhu city weather"));
        assert!(prompt.contains("Owner's Kordi: I think you mean Xuzhou city, China."));
        assert!(prompt.ends_with("Current request:\ncheck ahain"));
    }

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
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id, session_id, sandbox_id, response_message_id, error_code, error_message",
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

pub async fn lease_canary_run(
    pool: &PgPool,
    runner_id: &str,
    canary_run_id: &str,
) -> Result<Option<RunnerRunResponse>, sqlx_core::Error> {
    let now = Utc::now();
    let lease_expires_at = (now + chrono::Duration::seconds(120)).to_rfc3339();
    let row: Option<RunnerRunRow> = query_as(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'leased', claimed_by = $1, lease_expires_at = $2, updated_at = $3 \
         WHERE run_id = $4 AND status = 'queued' \
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
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id, session_id, sandbox_id, response_message_id, error_code, error_message",
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

fn encode_cloud_agent_response_body_with_state(
    request_message_id: &str,
    response_text: &str,
    delivery_state: &str,
) -> String {
    let envelope = serde_json::json!({
        "kind": "agent-response",
        "requestId": request_message_id,
        "text": response_text,
        "deliveryState": delivery_state,
    });
    format!(
        "{}{}",
        CLOUD_AGENT_RESPONSE_PREFIX,
        URL_SAFE_NO_PAD.encode(envelope.to_string())
    )
}

pub fn encode_cloud_agent_response_body(request_message_id: &str, response_text: &str) -> String {
    encode_cloud_agent_response_body_with_state(request_message_id, response_text, "complete")
}

fn cloud_agent_failure_response_text(error_code: &str) -> &'static str {
    match error_code {
        "missing_provider_auth" => "No provider configured yet.",
        "model_provider_error" => "Cloud fallback could not complete this request because the configured provider/model failed.",
        "sandbox_error" => "Cloud fallback could not complete this request because the sandbox failed.",
        _ => "Cloud fallback could not complete this request.",
    }
}

fn encode_failed_cloud_agent_response_body(request_message_id: &str, error_code: &str) -> String {
    encode_cloud_agent_response_body_with_state(
        request_message_id,
        cloud_agent_failure_response_text(error_code),
        "failed",
    )
}

pub async fn complete_run(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    response_text: &str,
) -> Result<Option<RunnerRunResponse>, sqlx_core::Error> {
    let trimmed = response_text.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let existing: Option<(String, String, String, String, String, Option<String>)> = query_as(
        "SELECT owner_account_id, requester_account_id, session_id, request_message_id, status, response_message_id \
         FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await?;
    let Some((
        owner_account_id,
        requester_account_id,
        session_id,
        request_message_id,
        _status,
        _message_id,
    )) = existing
    else {
        return Ok(None);
    };
    let response_body = encode_cloud_agent_response_body(&request_message_id, trimmed);
    let response_message_id = crate::cloud_agent_runtime::artifacts::ensure_response_message(
        pool,
        run_id,
        &owner_account_id,
        &requester_account_id,
        &session_id,
        &response_body,
    )
    .await?;
    crate::cloud_agent_runtime::artifacts::update_response_message_body(
        pool,
        &response_message_id,
        &response_body,
    )
    .await?;
    let now = Utc::now().to_rfc3339();
    let row: Option<RunnerRunRow> = query_as(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'completed', response_message_id = $3, \
             error_code = NULL, error_message = NULL, updated_at = $4, completed_at = $4 \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running') \
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id, session_id, sandbox_id, response_message_id, error_code, error_message",
    )
    .bind(run_id)
    .bind(runner_id)
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
    let existing: Option<(String, String, String, String, Option<String>)> = query_as(
        "SELECT owner_account_id, requester_account_id, session_id, request_message_id, response_message_id \
         FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await?;
    let Some((owner_account_id, requester_account_id, session_id, request_message_id, _message_id)) =
        existing
    else {
        return Ok(None);
    };
    let response_body = encode_failed_cloud_agent_response_body(&request_message_id, error_code);
    let response_message_id = crate::cloud_agent_runtime::artifacts::ensure_response_message(
        pool,
        run_id,
        &owner_account_id,
        &requester_account_id,
        &session_id,
        &response_body,
    )
    .await?;
    crate::cloud_agent_runtime::artifacts::update_response_message_body(
        pool,
        &response_message_id,
        &response_body,
    )
    .await?;
    let row: Option<RunnerRunRow> = query_as(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'failed', response_message_id = $5, error_code = $3, error_message = $4, updated_at = $6, completed_at = $6 \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running') \
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id, session_id, sandbox_id, response_message_id, error_code, error_message",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(error_code)
    .bind(message)
    .bind(response_message_id)
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
        sandbox_id: row.6,
        provider_auth_available: provider_auth_available.is_some(),
        response_message_id: row.7,
        error_code: row.8,
        error_message: row.9,
    })
}
