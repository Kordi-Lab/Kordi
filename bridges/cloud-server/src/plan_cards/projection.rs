use sqlx_core::executor::Executor;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

use super::models::PlanCardRow;

const DRAIN_BATCH: i64 = 20;
const MAX_DRAIN_BATCH: i64 = 100;
const DRAIN_INTERVAL_SECS: u64 = 5;

pub(super) struct DrainOutcome {
    pub(super) projected: usize,
    pub(super) failed: usize,
    pub(super) pending: i64,
}

impl DrainOutcome {
    pub(super) const fn is_complete(&self) -> bool {
        self.failed == 0 && self.pending == 0
    }
}

pub(super) async fn enqueue(
    executor: impl Executor<'_, Database = Postgres>,
    row: &PlanCardRow,
) -> Result<(), sqlx_core::Error> {
    query(
        "INSERT INTO cloud_plan_card_projection_queue (event_id, target_revision)
         VALUES ($1, $2)
         ON CONFLICT (event_id) DO UPDATE SET
             target_revision = EXCLUDED.target_revision,
             attempts = 0,
             retry_after = now(),
             last_error = NULL,
             updated_at = now()
         WHERE cloud_plan_card_projection_queue.target_revision < EXCLUDED.target_revision",
    )
    .bind(&row.event_id)
    .bind(row.revision)
    .execute(executor)
    .await?;
    Ok(())
}

async fn project_one(pool: &PgPool, event_id: &str) -> Result<bool, sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    super::transitions::lock_event(&mut tx, event_id)
        .await
        .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
    let queued: Option<(i64,)> = query_as(
        "SELECT target_revision FROM cloud_plan_card_projection_queue
         WHERE event_id = $1 AND retry_after <= now()
         FOR UPDATE",
    )
    .bind(event_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((target_revision,)) = queued else {
        tx.commit().await?;
        return Ok(false);
    };
    let Some(row) = super::store::fetch_row(&mut tx, event_id).await? else {
        query("DELETE FROM cloud_plan_card_projection_queue WHERE event_id = $1")
            .bind(event_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(false);
    };
    if row.revision < target_revision {
        return Err(sqlx_core::Error::Protocol(format!(
            "plan-card projection target {target_revision} exceeds stored revision {}",
            row.revision
        )));
    }
    super::calendar::sync_plan(&mut tx, &row).await?;
    let deleted = query(
        "DELETE FROM cloud_plan_card_projection_queue
         WHERE event_id = $1 AND target_revision <= $2",
    )
    .bind(event_id)
    .bind(row.revision)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(deleted.rows_affected() > 0)
}

pub(super) async fn record_failure(
    pool: &PgPool,
    event_id: &str,
    target_revision: i64,
    error: &str,
) -> Result<(), sqlx_core::Error> {
    query(
        "UPDATE cloud_plan_card_projection_queue SET
             attempts = attempts + 1,
             retry_after = now() + CASE LEAST(attempts + 1, 5)
                 WHEN 1 THEN interval '1 minute'
                 WHEN 2 THEN interval '5 minutes'
                 WHEN 3 THEN interval '30 minutes'
                 WHEN 4 THEN interval '2 hours'
                 ELSE interval '12 hours'
             END,
             last_error = $2,
             updated_at = now()
         WHERE event_id = $1 AND target_revision = $3",
    )
    .bind(event_id)
    .bind(error)
    .bind(target_revision)
    .execute(pool)
    .await?;
    Ok(())
}

pub(super) async fn drain(pool: &PgPool, limit: i64) -> Result<DrainOutcome, sqlx_core::Error> {
    let limit = limit.clamp(1, MAX_DRAIN_BATCH);
    let due: Vec<(String, i64)> = query_as(
        "SELECT event_id, target_revision FROM cloud_plan_card_projection_queue
         WHERE retry_after <= now()
         ORDER BY retry_after, updated_at
         LIMIT $1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    let mut projected = 0;
    let mut failed = 0;
    for (event_id, target_revision) in due {
        match project_one(pool, &event_id).await {
            Ok(true) => projected += 1,
            Ok(false) => {}
            Err(error) => {
                record_failure(pool, &event_id, target_revision, &error.to_string()).await?;
                failed += 1;
            }
        }
    }
    let (pending,): (i64,) = query_as("SELECT count(*) FROM cloud_plan_card_projection_queue")
        .fetch_one(pool)
        .await?;
    Ok(DrainOutcome {
        projected,
        failed,
        pending,
    })
}

pub(crate) fn spawn(pool: PgPool) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(DRAIN_INTERVAL_SECS));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            match drain(&pool, DRAIN_BATCH).await {
                Ok(outcome) if !outcome.is_complete() && outcome.failed > 0 => {
                    eprintln!(
                        "[plan-card] Calendar projection processed {} item(s), failed for {}, and left {} queued.",
                        outcome.projected, outcome.failed, outcome.pending
                    );
                }
                Ok(_) => {}
                Err(error) => {
                    eprintln!("[plan-card] Calendar projection drain failed: {error}");
                }
            }
        }
    })
}
