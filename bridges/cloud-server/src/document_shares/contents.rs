//! The canonical source of a document.
//!
//! The first read of a Markdown document copies the attachment bytes into
//! `cloud_document_contents` at revision 1; every later read, on every route,
//! uses the stored source. HTML documents are not editable and keep reading
//! the attachment bytes at revision 1.

use axum::http::StatusCode;
use axum::response::Response;
use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use super::access::{DocumentRecord, MAX_DOCUMENT_BYTES};
use super::model::DocumentFormat;
use super::{db_error, err};
use crate::server::ServerState;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DocumentSource {
    pub text: String,
    pub revision: i64,
    /// When a save last changed the source; `None` before the first save.
    pub updated_at: Option<String>,
}

/// Decodes stored bytes as text. Postgres text cannot hold NUL, so it is
/// removed.
pub(crate) fn decode_source(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).replace('\0', "")
}

/// The attachment bytes as text, capped at the document size limit.
async fn attachment_text(
    state: &ServerState,
    record: &DocumentRecord,
) -> Result<String, Box<Response>> {
    if record
        .size_bytes
        .is_some_and(|size| size > MAX_DOCUMENT_BYTES as i64)
    {
        return Err(Box::new(err(
            "document_too_large",
            "This document is too large to open.",
            StatusCode::PAYLOAD_TOO_LARGE,
        )));
    }
    let bytes = crate::attachments::fetch::fetch_attachment_bytes(
        state,
        &record.object_key,
        MAX_DOCUMENT_BYTES,
    )
    .await?;
    Ok(decode_source(&bytes))
}

async fn stored_source(
    state: &ServerState,
    attachment_id: &str,
) -> Result<Option<DocumentSource>, Box<Response>> {
    let row: Option<(String, i64, String)> = query_as(
        "SELECT source, revision, updated_at FROM cloud_document_contents \
         WHERE attachment_id = $1",
    )
    .bind(attachment_id)
    .fetch_optional(state.db_pool())
    .await
    .map_err(|_| db_error())?;
    Ok(row.map(|(text, revision, updated_at)| DocumentSource {
        text,
        revision,
        updated_at: (revision > 1).then_some(updated_at),
    }))
}

/// The document source and its revision. Markdown documents are seeded from
/// the attachment on first read; concurrent first reads keep one row.
pub(crate) async fn document_source(
    state: &ServerState,
    record: &DocumentRecord,
) -> Result<DocumentSource, Box<Response>> {
    if record.format == DocumentFormat::Html {
        return Ok(DocumentSource {
            text: attachment_text(state, record).await?,
            revision: 1,
            updated_at: None,
        });
    }
    if let Some(source) = stored_source(state, &record.attachment_id).await? {
        return Ok(source);
    }
    let text = attachment_text(state, record).await?;
    query(
        "INSERT INTO cloud_document_contents \
         (attachment_id, source, revision, updated_by_account_id, updated_at) \
         VALUES ($1, $2, 1, $3, $4) ON CONFLICT (attachment_id) DO NOTHING",
    )
    .bind(&record.attachment_id)
    .bind(&text)
    .bind(&record.owner_account_id)
    .bind(Utc::now().to_rfc3339())
    .execute(state.db_pool())
    .await
    .map_err(|_| db_error())?;
    stored_source(state, &record.attachment_id)
        .await?
        .ok_or_else(|| Box::new(db_error()))
}
