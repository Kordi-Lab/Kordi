//! Runs stop when their requester loses access to the agent.
//!
//! A run is admitted when it is claimed, but the requester and the agent's
//! owner can stop being contacts, or block each other, while it waits or
//! works. Leasing and finishing a run check again; a revoked run is cancelled
//! instead of delivered.

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::{ClaimRunRequest, RunResult};

/// The error code a run cancelled for lost access carries.
pub const RELATIONSHIP_REVOKED: &str = "relationship_revoked";

/// Whether the run's requester may still use the agent it runs. Runs the
/// owner asked for, subsession turns (checked by their own rules), and
/// digest and PiP runs always may.
pub(super) async fn requester_still_allowed(pool: &PgPool, run_id: &str) -> RunResult<bool> {
    if run_id.starts_with(crate::digest::RUN_PREFIX) || run_id.starts_with(crate::pip::RUN_PREFIX) {
        return Ok(true);
    }
    let row: Option<(String, String, String, String, bool)> = query_as(
        "SELECT session_id, request_message_id, owner_account_id, requester_account_id, \
                subsession_id IS NOT NULL \
         FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await?;
    let Some((session_id, request_message_id, owner, requester, subsession)) = row else {
        return Ok(true);
    };
    if requester == owner || subsession {
        return Ok(true);
    }
    super::requester_may_invoke(
        pool,
        &ClaimRunRequest {
            session_id,
            request_message_id,
            owner_account_id: owner,
            requester_account_id: requester,
            prompt: String::new(),
            runtime_route: None,
            idempotency_key: String::new(),
        },
    )
    .await
}

/// Cancels a run that has not finished because its requester lost access.
pub(super) async fn cancel_revoked_run(pool: &PgPool, run_id: &str) -> RunResult<()> {
    let now = Utc::now().to_rfc3339();
    query(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'cancelled', error_code = $2, completed_at = $3, updated_at = $3 \
         WHERE run_id = $1 AND status IN ('queued', 'leased', 'running')",
    )
    .bind(run_id)
    .bind(RELATIONSHIP_REVOKED)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}
