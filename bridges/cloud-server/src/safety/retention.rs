//! Report retention: open reports nobody reviewed close after 180 days, and
//! closed reports are deleted 90 days after closing, with their access log.
//!
//! Only reports are swept here. The contact conversion archive from
//! migration 110 is the only way to revert that conversion, so nothing
//! deletes it automatically; an operator can remove rows older than 90 days
//! with `cloud_purge_contact_consent_backfill` (a dry run unless told to
//! delete).

use std::time::Duration;

use chrono::{DateTime, Utc};
use sqlx_core::query::query;
use sqlx_postgres::PgPool;

pub const UNREVIEWED_REPORT_DAYS: i64 = 180;
pub const CLOSED_REPORT_DAYS: i64 = 90;
const SWEEP_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Default, PartialEq, Eq)]
pub struct SweepOutcome {
    pub expired: u64,
    pub deleted: u64,
}

/// Applies the retention rules as of `now`.
pub async fn sweep(pool: &PgPool, now: DateTime<Utc>) -> Result<SweepOutcome, sqlx_core::Error> {
    let expired = query(
        "UPDATE cloud_abuse_reports \
         SET status = 'closed', resolution = 'expired_unreviewed', closed_at = $1 \
         WHERE status = 'open' AND created_at < $2",
    )
    .bind(now)
    .bind(now - chrono::Duration::days(UNREVIEWED_REPORT_DAYS))
    .execute(pool)
    .await?
    .rows_affected();
    let deleted =
        query("DELETE FROM cloud_abuse_reports WHERE status = 'closed' AND closed_at < $1")
            .bind(now - chrono::Duration::days(CLOSED_REPORT_DAYS))
            .execute(pool)
            .await?
            .rows_affected();
    Ok(SweepOutcome { expired, deleted })
}

pub fn spawn_report_retention_worker(pool: PgPool) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            interval.tick().await;
            match sweep(&pool, Utc::now()).await {
                Ok(outcome) if outcome != SweepOutcome::default() => eprintln!(
                    "[safety] report retention closed {} and deleted {} reports",
                    outcome.expired, outcome.deleted
                ),
                Ok(_) => {}
                Err(_) => eprintln!("[safety] report retention sweep failed; retrying later"),
            }
        }
    });
}
