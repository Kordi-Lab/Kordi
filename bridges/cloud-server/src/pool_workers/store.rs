//! Runs queued for pool workers, and their leases.
//!
//! A run of a pool worker pool gets a row in `cloud_pool_worker_runs` in the
//! transaction that queues it; the control plane's runners never lease such a
//! run. A worker leases only runs of the pool it authenticated for. Every
//! lease issues a new one-time token, kept here only as a SHA-256 hash; each
//! later call for the run must present the token, the pool and the worker id,
//! and completing or failing the run spends the token, so a replayed call or
//! a run taken over after its lease expired is refused. A run is leased at
//! most [`MAX_LEASES`] times and lives at most [`RUN_DEADLINE_MINUTES`], so a
//! run that keeps failing on a worker cannot spend the sponsor's budget
//! without end.

use chrono::Utc;
use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::query_scalar::query_scalar;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};

use crate::resource_pools::{coverage, Executor, Feature, ResourcePool, ResourcePools};

/// A lease lasts this long unless the worker renews it.
pub const LEASE_SECONDS: i64 = 120;
/// How often one run may be leased. A worker that crashes or whose result is
/// refused does not get the run back without end.
pub const MAX_LEASES: i32 = 3;
/// A run still unfinished this many minutes after it was queued fails,
/// whatever its state.
pub const RUN_DEADLINE_MINUTES: i32 = 30;
/// A run that no worker leased within this many minutes fails, so its
/// conversation or member is not left waiting; so does a lease that lapsed
/// this long ago.
const QUEUE_TIMEOUT_MINUTES: i32 = 10;
/// Leases tried per lease request when candidates turn out to be rebound.
const LEASE_ATTEMPTS: usize = 4;
/// Runs failed per batch, and batches per sweep.
const EXPIRE_BATCH: i64 = 200;
const EXPIRE_BATCHES: usize = 10;

/// The runner id a pool worker's runs are claimed under.
pub fn runner_id(pool_id: &str, worker_id: &str) -> String {
    format!("pool-worker:{pool_id}:{worker_id}")
}

fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Tags a run just queued in `tx` for its pool's worker. Does nothing for a
/// control plane pool.
pub async fn tag_run(
    tx: &mut Transaction<'_, Postgres>,
    run_id: &str,
    pool: &ResourcePool,
    feature: Feature,
) -> sqlx_core::Result<()> {
    if pool.executor() != Executor::PoolWorker {
        return Ok(());
    }
    query("INSERT INTO cloud_pool_worker_runs (run_id, pool_id, feature) VALUES ($1, $2, $3)")
        .bind(run_id)
        .bind(pool.id())
        .bind(feature.as_str())
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// What a worker receives for one run: the model input (the System agent's
/// conversation snapshot or the Grounding prompt) and no credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeasedRun {
    pub run_id: String,
    pub feature: String,
    pub lease_token: String,
    pub system_prompt: String,
    pub prompt: String,
    pub thinking: Option<String>,
}

type Candidate = (String, String, Option<String>);

/// Leases the oldest run of `pool_id` for `worker_id`. A run whose
/// organization is no longer served by this pool (the bindings or the
/// owner's covering membership changed after it was queued, or its tag is
/// wrong), or whose organization is disabled,
/// fails instead of reaching this worker.
pub async fn lease(
    db: &PgPool,
    pools: &ResourcePools,
    pool_id: &str,
    worker_id: &str,
) -> sqlx_core::Result<Option<LeasedRun>> {
    for _ in 0..LEASE_ATTEMPTS {
        let mut tx = db.begin().await?;
        let candidate: Option<Candidate> = query_as(
            "SELECT w.run_id, w.feature, run.organization_id
             FROM cloud_pool_worker_runs w
             JOIN cloud_agent_fallback_runs run ON run.run_id = w.run_id
             WHERE w.pool_id = $1 AND run.cancel_requested_at IS NULL
               AND w.lease_count < $2
               AND run.created_at::timestamptz > now() - make_interval(mins => $3)
               AND (run.status = 'queued'
                    OR (run.status IN ('leased', 'running')
                        AND run.lease_expires_at IS NOT NULL
                        AND run.lease_expires_at::timestamptz <= now()))
             ORDER BY w.created_at
             LIMIT 1
             FOR UPDATE OF run, w SKIP LOCKED",
        )
        .bind(pool_id)
        .bind(MAX_LEASES)
        .bind(RUN_DEADLINE_MINUTES)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((run_id, feature, organization_id)) = candidate else {
            return Ok(None);
        };
        let organization = organization_id.as_deref();
        let refusal = if !pools.admits(organization) {
            Some("organization_disabled")
        } else if !coverage::serves(&mut tx, pools, organization, pool_id).await? {
            Some("pool_binding_changed")
        } else {
            None
        };
        if let Some(code) = refusal {
            tx.rollback().await?;
            fail(db, &run_id, None, code).await?;
            continue;
        }
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let lease_token = hex::encode(bytes);
        let now = Utc::now();
        let (prompt, system_prompt, route): (String, Option<String>, Option<serde_json::Value>) =
            query_as(
                "UPDATE cloud_agent_fallback_runs
                 SET status = 'leased', execution_backend = 'cloud', claimed_by = $2,
                     lease_expires_at = $3, updated_at = $4
                 WHERE run_id = $1
                 RETURNING prompt, system_prompt, runtime_route_json",
            )
            .bind(&run_id)
            .bind(runner_id(pool_id, worker_id))
            .bind((now + chrono::Duration::seconds(LEASE_SECONDS)).to_rfc3339())
            .bind(now.to_rfc3339())
            .fetch_one(&mut *tx)
            .await?;
        query(
            "UPDATE cloud_pool_worker_runs
             SET worker_id = $2, lease_token_hash = $3, leased_at = now(),
                 lease_count = lease_count + 1
             WHERE run_id = $1",
        )
        .bind(&run_id)
        .bind(worker_id)
        .bind(token_hash(&lease_token))
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        let thinking = route
            .as_ref()
            .and_then(|route| route["thinking"].as_str())
            .map(str::to_string);
        return Ok(Some(LeasedRun {
            run_id,
            feature,
            lease_token,
            system_prompt: system_prompt.unwrap_or_default(),
            prompt,
            thinking,
        }));
    }
    Ok(None)
}

/// A run a worker holds, after its lease was checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldRun {
    pub feature: String,
    pub runner_id: String,
    pub cancel_requested: bool,
}

/// The lease conditions shared by [`held`] and [`take`]: $1 run, $2 pool,
/// $3 worker, $4 token hash, $5 runner id.
const LEASE_MATCHES: &str = "w.run_id = $1 AND w.pool_id = $2 AND w.worker_id = $3
           AND w.lease_token_hash = $4 AND run.run_id = w.run_id AND run.claimed_by = $5
           AND run.status IN ('leased', 'running')
           AND run.lease_expires_at::timestamptz > now()";

/// Checks that `worker_id` of `pool_id` holds a live lease on `run_id` with
/// `lease_token`. Any mismatch, including another pool's run, is `None`.
pub async fn held(
    db: &PgPool,
    run_id: &str,
    pool_id: &str,
    worker_id: &str,
    lease_token: &str,
) -> sqlx_core::Result<Option<HeldRun>> {
    let runner = runner_id(pool_id, worker_id);
    let row: Option<(String, bool)> = query_as(&format!(
        "SELECT w.feature, run.cancel_requested_at IS NOT NULL
         FROM cloud_pool_worker_runs w, cloud_agent_fallback_runs run
         WHERE {LEASE_MATCHES}"
    ))
    .bind(run_id)
    .bind(pool_id)
    .bind(worker_id)
    .bind(token_hash(lease_token))
    .bind(&runner)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(feature, cancel_requested)| HeldRun {
        feature,
        runner_id: runner,
        cancel_requested,
    }))
}

/// Like [`held`], but spends the lease token in the same statement, so of
/// two concurrent or replayed calls only one gets the run.
pub async fn take(
    db: &PgPool,
    run_id: &str,
    pool_id: &str,
    worker_id: &str,
    lease_token: &str,
) -> sqlx_core::Result<Option<HeldRun>> {
    let runner = runner_id(pool_id, worker_id);
    let row: Option<(String, bool)> = query_as(&format!(
        "UPDATE cloud_pool_worker_runs w SET lease_token_hash = NULL
         FROM cloud_agent_fallback_runs run
         WHERE {LEASE_MATCHES}
         RETURNING w.feature, run.cancel_requested_at IS NOT NULL"
    ))
    .bind(run_id)
    .bind(pool_id)
    .bind(worker_id)
    .bind(token_hash(lease_token))
    .bind(&runner)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(feature, cancel_requested)| HeldRun {
        feature,
        runner_id: runner,
        cancel_requested,
    }))
}

/// Renews a held lease.
pub async fn renew(db: &PgPool, run_id: &str, runner_id: &str) -> sqlx_core::Result<bool> {
    let now = Utc::now();
    let changed = query(
        "UPDATE cloud_agent_fallback_runs
         SET status = 'running', lease_expires_at = $3, updated_at = $4
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind((now + chrono::Duration::seconds(LEASE_SECONDS)).to_rfc3339())
    .bind(now.to_rfc3339())
    .execute(db)
    .await?;
    Ok(changed.rows_affected() > 0)
}

/// Whether `run_id` is now completed by `runner_id`.
pub async fn completed_by(db: &PgPool, run_id: &str, runner_id: &str) -> sqlx_core::Result<bool> {
    let found: Option<i32> = query_scalar(
        "SELECT 1 FROM cloud_agent_fallback_runs
         WHERE run_id = $1 AND claimed_by = $2 AND status = 'completed'",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(db)
    .await?;
    Ok(found.is_some())
}

/// Hands a finished run to its feature, which validates the reply and
/// writes it into the conversation or the member's cards. Returns whether
/// the run is now completed: a feature ignores a reply for a run that is no
/// longer its to finish.
pub async fn complete(
    db: &PgPool,
    run_id: &str,
    runner_id: &str,
    text: &str,
) -> sqlx_core::Result<bool> {
    if run_id.starts_with(crate::system_agent::RUN_PREFIX) {
        crate::system_agent::store::complete(db, run_id, runner_id, text).await?;
    } else if run_id.starts_with(crate::common_ground::RUN_PREFIX) {
        crate::common_ground::complete(db, run_id, runner_id, text).await?;
    } else {
        return Ok(false);
    }
    completed_by(db, run_id, runner_id).await
}

/// Fails a run through its feature. `runner_id` `None` fails it whoever
/// holds it.
pub async fn fail(
    db: &PgPool,
    run_id: &str,
    runner_id: Option<&str>,
    code: &str,
) -> sqlx_core::Result<()> {
    if run_id.starts_with(crate::system_agent::RUN_PREFIX) {
        crate::system_agent::store::fail(db, run_id, runner_id, code).await
    } else if run_id.starts_with(crate::common_ground::RUN_PREFIX) {
        crate::common_ground::fail(db, run_id, runner_id, code).await
    } else {
        Ok(())
    }
}

/// Runs to fail, with the reason. $1 pools with a worker, $2 stopped pools,
/// $3 queue timeout and $4 deadline in minutes, $5 lease cap.
const EXPIRED_SQL: &str = "
SELECT run_id, code FROM (
    SELECT w.run_id, w.created_at, CASE
        WHEN run.cancel_requested_at IS NOT NULL THEN 'cancelled'
        WHEN NOT (w.pool_id = ANY($1)) THEN 'pool_worker_unavailable'
        WHEN w.pool_id = ANY($2) AND (run.status = 'queued' OR lapsed) THEN 'pool_stopped'
        WHEN run.created_at::timestamptz < now() - make_interval(mins => $4)
            THEN 'pool_worker_deadline'
        WHEN lapsed AND w.lease_count >= $5 THEN 'lease_limit'
        WHEN run.status = 'queued'
             AND run.created_at::timestamptz < now() - make_interval(mins => $3)
            THEN 'pool_worker_unavailable'
        WHEN lapsed AND run.lease_expires_at::timestamptz < now() - make_interval(mins => $3)
            THEN 'lease_expired'
    END AS code
    FROM cloud_pool_worker_runs w
    JOIN cloud_agent_fallback_runs run ON run.run_id = w.run_id
    CROSS JOIN LATERAL (SELECT run.status IN ('leased', 'running')
        AND run.lease_expires_at::timestamptz < now() AS lapsed) lease
    WHERE run.status IN ('queued', 'leased', 'running')
) due
WHERE code IS NOT NULL
ORDER BY created_at
LIMIT $6";

/// Fails pool worker runs that can no longer finish: cancelled runs, runs of
/// a stopped pool or of a pool that no longer has a worker, runs past their
/// deadline or lease cap, runs no worker leased in time, and leases that
/// lapsed long ago. Then forgets the tags of runs that ended. Returns how
/// many runs failed.
pub async fn expire(db: &PgPool, pools: &ResourcePools) -> sqlx_core::Result<usize> {
    let worker_pools: Vec<String> = pools
        .pools()
        .iter()
        .filter(|pool| pool.executor() == Executor::PoolWorker)
        .map(|pool| pool.id().to_string())
        .collect();
    let stopped: Vec<String> = pools
        .pools()
        .iter()
        .filter(|pool| pool.executor() == Executor::PoolWorker && pool.is_stopped())
        .map(|pool| pool.id().to_string())
        .collect();
    let mut failed = 0;
    for _ in 0..EXPIRE_BATCHES {
        let due: Vec<(String, String)> = query_as(EXPIRED_SQL)
            .bind(&worker_pools)
            .bind(&stopped)
            .bind(QUEUE_TIMEOUT_MINUTES)
            .bind(RUN_DEADLINE_MINUTES)
            .bind(MAX_LEASES)
            .bind(EXPIRE_BATCH)
            .fetch_all(db)
            .await?;
        for (run_id, code) in &due {
            fail(db, run_id, None, code).await?;
            failed += 1;
        }
        if (due.len() as i64) < EXPIRE_BATCH {
            break;
        }
    }
    query(
        "DELETE FROM cloud_pool_worker_runs w USING cloud_agent_fallback_runs run
         WHERE run.run_id = w.run_id AND run.status NOT IN ('queued', 'leased', 'running')",
    )
    .execute(db)
    .await?;
    Ok(failed)
}
