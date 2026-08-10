//! Transactional-outbox delivery for Cloud realtime sync wakeups.
//!
//! `cloud_sync_events` is committed in the same Postgres transaction as the
//! domain write. This worker only publishes a small cursor hint. The client
//! then reads the authoritative event from `/v1/cloud/sync`, so duplicate NATS
//! delivery and a crash after publish-before-ack are both harmless.

use std::sync::Arc;
use std::time::Duration;

use chrono::{Duration as ChronoDuration, Utc};
use futures_util::{stream, StreamExt};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use crate::events::SyncChanged;
use crate::server::ServerState;

const OUTBOX_BATCH_SIZE: i64 = 25;
const OUTBOX_DELIVERY_CONCURRENCY: usize = 8;
const OUTBOX_CLAIM_SECONDS: i64 = 60;
const OUTBOX_PUBLISH_TIMEOUT: Duration = Duration::from_secs(10);
const OUTBOX_IDLE_POLL: Duration = Duration::from_millis(750);
const OUTBOX_ERROR_POLL: Duration = Duration::from_secs(2);

type ClaimedSyncEvent = (i64, String, String, Option<String>, String);

fn retry_delay_seconds(attempts: i32) -> i64 {
    let exponent = attempts.clamp(0, 6) as u32;
    (1_i64 << exponent).min(60)
}

async fn claim_pending_events(
    state: &ServerState,
    worker_id: &str,
) -> Result<Vec<ClaimedSyncEvent>, sqlx_core::Error> {
    query_as(
        "WITH candidates AS ( \
             SELECT event_id FROM cloud_sync_events \
             WHERE realtime_published_at IS NULL \
               AND realtime_next_attempt_at <= clock_timestamp() \
               AND (realtime_claimed_until IS NULL \
                    OR realtime_claimed_until < clock_timestamp()) \
             ORDER BY event_id ASC \
             LIMIT $1 FOR UPDATE SKIP LOCKED \
         ) \
         UPDATE cloud_sync_events AS event \
         SET realtime_claimed_by = $2, \
             realtime_claimed_until = clock_timestamp() + ($3 * INTERVAL '1 second') \
         FROM candidates \
         WHERE event.event_id = candidates.event_id \
         RETURNING event.event_id, event.account_id, event.event_type, \
                   event.message_id, event.occurred_at",
    )
    .bind(OUTBOX_BATCH_SIZE)
    .bind(worker_id)
    .bind(OUTBOX_CLAIM_SECONDS)
    .fetch_all(state.db_pool())
    .await
}

async fn mark_published(
    state: &ServerState,
    worker_id: &str,
    event_id: i64,
) -> Result<(), sqlx_core::Error> {
    query(
        "UPDATE cloud_sync_events \
         SET realtime_published_at = clock_timestamp(), \
             realtime_claimed_until = NULL, realtime_claimed_by = NULL \
         WHERE event_id = $1 AND realtime_claimed_by = $2",
    )
    .bind(event_id)
    .bind(worker_id)
    .execute(state.db_pool())
    .await?;
    Ok(())
}

async fn release_for_retry(
    state: &ServerState,
    worker_id: &str,
    event_id: i64,
) -> Result<(), sqlx_core::Error> {
    let current_attempts: Option<(i32,)> = query_as(
        "SELECT realtime_attempts FROM cloud_sync_events \
         WHERE event_id = $1 AND realtime_claimed_by = $2",
    )
    .bind(event_id)
    .bind(worker_id)
    .fetch_optional(state.db_pool())
    .await?;
    let attempts = current_attempts.map(|row| row.0).unwrap_or_default() + 1;
    let next_attempt_at = Utc::now() + ChronoDuration::seconds(retry_delay_seconds(attempts));
    query(
        "UPDATE cloud_sync_events \
         SET realtime_attempts = $3, realtime_next_attempt_at = $4, \
             realtime_claimed_until = NULL, realtime_claimed_by = NULL \
         WHERE event_id = $1 AND realtime_claimed_by = $2",
    )
    .bind(event_id)
    .bind(worker_id)
    .bind(attempts)
    .bind(next_attempt_at)
    .execute(state.db_pool())
    .await?;
    Ok(())
}

async fn deliver_claimed(state: &ServerState, worker_id: &str, row: ClaimedSyncEvent) {
    let (event_id, account_id, event_type, message_id, occurred_at) = row;
    let publish = tokio::time::timeout(
        OUTBOX_PUBLISH_TIMEOUT,
        state.events().publish_sync_changed(SyncChanged {
            event_id,
            account_id: &account_id,
            sync_event_type: &event_type,
            message_id: message_id.as_deref(),
            occurred_at: &occurred_at,
        }),
    )
    .await
    .map_err(|_| "publish acknowledgement timed out".to_string())
    .and_then(|result| result);
    match publish {
        Ok(()) => {
            if let Err(error) = mark_published(state, worker_id, event_id).await {
                eprintln!("[realtime-outbox] mark event {event_id} published: {error}");
            }
        }
        Err(error) => {
            eprintln!("[realtime-outbox] publish event {event_id}: {error}");
            if let Err(retry_error) = release_for_retry(state, worker_id, event_id).await {
                eprintln!("[realtime-outbox] release event {event_id}: {retry_error}");
            }
        }
    }
}

pub fn spawn_realtime_outbox_worker(state: Arc<ServerState>) {
    if !state.events().is_enabled() {
        return;
    }
    tokio::spawn(async move {
        let worker_id = format!("cloud-outbox-{}", uuid::Uuid::new_v4().simple());
        loop {
            match claim_pending_events(&state, &worker_id).await {
                Ok(rows) if rows.is_empty() => tokio::time::sleep(OUTBOX_IDLE_POLL).await,
                Ok(rows) => {
                    stream::iter(rows)
                        .for_each_concurrent(OUTBOX_DELIVERY_CONCURRENCY, |row| {
                            deliver_claimed(&state, &worker_id, row)
                        })
                        .await
                }
                Err(error) => {
                    eprintln!("[realtime-outbox] claim failed: {error}");
                    tokio::time::sleep(OUTBOX_ERROR_POLL).await;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::retry_delay_seconds;

    #[test]
    fn retry_backoff_is_bounded() {
        assert_eq!(retry_delay_seconds(0), 1);
        assert_eq!(retry_delay_seconds(1), 2);
        assert_eq!(retry_delay_seconds(5), 32);
        assert_eq!(retry_delay_seconds(20), 60);
    }
}
