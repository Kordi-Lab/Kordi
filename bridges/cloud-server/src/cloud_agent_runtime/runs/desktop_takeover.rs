//! Mac-first routing for a run that is already queued.
//!
//! A person's request admitted while the owner's Mac is ready waits in
//! `queued` with `desktop_preferred_until` set: the cloud runner skips it
//! until then. The Mac takes it with [`take`]; when no Mac does, the runner
//! leases it once the window ends. Both move the row out of `queued` with a
//! conditional update, so exactly one of them runs it.

use chrono::Utc;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::claims::runtime_route_for_claim;
use super::{ClaimRunRequest, CloudAgentRunResponse, RunResult};

/// Seconds a desktop claim holds the run before it must renew.
const DESKTOP_LEASE_SECONDS: i64 = 45;

pub(super) async fn existing_run_id(
    pool: &PgPool,
    input: &ClaimRunRequest,
    agent_id: &str,
) -> RunResult<Option<String>> {
    let row: Option<(String,)> = query_as(
        "SELECT run_id FROM cloud_agent_fallback_runs \
         WHERE owner_account_id = $1 AND execution_agent_id = $2 AND request_message_id = $3 \
           AND NOT legacy_duplicate",
    )
    .bind(&input.owner_account_id)
    .bind(agent_id)
    .bind(&input.request_message_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(run_id,)| run_id))
}

pub(super) async fn run_response(pool: &PgPool, run_id: &str) -> RunResult<CloudAgentRunResponse> {
    let row: (String, String, Option<String>, String, String, String) = query_as(
        "SELECT run_id, status, sandbox_id, created_at, updated_at, execution_backend \
         FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await?;
    Ok(CloudAgentRunResponse {
        run_id: row.0,
        status: row.1,
        sandbox_id: row.2,
        created_at: row.3,
        updated_at: row.4,
        execution_backend: row.5,
    })
}

/// Moves a queued chat run to the claiming Mac. A run the cloud runner, a
/// stop request, or another claim already took is left as it is, and the
/// caller then reports `acquired: false`.
pub(super) async fn take(
    pool: &PgPool,
    run_id: &str,
    input: &ClaimRunRequest,
    executor: &str,
) -> RunResult<()> {
    let route = runtime_route_for_claim(pool, input).await?;
    let route =
        serde_json::to_value(route).map_err(|error| sqlx_core::Error::Encode(Box::new(error)))?;
    let now = Utc::now();
    query(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'leased', execution_backend = 'desktop', claimed_by = $2, \
             lease_expires_at = $3, desktop_preferred_until = NULL, runtime_route_json = $4, \
             updated_at = $5 \
         WHERE run_id = $1 AND status = 'queued' AND cancel_requested_at IS NULL \
           AND subsession_id IS NULL AND document_comment_id IS NULL AND NOT legacy_duplicate",
    )
    .bind(run_id)
    .bind(executor)
    .bind((now + chrono::Duration::seconds(DESKTOP_LEASE_SECONDS)).to_rfc3339())
    .bind(route)
    .bind(now.to_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}

/// Lets the cloud runner lease a run held for a Mac that is no longer ready.
pub(super) async fn release_to_cloud(pool: &PgPool, run_id: &str) -> RunResult<()> {
    query(
        "UPDATE cloud_agent_fallback_runs SET desktop_preferred_until = NULL, updated_at = $2 \
         WHERE run_id = $1 AND status = 'queued' AND desktop_preferred_until > now()",
    )
    .bind(run_id)
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}
