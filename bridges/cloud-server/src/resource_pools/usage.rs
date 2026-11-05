//! Daily pool usage in Postgres: admission before a run is queued and
//! settlement after it ends.
//!
//! Admission runs inside the transaction that queues the run, so a run is
//! never queued without its reservation and a rolled-back queue leaves no
//! count behind. Each counter is raised by one upsert that only passes while
//! the counter is below its limit; the row lock of the upsert serializes
//! concurrent admissions, so no limit is ever passed. The reservation row is
//! keyed by run id: admitting the same run again counts nothing, and
//! settlement changes a reservation at most once. Unlimited counters are not
//! kept, and a run with no limited counter leaves no rows at all.

use chrono::{NaiveDate, Utc};
use sqlx_core::acquire::Acquire;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::query_scalar::query_scalar;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgConnection, PgPool, Postgres};

use super::{Feature, ResourcePool};

/// The feature and scope of the counter for a whole pool.
pub(crate) const POOL_FEATURE: &str = "*";
pub(crate) const POOL_SCOPE: &str = "";
/// Usage older than this many days is pruned.
const RETAIN_DAYS: i64 = 90;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    /// The run may be queued; its reservation is part of the transaction.
    Admitted,
    /// A daily limit is used up. Nothing was counted.
    Exhausted,
    /// The pool's emergency stop is on. Nothing was counted.
    Stopped,
}

impl Admission {
    pub fn admitted(self) -> bool {
        self == Self::Admitted
    }
}

/// One run asking to be admitted.
pub struct Request<'a> {
    pub run_id: &'a str,
    pub pool: &'a ResourcePool,
    pub feature: Feature,
    /// The conversation id for System agent runs, the person's account id
    /// for Grounding runs.
    pub scope_id: &'a str,
    pub organization_id: Option<&'a str>,
}

/// The UTC day usage is counted on.
pub fn usage_day() -> NaiveDate {
    Utc::now().date_naive()
}

/// The time left until the next UTC day, when daily limits start over.
pub fn until_next_day() -> std::time::Duration {
    let now = Utc::now();
    let next = (now.date_naive() + chrono::Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .map(|midnight| midnight.and_utc());
    next.and_then(|next| (next - now).to_std().ok())
        .unwrap_or(std::time::Duration::from_secs(60))
}

/// Admits a run on `day` (the current UTC day outside tests). On
/// [`Admission::Admitted`] the reservation and counters are written in `tx`
/// and commit with it; on any other outcome `tx` is left as it was.
pub async fn reserve_on(
    tx: &mut Transaction<'_, Postgres>,
    request: &Request<'_>,
    day: NaiveDate,
) -> sqlx_core::Result<Admission> {
    let pool = request.pool;
    if pool.is_stopped() {
        return Ok(Admission::Stopped);
    }
    let limits = pool.limits();
    let scope_limit = limits.per_scope(request.feature).map(i64::from);
    let pool_runs = limits.pool_runs.map(clamp);
    let pool_spend = limits.pool_spend_micros.map(clamp);
    let cost = clamp(pool.provider(request.feature).estimated_cost_micros());
    if scope_limit == Some(0) || pool_runs == Some(0) || pool_spend.is_some_and(|c| cost > c) {
        return Ok(Admission::Exhausted);
    }
    // Only limited counters are kept, so an unlimited pool (such as the
    // pool built without a pool file) admits every run without a write.
    let count_scope = scope_limit.is_some();
    let count_pool = pool_runs.is_some() || pool_spend.is_some();
    if !count_scope && !count_pool {
        return Ok(Admission::Admitted);
    }

    let mut savepoint = tx.begin().await?;
    let inserted: Option<String> = query_scalar(
        "INSERT INTO cloud_resource_pool_reservations
             (run_id, pool_id, usage_day, feature, scope_id, organization_id, spend_micros)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (run_id) DO NOTHING
         RETURNING run_id",
    )
    .bind(request.run_id)
    .bind(pool.id())
    .bind(day)
    .bind(request.feature.as_str())
    .bind(request.scope_id)
    .bind(request.organization_id)
    .bind(cost)
    .fetch_optional(&mut *savepoint)
    .await?;
    if inserted.is_none() {
        // Already admitted: a retried admission counts nothing again.
        savepoint.commit().await?;
        return Ok(Admission::Admitted);
    }
    let counted = (!count_scope
        || raise(
            &mut savepoint,
            pool.id(),
            day,
            request.feature.as_str(),
            request.scope_id,
            cost,
            scope_limit,
            None,
        )
        .await?)
        && (!count_pool
            || raise(
                &mut savepoint,
                pool.id(),
                day,
                POOL_FEATURE,
                POOL_SCOPE,
                cost,
                pool_runs,
                pool_spend,
            )
            .await?);
    if counted {
        savepoint.commit().await?;
        Ok(Admission::Admitted)
    } else {
        savepoint.rollback().await?;
        Ok(Admission::Exhausted)
    }
}

/// Admits a run on the current UTC day. See [`reserve_on`].
pub async fn reserve(
    tx: &mut Transaction<'_, Postgres>,
    request: &Request<'_>,
) -> sqlx_core::Result<Admission> {
    reserve_on(tx, request, usage_day()).await
}

fn clamp(value: impl TryInto<i64>) -> i64 {
    value.try_into().unwrap_or(i64::MAX)
}

/// Adds one run and `cost` to a counter while it stays within the limits.
/// Returns false, changing nothing, when a limit would be passed.
#[allow(clippy::too_many_arguments)]
async fn raise(
    conn: &mut PgConnection,
    pool_id: &str,
    day: NaiveDate,
    feature: &str,
    scope_id: &str,
    cost: i64,
    run_limit: Option<i64>,
    spend_limit: Option<i64>,
) -> sqlx_core::Result<bool> {
    // The pre-check in `reserve_on` rejects limits a first row would pass.
    let raised: Option<i64> = query_scalar(
        "INSERT INTO cloud_resource_pool_usage AS usage
             (pool_id, usage_day, feature, scope_id, runs, spend_micros)
         VALUES ($1, $2, $3, $4, 1, $5)
         ON CONFLICT (pool_id, usage_day, feature, scope_id) DO UPDATE
         SET runs = usage.runs + 1,
             spend_micros = usage.spend_micros + EXCLUDED.spend_micros,
             updated_at = now()
         WHERE ($6::bigint IS NULL OR usage.runs < $6)
           AND ($7::bigint IS NULL OR usage.spend_micros + EXCLUDED.spend_micros <= $7)
         RETURNING usage.runs",
    )
    .bind(pool_id)
    .bind(day)
    .bind(feature)
    .bind(scope_id)
    .bind(cost)
    .bind(run_limit)
    .bind(spend_limit)
    .fetch_optional(conn)
    .await?;
    Ok(raised.is_some())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settlement {
    /// The run used the pool; it stays counted.
    Consumed,
    /// The run never reached a model; its count is given back.
    Released,
}

/// Settles a run's reservation. Only the first settlement of a reservation
/// changes anything; later ones, and runs without a reservation, return
/// false.
pub async fn settle(
    conn: &mut PgConnection,
    run_id: &str,
    settlement: Settlement,
) -> sqlx_core::Result<bool> {
    let state = match settlement {
        Settlement::Consumed => "consumed",
        Settlement::Released => "released",
    };
    let settled: Option<(String, NaiveDate, String, String, i64)> = query_as(
        "UPDATE cloud_resource_pool_reservations
         SET state = $2, settled_at = now()
         WHERE run_id = $1 AND state = 'reserved'
         RETURNING pool_id, usage_day, feature, scope_id, spend_micros",
    )
    .bind(run_id)
    .bind(state)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((pool_id, day, feature, scope_id, cost)) = settled else {
        return Ok(false);
    };
    if settlement == Settlement::Released {
        for (feature, scope_id) in [
            (feature.as_str(), scope_id.as_str()),
            (POOL_FEATURE, POOL_SCOPE),
        ] {
            query(
                "UPDATE cloud_resource_pool_usage
                 SET runs = GREATEST(runs - 1, 0),
                     spend_micros = GREATEST(spend_micros - $5, 0),
                     updated_at = now()
                 WHERE pool_id = $1 AND usage_day = $2 AND feature = $3 AND scope_id = $4",
            )
            .bind(&pool_id)
            .bind(day)
            .bind(feature)
            .bind(scope_id)
            .bind(cost)
            .execute(&mut *conn)
            .await?;
        }
    }
    Ok(true)
}

/// Settles a run that has ended: consumed once any runner claimed it (a model
/// may have been called), released when it never left the queue.
pub async fn settle_ended_run(conn: &mut PgConnection, run_id: &str) -> sqlx_core::Result<bool> {
    let claimed: Option<bool> = query_scalar(
        "SELECT claimed_by IS NOT NULL FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_optional(&mut *conn)
    .await?;
    let settlement = if claimed.unwrap_or(false) {
        Settlement::Consumed
    } else {
        Settlement::Released
    };
    settle(conn, run_id, settlement).await
}

/// Settles the reservations of runs that ended by another path (a stop, an
/// expiry, a deleted account) and so were never settled. Returns how many
/// were settled.
pub async fn settle_ended_runs(pool: &PgPool) -> sqlx_core::Result<usize> {
    let ended: Vec<String> = query_scalar(
        "SELECT reservation.run_id FROM cloud_resource_pool_reservations reservation
         LEFT JOIN cloud_agent_fallback_runs run ON run.run_id = reservation.run_id
         WHERE reservation.state = 'reserved'
           AND (run.run_id IS NULL OR run.status NOT IN ('queued', 'leased', 'running'))
         ORDER BY reservation.created_at
         LIMIT 500",
    )
    .fetch_all(pool)
    .await?;
    let mut settled = 0;
    for run_id in ended {
        let mut tx = pool.begin().await?;
        if settle_ended_run(&mut tx, &run_id).await? {
            settled += 1;
        }
        tx.commit().await?;
    }
    Ok(settled)
}

/// Runs counted for one scope of a pool on `day`.
pub async fn runs_on(
    pool: &PgPool,
    pool_id: &str,
    day: NaiveDate,
    feature: Option<Feature>,
    scope_id: &str,
) -> sqlx_core::Result<i64> {
    let feature = feature.map_or(POOL_FEATURE, Feature::as_str);
    let runs: Option<i64> = query_scalar(
        "SELECT runs FROM cloud_resource_pool_usage
         WHERE pool_id = $1 AND usage_day = $2 AND feature = $3 AND scope_id = $4",
    )
    .bind(pool_id)
    .bind(day)
    .bind(feature)
    .bind(scope_id)
    .fetch_optional(pool)
    .await?;
    Ok(runs.unwrap_or(0))
}

/// Removes usage, reservations and usage pauses older than the retention window.
pub async fn prune(pool: &PgPool) -> sqlx_core::Result<u64> {
    let cutoff = usage_day() - chrono::Duration::days(RETAIN_DAYS);
    let usage = query("DELETE FROM cloud_resource_pool_usage WHERE usage_day < $1")
        .bind(cutoff)
        .execute(pool)
        .await?;
    let reservations = query("DELETE FROM cloud_resource_pool_reservations WHERE usage_day < $1")
        .bind(cutoff)
        .execute(pool)
        .await?;
    let pauses = query("DELETE FROM cloud_usage_pauses WHERE usage_day < $1")
        .bind(cutoff)
        .execute(pool)
        .await?;
    Ok(usage.rows_affected() + reservations.rows_affected() + pauses.rows_affected())
}

#[cfg(test)]
#[path = "usage_tests.rs"]
pub(crate) mod tests;
