//! Durable realtime transport for the canonical chat protocol.
//!
//! The socket never owns canonical state. It authenticates with a single-use
//! ticket, catches up from the PostgreSQL sync stream, and keeps polling that
//! same stream for live events. A dropped notification or gateway restart is
//! therefore repaired by the next durable read.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header::ORIGIN, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sqlx_core::query::query;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::auth::session::device_is_active;
use crate::chat_sync::cursor::CursorCodec;
use crate::chat_sync::models::SyncEventSnapshot;
use crate::chat_sync::store::{self, StoreError};
use crate::chat_sync::PROTOCOL_VERSION;
use crate::server::ServerState;

#[cfg(test)]
mod tests;
mod ticket;
mod wake;

use ticket::{consume_ticket, ConsumedRealtimeTicket};
pub use ticket::{issue_ticket, IssuedRealtimeTicket, TicketError};
pub(crate) use wake::{spawn_wake_listener, ChatSyncWakeHub};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(65);
const DURABLE_REPAIR_INTERVAL: Duration = Duration::from_secs(15);
const SEND_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CLIENT_FRAME_BYTES: usize = 64 * 1024;
const MAX_SERVER_FRAME_BYTES: usize = 512 * 1024;
const MAX_UNACKNOWLEDGED_EVENTS: i64 = 1_000;
const DEVICE_REVALIDATION_INTERVAL: Duration = Duration::from_secs(2);

fn event_is_within_delivery_window(stream_seq: i64, acknowledged_stream_seq: i64) -> bool {
    stream_seq.saturating_sub(acknowledged_stream_seq) <= MAX_UNACKNOWLEDGED_EVENTS
}

fn cursor_codec() -> Option<CursorCodec> {
    std::env::var("KORDI_CHAT_SYNC_CURSOR_SECRET")
        .ok()
        .and_then(|secret| CursorCodec::new(secret).ok())
}

#[derive(Deserialize)]
pub struct RealtimeQuery {
    ticket: String,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ServerState>>,
    Query(query): Query<RealtimeQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(codec) = cursor_codec() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let ticket = match consume_ticket(state.db_pool(), &query.ticket).await {
        Ok(ticket) => ticket,
        Err(TicketError::InvalidTicket) => return StatusCode::UNAUTHORIZED.into_response(),
        Err(TicketError::OriginNotAllowed) => return StatusCode::FORBIDDEN.into_response(),
        Err(TicketError::Database(error)) => {
            eprintln!("[chat-realtime] consume ticket: {error}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let request_origin = headers
        .get(ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(ToString::to_string);
    if ticket.allowed_origin != request_origin {
        return StatusCode::FORBIDDEN.into_response();
    }

    ws.max_message_size(MAX_CLIENT_FRAME_BYTES)
        .max_frame_size(MAX_CLIENT_FRAME_BYTES)
        .on_upgrade(move |socket| run_socket(socket, state, ticket, codec))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientFrame {
    Connect {
        protocol_version: i32,
        device_id: String,
        cursor: String,
    },
    Heartbeat {
        last_applied_seq: i64,
    },
}

#[derive(Serialize)]
struct HelloFrame {
    #[serde(rename = "type")]
    frame_type: &'static str,
    connection_id: Uuid,
    protocol_version: i32,
    heartbeat_interval_ms: u64,
    max_frame_bytes: usize,
}

#[derive(Serialize)]
struct EventFrame<'a> {
    #[serde(rename = "type")]
    frame_type: &'static str,
    stream_seq: i64,
    cursor: String,
    event: &'a SyncEventSnapshot,
}

#[derive(Serialize)]
struct HeartbeatAckFrame {
    #[serde(rename = "type")]
    frame_type: &'static str,
    server_time: DateTime<Utc>,
}

#[derive(Serialize)]
struct ResyncRequiredFrame<'a> {
    #[serde(rename = "type")]
    frame_type: &'static str,
    reason: &'a str,
}

#[derive(Serialize)]
struct ErrorFrame<'a> {
    #[serde(rename = "type")]
    frame_type: &'static str,
    code: &'a str,
}

async fn send_json<T: Serialize>(
    sender: &mut SplitSink<WebSocket, Message>,
    value: &T,
) -> Result<(), ()> {
    let body = serde_json::to_string(value).map_err(|_| ())?;
    if body.len() > MAX_SERVER_FRAME_BYTES {
        return Err(());
    }
    tokio::time::timeout(SEND_TIMEOUT, sender.send(Message::Text(body)))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

async fn send_socket_json<T: Serialize>(socket: &mut WebSocket, value: &T) -> Result<(), ()> {
    let body = serde_json::to_string(value).map_err(|_| ())?;
    if body.len() > MAX_SERVER_FRAME_BYTES {
        return Err(());
    }
    tokio::time::timeout(SEND_TIMEOUT, socket.send(Message::Text(body)))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

async fn receive_connect(
    socket: &mut WebSocket,
    ticket: &ConsumedRealtimeTicket,
    codec: &CursorCodec,
) -> Result<i64, ()> {
    let incoming = tokio::time::timeout(CONNECT_TIMEOUT, socket.recv())
        .await
        .map_err(|_| ())?;
    let Some(Ok(Message::Text(body))) = incoming else {
        return Err(());
    };
    let frame: ClientFrame = serde_json::from_str(&body).map_err(|_| ())?;
    let ClientFrame::Connect {
        protocol_version,
        device_id,
        cursor,
    } = frame
    else {
        return Err(());
    };
    if protocol_version != PROTOCOL_VERSION || device_id != ticket.device_id {
        return Err(());
    }
    codec.decode(&cursor, &ticket.account_id).map_err(|_| ())
}

async fn resync_and_close(sender: &mut SplitSink<WebSocket, Message>, reason: &str) {
    let _ = send_json(
        sender,
        &ResyncRequiredFrame {
            frame_type: "resync_required",
            reason,
        },
    )
    .await;
    let _ = sender.send(Message::Close(None)).await;
}

async fn send_available_events(
    pool: &PgPool,
    account_id: &str,
    codec: &CursorCodec,
    sender: &mut SplitSink<WebSocket, Message>,
    sent_stream_seq: &mut i64,
    acknowledged_stream_seq: i64,
) -> Result<(), &'static str> {
    loop {
        let batch = match store::sync_batch(pool, account_id, *sent_stream_seq, Some(500)).await {
            Ok(batch) => batch,
            Err(StoreError::CursorExpired) => return Err("SYNC_CURSOR_EXPIRED"),
            Err(StoreError::CursorAhead) => return Err("SYNC_CURSOR_EXPIRED"),
            Err(StoreError::InvariantViolation(_)) => return Err("STREAM_SEQUENCE_GAP"),
            Err(StoreError::Database(error)) => {
                eprintln!("[chat-realtime] read durable events: {error}");
                return Err("SERVER_ERROR");
            }
            Err(_) => return Err("SERVER_ERROR"),
        };
        for event in &batch.events {
            if !event_is_within_delivery_window(event.stream_seq, acknowledged_stream_seq) {
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
                .map_err(|_| "CLIENT_TOO_SLOW")?;
            *sent_stream_seq = event.stream_seq;
        }
        if !batch.has_more {
            return Ok(());
        }
    }
}

async fn persist_device_ack(
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

async fn run_socket(
    mut socket: WebSocket,
    state: Arc<ServerState>,
    ticket: ConsumedRealtimeTicket,
    codec: CursorCodec,
) {
    match device_is_active(state.db_pool(), &ticket.account_id, &ticket.device_id).await {
        Ok(true) => {}
        Ok(false) => {
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
        Err(error) => {
            eprintln!("[chat-realtime] validate device: {error}");
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    }
    let connect_stream_seq = match receive_connect(&mut socket, &ticket, &codec).await {
        Ok(sequence) => sequence,
        Err(()) => {
            let _ = send_socket_json(
                &mut socket,
                &ErrorFrame {
                    frame_type: "error",
                    code: "INVALID_CONNECT_FRAME",
                },
            )
            .await;
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    };
    let mut sent_stream_seq = connect_stream_seq;
    let (mut sender, mut receiver): (SplitSink<_, _>, SplitStream<_>) = socket.split();
    let mut event_wake = state.chat_sync_wakes().subscribe(&ticket.account_id);
    if send_json(
        &mut sender,
        &HelloFrame {
            frame_type: "hello",
            connection_id: Uuid::now_v7(),
            protocol_version: PROTOCOL_VERSION,
            heartbeat_interval_ms: HEARTBEAT_INTERVAL.as_millis() as u64,
            max_frame_bytes: MAX_SERVER_FRAME_BYTES,
        },
    )
    .await
    .is_err()
    {
        return;
    }
    if let Err(reason) = send_available_events(
        state.db_pool(),
        &ticket.account_id,
        &codec,
        &mut sender,
        &mut sent_stream_seq,
        connect_stream_seq,
    )
    .await
    {
        resync_and_close(&mut sender, reason).await;
        return;
    }

    let mut durable_repair = tokio::time::interval(DURABLE_REPAIR_INTERVAL);
    durable_repair.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    durable_repair.tick().await;
    let mut heartbeat_check = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut device_revalidation = tokio::time::interval(DEVICE_REVALIDATION_INTERVAL);
    device_revalidation.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_liveness = tokio::time::Instant::now();
    let mut last_applied_seq = connect_stream_seq;

    loop {
        tokio::select! {
            incoming = receiver.next() => match incoming {
                Some(Ok(Message::Text(body))) => {
                    let Ok(ClientFrame::Heartbeat { last_applied_seq: applied }) =
                        serde_json::from_str::<ClientFrame>(&body)
                    else {
                        resync_and_close(&mut sender, "INVALID_CLIENT_FRAME").await;
                        return;
                    };
                    if applied < last_applied_seq || applied > sent_stream_seq {
                        resync_and_close(&mut sender, "INVALID_CLIENT_SEQUENCE").await;
                        return;
                    }
                    last_applied_seq = applied;
                    last_liveness = tokio::time::Instant::now();
                    match persist_device_ack(
                        state.db_pool(),
                        &ticket.account_id,
                        &ticket.device_id,
                        applied,
                    ).await {
                        Ok(true) => {}
                        Ok(false) => {
                            let _ = sender.send(Message::Close(None)).await;
                            return;
                        }
                        Err(error) => {
                            eprintln!("[chat-realtime] persist device ack: {error}");
                            let _ = sender.send(Message::Close(None)).await;
                            return;
                        }
                    }
                    if send_json(&mut sender, &HeartbeatAckFrame {
                        frame_type: "heartbeat_ack",
                        server_time: Utc::now(),
                    }).await.is_err() {
                        return;
                    }
                }
                Some(Ok(Message::Ping(payload))) => {
                    last_liveness = tokio::time::Instant::now();
                    if sender.send(Message::Pong(payload)).await.is_err() {
                        return;
                    }
                }
                Some(Ok(Message::Pong(_))) => {
                    last_liveness = tokio::time::Instant::now();
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => {
                    resync_and_close(&mut sender, "INVALID_CLIENT_FRAME").await;
                    return;
                }
            },
            _ = event_wake.recv() => {
                if let Err(reason) = send_available_events(
                    state.db_pool(),
                    &ticket.account_id,
                    &codec,
                    &mut sender,
                    &mut sent_stream_seq,
                    last_applied_seq,
                ).await {
                    resync_and_close(&mut sender, reason).await;
                    return;
                }
            }
            _ = durable_repair.tick() => {
                if let Err(reason) = send_available_events(
                    state.db_pool(),
                    &ticket.account_id,
                    &codec,
                    &mut sender,
                    &mut sent_stream_seq,
                    last_applied_seq,
                ).await {
                    resync_and_close(&mut sender, reason).await;
                    return;
                }
                if sent_stream_seq - last_applied_seq > MAX_UNACKNOWLEDGED_EVENTS {
                    resync_and_close(&mut sender, "CLIENT_TOO_SLOW").await;
                    return;
                }
            }
            _ = heartbeat_check.tick() => {
                if last_liveness.elapsed() > HEARTBEAT_TIMEOUT {
                    let _ = sender.send(Message::Close(None)).await;
                    return;
                }
                if sender.send(Message::Ping(Vec::new())).await.is_err() {
                    return;
                }
            }
            _ = device_revalidation.tick() => {
                match device_is_active(
                    state.db_pool(),
                    &ticket.account_id,
                    &ticket.device_id,
                ).await {
                    Ok(true) => {}
                    Ok(false) => {
                        let _ = sender.send(Message::Close(None)).await;
                        return;
                    }
                    Err(error) => {
                        eprintln!("[chat-realtime] revalidate device: {error}");
                        let _ = sender.send(Message::Close(None)).await;
                        return;
                    }
                }
            }
        }
    }
}
