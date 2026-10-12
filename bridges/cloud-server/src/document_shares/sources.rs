//! `POST /v1/cloud/documents/:attachment_id/source`: links a forwarded copy
//! to the document it was forwarded from.
//!
//! Clients call it right after uploading a forwarded Markdown or HTML
//! attachment and before sending the message. The copy then resolves to the
//! canonical document on every route.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::access::authorized_document;
use super::canonical::canonical_attachment_id;
use super::contents::document_source;
use super::documents::signed_in_response;
use super::model::LinkSourceRequest;
use super::{db_error, err};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

fn not_found() -> Response {
    err("not_found", "Attachment not found.", StatusCode::NOT_FOUND)
}

fn forbidden() -> Response {
    err(
        "document_source_forbidden",
        "You can't link this document.",
        StatusCode::FORBIDDEN,
    )
}

fn conflict(message: &str) -> Response {
    err("document_source_conflict", message, StatusCode::CONFLICT)
}

fn mismatch() -> Response {
    err(
        "document_source_mismatch",
        "Both files must be finalized documents of the same format.",
        StatusCode::BAD_REQUEST,
    )
}

/// Whether the copy already has a stored source, reactions, comments, or
/// shares of its own.
async fn copy_has_state(pool: &PgPool, attachment_id: &str) -> Result<bool, sqlx_core::Error> {
    let (taken,): (bool,) = query_as(
        "SELECT EXISTS (SELECT 1 FROM cloud_document_contents WHERE attachment_id = $1) \
             OR EXISTS (SELECT 1 FROM cloud_document_reactions WHERE attachment_id = $1) \
             OR EXISTS (SELECT 1 FROM cloud_document_comments WHERE attachment_id = $1) \
             OR EXISTS (SELECT 1 FROM cloud_document_shares WHERE attachment_id = $1)",
    )
    .bind(attachment_id)
    .fetch_one(pool)
    .await?;
    Ok(taken)
}

/// `POST /v1/cloud/documents/:attachment_id/source`
pub(crate) async fn link_source(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(copy_id): Path<String>,
    Json(req): Json<LinkSourceRequest>,
) -> Response {
    let pool = state.db_pool();
    let source_id = req.source_attachment_id.trim().to_string();
    let rows: Result<Vec<(String, String, Option<String>)>, _> = query_as(
        "SELECT attachment_id, owner_account_id, document_source_attachment_id \
         FROM cloud_attachments WHERE attachment_id = ANY($1)",
    )
    .bind(vec![copy_id.clone(), source_id.clone()])
    .fetch_all(pool)
    .await;
    let Ok(rows) = rows else {
        return db_error();
    };
    let find = |id: &str| rows.iter().find(|row| row.0 == id);
    let (Some(copy), Some(_)) = (find(&copy_id), find(&source_id)) else {
        return not_found();
    };
    if copy.1 != session.account_id {
        return forbidden();
    }
    let canonical = match canonical_attachment_id(pool, &source_id).await {
        Ok(value) => value,
        Err(_) => return db_error(),
    };
    if canonical == copy_id {
        return conflict("A document can't be its own source.");
    }
    match copy.2.as_deref() {
        // Linking again to the same document is a no-op.
        Some(existing) if existing == canonical => {}
        Some(_) => return conflict("This copy is already linked to another document."),
        None => match copy_has_state(pool, &copy_id).await {
            Ok(true) => {
                return conflict("This copy already has its own edits, comments, or links.")
            }
            Ok(false) => {}
            Err(_) => return db_error(),
        },
    }
    let source = match authorized_document(&state, &session, &source_id).await {
        Ok((record, _)) => record,
        Err(response)
            if matches!(
                response.status(),
                StatusCode::UNSUPPORTED_MEDIA_TYPE | StatusCode::CONFLICT
            ) =>
        {
            return mismatch()
        }
        Err(response) if response.status() == StatusCode::NOT_FOUND => return forbidden(),
        Err(response) => return *response,
    };
    let copy_record = match authorized_document(&state, &session, &copy_id).await {
        Ok((record, _)) => record,
        Err(response)
            if matches!(
                response.status(),
                StatusCode::UNSUPPORTED_MEDIA_TYPE | StatusCode::CONFLICT
            ) =>
        {
            return mismatch()
        }
        Err(response) => return *response,
    };
    if copy_record.format != source.format {
        return mismatch();
    }
    let linked = query(
        "UPDATE cloud_attachments SET document_source_attachment_id = $2 \
         WHERE attachment_id = $1 AND owner_account_id = $3",
    )
    .bind(&copy_id)
    .bind(&canonical)
    .bind(&session.account_id)
    .execute(pool)
    .await;
    if linked.is_err() {
        return db_error();
    }
    let (record, viewer) = match authorized_document(&state, &session, &copy_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let text = match document_source(&state, &record).await {
        Ok(text) => text,
        Err(response) => return *response,
    };
    match signed_in_response(&state, &session, &record, viewer, &text).await {
        Ok(document) => Json(document).into_response(),
        Err(response) => *response,
    }
}
