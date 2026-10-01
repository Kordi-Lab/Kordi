//! Single-part attachment uploads: bytes proxied through the server, or an
//! object written directly to object storage and then finalized.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::Utc;
use sqlx_core::query::query;

use super::upload_claim::{
    immutable_attachment, writable_attachment_row, UploadClaim, UPLOAD_IN_PROGRESS_SIZE,
};
use super::{s3_or_503, AttachmentSummary, FinalizeRequest};
use crate::attachments::content_type::{
    detected_supported_content_type, inline_media_type, normalized_verified_content_type,
    OPAQUE_CONTENT_TYPE,
};
use crate::attachments::response::err;
use crate::attachments::{presign_head_url, presign_upload_url, S3Config};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

/// `PUT /v1/cloud/attachments/:attachment_id/upload`
///
/// Proxies bytes through the cloud server into the configured object store.
/// Presigned URLs stay internal to the cluster, so desktop clients don't need
/// direct network access to MinIO.
pub async fn upload(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    let s3 = match s3_or_503(&state) {
        Ok(value) => value,
        Err(resp) => return *resp,
    };
    let pool = state.db_pool();

    let row = match writable_attachment_row(pool, &attachment_id).await {
        Ok(value) => value,
        Err(resp) => return *resp,
    };
    let Some(row) = row else {
        return err("not_found", "Attachment not found.", StatusCode::NOT_FOUND);
    };
    if row.owner_account_id != session.account_id {
        return err("not_found", "Attachment not found.", StatusCode::NOT_FOUND);
    }
    if !row.accepts_bytes() {
        return immutable_attachment();
    }

    let content_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let detected_content_type = detected_supported_content_type(&bytes);
    if let Some(declared) = content_type
        .as_deref()
        .and_then(normalized_verified_content_type)
    {
        if detected_content_type != Some(declared) {
            return err(
                "invalid_attachment_content",
                "The attachment bytes do not match the declared media type.",
                StatusCode::BAD_REQUEST,
            );
        }
    }

    // Claim the attachment before writing its object, so a concurrent upload
    // cannot replace bytes that another request is about to finalize.
    let claimed = query(
        "UPDATE cloud_attachments attachment SET size_bytes = $3 \
         WHERE attachment.attachment_id = $1 AND attachment.owner_account_id = $2 \
           AND attachment.finalized_at IS NULL AND attachment.size_bytes IS NULL \
           AND NOT EXISTS ( \
             SELECT 1 FROM cloud_attachment_uploads upload \
             WHERE upload.attachment_id = attachment.attachment_id)",
    )
    .bind(&attachment_id)
    .bind(&session.account_id)
    .bind(UPLOAD_IN_PROGRESS_SIZE)
    .execute(pool)
    .await;
    match claimed {
        Ok(result) if result.rows_affected() == 1 => {}
        Ok(_) => return immutable_attachment(),
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
    let claim = UploadClaim::new(pool, &attachment_id);
    let object_key = row.object_key;

    let upload_url = match presign_upload_url(s3, &object_key) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[attachments] presign proxy upload: {error}");
            claim.release().await;
            return err(
                "server_error",
                "Could not sign upload URL.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    // Object storage keeps a safe type, so a direct object URL never serves
    // the declared type when it is not an allowlisted media type.
    let object_content_type = detected_content_type
        .or_else(|| content_type.as_deref().and_then(inline_media_type))
        .unwrap_or(OPAQUE_CONTENT_TYPE);
    let req = reqwest::Client::new()
        .put(upload_url.to_string())
        .header(reqwest::header::CONTENT_TYPE, object_content_type)
        .body(bytes.clone());
    match req.send().await {
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => {
            eprintln!("[attachments] proxy upload failed: {}", resp.status());
            claim.release().await;
            return err(
                "server_error",
                "Could not upload attachment.",
                StatusCode::BAD_GATEWAY,
            );
        }
        Err(error) => {
            eprintln!("[attachments] proxy upload request failed: {error}");
            claim.release().await;
            return err(
                "server_error",
                "Could not upload attachment.",
                StatusCode::BAD_GATEWAY,
            );
        }
    }

    let now = Utc::now().to_rfc3339();
    let size_bytes = i64::try_from(bytes.len()).unwrap_or(i64::MAX);
    match query(
        "UPDATE cloud_attachments \
         SET size_bytes = $1, content_type = $2, detected_content_type = $3, finalized_at = $4 \
         WHERE attachment_id = $5 AND size_bytes = $6 AND finalized_at IS NULL",
    )
    .bind(size_bytes)
    .bind(content_type.as_deref())
    .bind(detected_content_type)
    .bind(&now)
    .bind(&attachment_id)
    .bind(UPLOAD_IN_PROGRESS_SIZE)
    .execute(pool)
    .await
    {
        Ok(result) if result.rows_affected() == 1 => claim.finalized(),
        Ok(_) => return immutable_attachment(),
        Err(_) => {
            claim.release().await;
            return err(
                "server_error",
                "Could not finalize attachment.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }

    Json(AttachmentSummary {
        attachment_id,
        object_key,
        size_bytes: Some(size_bytes),
        content_type,
        sha256_hex: None,
        finalized_at: Some(now),
    })
    .into_response()
}

/// Returns the stored object's size, or `None` when it is missing.
async fn stored_object_size(s3: &S3Config, object_key: &str) -> Result<Option<i64>, ()> {
    let url = presign_head_url(s3, object_key).map_err(|_| ())?;
    let response = reqwest::Client::new()
        .head(url.to_string())
        .send()
        .await
        .map_err(|_| ())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(());
    }
    response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok())
        .map(Some)
        .ok_or(())
}

/// `POST /v1/cloud/attachments/:attachment_id/finalize`
///
/// Finalizes an object written directly to object storage. The declared size
/// must match the stored object, and a finalized attachment is immutable.
/// The declared SHA-256 is recorded as reported; verifying it would require
/// reading the whole object.
pub async fn finalize(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
    Json(req): Json<FinalizeRequest>,
) -> Response {
    if req.size_bytes < 0 {
        return err(
            "invalid_request",
            "sizeBytes must be non-negative.",
            StatusCode::BAD_REQUEST,
        );
    }
    let s3 = match s3_or_503(&state) {
        Ok(value) => value,
        Err(resp) => return *resp,
    };
    let pool = state.db_pool();

    let row = match writable_attachment_row(pool, &attachment_id).await {
        Ok(value) => value,
        Err(resp) => return *resp,
    };
    let Some(row) = row else {
        return err("not_found", "Attachment not found.", StatusCode::NOT_FOUND);
    };
    if row.owner_account_id != session.account_id {
        // Don't leak existence to non-owners.
        return err("not_found", "Attachment not found.", StatusCode::NOT_FOUND);
    }
    if let Some(finalized_at) = row.finalized_at.clone() {
        // A retried finalize with identical metadata is idempotent.
        return if row.size_bytes == Some(req.size_bytes)
            && row.content_type == req.content_type
            && row.sha256_hex == req.sha256_hex
        {
            Json(AttachmentSummary {
                attachment_id,
                object_key: row.object_key,
                size_bytes: row.size_bytes,
                content_type: row.content_type,
                sha256_hex: row.sha256_hex,
                finalized_at: Some(finalized_at),
            })
            .into_response()
        } else {
            immutable_attachment()
        };
    }
    if !row.accepts_bytes() {
        return immutable_attachment();
    }
    match stored_object_size(s3, &row.object_key).await {
        Ok(Some(size)) if size == req.size_bytes => {}
        Ok(Some(_)) => {
            return err(
                "invalid_attachment",
                "sizeBytes does not match the uploaded object.",
                StatusCode::BAD_REQUEST,
            )
        }
        Ok(None) => {
            return err(
                "attachment_not_uploaded",
                "Upload the attachment bytes before finalizing.",
                StatusCode::CONFLICT,
            )
        }
        Err(()) => {
            return err(
                "server_error",
                "Could not verify the uploaded object.",
                StatusCode::BAD_GATEWAY,
            )
        }
    }
    let object_key = row.object_key;

    let now = Utc::now().to_rfc3339();
    match query(
        "UPDATE cloud_attachments attachment \
         SET size_bytes = $1, content_type = $2, sha256_hex = $3, finalized_at = $4 \
         WHERE attachment.attachment_id = $5 AND attachment.finalized_at IS NULL \
           AND attachment.size_bytes IS NULL \
           AND NOT EXISTS ( \
             SELECT 1 FROM cloud_attachment_uploads upload \
             WHERE upload.attachment_id = attachment.attachment_id)",
    )
    .bind(req.size_bytes)
    .bind(req.content_type.as_deref())
    .bind(req.sha256_hex.as_deref())
    .bind(&now)
    .bind(&attachment_id)
    .execute(pool)
    .await
    {
        Ok(result) if result.rows_affected() == 1 => {}
        Ok(_) => return immutable_attachment(),
        Err(_) => {
            return err(
                "server_error",
                "Could not finalize attachment.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }

    Json(AttachmentSummary {
        attachment_id,
        object_key,
        size_bytes: Some(req.size_bytes),
        content_type: req.content_type,
        sha256_hex: req.sha256_hex,
        finalized_at: Some(now),
    })
    .into_response()
}
