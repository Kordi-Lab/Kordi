//! Wire frames of the realtime protocol and the helpers that send them.

use axum::extract::ws::{Message, WebSocket};
use chrono::{DateTime, Utc};
use futures_util::stream::SplitSink;
use futures_util::SinkExt;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::ticket::ConsumedRealtimeTicket;
use super::{CONNECT_TIMEOUT, MAX_SERVER_FRAME_BYTES, SEND_TIMEOUT};
use crate::chat_sync::cursor::CursorCodec;
use crate::chat_sync::models::SyncEventSnapshot;
use crate::chat_sync::PROTOCOL_VERSION;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum ClientFrame {
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
pub(super) struct HelloFrame {
    #[serde(rename = "type")]
    pub(super) frame_type: &'static str,
    pub(super) connection_id: Uuid,
    pub(super) protocol_version: i32,
    pub(super) heartbeat_interval_ms: u64,
    pub(super) max_frame_bytes: usize,
}

#[derive(Serialize)]
pub(super) struct EventFrame<'a> {
    #[serde(rename = "type")]
    pub(super) frame_type: &'static str,
    pub(super) stream_seq: i64,
    pub(super) cursor: String,
    pub(super) event: &'a SyncEventSnapshot,
}

#[derive(Serialize)]
pub(super) struct HeartbeatAckFrame {
    #[serde(rename = "type")]
    pub(super) frame_type: &'static str,
    pub(super) server_time: DateTime<Utc>,
}

#[derive(Serialize)]
struct ResyncRequiredFrame<'a> {
    #[serde(rename = "type")]
    frame_type: &'static str,
    reason: &'a str,
}

#[derive(Serialize)]
pub(super) struct ErrorFrame<'a> {
    #[serde(rename = "type")]
    pub(super) frame_type: &'static str,
    pub(super) code: &'a str,
}

pub(super) async fn send_json<T: Serialize>(
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

pub(super) async fn send_socket_json<T: Serialize>(
    socket: &mut WebSocket,
    value: &T,
) -> Result<(), ()> {
    let body = serde_json::to_string(value).map_err(|_| ())?;
    if body.len() > MAX_SERVER_FRAME_BYTES {
        return Err(());
    }
    tokio::time::timeout(SEND_TIMEOUT, socket.send(Message::Text(body)))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

pub(super) async fn receive_connect(
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

pub(super) async fn resync_and_close(sender: &mut SplitSink<WebSocket, Message>, reason: &str) {
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
