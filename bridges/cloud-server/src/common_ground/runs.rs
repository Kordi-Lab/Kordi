//! Background runs for Common ground. Every run belongs to the Kordi-operated
//! service account, so it uses the key of its organization's resource pool
//! rather than a member's own provider. Runs have no chat and no tools; the
//! runner answers each with one completion, and the server parses the reply.

use chrono::Utc;
use sqlx_core::{query::query, query_scalar::query_scalar, transaction::Transaction};
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use crate::resource_pools::usage::{self, Settlement};
use crate::resource_pools::{coverage, Feature};

/// Every Common ground run id starts with this.
pub const RUN_PREFIX: &str = "cg_";
pub(super) const CARD_PREFIX: &str = "cg_card_";
pub(super) const MATCH_PREFIX: &str = "cg_match_";
pub(super) const ROOM_PREFIX: &str = "cg_room_";
pub(super) const INTRO_PREFIX: &str = "cg_intro_";

pub(super) fn new_run_id(prefix: &str) -> String {
    format!("{prefix}{}", Uuid::new_v4().simple())
}

pub(super) struct NewRun<'a> {
    pub run_id: &'a str,
    /// The member the run works for.
    pub requester: &'a str,
    /// The conversation the run works in, if any. Its organization picks the
    /// resource pool.
    pub conversation_id: Option<Uuid>,
    /// The checked organization of the request that started the run
    /// (organization-requests.md). Without a conversation it picks the pool;
    /// background work names none and uses the requester's personal one.
    pub organization_id: Option<&'a str>,
    pub prompt: String,
    pub system_prompt: &'a str,
}

/// Queues a run in `tx` once the resource pool of its organization admits it,
/// counted for the requester. Returns false, queueing nothing and leaving
/// `tx` as it was, when the pool's daily limit is used up, the pool is
/// stopped, or the organization is disabled.
pub(super) async fn insert(
    tx: &mut Transaction<'_, Postgres>,
    service: &crate::system_agent::SystemAgentConfig,
    run: NewRun<'_>,
) -> sqlx_core::Result<bool> {
    let organization_id: Option<String> =
        match (run.conversation_id, run.organization_id) {
            (Some(conversation_id), _) => query_scalar(
                "SELECT organization_id FROM cloud_chat_conversations WHERE conversation_id = $1",
            )
            .bind(conversation_id)
            .fetch_optional(&mut **tx)
            .await?
            .flatten(),
            (None, Some(organization_id)) => Some(organization_id.to_string()),
            (None, None) => query_scalar(
                "SELECT organization_id FROM cloud_organizations WHERE personal_account_id = $1",
            )
            .bind(run.requester)
            .fetch_optional(&mut **tx)
            .await?,
        };
    let pools = service.resource_pools();
    // A disabled organization's work is refused outright.
    if !pools.admits(organization_id.as_deref()) {
        return Ok(false);
    }
    // A member's personal work may be covered by an organization's pool.
    let sightings = service.resource_pool_registry().worker_sightings();
    let pool = coverage::route(tx, &pools, sightings, organization_id.as_deref()).await?;
    let pool = &pool;
    let admission = usage::reserve(
        tx,
        &usage::Request {
            run_id: run.run_id,
            pool,
            feature: Feature::Grounding,
            scope_id: run.requester,
            organization_id: organization_id.as_deref(),
        },
    )
    .await?;
    if !admission.admitted() {
        return Ok(false);
    }
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_agent_fallback_runs (
             run_id, idempotency_key, request_message_id, session_id, owner_account_id,
             requester_account_id, status, prompt, system_prompt, runtime_route_json,
             created_at, updated_at, run_trigger, connector_audience, organization_id
         ) VALUES ($1, $1, $1, $2, $3, $4, 'queued', $5, $6, $7, $8, $8, 'background', 'owner_private', $9)",
    )
    .bind(run.run_id)
    .bind(format!("common-ground:{}", run.requester))
    .bind(&service.account_id)
    .bind(run.requester)
    .bind(run.prompt)
    .bind(run.system_prompt)
    .bind(pool.routing(Feature::Grounding))
    .bind(&now)
    .bind(organization_id.as_deref())
    .execute(&mut **tx)
    .await?;
    // A pool worker pool's run waits for that pool's own worker.
    crate::pool_workers::store::tag_run(tx, run.run_id, pool, Feature::Grounding).await?;
    Ok(true)
}

/// Marks a claimed run completed. Returns false when the run is no longer
/// this runner's (cancelled, expired or already finished).
pub(super) async fn mark_completed(
    tx: &mut Transaction<'_, Postgres>,
    run_id: &str,
    runner_id: &str,
) -> sqlx_core::Result<bool> {
    let changed = query(
        "UPDATE cloud_agent_fallback_runs SET status = 'completed', completed_at = $3, updated_at = $3
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut **tx)
    .await?;
    if changed.rows_affected() == 0 {
        return Ok(false);
    }
    usage::settle(tx, run_id, Settlement::Consumed).await?;
    Ok(true)
}

/// Marks an unfinished run failed. Returns false when the run is no longer
/// this runner's (re-leased, or already completed or failed).
pub(super) async fn mark_failed(
    tx: &mut Transaction<'_, Postgres>,
    run_id: &str,
    runner_id: Option<&str>,
    code: &str,
    message: &str,
) -> sqlx_core::Result<bool> {
    let changed = query(
        "UPDATE cloud_agent_fallback_runs SET status = 'failed', error_code = $3,
             error_message = $4, updated_at = $5
         WHERE run_id = $1 AND ($2::text IS NULL OR claimed_by = $2)
           AND status IN ('queued', 'leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(code)
    .bind(message)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut **tx)
    .await?;
    if changed.rows_affected() == 0 {
        return Ok(false);
    }
    usage::settle_ended_run(tx, run_id).await?;
    Ok(true)
}

/// Stores a finished run's reply with the feature that queued it.
pub async fn complete(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    text: &str,
) -> sqlx_core::Result<()> {
    if run_id.starts_with(CARD_PREFIX) {
        super::build::complete(pool, run_id, runner_id, text).await
    } else if run_id.starts_with(INTRO_PREFIX) {
        super::intro::complete(pool, run_id, runner_id, text).await
    } else if run_id.starts_with(super::nearby::NEED_PREFIX) {
        super::nearby::complete_check(pool, run_id, runner_id, text).await
    } else {
        super::matching::complete(pool, run_id, runner_id, text).await
    }
}

pub async fn fail(
    pool: &PgPool,
    run_id: &str,
    runner_id: Option<&str>,
    code: &str,
) -> sqlx_core::Result<()> {
    if run_id.starts_with(CARD_PREFIX) {
        super::build::fail(pool, run_id, runner_id, code).await
    } else if run_id.starts_with(INTRO_PREFIX) {
        super::intro::fail(pool, run_id, runner_id, code).await
    } else if run_id.starts_with(super::nearby::NEED_PREFIX) {
        super::nearby::fail_check(pool, run_id, runner_id, code).await
    } else {
        super::matching::fail(pool, run_id, runner_id, code).await
    }
}

#[cfg(test)]
#[path = "runs_pool_tests.rs"]
mod pool_tests;
