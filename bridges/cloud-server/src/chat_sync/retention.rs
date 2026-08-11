//! Retention for the recoverable per-user chat stream.
//!
//! Canonical conversations and messages are retained by product policy. Only
//! replay rows are trimmed here, and each user's `min_seq` is advanced in the
//! same transaction before the rows disappear so an old cursor fails with an
//! explicit bootstrap requirement.

use chrono::{DateTime, Utc};
use sqlx_core::query::query;
use sqlx_postgres::PgPool;

const DEFAULT_RETENTION_DAYS: i64 = 60;
const MIN_RETENTION_DAYS: i64 = 30;
const MAX_RETENTION_DAYS: i64 = 90;

pub fn retention_days() -> i64 {
    std::env::var("KORDI_CHAT_SYNC_RETENTION_DAYS")
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(DEFAULT_RETENTION_DAYS)
        .clamp(MIN_RETENTION_DAYS, MAX_RETENTION_DAYS)
}

pub fn retention_sweep_interval() -> std::time::Duration {
    std::time::Duration::from_secs(6 * 60 * 60)
}

pub async fn sweep_expired_events(
    pool: &PgPool,
    cutoff: DateTime<Utc>,
) -> Result<u64, sqlx_core::Error> {
    let mut transaction = pool.begin().await?;
    let deleted = query(
        "WITH candidates AS ( \
             SELECT account_id, MAX(stream_seq) AS expired_through \
             FROM cloud_chat_user_sync_events \
             WHERE occurred_at < $1 \
             GROUP BY account_id \
         ), advanced AS ( \
             UPDATE cloud_chat_user_sync_heads head \
             SET min_seq = GREATEST(head.min_seq, candidate.expired_through) \
             FROM candidates candidate \
             WHERE head.account_id = candidate.account_id \
             RETURNING head.account_id, head.min_seq \
         ) \
         DELETE FROM cloud_chat_user_sync_events event \
         USING advanced \
         WHERE event.account_id = advanced.account_id \
           AND event.stream_seq <= advanced.min_seq",
    )
    .bind(cutoff)
    .execute(&mut *transaction)
    .await?
    .rows_affected();
    transaction.commit().await?;
    Ok(deleted)
}

pub fn spawn_retention_worker(pool: PgPool) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(retention_sweep_interval());
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let cutoff = Utc::now() - chrono::Duration::days(retention_days());
            if let Err(error) = sweep_expired_events(&pool, cutoff).await {
                eprintln!("[chat-sync-v2] retention sweep: {error}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{retention_sweep_interval, DEFAULT_RETENTION_DAYS};

    #[test]
    fn retention_worker_has_a_bounded_nonzero_default() {
        assert_eq!(DEFAULT_RETENTION_DAYS, 60);
        assert!(retention_sweep_interval() >= std::time::Duration::from_secs(60));
    }
}
