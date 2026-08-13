//! WebSocket gateway endpoint.
//!
//! `/v1/cloud/ws?token=<session-token>` upgrades the connection, looks
//! the token up in `cloud_refresh_tokens`, and — if valid — subscribes
//! to NATS subjects addressed to that account. Every matching message is
//! forwarded to the WebSocket as a JSON text frame.
//!
//! # Why query-string auth
//!
//! The browser WebSocket API doesn't let pages set custom headers on
//! upgrade requests, so the standard `Authorization: Bearer …` path
//! that the HTTP API uses isn't available. The session token in the
//! query string is the same opaque value, looked up via the same
//! `lookup_session` path; rate limiting + audit happen at the same
//! Postgres ground-truth. Token leaks into URL logs are a real
//! concern, so we treat the query-string token as scoped to the WS
//! handshake only and don't accept it on any other endpoint.
//!
//! # Multi-replica fanout
//!
//! With N cloud-server pods, the WS connection lands on whichever pod
//! the Service load-balanced to. NATS is what stitches things across:
//! the publishing pod (e.g. the one handling the contact-add HTTP
//! request) and the subscribing pod (the one holding the WS) talk via
//! the broker. No Redis pubsub or cluster gossip required.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};

use crate::auth::session::{device_is_active, lookup_session};
use crate::server::ServerState;

#[derive(Debug, Deserialize)]
pub struct WsAuthQuery {
    pub token: String,
}

/// Axum handler for `/v1/cloud/ws`. Validates the session token before
/// upgrading; returns 401 on bad/expired tokens so misconfigured
/// clients get a clear signal instead of a silent close.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ServerState>>,
    Query(q): Query<WsAuthQuery>,
) -> Response {
    let pool = state.db_pool();
    let session = match lookup_session(pool, &q.token).await {
        Ok(Some(row)) => row,
        Ok(None) => return StatusCode::UNAUTHORIZED.into_response(),
        Err(err) => {
            eprintln!("[ws] lookup_session: {err}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let account_id = session.account_id;
    let device_id = session.device_id;
    ws.on_upgrade(move |socket| run_ws(socket, account_id, device_id, state))
}

#[derive(Serialize)]
struct EnvelopeFrame<'a> {
    /// The full NATS subject the message arrived on, e.g.
    /// `kordi.events.contact.added.acct_…`. Lets the client do
    /// further dispatching without re-parsing the payload.
    subject: &'a str,
    /// Original NATS payload, parsed as JSON when valid; bare string
    /// otherwise. Keeping both shapes means clients can `.payload.foo`
    /// without an inner JSON.parse roundtrip in the happy path.
    payload: serde_json::Value,
}

#[derive(Serialize)]
struct ConnectedFrame<'a> {
    event: &'static str,
    account_id: &'a str,
}

async fn run_ws(socket: WebSocket, account_id: String, device_id: String, state: Arc<ServerState>) {
    let bus = state.events().clone();
    let Some(client) = bus.nats_client() else {
        // Bus is in noop mode (no NATS_URL). Send a one-shot hello so
        // clients can tell the difference between "connected" and
        // "actually receiving events," then idle until close.
        mark_presence_online_on_websocket_connect(&state, &account_id, &device_id).await;
        idle_without_nats(socket, &state, &account_id, &device_id).await;
        let disconnected_at = Utc::now();
        mark_presence_offline_on_websocket_disconnect(
            &state,
            &account_id,
            &device_id,
            disconnected_at,
        )
        .await;
        return;
    };

    let subjects = account_event_subjects(&account_id);
    let mut general_sub = match client.subscribe(subjects[0].clone()).await {
        Ok(s) => s,
        Err(err) => {
            eprintln!("[ws] subscribe '{}': {err}", subjects[0]);
            let _ = close_with_message(socket, "subscribe failed").await;
            return;
        }
    };
    let mut contact_request_sub = match client.subscribe(subjects[1].clone()).await {
        Ok(s) => s,
        Err(err) => {
            eprintln!("[ws] subscribe '{}': {err}", subjects[1]);
            let _ = general_sub.unsubscribe().await;
            let _ = close_with_message(socket, "subscribe failed").await;
            return;
        }
    };
    let mut presence_sub = match client.subscribe(subjects[2].clone()).await {
        Ok(s) => s,
        Err(err) => {
            eprintln!("[ws] subscribe '{}': {err}", subjects[2]);
            let _ = general_sub.unsubscribe().await;
            let _ = contact_request_sub.unsubscribe().await;
            let _ = close_with_message(socket, "subscribe failed").await;
            return;
        }
    };
    let control_subject = format!("kordi.device.control.{device_id}");
    let mut device_control_sub = match client.subscribe(control_subject.clone()).await {
        Ok(subscription) => subscription,
        Err(err) => {
            eprintln!("[ws] subscribe '{control_subject}': {err}");
            let _ = general_sub.unsubscribe().await;
            let _ = contact_request_sub.unsubscribe().await;
            let _ = presence_sub.unsubscribe().await;
            let _ = close_with_message(socket, "subscribe failed").await;
            return;
        }
    };

    let (mut sender, mut receiver) = socket.split();

    // Initial frame so the client knows the subscription is live.
    let hello = serde_json::to_string(&ConnectedFrame {
        event: "connected",
        account_id: &account_id,
    })
    .unwrap_or_else(|_| String::from(r#"{"event":"connected"}"#));
    if sender.send(Message::Text(hello)).await.is_err() {
        return;
    }
    mark_presence_online_on_websocket_connect(&state, &account_id, &device_id).await;
    let mut device_revalidation = tokio::time::interval(Duration::from_secs(2));
    device_revalidation.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            biased;

            incoming = receiver.next() => match incoming {
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(Message::Ping(p))) => {
                    if sender.send(Message::Pong(p)).await.is_err() { break; }
                }
                Some(Ok(_)) => {
                    // Client text/binary frames are ignored for now —
                    // the gateway is read-only until message-send is
                    // wired.
                }
                Some(Err(err)) => {
                    eprintln!("[ws] socket error: {err}");
                    break;
                }
            },

            event = general_sub.next() => match event {
                Some(msg) => {
                    let Some(body) = envelope_body(msg.subject.as_str(), &msg.payload) else { continue; };
                    if sender.send(Message::Text(body)).await.is_err() { break; }
                }
                None => break,
            },

            event = contact_request_sub.next() => match event {
                Some(msg) => {
                    let Some(body) = envelope_body(msg.subject.as_str(), &msg.payload) else { continue; };
                    if sender.send(Message::Text(body)).await.is_err() { break; }
                }
                None => break,
            },

            event = presence_sub.next() => match event {
                Some(msg) => {
                    let Some(body) = envelope_body(msg.subject.as_str(), &msg.payload) else { continue; };
                    if sender.send(Message::Text(body)).await.is_err() { break; }
                }
                None => break,
            },

            event = device_control_sub.next() => {
                if event.is_some() {
                    let _ = sender.send(Message::Close(None)).await;
                }
                break;
            },

            _ = device_revalidation.tick() => {
                match device_is_active(state.db_pool(), &account_id, &device_id).await {
                    Ok(true) => {}
                    Ok(false) => {
                        let _ = sender.send(Message::Close(None)).await;
                        break;
                    }
                    Err(error) => {
                        eprintln!("[ws] revalidate device: {error}");
                        let _ = sender.send(Message::Close(None)).await;
                        break;
                    }
                }
            },
        }
    }

    // Best-effort unsubscribe on the way out so the broker doesn't keep
    // a dangling consumer for a closed socket.
    let _ = general_sub.unsubscribe().await;
    let _ = contact_request_sub.unsubscribe().await;
    let _ = presence_sub.unsubscribe().await;
    let _ = device_control_sub.unsubscribe().await;
    let disconnected_at = Utc::now();
    mark_presence_offline_on_websocket_disconnect(&state, &account_id, &device_id, disconnected_at)
        .await;
}

const WS_DISCONNECT_OFFLINE_GRACE: Duration = Duration::from_secs(2);

fn should_mark_presence_offline_on_websocket_disconnect(account_id: &str, device_id: &str) -> bool {
    !account_id.trim().is_empty() && !device_id.trim().is_empty()
}

async fn publish_presence_if_changed(
    state: &Arc<ServerState>,
    account_id: &str,
    before: crate::presence::AccountPresenceStatus,
    after: crate::presence::AccountPresenceStatus,
) {
    if before == after {
        return;
    }
    if let Err(err) = crate::presence::publish_presence_to_observers(
        state.db_pool(),
        state.events(),
        account_id,
        after,
    )
    .await
    {
        eprintln!("[ws] publish presence change: {err}");
    }
}

async fn account_presence_or_offline(
    state: &Arc<ServerState>,
    account_id: &str,
) -> crate::presence::AccountPresenceStatus {
    crate::presence::account_presence_status(
        state.db_pool(),
        account_id,
        Utc::now(),
        crate::presence::presence_timeout(),
    )
    .await
    .map(|summary| summary.status)
    .unwrap_or(crate::presence::AccountPresenceStatus::Offline)
}

async fn mark_presence_online_on_websocket_connect(
    state: &Arc<ServerState>,
    account_id: &str,
    device_id: &str,
) {
    if !should_mark_presence_offline_on_websocket_disconnect(account_id, device_id) {
        return;
    }
    let before = account_presence_or_offline(state, account_id).await;
    match crate::presence::mark_device_online(state.db_pool(), account_id, device_id).await {
        Ok(summary) => publish_presence_if_changed(state, account_id, before, summary.status).await,
        Err(err) => eprintln!("[ws] mark presence online on connect: {err}"),
    }
}

async fn mark_presence_offline_on_websocket_disconnect(
    state: &Arc<ServerState>,
    account_id: &str,
    device_id: &str,
    disconnected_at: chrono::DateTime<Utc>,
) {
    if !should_mark_presence_offline_on_websocket_disconnect(account_id, device_id) {
        return;
    }
    tokio::time::sleep(WS_DISCONNECT_OFFLINE_GRACE).await;
    let before = account_presence_or_offline(state, account_id).await;
    match crate::presence::mark_device_offline_if_heartbeat_not_after(
        state.db_pool(),
        account_id,
        device_id,
        disconnected_at,
    )
    .await
    {
        Ok(Some(summary)) => {
            publish_presence_if_changed(state, account_id, before, summary.status).await
        }
        Ok(None) => {}
        Err(err) => eprintln!("[ws] mark presence offline on disconnect: {err}"),
    }
}

fn account_event_subjects(account_id: &str) -> Vec<String> {
    vec![
        // Three-token account lifecycle events such as contact.added.
        format!("kordi.events.*.*.{account_id}"),
        // Four-token contact-request events: contact.request.created,
        // contact.request.accepted, contact.request.rejected. These did not
        // match the general subject above, causing recipient request badges to
        // wait for the 15s polling fallback.
        format!("kordi.events.contact.request.*.{account_id}"),
        // Presence events are addressed directly to each observer account.
        format!("kordi.events.presence.account.{account_id}"),
    ]
}

fn envelope_body(subject: &str, payload_bytes: &[u8]) -> Option<String> {
    let payload = parse_json_or_string(payload_bytes);
    let frame = EnvelopeFrame { subject, payload };
    match serde_json::to_string(&frame) {
        Ok(value) => Some(value),
        Err(err) => {
            eprintln!("[ws] serialize envelope: {err}");
            None
        }
    }
}

async fn idle_without_nats(
    mut socket: WebSocket,
    state: &Arc<ServerState>,
    account_id: &str,
    device_id: &str,
) {
    let frame = serde_json::to_string(&ConnectedFrame {
        event: "connected_no_events",
        account_id,
    })
    .unwrap_or_else(|_| String::from(r#"{"event":"connected_no_events"}"#));
    let _ = socket.send(Message::Text(frame)).await;
    let mut device_revalidation = tokio::time::interval(Duration::from_secs(2));
    loop {
        tokio::select! {
            message = socket.recv() => match message {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                _ => {}
            },
            _ = device_revalidation.tick() => {
                match device_is_active(state.db_pool(), account_id, device_id).await {
                    Ok(true) => {}
                    Ok(false) | Err(_) => {
                        let _ = socket.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
        }
    }
}

async fn close_with_message(mut socket: WebSocket, msg: &str) -> Result<(), axum::Error> {
    let _ = socket
        .send(Message::Text(format!(r#"{{"error":"{msg}"}}"#)))
        .await;
    socket.send(Message::Close(None)).await
}

fn parse_json_or_string(bytes: &[u8]) -> serde_json::Value {
    match serde_json::from_slice::<serde_json::Value>(bytes) {
        Ok(value) => value,
        Err(_) => serde_json::Value::String(String::from_utf8_lossy(bytes).into_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::{account_event_subjects, should_mark_presence_offline_on_websocket_disconnect};

    #[test]
    fn account_event_subjects_include_contact_request_events() {
        let subjects = account_event_subjects("acct_peer");

        assert!(subjects.contains(&"kordi.events.*.*.acct_peer".to_string()));
        assert!(subjects.contains(&"kordi.events.contact.request.*.acct_peer".to_string()));
    }

    #[test]
    fn websocket_subscribes_to_presence_account_events() {
        let subjects = account_event_subjects("acct_1");
        assert!(subjects.contains(&"kordi.events.presence.account.acct_1".to_string()));
    }

    #[test]
    fn websocket_disconnect_marks_authenticated_device_offline() {
        assert!(should_mark_presence_offline_on_websocket_disconnect(
            "acct_1", "dev_1"
        ));
        assert!(!should_mark_presence_offline_on_websocket_disconnect(
            "", "dev_1"
        ));
        assert!(!should_mark_presence_offline_on_websocket_disconnect(
            "acct_1", ""
        ));
    }
}
