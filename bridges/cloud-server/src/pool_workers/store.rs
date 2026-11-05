//! Runs queued for pool workers, and their leases.
//!
//! A run of a pool worker pool gets a row in `cloud_pool_worker_runs` in the
//! transaction that queues it; the control plane's runners never lease such a
//! run. A worker leases only runs of the pool it authenticated for. Every
//! lease issues a new one-time token, kept here only as a SHA-256 hash; each
//! later call for the run must present the token, the pool and the worker id,
//! so a run taken over after its lease expired is closed to the earlier
//! worker.

use chrono::Utc;
use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};

use crate::resource_pools::{Executor, Feature, ResourcePool, ResourcePools};

/// A lease lasts this long unless the worker renews it.
pub const LEASE_SECONDS: i64 = 120;
/// A run that no worker leased within this many minutes fails, so its
/// conversation or member is not left waiting.
const QUEUE_TIMEOUT_MINUTES: i64 = 10;
/// Leases tried per lease request when candidates turn out to be rebound.
const LEASE_ATTEMPTS: usize = 4;

/// The runner id a pool worker's runs are claimed under.
pub fn runner_id(pool_id: &str, worker_id: &str) -> String {
    format!("pool-worker:{pool_id}:{worker_id}")
}

fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn feature_name(feature: Feature) -> &'static str {
    feature.as_str()
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
        .bind(feature_name(feature))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// The scope-limited context a worker receives for one run: the model input
/// and nothing about the members, the conversation or any credential.
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
/// organization is no longer bound to this pool (the bindings changed after
/// it was queued, or its tag is wrong) fails instead of reaching this worker.
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
               AND (run.status = 'queued'
                    OR (run.status IN ('leased', 'running')
                        AND run.lease_expires_at IS NOT NULL
                        AND run.lease_expires_at::timestamptz <= now()))
             ORDER BY w.created_at
             LIMIT 1
             FOR UPDATE OF run, w SKIP LOCKED",
        )
        .bind(pool_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((run_id, feature, organization_id)) = candidate else {
            return Ok(None);
        };
        if pools.resolve(organization_id.as_deref()).id() != pool_id {
            tx.rollback().await?;
            fail_unclaimed(db, &run_id, "pool_binding_changed").await?;
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
             SET worker_id = $2, lease_token_hash = $3, leased_at = now()
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
    let row: Option<(String, bool)> = query_as(
        "SELECT w.feature, run.cancel_requested_at IS NOT NULL
         FROM cloud_pool_worker_runs w
         JOIN cloud_agent_fallback_runs run ON run.run_id = w.run_id
         WHERE w.run_id = $1 AND w.pool_id = $2 AND w.worker_id = $3
           AND w.lease_token_hash = $4 AND run.claimed_by = $5
           AND run.status IN ('leased', 'running')
           AND run.lease_expires_at::timestamptz > now()",
    )
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

/// Hands a finished run to its feature, which validates the reply and
/// writes it into the conversation or the member's cards.
pub async fn complete(
    db: &PgPool,
    run_id: &str,
    runner_id: &str,
    text: &str,
) -> sqlx_core::Result<()> {
    if run_id.starts_with(crate::system_agent::RUN_PREFIX) {
        crate::system_agent::store::complete(db, run_id, runner_id, text).await
    } else if run_id.starts_with(crate::common_ground::RUN_PREFIX) {
        crate::common_ground::complete(db, run_id, runner_id, text).await
    } else {
        Ok(())
    }
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

async fn fail_unclaimed(db: &PgPool, run_id: &str, code: &str) -> sqlx_core::Result<()> {
    fail(db, run_id, None, code).await
}

/// Fails pool worker runs that can no longer finish: runs of a stopped pool,
/// runs of a pool that is gone or no longer has a worker, runs no worker
/// leased in time, and leases that lapsed long ago. Returns how many failed.
pub async fn expire(db: &PgPool, pools: &ResourcePools) -> sqlx_core::Result<usize> {
    let rows: Vec<(String, String, String, bool, bool)> = query_as(
        "SELECT w.run_id, w.pool_id, run.status,
                run.status IN ('leased', 'running')
                   AND run.lease_expires_at::timestamptz < now(),
                (run.status = 'queued'
                   AND run.created_at::timestamptz < now() - make_interval(mins => $1::int))
                OR (run.status IN ('leased', 'running')
                   AND run.lease_expires_at::timestamptz < now() - make_interval(mins => $1::int))
         FROM cloud_pool_worker_runs w
         JOIN cloud_agent_fallback_runs run ON run.run_id = w.run_id
         WHERE run.status IN ('queued', 'leased', 'running')
         ORDER BY w.created_at
         LIMIT 200",
    )
    .bind(QUEUE_TIMEOUT_MINUTES as i32)
    .fetch_all(db)
    .await?;
    let mut failed = 0;
    for (run_id, pool_id, status, lapsed, overdue) in rows {
        let pool = pools.by_id(&pool_id);
        let code = match pool {
            Some(pool) if pool.executor() != Executor::PoolWorker => "pool_worker_unavailable",
            None => "pool_worker_unavailable",
            // A stopped pool's queued runs fail now; a run a worker is still
            // holding fails once its lease lapses, since the worker can no
            // longer complete it.
            Some(pool) if pool.is_stopped() && (status == "queued" || lapsed) => "pool_stopped",
            Some(_) if overdue && status == "queued" => "pool_worker_unavailable",
            Some(_) if overdue => "lease_expired",
            Some(_) => continue,
        };
        fail_unclaimed(db, &run_id, code).await?;
        failed += 1;
    }
    Ok(failed)
}
