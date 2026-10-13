//! `GET /v1/cloud/documents/:attachment_id/collab?ticket=...`: the room socket.
//!
//! Binary frames only, carrying y-protocols messages exactly as `y-websocket`
//! sends them: sync (0) and awareness (1), plus awareness queries (3). Close
//! codes: 4401 bad or used ticket, 4403 access revoked, 4409 unsupported
//! message, 1011 server error, 1013 the client fell too far behind.

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

use super::rooms::{Room, RoomError};
use super::tickets::{consume_ticket, ConsumedTicket, TicketError};
use crate::auth::routes::CloudSession;
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

/// Whether the ticket's session is still signed in and its account may
/// still edit the document it was issued for.
pub(crate) async fn still_allowed(state: &ServerState, ticket: &ConsumedTicket) -> bool {
    let pool = state.db_pool();
    let active = crate::auth::session::session_is_active(
        pool,
        &ticket.account_id,
        &ticket.device_id,
        &ticket.session_token_id,
    )
    .await
    .unwrap_or(false);
    if !active {
        return false;
    }
    let session = CloudSession {
        token_id: ticket.session_token_id.clone(),
        account_id: ticket.account_id.clone(),
        device_id: ticket.device_id.clone(),
    };
    match authorized_document(state, &session, &ticket.requested_attachment_id).await {
        Ok((record, viewer)) => {
            record.attachment_id == ticket.attachment_id
                && can_edit(pool, &record, viewer, &ticket.account_id)
                    .await
                    .unwrap_or(false)
        }
        Err(_) => false,
    }
}

async fn run(mut socket: WebSocket, state: Arc<ServerState>, ticket: ConsumedTicket) {
    if !still_allowed(&state, &ticket).await {
        return close(socket, CLOSE_FORBIDDEN, "forbidden").await;
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
    let close_code = serve(&mut socket, &state, &room, &ticket, conn, &mut clients).await;
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
    ticket: &ConsumedTicket,
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
    let mut revalidate = tokio::time::interval(REVALIDATE_EVERY);
    revalidate.tick().await;
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
            _ = revalidate.tick() => {
                if !still_allowed(state, ticket).await {
                    return Some((CLOSE_FORBIDDEN, "forbidden"));
                }
            }
        }
    }
}
