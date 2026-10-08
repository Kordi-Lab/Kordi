//! The polling fallback and subscription renewal, run from the scheduled
//! task worker.
//!
//! Every `KORDI_CONNECTOR_POLL_MINUTES` (default 15) each connected connector
//! is claimed once. Providers with a live subscription (webhooks or push)
//! only renew it when due; the others are asked for events since the last
//! poll, and each new event is recorded once.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::credentials::usable_secret;
use super::events::{record_event, NewConnectorEvent};
use super::models::{ConnectorRecord, CONNECTOR_COLUMNS};
use super::providers::ProviderError;
use super::store::{self, StoreResult};
use super::ConnectorRuntime;

/// Connectors handled per sweep; the rest wait for the next one.
const POLL_BATCH: i64 = 50;
/// First poll of a connector looks back this far.
const FIRST_POLL_LOOKBACK_HOURS: i64 = 24;
/// Gmail watches last seven days; renew daily.
const SUBSCRIPTION_RENEW_HOURS: i64 = 24;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PollReport {
    pub polled: usize,
    pub subscribed: usize,
    pub recorded: usize,
    pub failed: usize,
}

/// (connector id, previous poll, last subscription).
type ClaimRow = (String, Option<DateTime<Utc>>, Option<DateTime<Utc>>);

struct Claimed {
    record: ConnectorRecord,
    previous_poll: Option<DateTime<Utc>>,
    subscribed_at: Option<DateTime<Utc>>,
}

/// Claims connected connectors whose last poll is older than `interval`
/// and stamps them, so concurrent servers never poll the same one.
async fn claim_due(
    pool: &PgPool,
    now: DateTime<Utc>,
    interval: ChronoDuration,
) -> StoreResult<Vec<Claimed>> {
    let rows: Vec<ClaimRow> = query_as(
        "WITH due AS ( \
           SELECT connector_id, last_polled_at FROM cloud_connectors \
           WHERE status = 'connected' AND (last_polled_at IS NULL OR last_polled_at <= $1) \
           ORDER BY last_polled_at NULLS FIRST LIMIT $2 FOR UPDATE SKIP LOCKED) \
         UPDATE cloud_connectors c SET last_polled_at = $3 FROM due \
         WHERE c.connector_id = due.connector_id \
         RETURNING c.connector_id, due.last_polled_at, c.subscribed_at",
    )
    .bind(now - interval)
    .bind(POLL_BATCH)
    .bind(now)
    .fetch_all(pool)
    .await?;
    let mut claimed = Vec::with_capacity(rows.len());
    for (connector_id, previous_poll, subscribed_at) in rows {
        let row: Option<store::ConnectorRow> = query_as(&format!(
            "SELECT {CONNECTOR_COLUMNS} FROM cloud_connectors WHERE connector_id = $1"
        ))
        .bind(&connector_id)
        .fetch_optional(pool)
        .await?;
        if let Some(record) = row.map(store::record_from_row).transpose()? {
            claimed.push(Claimed {
                record,
                previous_poll,
                subscribed_at,
            });
        }
    }
    Ok(claimed)
}

/// One sweep: polls or renews every due connector. Returns what happened.
pub async fn poll_due_connectors(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    now: DateTime<Utc>,
) -> StoreResult<PollReport> {
    let interval = ChronoDuration::minutes(runtime.hooks.poll_minutes);
    let mut report = PollReport::default();
    for claimed in claim_due(pool, now, interval).await? {
        let record = &claimed.record;
        let Some(provider) = runtime.providers.get(&record.provider) else {
            continue;
        };
        let live = provider.live_subscription(&runtime.hooks);
        let renew_due = claimed
            .subscribed_at
            .is_none_or(|at| at <= now - ChronoDuration::hours(SUBSCRIPTION_RENEW_HOURS));
        if live && !renew_due {
            continue;
        }
        let secret = match usable_secret(pool, runtime, provider.as_ref(), record).await {
            Ok(secret) => secret,
            Err(error) => {
                eprintln!("[connectors] poll {}: {error}", record.connector_id);
                report.failed += 1;
                continue;
            }
        };
        if live {
            match provider.subscribe(&secret, &runtime.hooks).await {
                Ok(()) => {
                    query("UPDATE cloud_connectors SET subscribed_at = $2 WHERE connector_id = $1")
                        .bind(&record.connector_id)
                        .bind(now)
                        .execute(pool)
                        .await?;
                    report.subscribed += 1;
                }
                Err(error) => {
                    note_failure(pool, record, &error).await;
                    report.failed += 1;
                }
            }
            continue;
        }
        let since = claimed
            .previous_poll
            .unwrap_or(now - ChronoDuration::hours(FIRST_POLL_LOOKBACK_HOURS));
        match provider.poll(&secret, since, &record.settings).await {
            Ok(events) => {
                report.polled += 1;
                for event in events {
                    let stored = record_event(
                        pool,
                        NewConnectorEvent {
                            connector_id: &record.connector_id,
                            provider: &record.provider,
                            kind: &event.kind,
                            external_id: Some(&event.external_id),
                            occurred_at: event.occurred_at,
                            payload: &event.payload,
                        },
                    )
                    .await?;
                    report.recorded += usize::from(stored.is_some());
                }
            }
            Err(error) => {
                note_failure(pool, record, &error).await;
                report.failed += 1;
            }
        }
    }
    Ok(report)
}

async fn note_failure(pool: &PgPool, record: &ConnectorRecord, error: &ProviderError) {
    eprintln!(
        "[connectors] poll {} at {}: {error}",
        record.connector_id, record.provider
    );
    if matches!(error, ProviderError::Unauthorized) {
        let _ = store::mark_needs_reauth(pool, &record.connector_id).await;
    }
}

static LAST_SWEEP_EPOCH: AtomicI64 = AtomicI64::new(0);
static SWEEP_RUNNING: AtomicBool = AtomicBool::new(false);

/// Periodic entry point for the scheduled-task worker. Runs at most once a
/// minute and never overlaps itself; provider calls happen on a spawned
/// task so the worker loop is not held up.
pub fn spawn_poll_sweep(pool: &PgPool, runtime: &ConnectorRuntime) {
    let now = Utc::now();
    if now.timestamp() - LAST_SWEEP_EPOCH.load(Ordering::Relaxed) < 60 {
        return;
    }
    if SWEEP_RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    LAST_SWEEP_EPOCH.store(now.timestamp(), Ordering::Relaxed);
    let pool = pool.clone();
    let runtime = runtime.clone();
    tokio::spawn(async move {
        match poll_due_connectors(&pool, &runtime, Utc::now()).await {
            Ok(report) if report.recorded > 0 || report.failed > 0 => println!(
                "[connectors] polled {} connectors, recorded {} events, {} failed",
                report.polled, report.recorded, report.failed
            ),
            Ok(_) => {}
            Err(error) => eprintln!("[connectors] poll sweep: {error}"),
        }
        SWEEP_RUNNING.store(false, Ordering::Release);
    });
}
