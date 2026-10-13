//! Collaborative editing rooms for shared documents (Yjs).
//!
//! One room per canonical Markdown document. Editors get a single-use
//! ticket, open the socket, and speak y-protocols sync v1 plus awareness as
//! the `y-websocket` provider does. The first editor of a new room is
//! granted the job of building the Y document from Markdown; Markdown
//! snapshots keep flowing through `PUT /content` with `"mode": "snapshot"`.
//! Contract: `docs/development/issue-1741-shared-documents.md`.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{header::ORIGIN, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::Serialize;

use super::access::{authorized_document, DocumentRecord};
use super::canonical::can_edit;
use super::events::current_revision;
use super::model::DocumentFormat;
use super::{db_error, err};
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision, DOCUMENT_COLLAB_TICKET_LIMIT};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

mod rooms;
mod socket;
pub(crate) mod store;
pub(crate) mod tickets;

#[cfg(test)]
mod tests;

pub use rooms::RoomRegistry;

/// Routes that need a signed-in session (mounted behind the session layer).
pub(crate) fn protected_routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route(
            "/v1/cloud/documents/:attachment_id/collab/ticket",
            post(issue_ticket),
        )
        .route(
            "/v1/cloud/documents/:attachment_id/collab/init",
            post(init_room),
        )
}

/// The socket route; authenticated by its ticket.
pub(crate) fn socket_routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route(
            "/v1/cloud/documents/:attachment_id/collab",
            get(socket::collab_socket),
        )
        .with_state(state)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TicketResponse {
    ticket: String,
    url: String,
    expires_in_seconds: i64,
    /// A revisioned save landed while the room existed; this editor should
    /// replace blocks whose Markdown changed. Reported once.
    stale_revision: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InitResponse {
    initialize: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    revision: Option<i64>,
}

/// The document a signed-in editor may collaborate on: Markdown only, for
/// the owner and active members of a family conversation.
async fn collaborative_document(
    state: &ServerState,
    session: &CloudSession,
    attachment_id: &str,
) -> Result<DocumentRecord, Box<Response>> {
    let (record, viewer) = authorized_document(state, session, attachment_id).await?;
    if record.format != DocumentFormat::Markdown {
        return Err(Box::new(err(
            "document_not_collaborative",
            "Only Markdown documents can be edited together.",
            StatusCode::CONFLICT,
        )));
    }
    let allowed = can_edit(state.db_pool(), &record, viewer, &session.account_id)
        .await
        .map_err(|_| db_error())?;
    if !allowed {
        return Err(Box::new(err(
            "document_edit_forbidden",
            "You can't edit this document.",
            StatusCode::FORBIDDEN,
        )));
    }
    Ok(record)
}

/// `POST /v1/cloud/documents/:attachment_id/collab/ticket`
async fn issue_ticket(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let RateLimitDecision::Limited { .. } = rate_limiter
        .observe_account_limit(DOCUMENT_COLLAB_TICKET_LIMIT, &session.account_id)
        .await
    {
        return err(
            "rate_limited",
            "Too many attempts. Try again shortly.",
            StatusCode::TOO_MANY_REQUESTS,
        );
    }
    let record = match collaborative_document(&state, &session, &attachment_id).await {
        Ok(record) => record,
        Err(response) => return *response,
    };
    let pool = state.db_pool();
    let origin = headers.get(ORIGIN).and_then(|value| value.to_str().ok());
    let issued = tickets::issue_ticket(
        pool,
        tickets::TicketRequest {
            attachment_id: &record.attachment_id,
            requested_attachment_id: &attachment_id,
            account_id: &session.account_id,
            device_id: &session.device_id,
            session_token_id: &session.token_id,
            origin,
        },
    )
    .await;
    let ticket = match issued {
        Ok(ticket) => ticket,
        Err(tickets::TicketError::OriginNotAllowed) => {
            return err(
                "origin_not_allowed",
                "This app origin can't open a collaboration socket.",
                StatusCode::FORBIDDEN,
            )
        }
        Err(tickets::TicketError::InvalidTicket) => {
            return err(
                "invalid_session",
                "Session is expired or revoked.",
                StatusCode::UNAUTHORIZED,
            )
        }
        Err(tickets::TicketError::Database(_)) => return db_error(),
    };
    let stale_revision = match store::take_stale_flag(pool, &record.attachment_id).await {
        Ok(stale) => stale,
        Err(_) => return db_error(),
    };
    Json(TicketResponse {
        ticket,
        url: format!("/v1/cloud/documents/{attachment_id}/collab"),
        expires_in_seconds: tickets::TICKET_LIFETIME_SECONDS,
        stale_revision,
    })
    .into_response()
}

/// `POST /v1/cloud/documents/:attachment_id/collab/init`
async fn init_room(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
) -> Response {
    let record = match collaborative_document(&state, &session, &attachment_id).await {
        Ok(record) => record,
        Err(response) => return *response,
    };
    let pool = state.db_pool();
    // The grantee seeds from the current Markdown revision.
    if let Err(response) = super::contents::document_source(&state, &record).await {
        return *response;
    }
    match store::take_init_grant(pool, &record.attachment_id, &session.account_id).await {
        Ok(true) => Json(InitResponse {
            initialize: true,
            revision: Some(current_revision(pool, &record.attachment_id).await),
        })
        .into_response(),
        Ok(false) => Json(InitResponse {
            initialize: false,
            revision: None,
        })
        .into_response(),
        Err(_) => db_error(),
    }
}
