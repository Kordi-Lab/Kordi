//! Delivery of durable sync events to one socket.
//!
//! Events are pushed when the per-replica listener wakes the account. A
//! backstop read repairs anything a lost notification missed: every ~60 s
//! while the listener is connected, every ~15 s while it is not, and soon
//! after it reconnects. A database error delays delivery instead of closing
//! the socket, unless reads keep failing for the failure grace.

use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use chrono::Utc;
use futures_util::stream::SplitSink;
use sqlx_core::query::query;
use sqlx_postgres::PgPool;
use tokio::time::Instant;

use super::frames::{send_json, EventFrame};
use super::retry::{jittered, spread, Backoff, FAILURE_GRACE};
use super::MAX_UNACKNOWLEDGED_EVENTS;
use crate::chat_sync::cursor::CursorCodec;
use crate::chat_sync::store::{self, StoreError};
use crate::chat_sync::PROTOCOL_VERSION;

/// Backstop read interval while the notification listener is connected.
pub(super) const REPAIR_WHILE_LISTENING: Duration = Duration::from_secs(60);
/// Backstop read interval while the listener is reconnecting.
pub(super) const REPAIR_WITHOUT_LISTENER: Duration = Duration::from_secs(15);
/// After the listener reconnects, sockets catch up within this window.
pub(super) const CATCH_UP_SPREAD: Duration = Duration::from_secs(10);

pub(super) fn event_is_within_delivery_window(
    stream_seq: i64,
    acknowledged_stream_seq: i64,
) -> bool {
    stream_seq.saturating_sub(acknowledged_stream_seq) <= MAX_UNACKNOWLEDGED_EVENTS
}

/// How a socket's event delivery ended.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum DeliveryEnd {
    /// Keep the socket open.
    Continue,
    /// Ask the client to resync for this reason, then close.
    Resync(&'static str),
}

enum ReadError {
    Fatal(&'static str),
    Transient,
}

/// Per-socket delivery position and backstop schedule.
pub(super) struct Delivery {
    pub(super) sent_stream_seq: i64,
    pub(super) last_applied_seq: i64,
    /// Delivery stopped at the unacknowledged window; resume on the next ack.
    paused: bool,
    next_repair: Instant,
    failing_since: Option<Instant>,
    backoff: Backoff,
}

impl Delivery {
    pub(super) fn new(now: Instant, connect_stream_seq: i64, listening: bool) -> Self {
        Self {
            sent_stream_seq: connect_stream_seq,
            last_applied_seq: connect_stream_seq,
            paused: false,
            next_repair: now + jittered(repair_interval(listening)),
            failing_since: None,
            backoff: Backoff::default(),
        }
    }

    pub(super) fn repair_deadline(&self) -> Instant {
        self.next_repair
    }

    pub(super) fn paused(&self) -> bool {
        self.paused
    }

    /// Read again no later than a random moment within `within`.
    pub(super) fn repair_within(&mut self, now: Instant, within: Duration) {
        self.next_repair = self.next_repair.min(now + spread(within));
    }

    /// Reads and sends every available event within the delivery window.
    pub(super) async fn deliver(
        &mut self,
        pool: &PgPool,
        account_id: &str,
        codec: &CursorCodec,
        sender: &mut SplitSink<WebSocket, Message>,
        listening: bool,
    ) -> DeliveryEnd {
        let result = self.send_available(pool, account_id, codec, sender).await;
        let now = Instant::now();
        match result {
            Ok(()) => {
                self.failing_since = None;
                self.backoff = Backoff::default();
                // A paused socket also resumes on its next ack; the shorter
                // backstop keeps resumption prompt if acks are sparse.
                let interval = if self.paused {
                    REPAIR_WITHOUT_LISTENER
                } else {
                    repair_interval(listening)
                };
                self.next_repair = now + jittered(interval);
                DeliveryEnd::Continue
            }
            Err(ReadError::Fatal(reason)) => DeliveryEnd::Resync(reason),
            Err(ReadError::Transient) => self.record_failure(now),
        }
    }

    fn record_failure(&mut self, now: Instant) -> DeliveryEnd {
        let failing_since = *self.failing_since.get_or_insert(now);
        if now.duration_since(failing_since) >= FAILURE_GRACE {
            return DeliveryEnd::Resync("SERVER_ERROR");
        }
        self.next_repair = self.next_repair.min(now + self.backoff.next_delay());
        DeliveryEnd::Continue
    }

    async fn send_available(
        &mut self,
        pool: &PgPool,
        account_id: &str,
        codec: &CursorCodec,
        sender: &mut SplitSink<WebSocket, Message>,
    ) -> Result<(), ReadError> {
        self.paused = false;
        loop {
            let batch =
                match store::sync_batch(pool, account_id, self.sent_stream_seq, Some(500)).await {
                    Ok(batch) => batch,
                    Err(StoreError::CursorExpired | StoreError::CursorAhead) => {
                        return Err(ReadError::Fatal("SYNC_CURSOR_EXPIRED"))
                    }
                    Err(StoreError::InvariantViolation(_)) => {
                        return Err(ReadError::Fatal("STREAM_SEQUENCE_GAP"))
                    }
                    Err(StoreError::Database(error)) => {
                        eprintln!("[chat-realtime] read durable events: {error}");
                        return Err(ReadError::Transient);
                    }
                    Err(_) => return Err(ReadError::Fatal("SERVER_ERROR")),
                };
            for event in &batch.events {
                if !event_is_within_delivery_window(event.stream_seq, self.last_applied_seq) {
                    self.paused = true;
                    return Ok(());
                }
                let frame = EventFrame {
                    frame_type: "event",
                    stream_seq: event.stream_seq,
                    cursor: codec.encode(account_id, event.stream_seq),
                    event,
                };
                send_json(sender, &frame)
                    .await
                    .map_err(|_| ReadError::Fatal("CLIENT_TOO_SLOW"))?;
                self.sent_stream_seq = event.stream_seq;
            }
            if !batch.has_more {
                return Ok(());
            }
        }
    }
}

fn repair_interval(listening: bool) -> Duration {
    if listening {
        REPAIR_WHILE_LISTENING
    } else {
        REPAIR_WITHOUT_LISTENER
    }
}

/// Records the client's acknowledged position. `Ok(false)` means the device
/// was revoked.
pub(super) async fn persist_device_ack(
    pool: &PgPool,
    account_id: &str,
    device_id: &str,
    stream_seq: i64,
) -> Result<bool, sqlx_core::Error> {
    let now = Utc::now().to_rfc3339();
    let result = query(
        "UPDATE cloud_devices \
         SET last_ack_seq = GREATEST(last_ack_seq, $1), protocol_version = $2, \
             last_sync_at = $3, last_seen_at = $3 \
         WHERE device_id = $4 AND account_id = $5 AND revoked_at IS NULL",
    )
    .bind(stream_seq)
    .bind(PROTOCOL_VERSION)
    .bind(&now)
    .bind(device_id)
    .bind(account_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

#[cfg(test)]
impl Delivery {
    pub(super) fn fail_for_test(&mut self, now: Instant) -> DeliveryEnd {
        self.record_failure(now)
    }
}
