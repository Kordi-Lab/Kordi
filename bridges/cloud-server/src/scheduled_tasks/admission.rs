//! Conversation admission for scheduled cloud runs.

use chrono::{DateTime, Utc};
use sqlx_postgres::PgPool;

use crate::cloud_agent_runtime::runs::{claim_conversation_admits_run, ClaimRunRequest, RunError};
use crate::scheduled_tasks::models::ScheduledTaskRunResponse;
use crate::scheduled_tasks::store::mark_scheduled_task_run_failed;

const SESSION_UNAVAILABLE: &str = "session_unavailable";
const SESSION_UNAVAILABLE_MESSAGE: &str =
    "The conversation for this task is not available to its owner.";
const PROJECT_MAC_REQUIRED: &str = "project_mac_required";
const PROJECT_MAC_REQUIRED_MESSAGE: &str =
    "The conversation for this task is in a project on a Mac, so Kordi Cloud cannot run it.";
const CONTEXT_UNAVAILABLE: &str = "context_unavailable";

/// A scheduled run reads the conversation its task names, under the same
/// membership rule as an interactive claim. A conversation in a project on
/// the owner's Mac never runs in the cloud. A refused run is recorded as
/// failed instead of failing the due batch, so other tasks still start.
pub(super) async fn admit_scheduled_run(
    pool: &PgPool,
    claim: &ClaimRunRequest,
    run: &mut ScheduledTaskRunResponse,
    now: DateTime<Utc>,
) -> Result<bool, sqlx_core::Error> {
    if !claim_conversation_admits_run(pool, claim)
        .await
        .map_err(RunError::into_persistence_error)?
    {
        record_failed_run(
            pool,
            run,
            SESSION_UNAVAILABLE,
            SESSION_UNAVAILABLE_MESSAGE,
            now,
        )
        .await?;
        return Ok(false);
    }
    if crate::projects::session_device(pool, &claim.owner_account_id, &claim.session_id)
        .await?
        .is_some()
    {
        record_failed_run(
            pool,
            run,
            PROJECT_MAC_REQUIRED,
            PROJECT_MAC_REQUIRED_MESSAGE,
            now,
        )
        .await?;
        return Ok(false);
    }
    Ok(true)
}

/// Records a claim the run domain refused, for example a conversation that
/// joined a project after admission, as a failed run. Only a persistence
/// failure is returned as an error.
pub(super) async fn record_refused_claim(
    pool: &PgPool,
    run: &mut ScheduledTaskRunResponse,
    refusal: RunError,
    now: DateTime<Utc>,
) -> Result<(), sqlx_core::Error> {
    match refusal {
        RunError::Persistence(error) => Err(error),
        RunError::ContextUnavailable(message) => {
            record_failed_run(pool, run, CONTEXT_UNAVAILABLE, message, now).await
        }
        RunError::NotFound => {
            record_failed_run(
                pool,
                run,
                SESSION_UNAVAILABLE,
                SESSION_UNAVAILABLE_MESSAGE,
                now,
            )
            .await
        }
    }
}

async fn record_failed_run(
    pool: &PgPool,
    run: &mut ScheduledTaskRunResponse,
    error_code: &str,
    error_message: &str,
    now: DateTime<Utc>,
) -> Result<(), sqlx_core::Error> {
    mark_scheduled_task_run_failed(pool, &run.run_id, error_code, error_message, now).await?;
    let completed_at = now.to_rfc3339();
    run.status = "failed".to_string();
    run.error_code = Some(error_code.to_string());
    run.error_message = Some(error_message.to_string());
    run.updated_at = completed_at.clone();
    run.completed_at = Some(completed_at);
    Ok(())
}
