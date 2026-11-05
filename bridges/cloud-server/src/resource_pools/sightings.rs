//! When each pool's worker last asked for a run, shared by every server
//! replica through `cloud_pool_worker_sightings`.
//!
//! A worker's lease requests reach any replica, so a sighting is written to
//! Postgres, at most once per pool every [`WRITE_EVERY`] by each process.
//! Routing reads it through a per-process cache that is at most
//! [`READ_CACHE`] old. Ages are computed by the database clock, so replicas
//! with different clocks agree. A running worker is therefore seen as at
//! most `WRITE_EVERY + READ_CACHE` old, well within
//! [`super::coverage::WORKER_SEEN_WINDOW`].

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sqlx_core::query::query;
use sqlx_core::query_scalar::query_scalar;
use sqlx_postgres::PgConnection;

/// A process writes a pool's sighting at most this often.
pub const WRITE_EVERY: Duration = Duration::from_secs(20);
/// A sighting read from the database is reused for this long.
pub const READ_CACHE: Duration = Duration::from_secs(10);

#[derive(Debug, Default)]
pub struct WorkerSightings {
    /// When this process last wrote each pool's sighting.
    written: Mutex<HashMap<String, Instant>>,
    /// Per pool: when it was read, and the estimated local instant of the
    /// last sighting (`None`: never seen).
    read: Mutex<HashMap<String, (Instant, Option<Instant>)>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl WorkerSightings {
    /// Notes that `pool_id`'s worker asked for a run now. Only callers that
    /// authenticated the worker may note it, so the table holds at most one
    /// row per configured pool.
    pub async fn note(&self, conn: &mut PgConnection, pool_id: &str) -> sqlx_core::Result<()> {
        let now = Instant::now();
        lock(&self.read).insert(pool_id.to_string(), (now, Some(now)));
        let due = lock(&self.written)
            .get(pool_id)
            .is_none_or(|written| written.elapsed() >= WRITE_EVERY);
        if !due {
            return Ok(());
        }
        query(
            "INSERT INTO cloud_pool_worker_sightings (pool_id, last_seen_at) VALUES ($1, now())
             ON CONFLICT (pool_id) DO UPDATE
             SET last_seen_at = GREATEST(cloud_pool_worker_sightings.last_seen_at, now())",
        )
        .bind(pool_id)
        .execute(conn)
        .await?;
        lock(&self.written).insert(pool_id.to_string(), now);
        Ok(())
    }

    /// Whether any replica saw `pool_id`'s worker within `window`.
    pub async fn seen_within(
        &self,
        conn: &mut PgConnection,
        pool_id: &str,
        window: Duration,
    ) -> sqlx_core::Result<bool> {
        let cached = lock(&self.read)
            .get(pool_id)
            .filter(|(read_at, _)| read_at.elapsed() < READ_CACHE)
            .map(|(_, seen)| *seen);
        let seen = match cached {
            Some(seen) => seen,
            None => {
                let age: Option<f64> = query_scalar(
                    "SELECT GREATEST(EXTRACT(EPOCH FROM now() - last_seen_at), 0)::float8
                     FROM cloud_pool_worker_sightings WHERE pool_id = $1",
                )
                .bind(pool_id)
                .fetch_optional(conn)
                .await?;
                let now = Instant::now();
                // An age beyond what `Instant` can hold counts as never seen.
                let seen = age
                    .and_then(|age| Duration::try_from_secs_f64(age).ok())
                    .and_then(|age| now.checked_sub(age));
                lock(&self.read).insert(pool_id.to_string(), (now, seen));
                seen
            }
        };
        Ok(seen.is_some_and(|seen| seen.elapsed() <= window))
    }
}
