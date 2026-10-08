//! Connector events from webhooks, push, and polling, and their retention
//! sweep.

use std::sync::atomic::{AtomicI64, Ordering};

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::store::new_id;

pub const DEFAULT_EVENT_RETENTION_DAYS: i64 = 30;
const MAX_EVENT_RETENTION_DAYS: i64 = 365;
/// The scheduled-task loop ticks every few seconds; the sweep itself runs
/// at most this often.
const SWEEP_EVERY_SECONDS: i64 = 3600;
const SWEEP_BATCH: i64 = 5000;

/// Parses `KORDI_CONNECTOR_EVENT_RETENTION_DAYS`, clamped to 1..=365.
pub fn retention_days_from(value: Option<&str>) -> i64 {
    value
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|days| (1..=MAX_EVENT_RETENTION_DAYS).contains(days))
        .unwrap_or(DEFAULT_EVENT_RETENTION_DAYS)
}

pub fn event_retention_days() -> i64 {
    retention_days_from(
        std::env::var("KORDI_CONNECTOR_EVENT_RETENTION_DAYS")
            .ok()
            .as_deref(),
    )
}

pub struct NewConnectorEvent<'a> {
    pub connector_id: &'a str,
    pub provider: &'a str,
    pub kind: &'a str,
    pub external_id: Option<&'a str>,
    pub occurred_at: DateTime<Utc>,
    pub payload: &'a Value,
}

/// Stores one event and returns its id, or `None` when an event with the
/// same `external_id` is already stored for the connector (webhook retries,
/// replays, and overlapping polls), or when the connector is revoked. A new
/// event moves the connector's `last_event_at`. Events expire after the
/// retention window and are deleted with their connector.
///
/// The insert reads the connector row `FOR SHARE`. A disconnect holds that
/// row `FOR UPDATE` while it deletes events, so an event arriving meanwhile
/// waits, sees the connector revoked, and stores nothing.
pub async fn record_event(
    pool: &PgPool,
    event: NewConnectorEvent<'_>,
) -> Result<Option<String>, sqlx_core::Error> {
    let event_id = new_id("cnevt");
    let expires_at = Utc::now() + ChronoDuration::days(event_retention_days());
    let row: Option<(String,)> = query_as(
        "WITH inserted AS ( \
           INSERT INTO cloud_connector_events \
           (event_id, connector_id, provider, kind, external_id, occurred_at, payload, expires_at) \
           SELECT $1, connector_id, $3, $4, $5, $6, $7, $8 FROM cloud_connectors \
           WHERE connector_id = $2 AND status <> 'revoked' FOR SHARE \
           ON CONFLICT (connector_id, external_id) WHERE external_id IS NOT NULL DO NOTHING \
           RETURNING event_id, connector_id), \
         touched AS ( \
           UPDATE cloud_connectors c SET last_event_at = now() \
           FROM inserted WHERE c.connector_id = inserted.connector_id) \
         SELECT event_id FROM inserted",
    )
    .bind(&event_id)
    .bind(event.connector_id)
    .bind(event.provider)
    .bind(event.kind)
    .bind(event.external_id)
    .bind(event.occurred_at)
    .bind(event.payload)
    .bind(expires_at)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(event_id,)| event_id))
}

/// Deletes events past `expires_at`, in batches. Returns rows deleted.
pub async fn sweep_expired_events(
    pool: &PgPool,
    now: DateTime<Utc>,
) -> Result<u64, sqlx_core::Error> {
    let mut total = 0;
    loop {
        let deleted = query(
            "DELETE FROM cloud_connector_events WHERE event_id IN ( \
               SELECT event_id FROM cloud_connector_events WHERE expires_at <= $1 LIMIT $2)",
        )
        .bind(now)
        .bind(SWEEP_BATCH)
        .execute(pool)
        .await?
        .rows_affected();
        total += deleted;
        if deleted < SWEEP_BATCH as u64 {
            return Ok(total);
        }
    }
}

static LAST_SWEEP_EPOCH: AtomicI64 = AtomicI64::new(0);

/// Periodic entry point for the scheduled-task worker: at most once an hour,
/// deletes expired events and expired pending grants, and logs failures.
pub async fn run_retention_sweep(pool: &PgPool) {
    let now = Utc::now();
    let last = LAST_SWEEP_EPOCH.load(Ordering::Relaxed);
    if now.timestamp() - last < SWEEP_EVERY_SECONDS {
        return;
    }
    LAST_SWEEP_EPOCH.store(now.timestamp(), Ordering::Relaxed);
    match sweep_expired_events(pool, now).await {
        Ok(0) => {}
        Ok(deleted) => println!("[connectors] retention removed {deleted} expired events"),
        Err(error) => eprintln!("[connectors] retention sweep: {error}"),
    }
    match super::store::sweep_expired_pending_grants(pool, now).await {
        Ok(0) => {}
        Ok(deleted) => println!("[connectors] retention removed {deleted} expired pending grants"),
        Err(error) => eprintln!("[connectors] pending grant sweep: {error}"),
    }
}
