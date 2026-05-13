//! HTTP handlers for the attachment lifecycle. Mounted under
//! `/v1/cloud/attachments/*` by the auth router so the session
//! middleware authenticates every request.

use std::sync::Arc;
use std::time::SystemTime;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use crate::attachments::{presign_download_url, presign_upload_url, url_expires_at, S3Config};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

#[derive(Debug, Serialize)]
pub struct InitiateResponse {
    #[serde(rename = "attachmentId")]
    pub attachment_id: String,
    #[serde(rename = "objectKey")]
    pub object_key: String,
    #[serde(rename = "uploadUrl")]
    pub upload_url: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

#[derive(Debug, Deserialize)]
pub struct FinalizeRequest {
    #[serde(rename = "sizeBytes")]
    pub size_bytes: i64,
    #[serde(rename = "contentType")]
    pub content_type: Option<String>,
    #[serde(rename = "sha256Hex")]
    pub sha256_hex: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AttachmentSummary {
    #[serde(rename = "attachmentId")]
    pub attachment_id: String,
    #[serde(rename = "objectKey")]
    pub object_key: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: Option<i64>,
    #[serde(rename = "contentType")]
    pub content_type: Option<String>,
    #[serde(rename = "sha256Hex")]
    pub sha256_hex: Option<String>,
    #[serde(rename = "finalizedAt")]
    pub finalized_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DownloadResponse {
    #[serde(rename = "attachmentId")]
    pub attachment_id: String,
    #[serde(rename = "downloadUrl")]
    pub download_url: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

#[derive(Debug, Serialize)]
struct ErrBody<'a> {
    #[serde(rename = "errorCode")]
    error_code: &'a str,
    message: &'a str,
}

fn err(code: &str, message: &str, status: StatusCode) -> Response {
    (
        status,
        Json(ErrBody {
            error_code: code,
            message,
        }),
    )
        .into_response()
}

fn s3_or_503<'a>(state: &'a ServerState) -> Result<&'a S3Config, Response> {
    state.s3().ok_or_else(|| {
        err(
            "attachments_unavailable",
            "Object storage is not configured on this server.",
            StatusCode::SERVICE_UNAVAILABLE,
        )
    })
}

/// `POST /v1/cloud/attachments/initiate`
///
/// Creates a `cloud_attachments` row and returns a presigned PUT URL.
/// Object key is derived as `attachments/<owner>/<attachment_id>` so
/// listing-by-prefix is straightforward when GC arrives later.
pub async fn initiate(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let s3 = match s3_or_503(&state) {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let pool = state.db_pool();

    let attachment_id = format!("att_{}", uuid::Uuid::new_v4().simple());
    let object_key = format!("attachments/{}/{}", session.account_id, attachment_id);
    let now = Utc::now().to_rfc3339();

    if query(
        "INSERT INTO cloud_attachments \
         (attachment_id, owner_account_id, object_key, created_at) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(&attachment_id)
    .bind(&session.account_id)
    .bind(&object_key)
    .bind(&now)
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not record attachment.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let upload_url = match presign_upload_url(s3, &object_key) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[attachments] presign upload: {error}");
            return err(
                "server_error",
                "Could not sign upload URL.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let expires_at = url_expires_at(SystemTime::now()).to_rfc3339();

    Json(InitiateResponse {
        attachment_id,
        object_key,
        upload_url: upload_url.to_string(),
        expires_at,
    })
    .into_response()
}

/// `POST /v1/cloud/attachments/:attachment_id/finalize`
///
/// Records the post-upload metadata reported by the client and stamps
/// `finalized_at`. We trust the client's `size_bytes` and `sha256_hex`
/// values for now — verifying against MinIO via HEAD is a later
/// hardening pass once that adds an HTTP client.
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
    let pool = state.db_pool();

    let row: Option<(String, String)> = match query_as(
        "SELECT object_key, owner_account_id \
         FROM cloud_attachments \
         WHERE attachment_id = $1",
    )
    .bind(&attachment_id)
    .fetch_optional(pool)
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    let Some((object_key, owner)) = row else {
        return err("not_found", "Attachment not found.", StatusCode::NOT_FOUND);
    };
    if owner != session.account_id {
        // Don't leak existence to non-owners.
        return err("not_found", "Attachment not found.", StatusCode::NOT_FOUND);
    }

    let now = Utc::now().to_rfc3339();
    if query(
        "UPDATE cloud_attachments \
         SET size_bytes = $1, content_type = $2, sha256_hex = $3, finalized_at = $4 \
         WHERE attachment_id = $5",
    )
    .bind(req.size_bytes)
    .bind(req.content_type.as_deref())
    .bind(req.sha256_hex.as_deref())
    .bind(&now)
    .bind(&attachment_id)
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not finalize attachment.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
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

/// `GET /v1/cloud/attachments/:attachment_id/download-url`
///
/// Returns a presigned GET URL. The attachment owner can always request
/// one; recipients can request one once the attachment is linked to a
/// cloud message addressed to them.
pub async fn download_url(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
) -> Response {
    let s3 = match s3_or_503(&state) {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let pool = state.db_pool();

    let row: Option<(String, String, Option<String>)> = match query_as(
        "SELECT object_key, owner_account_id, finalized_at \
         FROM cloud_attachments \
         WHERE attachment_id = $1",
    )
    .bind(&attachment_id)
    .fetch_optional(pool)
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    let Some((object_key, owner, finalized_at)) = row else {
        return err("not_found", "Attachment not found.", StatusCode::NOT_FOUND);
    };
    if owner != session.account_id {
        let allowed: Option<(i32,)> = match query_as(
            "SELECT 1 \
             FROM cloud_message_attachments cma \
             JOIN cloud_messages cm ON cm.message_id = cma.message_id \
             WHERE cma.attachment_id = $1 \
               AND (cm.from_account_id = $2 OR cm.to_account_id = $2) \
             LIMIT 1",
        )
        .bind(&attachment_id)
        .bind(&session.account_id)
        .fetch_optional(pool)
        .await
        {
            Ok(value) => value,
            Err(_) => {
                return err(
                    "server_error",
                    "Database error.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                )
            }
        };
        if allowed.is_none() {
            return err("not_found", "Attachment not found.", StatusCode::NOT_FOUND);
        }
    }
    if finalized_at.is_none() {
        return err(
            "not_finalized",
            "Attachment upload has not been finalized.",
            StatusCode::CONFLICT,
        );
    }

    let url = match presign_download_url(s3, &object_key) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[attachments] presign download: {error}");
            return err(
                "server_error",
                "Could not sign download URL.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    Json(DownloadResponse {
        attachment_id,
        download_url: url.to_string(),
        expires_at: url_expires_at(SystemTime::now()).to_rfc3339(),
    })
    .into_response()
}
