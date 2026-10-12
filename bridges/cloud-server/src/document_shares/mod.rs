//! Shared documents (issue 1741).
//!
//! Agent-written Markdown and HTML attachments open as documents and can be
//! shared through a public link that works without a Kordi account.
//! Reactions and comments are anchored to document blocks and keyed by the
//! attachment, so revoking a link keeps what people wrote. The server owns
//! block identity, renders the public page, and makes every access check.
//!
//! Contract: `docs/development/issue-1741-shared-documents.md`.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Extension, Json, Router};
use chrono::Utc;
use serde::Serialize;
use sqlx_core::query::query;
use sqlx_postgres::PgPool;

use crate::auth::rate_limit::{
    rate_limit_client_key, CloudRateLimiter, RateLimitDecision, DOCUMENT_PUBLIC_READ_LIMIT,
    DOCUMENT_PUBLIC_WRITE_LIMIT,
};
use crate::server::ServerState;

pub(crate) mod access;
pub(crate) mod canonical;
mod comments;
pub(crate) mod contents;
mod documents;
mod editing;
pub(crate) mod events;
pub(crate) mod inline_formats;
pub mod model;
mod public_page;
mod reactions;
pub(crate) mod render;
mod shares;
mod sources;
pub(crate) mod tokens;
pub(crate) mod validate;

#[cfg(test)]
mod tests;

pub use model::{
    DocumentComment, DocumentReaction, DocumentResponse, DocumentShare, DocumentShareList,
};

pub fn routes(state: Arc<ServerState>, rate_limiter: Arc<CloudRateLimiter>) -> Router {
    let public = Router::new()
        .route("/d/:token", get(public_page::page))
        .route("/d/:token/raw", get(public_page::raw))
        .route(
            "/v1/cloud/public/documents/:token",
            get(documents::get_public_document),
        )
        .route(
            "/v1/cloud/public/documents/:token/reactions",
            post(reactions::react_public),
        )
        .route(
            "/v1/cloud/public/documents/:token/comments",
            post(comments::comment_public),
        )
        .layer(Extension(rate_limiter.clone()))
        .with_state(state.clone());

    let protected = Router::new()
        .route(
            "/v1/cloud/documents/shares/:share_id",
            patch(shares::patch_share).delete(shares::revoke_share),
        )
        .route(
            "/v1/cloud/documents/comments/:comment_id",
            patch(comments::patch_comment).delete(comments::delete_comment),
        )
        .route(
            "/v1/cloud/documents/:attachment_id",
            get(documents::get_document),
        )
        .route(
            "/v1/cloud/documents/:attachment_id/content",
            axum::routing::put(editing::save_content).layer(axum::extract::DefaultBodyLimit::max(
                4 * editing::MAX_EDIT_BYTES,
            )),
        )
        .route(
            "/v1/cloud/documents/:attachment_id/source",
            post(sources::link_source),
        )
        .route(
            "/v1/cloud/documents/:attachment_id/raw",
            get(documents::get_raw),
        )
        .route(
            "/v1/cloud/documents/:attachment_id/shares",
            get(shares::list_shares).post(shares::create_share),
        )
        .route(
            "/v1/cloud/documents/:attachment_id/reactions",
            post(reactions::react),
        )
        .route(
            "/v1/cloud/documents/:attachment_id/comments",
            post(comments::comment),
        )
        .layer(Extension(rate_limiter))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::auth::routes::cloud_session_middleware,
        ))
        .with_state(state);

    public.merge(protected)
}

/// Who is asking: a signed-in account, or a public reader with the
/// reader key they keep in their browser or app (if they sent one).
#[derive(Debug, Clone)]
pub(crate) enum Caller {
    Account(String),
    Reader(Option<String>),
}

impl Caller {
    pub(crate) fn is_public(&self) -> bool {
        matches!(self, Self::Reader(_))
    }

    /// Whether a row written by `account_id` or `reader_key` is the caller's.
    pub(crate) fn owns(&self, account_id: Option<&str>, reader_key: Option<&str>) -> bool {
        match self {
            Self::Account(own) => account_id == Some(own.as_str()),
            Self::Reader(Some(own)) => reader_key == Some(own.as_str()),
            Self::Reader(None) => false,
        }
    }

    /// The signed-in account, or `None` for public readers.
    pub(crate) fn account_id(&self) -> Option<&str> {
        match self {
            Self::Account(own) => Some(own.as_str()),
            Self::Reader(_) => None,
        }
    }

    /// The actor columns for a write.
    pub(crate) fn columns(&self) -> (Option<&str>, Option<&str>) {
        match self {
            Self::Account(own) => (Some(own.as_str()), None),
            Self::Reader(key) => (None, key.as_deref()),
        }
    }
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    #[serde(rename = "errorCode")]
    error_code: &'a str,
    message: &'a str,
}

pub(crate) fn err(code: &str, message: &str, status: StatusCode) -> Response {
    (
        status,
        Json(ErrorBody {
            error_code: code,
            message,
        }),
    )
        .into_response()
}

pub(crate) fn db_error() -> Response {
    err(
        "server_error",
        "Database error.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

/// Revoked, unknown, and malformed tokens all answer this.
pub(crate) fn link_off() -> Response {
    err(
        "document_link_off",
        "This link is off",
        StatusCode::NOT_FOUND,
    )
}

pub(crate) fn limit_reached() -> Response {
    err(
        "document_limit_reached",
        "This document has too many reactions or comments.",
        StatusCode::TOO_MANY_REQUESTS,
    )
}

pub(crate) fn invalid_reader_key() -> Response {
    err(
        "invalid_reader_key",
        "readerKey must be 16 to 64 URL-safe characters.",
        StatusCode::BAD_REQUEST,
    )
}

pub(crate) fn invalid_reader_name() -> Response {
    err(
        "invalid_reader_name",
        "Enter a name of 1 to 40 characters.",
        StatusCode::BAD_REQUEST,
    )
}

/// Which per-address budget a public request charges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PublicAccess {
    Read,
    Write,
}

/// Charges one public request to the caller's address: reads against
/// [`DOCUMENT_PUBLIC_READ_LIMIT`], reactions and comments against
/// [`DOCUMENT_PUBLIC_WRITE_LIMIT`]. These budgets are separate from the
/// sign-in limit, so reading a document never uses up login attempts.
pub(crate) async fn observe_public(
    rate_limiter: &CloudRateLimiter,
    headers: &HeaderMap,
    connect_info: Option<&ConnectInfo<SocketAddr>>,
    access: PublicAccess,
) -> Result<(), Box<Response>> {
    let peer = connect_info.map(|info| info.0.ip());
    let client = crate::client_ip::resolve_client_ip(headers, peer);
    observe_public_address(rate_limiter, client, access).await
}

pub(crate) async fn observe_public_address(
    rate_limiter: &CloudRateLimiter,
    client: Option<IpAddr>,
    access: PublicAccess,
) -> Result<(), Box<Response>> {
    let limit = match access {
        PublicAccess::Read => DOCUMENT_PUBLIC_READ_LIMIT,
        PublicAccess::Write => DOCUMENT_PUBLIC_WRITE_LIMIT,
    };
    let key = rate_limit_client_key(client).to_string();
    match rate_limiter.observe_account_limit(limit, &key).await {
        RateLimitDecision::Allowed => Ok(()),
        RateLimitDecision::Limited { retry_after } => {
            let mut response = err(
                "rate_limited",
                "Too many attempts. Try again shortly.",
                StatusCode::TOO_MANY_REQUESTS,
            );
            if let Ok(value) = retry_after.as_secs().max(1).to_string().parse() {
                response.headers_mut().insert("Retry-After", value);
            }
            Err(Box::new(response))
        }
    }
}

/// Checks that `block_id` names a block of the document: `b0` for HTML, an
/// existing top-level block for Markdown.
pub(crate) async fn require_block(
    state: &ServerState,
    record: &access::DocumentRecord,
    block_id: &str,
) -> Result<(), Box<Response>> {
    let invalid = || {
        err(
            "invalid_block",
            "That part of the document no longer exists.",
            StatusCode::BAD_REQUEST,
        )
    };
    if !validate::is_valid_block_id(block_id) {
        return Err(Box::new(invalid()));
    }
    let exists = match record.format {
        model::DocumentFormat::Html => block_id == "b0",
        model::DocumentFormat::Markdown => {
            let source = contents::document_source(state, record).await?.text;
            let index: usize = block_id[1..].parse().map_err(|_| invalid())?;
            index < render::markdown_blocks(&source).len()
        }
    };
    if exists {
        Ok(())
    } else {
        Err(Box::new(invalid()))
    }
}

/// Records an audit event, like the auth routes do.
pub(crate) async fn write_audit(
    pool: &PgPool,
    account_id: Option<&str>,
    device_id: Option<&str>,
    event_type: &str,
    metadata: serde_json::Value,
) -> Result<(), sqlx_core::Error> {
    query(
        "INSERT INTO cloud_audit_events \
         (event_id, account_id, device_id, event_type, metadata_json, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(format!("evt_{}", uuid::Uuid::new_v4().simple()))
    .bind(account_id)
    .bind(device_id)
    .bind(event_type)
    .bind(metadata.to_string())
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}
