//! Completion/failure DTOs and terminal Cloud run state transitions.

use chrono::Utc;
use serde::Deserialize;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use crate::cloud_agent_runtime::sync_events::{
    append_cloud_agent_response_sync_event, CloudAgentResponseSyncEvent,
};
use crate::scheduled_tasks::store::{
    mark_scheduled_task_run_completed, mark_scheduled_task_run_failed,
};

use super::delivery::{
    ensure_group_response_messages, ensure_scheduled_direct_person_response_message,
    is_scheduled_run_request_id, GroupResponse,
};
use super::envelopes::{
    encode_cloud_agent_response_body, encode_cloud_agent_response_body_with_state,
};
use super::leases::{runner_response_from_row, RunnerRunResponse, RunnerRunRow};
use super::{RunError, RunResult};

type FailedRunRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
);

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

fn cloud_agent_failure_response_text(error_code: &str, is_support_agent: bool) -> &'static str {
    match error_code {
        "missing_provider_auth" if is_support_agent => {
            "Kordi Support is temporarily unavailable. Try again shortly."
        }
        "missing_provider_auth" => "No provider configured yet.",
        "model_provider_error" => {
            "Cloud fallback could not complete this request because the configured provider/model failed."
        }
        "sandbox_error" => {
            "Cloud fallback could not complete this request because the sandbox failed."
        }
        _ => "Cloud fallback could not complete this request.",
    }
}

fn encode_failed_cloud_agent_response_body(
    request_message_id: &str,
    error_code: &str,
    is_support_agent: bool,
) -> String {
    encode_cloud_agent_response_body_with_state(
        request_message_id,
        cloud_agent_failure_response_text(error_code, is_support_agent),
        "failed",
    )
}

pub async fn complete_run(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    response_text: &str,
) -> RunResult<RunnerRunResponse> {
    let trimmed = response_text.trim();
    if trimmed.is_empty() {
        return Err(RunError::NotFound);
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
        return Err(RunError::NotFound);
    };
    let response_body = encode_cloud_agent_response_body(&request_message_id, trimmed);
    let mut direct_response_sync_event: Option<String> = None;
    let response_message_id = if is_scheduled_run_request_id(&request_message_id) {
        if let Some(message_id) = ensure_scheduled_direct_person_response_message(
            pool,
            run_id,
            &owner_account_id,
            &session_id,
            &response_body,
        )
        .await?
        {
            message_id
        } else if let Some(message_id) = ensure_group_response_messages(
            pool,
            GroupResponse {
                run_id,
                owner_account_id: &owner_account_id,
                session_id: &session_id,
                request_message_id: &request_message_id,
                response_text: trimmed,
                delivery_state: "complete",
            },
        )
        .await?
        {
            message_id
        } else {
            let message_id = crate::cloud_agent_runtime::artifacts::ensure_response_message(
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
                &message_id,
                &response_body,
            )
            .await?;
            direct_response_sync_event = Some(message_id.clone());
            message_id
        }
    } else if let Some(message_id) = ensure_group_response_messages(
        pool,
        GroupResponse {
            run_id,
            owner_account_id: &owner_account_id,
            session_id: &session_id,
            request_message_id: &request_message_id,
            response_text: trimmed,
            delivery_state: "complete",
        },
    )
    .await?
    {
        message_id
    } else {
        let message_id = crate::cloud_agent_runtime::artifacts::ensure_response_message(
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
            &message_id,
            &response_body,
        )
        .await?;
        direct_response_sync_event = Some(message_id.clone());
        message_id
    };
    if let Some(message_id) = direct_response_sync_event.as_deref() {
        append_cloud_agent_response_sync_event(
            pool,
            CloudAgentResponseSyncEvent {
                account_id: &requester_account_id,
                peer_account_id: &owner_account_id,
                message_id,
                from_account_id: &owner_account_id,
                to_account_id: &requester_account_id,
                body: &response_body,
                session_id: &session_id,
                created_at: &Utc::now().to_rfc3339(),
                direction: "incoming",
            },
        )
        .await?;
    }
    let now = Utc::now();
    let now_text = now.to_rfc3339();
    let row: Option<RunnerRunRow> = query_as(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'completed', response_message_id = $3, \
             error_code = NULL, error_message = NULL, updated_at = $4, completed_at = $4 \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running') \
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id, session_id, sandbox_id, response_message_id, error_code, error_message",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(&response_message_id)
    .bind(&now_text)
    .fetch_optional(pool)
    .await?;
    match row {
        Some(row) => {
            mark_scheduled_task_run_completed(pool, &request_message_id, &response_message_id, now)
                .await?;
            runner_response_from_row(pool, row).await
        }
        None => Err(RunError::NotFound),
    }
}

pub async fn fail_run(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    error_code: &str,
    message: &str,
    support_agent_id: Option<&str>,
) -> RunResult<RunnerRunResponse> {
    let existing: Option<FailedRunRow> = query_as(
        "SELECT owner_account_id, requester_account_id, session_id, request_message_id, response_message_id, target_agent_id \
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
        _message_id,
        target_agent_id,
    )) = existing
    else {
        return Err(RunError::NotFound);
    };
    let is_support_agent = support_agent_id
        .is_some_and(|support_agent_id| target_agent_id.as_deref() == Some(support_agent_id));
    let failure_text = cloud_agent_failure_response_text(error_code, is_support_agent);
    let response_body =
        encode_failed_cloud_agent_response_body(&request_message_id, error_code, is_support_agent);
    let mut direct_response_sync_event: Option<String> = None;
    let response_message_id = if is_scheduled_run_request_id(&request_message_id) {
        if let Some(message_id) = ensure_scheduled_direct_person_response_message(
            pool,
            run_id,
            &owner_account_id,
            &session_id,
            &response_body,
        )
        .await?
        {
            message_id
        } else if let Some(message_id) = ensure_group_response_messages(
            pool,
            GroupResponse {
                run_id,
                owner_account_id: &owner_account_id,
                session_id: &session_id,
                request_message_id: &request_message_id,
                response_text: failure_text,
                delivery_state: "failed",
            },
        )
        .await?
        {
            message_id
        } else {
            let message_id = crate::cloud_agent_runtime::artifacts::ensure_response_message(
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
                &message_id,
                &response_body,
            )
            .await?;
            direct_response_sync_event = Some(message_id.clone());
            message_id
        }
    } else if let Some(message_id) = ensure_group_response_messages(
        pool,
        GroupResponse {
            run_id,
            owner_account_id: &owner_account_id,
            session_id: &session_id,
            request_message_id: &request_message_id,
            response_text: failure_text,
            delivery_state: "failed",
        },
    )
    .await?
    {
        message_id
    } else {
        let message_id = crate::cloud_agent_runtime::artifacts::ensure_response_message(
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
            &message_id,
            &response_body,
        )
        .await?;
        direct_response_sync_event = Some(message_id.clone());
        message_id
    };
    if let Some(message_id) = direct_response_sync_event.as_deref() {
        append_cloud_agent_response_sync_event(
            pool,
            CloudAgentResponseSyncEvent {
                account_id: &requester_account_id,
                peer_account_id: &owner_account_id,
                message_id,
                from_account_id: &owner_account_id,
                to_account_id: &requester_account_id,
                body: &response_body,
                session_id: &session_id,
                created_at: &Utc::now().to_rfc3339(),
                direction: "incoming",
            },
        )
        .await?;
    }
    let now = Utc::now();
    let now_text = now.to_rfc3339();
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
    .bind(&response_message_id)
    .bind(&now_text)
    .fetch_optional(pool)
    .await?;
    match row {
        Some(row) => {
            mark_scheduled_task_run_failed(pool, &request_message_id, error_code, message, now)
                .await?;
            runner_response_from_row(pool, row).await
        }
        None => Err(RunError::NotFound),
    }
}

#[cfg(test)]
mod tests {
    use super::cloud_agent_failure_response_text;

    #[test]
    fn support_auth_failure_never_asks_the_user_to_configure_a_provider() {
        assert_eq!(
            cloud_agent_failure_response_text("missing_provider_auth", true),
            "Kordi Support is temporarily unavailable. Try again shortly."
        );
        assert_eq!(
            cloud_agent_failure_response_text("missing_provider_auth", false),
            "No provider configured yet."
        );
    }
}
