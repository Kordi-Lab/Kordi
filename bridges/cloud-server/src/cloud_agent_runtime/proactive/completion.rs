use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use crate::cloud_agent_runtime::runs::{
    runner_response_from_row, RunError, RunResult, RunnerRunResponse, RunnerRunRow,
};

use super::ModelDecision;

pub async fn finish_without_message(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    status: &str,
    decision: Option<&ModelDecision>,
    error_code: Option<&str>,
    error_message: Option<&str>,
) -> RunResult<RunnerRunResponse> {
    let now = chrono::Utc::now().to_rfc3339();
    let row: Option<RunnerRunRow> = query_as(
        "UPDATE cloud_agent_fallback_runs
         SET status = $3,
             response_message_id = NULL,
             proactive_decision = $4,
             proactive_breakdown = $5,
             proactive_selected_skill = $6,
             proactive_evidence_message_ids_json = $7,
             error_code = $8,
             error_message = $9,
             updated_at = $10,
             completed_at = $10
         WHERE run_id = $1
           AND claimed_by = $2
           AND trigger_kind = 'proactive'
           AND status IN ('leased', 'running')
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id,
             session_id, sandbox_id, response_message_id, error_code, error_message",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(status)
    .bind(decision.map(|value| {
        if value.action == "intervene" {
            "intervention"
        } else {
            value.action.as_str()
        }
    }))
    .bind(decision.map(|value| value.breakdown.as_str()))
    .bind(decision.map(|value| value.selected_skill.as_str()))
    .bind(serde_json::json!(decision
        .map(|value| value.evidence_message_ids.clone())
        .unwrap_or_default()))
    .bind(error_code)
    .bind(error_message)
    .bind(&now)
    .fetch_optional(pool)
    .await?;
    match row {
        Some(row) => runner_response_from_row(pool, row).await,
        None => Err(RunError::NotFound),
    }
}
