//! The polling job and subscription renewal, run from the scheduled task
//! worker.
//!
//! Every `KORDI_CONNECTOR_POLL_MINUTES` (default 15) each connected connector
//! is claimed once. Providers with a renewable subscription (Gmail push)
//! renew it when due. Every provider is then polled, also when webhooks or
//! push are configured, because a webhook can miss events: the provider is
//! asked for changes since the connector's `poll_cursor`, and each new event
//! is recorded once. The cursor moves only after a successful poll, and only
//! as far as the newest event actually stored.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::events::{record_event, NewConnectorEvent};
use super::models::{ConnectorRecord, CONNECTOR_COLUMNS};
use super::providers::{PolledEvent, ProviderError};
use super::refresh::usable_secret;
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

/// (connector id, poll cursor, last subscription).
type ClaimRow = (String, Option<DateTime<Utc>>, Option<DateTime<Utc>>);

struct Claimed {
    record: ConnectorRecord,
    poll_cursor: Option<DateTime<Utc>>,
    subscribed_at: Option<DateTime<Utc>>,
}

/// Claims connected connectors whose last poll attempt is older than
/// `interval` and stamps the attempt, so concurrent servers never poll the
/// same one.
async fn claim_due(
    pool: &PgPool,
    now: DateTime<Utc>,
    interval: ChronoDuration,
) -> StoreResult<Vec<ClaimRow>> {
    let rows: Vec<ClaimRow> = query_as(
        "WITH due AS ( \
           SELECT connector_id FROM cloud_connectors \
           WHERE status = 'connected' AND (last_polled_at IS NULL OR last_polled_at <= $1) \
           ORDER BY last_polled_at NULLS FIRST LIMIT $2 FOR UPDATE SKIP LOCKED) \
         UPDATE cloud_connectors c SET last_polled_at = $3 FROM due \
         WHERE c.connector_id = due.connector_id \
         RETURNING c.connector_id, c.poll_cursor, c.subscribed_at",
    )
    .bind(now - interval)
    .bind(POLL_BATCH)
    .bind(now)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

async fn load_claimed(pool: &PgPool, row: ClaimRow) -> StoreResult<Option<Claimed>> {
    let (connector_id, poll_cursor, subscribed_at) = row;
    let found: Option<store::ConnectorRow> = query_as(&format!(
        "SELECT {CONNECTOR_COLUMNS} FROM cloud_connectors WHERE connector_id = $1"
    ))
    .bind(&connector_id)
    .fetch_optional(pool)
    .await?;
    Ok(found
        .map(store::record_from_row)
        .transpose()?
        .map(|record| Claimed {
            record,
            poll_cursor,
            subscribed_at,
        }))
}

/// What one connector's turn did. `failed` is set when any step failed;
/// the other connectors in the sweep are handled either way.
#[derive(Default)]
struct ConnectorOutcome {
    polled: bool,
    subscribed: bool,
    recorded: usize,
    failed: bool,
}

/// One sweep: renews and polls every due connector. A failure in one
/// connector, from the provider or the database, is counted and logged and
/// never stops the others. Only the claim itself can fail the sweep.
pub async fn poll_due_connectors(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    now: DateTime<Utc>,
) -> StoreResult<PollReport> {
    let interval = ChronoDuration::minutes(runtime.hooks.poll_minutes);
    let mut report = PollReport::default();
    for row in claim_due(pool, now, interval).await? {
        let connector_id = row.0.clone();
        let outcome = match load_claimed(pool, row).await {
            Ok(Some(claimed)) => poll_connector(pool, runtime, &claimed, now).await,
            Ok(None) => continue,
            Err(error) => {
                eprintln!("[connectors] poll {connector_id}: load: {error}");
                ConnectorOutcome {
                    failed: true,
                    ..Default::default()
                }
            }
        };
        report.polled += usize::from(outcome.polled);
        report.subscribed += usize::from(outcome.subscribed);
        report.recorded += outcome.recorded;
        report.failed += usize::from(outcome.failed);
    }
    Ok(report)
}

async fn poll_connector(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    claimed: &Claimed,
    now: DateTime<Utc>,
) -> ConnectorOutcome {
    let record = &claimed.record;
    let mut outcome = ConnectorOutcome::default();
    let Some(provider) = runtime.providers.get(&record.provider) else {
        return outcome;
    };
    let secret = match usable_secret(pool, runtime, provider.as_ref(), &record.connector_id).await {
        Ok(secret) => secret,
        Err(error) => {
            eprintln!("[connectors] poll {}: {error}", record.connector_id);
            outcome.failed = true;
            return outcome;
        }
    };
    let renew_due = claimed
        .subscribed_at
        .is_none_or(|at| at <= now - ChronoDuration::hours(SUBSCRIPTION_RENEW_HOURS));
    if provider.live_subscription(&runtime.hooks) && renew_due {
        match provider.subscribe(&secret, &runtime.hooks).await {
            Ok(()) => match mark_subscribed(pool, &record.connector_id, now).await {
                Ok(()) => outcome.subscribed = true,
                Err(error) => {
                    eprintln!("[connectors] subscribe {}: {error}", record.connector_id);
                    outcome.failed = true;
                }
            },
            Err(error) => {
                note_failure(pool, record, &error).await;
                outcome.failed = true;
            }
        }
    }
    let since = claimed
        .poll_cursor
        .unwrap_or(now - ChronoDuration::hours(FIRST_POLL_LOOKBACK_HOURS));
    match provider.poll(&secret, since, &record.settings).await {
        Ok(events) => {
            outcome.polled = true;
            let stored = store_polled(pool, record, events).await;
            outcome.recorded = stored.recorded;
            // The cursor covers what was stored, even when a later event
            // failed. A poll with no events covered its window start.
            let cursor = match (stored.newest, &stored.error) {
                (Some(newest), _) => Some(newest),
                (None, None) => Some(since),
                (None, Some(_)) => None,
            };
            if let Some(cursor) = cursor {
                if let Err(error) = advance_cursor(pool, &record.connector_id, cursor).await {
                    eprintln!("[connectors] poll cursor {}: {error}", record.connector_id);
                    outcome.failed = true;
                }
            }
            if let Some(error) = stored.error {
                eprintln!("[connectors] record {}: {error}", record.connector_id);
                outcome.failed = true;
            }
        }
        Err(error) => {
            note_failure(pool, record, &error).await;
            outcome.failed = true;
        }
    }
    outcome
}

struct Stored {
    recorded: usize,
    /// The newest `occurred_at` stored (or already stored) before any error.
    newest: Option<DateTime<Utc>>,
    error: Option<sqlx_core::Error>,
}

/// Records events oldest first and stops at the first database error, so the
/// newest stored time is a safe cursor: everything before it is stored.
async fn store_polled(
    pool: &PgPool,
    record: &ConnectorRecord,
    mut events: Vec<PolledEvent>,
) -> Stored {
    events.sort_by_key(|event| event.occurred_at);
    let mut stored = Stored {
        recorded: 0,
        newest: None,
        error: None,
    };
    for event in &events {
        let result = record_event(
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
        .await;
        match result {
            Ok(id) => {
                stored.recorded += usize::from(id.is_some());
                stored.newest = Some(event.occurred_at);
            }
            Err(error) => {
                stored.error = Some(error);
                break;
            }
        }
    }
    stored
}

/// Moves the cursor forward, never back.
async fn advance_cursor(
    pool: &PgPool,
    connector_id: &str,
    cursor: DateTime<Utc>,
) -> StoreResult<()> {
    query(
        "UPDATE cloud_connectors SET poll_cursor = GREATEST(COALESCE(poll_cursor, $2), $2) \
         WHERE connector_id = $1 AND status <> 'revoked'",
    )
    .bind(connector_id)
    .bind(cursor)
    .execute(pool)
    .await?;
    Ok(())
}

async fn mark_subscribed(pool: &PgPool, connector_id: &str, now: DateTime<Utc>) -> StoreResult<()> {
    query("UPDATE cloud_connectors SET subscribed_at = $2 WHERE connector_id = $1")
        .bind(connector_id)
        .bind(now)
        .execute(pool)
        .await?;
    Ok(())
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

/// Holds a "sweep running" flag and clears it when dropped, also when the
/// sweep panics, so one failed sweep cannot stop polling for good.
pub(crate) struct RunningGuard(&'static AtomicBool);

impl RunningGuard {
    /// Sets `flag`, or returns `None` when it is already set.
    pub(crate) fn acquire(flag: &'static AtomicBool) -> Option<Self> {
        (!flag.swap(true, Ordering::AcqRel)).then_some(Self(flag))
    }
}

impl Drop for RunningGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
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
    let Some(guard) = RunningGuard::acquire(&SWEEP_RUNNING) else {
        return;
    };
    LAST_SWEEP_EPOCH.store(now.timestamp(), Ordering::Relaxed);
    let pool = pool.clone();
    let runtime = runtime.clone();
    tokio::spawn(async move {
        let _guard = guard;
        match poll_due_connectors(&pool, &runtime, Utc::now()).await {
            Ok(report) if report.recorded > 0 || report.failed > 0 => println!(
                "[connectors] polled {} connectors, recorded {} events, {} failed",
                report.polled, report.recorded, report.failed
            ),
            Ok(_) => {}
            Err(error) => eprintln!("[connectors] poll sweep: {error}"),
        }
    });
}
