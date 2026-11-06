//! `GET /v1/cloud/documents/:attachment_id/collab?ticket=...`: the room socket.
//!
//! Binary frames only, carrying y-protocols messages exactly as `y-websocket`
//! sends them: sync (0) and awareness (1), plus awareness queries (3). Close
//! codes: 4401 bad or used ticket, 4403 access revoked, 4409 unsupported
//! message, 1011 server error, 1013 the client fell too far behind.
//!
//! Sign-out and device revocation arrive as session signals and close the
//! socket at once. Document access is rechecked every ~30 s (jittered); a
//! database error retries with backoff and closes only after the failure
//! grace, so a short outage does not disconnect every editor.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::header::ORIGIN;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use tokio::sync::broadcast::error::RecvError;
use tokio::time::Instant;

use super::rooms::{Room, RoomError};
use super::tickets::{consume_ticket, ConsumedTicket, TicketError};
use crate::auth::routes::CloudSession;
use crate::auth::session_signals::{SessionSignalSubscription, SignalVerdict};
use crate::chat_sync::realtime::retry::{jittered, Backoff, FAILURE_GRACE};
use crate::document_shares::access::authorized_document;
use crate::document_shares::canonical::can_edit;
use crate::server::ServerState;

pub(crate) const CLOSE_BAD_TICKET: u16 = 4401;
pub(crate) const CLOSE_FORBIDDEN: u16 = 4403;
pub(crate) const CLOSE_UNSUPPORTED: u16 = 4409;
const CLOSE_SERVER_ERROR: u16 = 1011;
const CLOSE_TRY_AGAIN: u16 = 1013;
const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
const REVALIDATE_EVERY: Duration = Duration::from_secs(30);

static NEXT_CONNECTION: AtomicU64 = AtomicU64::new(1);

#[derive(Deserialize)]
pub struct CollabQuery {
    #[serde(default)]
    ticket: String,
}

pub(crate) async fn collab_socket(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ServerState>>,
    Path(attachment_id): Path<String>,
    Query(query): Query<CollabQuery>,
    headers: HeaderMap,
) -> Response {
    let origin = headers
        .get(ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(ToString::to_string);
    let ticket = match consume_ticket(state.db_pool(), &query.ticket).await {
        Ok(ticket)
            if ticket.allowed_origin == origin
                && (ticket.requested_attachment_id == attachment_id
                    || ticket.attachment_id == attachment_id) =>
        {
            Some(ticket)
        }
        Ok(_) | Err(TicketError::InvalidTicket | TicketError::OriginNotAllowed) => None,
        Err(TicketError::Database(error)) => {
            eprintln!("[document-collab] consume ticket: {error}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    ws.max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| async move {
            match ticket {
                Some(ticket) => run(socket, state, ticket).await,
                None => close(socket, CLOSE_BAD_TICKET, "ticket").await,
            }
        })
}

async fn close(mut socket: WebSocket, code: u16, reason: &'static str) {
    let _ = socket
        .send(WsMessage::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Access {
    Allowed,
    Denied,
    /// The database could not answer; the verdict is unknown.
    Unavailable,
}

/// Whether the ticket's session is still signed in and its account may
/// still edit the document it was issued for.
pub(crate) async fn check_access(state: &ServerState, ticket: &ConsumedTicket) -> Access {
    let pool = state.db_pool();
    match crate::auth::session::session_is_active(
        pool,
        &ticket.account_id,
        &ticket.device_id,
        &ticket.session_token_id,
    )
    .await
    {
        Ok(true) => {}
        Ok(false) => return Access::Denied,
        Err(error) => {
            eprintln!("[document-collab] revalidate session: {error}");
            return Access::Unavailable;
        }
    }
    let session = CloudSession {
        token_id: ticket.session_token_id.clone(),
        account_id: ticket.account_id.clone(),
        device_id: ticket.device_id.clone(),
    };
    match authorized_document(state, &session, &ticket.requested_attachment_id).await {
        Ok((record, _)) if record.attachment_id != ticket.attachment_id => Access::Denied,
        Ok((record, viewer)) => match can_edit(pool, &record, viewer, &ticket.account_id).await {
            Ok(true) => Access::Allowed,
            Ok(false) => Access::Denied,
            Err(_) => Access::Unavailable,
        },
        Err(response) if response.status().is_server_error() => Access::Unavailable,
        Err(_) => Access::Denied,
    }
}

async fn run(mut socket: WebSocket, state: Arc<ServerState>, ticket: ConsumedTicket) {
    // Subscribe before checking, so a revocation after the check still lands.
    let mut signals = state.session_signals().subscribe(
        &ticket.account_id,
        &ticket.device_id,
        Some(&ticket.session_token_id),
    );
    match check_access(&state, &ticket).await {
        Access::Allowed => {}
        Access::Denied => return close(socket, CLOSE_FORBIDDEN, "forbidden").await,
        Access::Unavailable => return close(socket, CLOSE_SERVER_ERROR, "unavailable").await,
    }
    let pool = state.db_pool().clone();
    let registry = state.document_rooms();
    let room = match registry.join(&pool, &ticket.attachment_id).await {
        Ok(room) => room,
        Err(error) => {
            eprintln!("[document-collab] join room: {error:?}");
            return close(socket, CLOSE_SERVER_ERROR, "room").await;
        }
    };
    let conn = NEXT_CONNECTION.fetch_add(1, Ordering::Relaxed);
    let mut clients = HashSet::new();
    let close_code = serve(
        &mut socket,
        &state,
        &room,
        (&ticket, &mut signals),
        conn,
        &mut clients,
    )
    .await;
    registry.leave(&pool, &room, conn, &clients).await;
    if let Some((code, reason)) = close_code {
        close(socket, code, reason).await;
    }
}

/// Runs the connection until it ends; returns the close code to send.
async fn serve(
    socket: &mut WebSocket,
    state: &ServerState,
    room: &Arc<Room>,
    (ticket, signals): (&ConsumedTicket, &mut SessionSignalSubscription),
    conn: u64,
    clients: &mut HashSet<yrs::ClientID>,
) -> Option<(u16, &'static str)> {
    let pool = state.db_pool();
    let mut outgoing = room.subscribe();
    for frame in room.greeting().await {
        if socket.send(WsMessage::Binary(frame)).await.is_err() {
            return None;
        }
    }
    let mut next_check = Instant::now() + jittered(REVALIDATE_EVERY);
    let mut failing_since = None;
    let mut backoff = Backoff::default();
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(WsMessage::Binary(data))) => {
                    match room.handle(pool, conn, &data, clients).await {
                        Ok(replies) => {
                            for reply in replies {
                                if socket.send(WsMessage::Binary(reply)).await.is_err() {
                                    return None;
                                }
                            }
                        }
                        Err(RoomError::Invalid) => return Some((CLOSE_UNSUPPORTED, "unsupported")),
                        Err(RoomError::Database(error)) => {
                            eprintln!("[document-collab] apply update: {error}");
                            return Some((CLOSE_SERVER_ERROR, "storage"));
                        }
                    }
                }
                Some(Ok(WsMessage::Text(_))) => return Some((CLOSE_UNSUPPORTED, "binary only")),
                Some(Ok(WsMessage::Ping(_) | WsMessage::Pong(_))) => {}
                Some(Ok(WsMessage::Close(_))) | Some(Err(_)) | None => return None,
            },
            sent = outgoing.recv() => match sent {
                Ok(message) if message.from == conn => {}
                Ok(message) => {
                    if socket.send(WsMessage::Binary(message.frame.as_ref().clone())).await.is_err() {
                        return None;
                    }
                }
                Err(RecvError::Lagged(_)) => return Some((CLOSE_TRY_AGAIN, "behind")),
                Err(RecvError::Closed) => return None,
            },
            verdict = signals.recv() => match verdict {
                SignalVerdict::Close => return Some((CLOSE_FORBIDDEN, "forbidden")),
                SignalVerdict::Recheck => next_check = Instant::now(),
            },
            _ = tokio::time::sleep_until(next_check) => {
                let now = Instant::now();
                match check_access(state, ticket).await {
                    Access::Allowed => {
                        failing_since = None;
                        backoff = Backoff::default();
                        next_check = now + jittered(REVALIDATE_EVERY);
                    }
                    Access::Denied => return Some((CLOSE_FORBIDDEN, "forbidden")),
                    Access::Unavailable => {
                        if now.duration_since(*failing_since.get_or_insert(now)) >= FAILURE_GRACE {
                            return Some((CLOSE_SERVER_ERROR, "unavailable"));
                        }
                        next_check = now + backoff.next_delay();
                    }
                }
            }
        }
    }
}
