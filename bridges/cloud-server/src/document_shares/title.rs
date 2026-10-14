//! Renaming a document.
//!
//! The title is stored on the canonical attachment and shown where the
//! document has no leading level-1 heading (see
//! [`super::render::document_title`]). The file name is unchanged. The same
//! people who may edit the content may rename, and every member hears about
//! it through `document.updated` with `"change": "title"`.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use sqlx_core::query::query;

use super::access::authorized_document;
use super::canonical::can_edit;
use super::contents::document_source;
use super::documents::signed_in_response;
use super::events::{publish_document_updated, DocumentChange};
use super::model::RenameDocumentRequest;
use super::render::valid_document_title;
use super::{db_error, err};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

/// `PATCH /v1/cloud/documents/:attachment_id`
pub(crate) async fn rename_document(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
    Json(req): Json<RenameDocumentRequest>,
) -> Response {
    let (mut record, viewer) = match authorized_document(&state, &session, &attachment_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let pool = state.db_pool();
    match can_edit(pool, &record, viewer, &session.account_id).await {
        Ok(true) => {}
        Ok(false) => {
            return err(
                "document_edit_forbidden",
                "You can't edit this document.",
                StatusCode::FORBIDDEN,
            )
        }
        Err(_) => return db_error(),
    }
    let Some(title) = valid_document_title(&req.title) else {
        return err(
            "document_title_invalid",
            "Titles are 1 to 200 characters.",
            StatusCode::BAD_REQUEST,
        );
    };
    let source = match document_source(&state, &record).await {
        Ok(source) => source,
        Err(response) => return *response,
    };
    if record.stored_title.as_deref() != Some(title.as_str()) {
        let updated =
            query("UPDATE cloud_attachments SET document_title = $2 WHERE attachment_id = $1")
                .bind(&record.attachment_id)
                .bind(&title)
                .execute(pool)
                .await;
        if updated.is_err() {
            return db_error();
        }
        record.stored_title = Some(title);
        publish_document_updated(
            pool,
            &record,
            Some(source.revision),
            DocumentChange::Title,
            Some(&session.account_id),
        )
        .await;
    }
    match signed_in_response(&state, &session, &record, viewer, &source).await {
        Ok(document) => Json(document).into_response(),
        Err(response) => *response,
    }
}
