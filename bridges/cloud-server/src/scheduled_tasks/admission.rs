//! Conversation admission for scheduled cloud runs.

use chrono::{DateTime, Utc};
use sqlx_postgres::PgPool;

use crate::cloud_agent_runtime::runs::{claim_conversation_admits_run, ClaimRunRequest, RunError};
use crate::scheduled_tasks::models::ScheduledTaskRunResponse;
use crate::scheduled_tasks::store::mark_scheduled_task_run_failed;

const SESSION_UNAVAILABLE: &str = "session_unavailable";
const SESSION_UNAVAILABLE_MESSAGE: &str =
    "The conversation for this task is not available to its owner.";

/// A scheduled run reads the conversation its task names, under the same
/// membership rule as an interactive claim. A refused run is recorded as
/// failed instead of failing the due batch, so other tasks still start.
pub(super) async fn admit_scheduled_run(
    pool: &PgPool,
    claim: &ClaimRunRequest,
    run: &mut ScheduledTaskRunResponse,
    now: DateTime<Utc>,
) -> Result<bool, sqlx_core::Error> {
    if claim_conversation_admits_run(pool, claim)
        .await
        .map_err(RunError::into_persistence_error)?
    {
        return Ok(true);
    }
    mark_scheduled_task_run_failed(
        pool,
        &run.run_id,
        SESSION_UNAVAILABLE,
        SESSION_UNAVAILABLE_MESSAGE,
        now,
    )
    .await?;
    let completed_at = now.to_rfc3339();
    run.status = "failed".to_string();
    run.error_code = Some(SESSION_UNAVAILABLE.to_string());
    run.error_message = Some(SESSION_UNAVAILABLE_MESSAGE.to_string());
    run.updated_at = completed_at.clone();
    run.completed_at = Some(completed_at);
    Ok(false)
}
