pub(crate) mod multipart;

use std::sync::Arc;
use std::time::SystemTime;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use crate::attachments::access::attachment_access_row;
use crate::attachments::content_type::{
    detected_supported_content_type, normalized_verified_content_type,
};
use crate::attachments::preview::{normalize_preview_url, preview_content_response};
use crate::attachments::response::{boxed_err, err};
use crate::attachments::url_expires_at;
use crate::auth::routes::CloudSession;
use crate::object_storage::ObjectStore;
use crate::server::ServerState;

/// Path of an authenticated attachment route on this server, used in place
/// of a presigned URL when the backend cannot sign one.
fn attachment_route(attachment_id: &str, action: &str) -> String {
    format!("/v1/cloud/attachments/{attachment_id}/{action}")
}

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

#[derive(Debug, Deserialize)]
pub struct UpdatePreviewRequest {
    #[serde(rename = "previewUrl")]
    pub preview_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UpdatePreviewResponse {
    #[serde(rename = "attachmentId")]
    pub attachment_id: String,
    #[serde(rename = "previewUrl")]
    pub preview_url: String,
    #[serde(rename = "updatedLinks")]
    pub updated_links: u64,
}

pub(crate) fn store_or_503(state: &ServerState) -> Result<&ObjectStore, Box<Response>> {
    state.object_store().ok_or_else(|| {
        boxed_err(
            "attachments_unavailable",
            "Object storage is not configured on this server.",
            StatusCode::SERVICE_UNAVAILABLE,
        )
    })
}

/// `POST /v1/cloud/attachments/initiate`
///
/// Creates a `cloud_attachments` row and returns an upload URL: a presigned
/// PUT URL on S3 backends, or the authenticated `/upload` route of this
/// server on GCS, which needs no signing key. Object key is derived as
/// `attachments/<owner>/<attachment_id>` so listing-by-prefix is
/// straightforward when GC arrives later.
pub async fn initiate(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let store = match store_or_503(&state) {
        Ok(value) => value,
        Err(resp) => return *resp,
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

    let upload_url = store
        .direct_upload_url(&object_key)
        .map(|url| url.to_string())
        .unwrap_or_else(|| attachment_route(&attachment_id, "upload"));
    let expires_at = url_expires_at(SystemTime::now()).to_rfc3339();

    Json(InitiateResponse {
        attachment_id,
        object_key,
        upload_url,
        expires_at,
    })
    .into_response()
}

/// `PUT /v1/cloud/attachments/:attachment_id/upload`
///
/// Proxies bytes through the cloud server into the configured object store,
/// so desktop clients never need network access to the store itself.
pub async fn upload(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    let store = match store_or_503(&state) {
        Ok(value) => value,
        Err(resp) => return *resp,
    };
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
        return err("not_found", "Attachment not found.", StatusCode::NOT_FOUND);
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

    let size_bytes = i64::try_from(bytes.len()).unwrap_or(i64::MAX);
    match store.put(&object_key, content_type.as_deref(), bytes).await {
        Ok(()) => {}
        Err(error) => {
            eprintln!("[attachments] proxy upload failed: {error}");
            return err(
                "server_error",
                "Could not upload attachment.",
                StatusCode::BAD_GATEWAY,
            );
        }
    }

    let now = Utc::now().to_rfc3339();
    if query(
        "UPDATE cloud_attachments \
         SET size_bytes = $1, content_type = $2, detected_content_type = $3, finalized_at = $4 \
         WHERE attachment_id = $5",
    )
    .bind(size_bytes)
    .bind(content_type.as_deref())
    .bind(detected_content_type)
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
        size_bytes: Some(size_bytes),
        content_type,
        sha256_hex: None,
        finalized_at: Some(now),
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
/// Returns a download URL: a presigned GET URL on S3 backends, or this
/// server's authenticated `/content` route on GCS. The attachment owner can
/// always request one; recipients can request one once the attachment is
/// linked to a cloud message addressed to them. This route is kept for
/// compatibility; desktop previews use `/content` so object storage can
/// remain private.
pub async fn download_url(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
) -> Response {
    let store = match store_or_503(&state) {
        Ok(value) => value,
        Err(resp) => return *resp,
    };

    let (object_key, _, _, _, _, _, _) =
        match attachment_access_row(&state, &session, &attachment_id).await {
            Ok(value) => value,
            Err(resp) => return *resp,
        };

    let download_url = store
        .direct_download_url(&object_key)
        .map(|url| url.to_string())
        .unwrap_or_else(|| attachment_route(&attachment_id, "content"));

    Json(DownloadResponse {
        attachment_id,
        download_url,
        expires_at: url_expires_at(SystemTime::now()).to_rfc3339(),
    })
    .into_response()
}

/// `POST /v1/cloud/attachments/:attachment_id/preview`
///
/// Stores a client-generated compressed preview on the canonical attachment.
/// The caller must be the attachment owner or an active member of a linked
/// conversation.
pub async fn update_preview(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
    Json(req): Json<UpdatePreviewRequest>,
) -> Response {
    let preview_url = match normalize_preview_url(req.preview_url.as_deref()) {
        Ok(value) => value,
        Err(resp) => return *resp,
    };

    let (_, _owner_account_id, _, _, _, _, _) =
        match attachment_access_row(&state, &session, &attachment_id).await {
            Ok(row) => row,
            Err(resp) => return *resp,
        };

    let result = match query(
        "UPDATE cloud_attachments \
         SET preview_url = $1 \
         WHERE attachment_id = $2 \
           AND (preview_url IS NULL OR preview_url = '')",
    )
    .bind(&preview_url)
    .bind(&attachment_id)
    .execute(state.db_pool())
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not update attachment preview.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    Json(UpdatePreviewResponse {
        attachment_id,
        preview_url,
        updated_links: result.rows_affected(),
    })
    .into_response()
}

/// `GET /v1/cloud/attachments/:attachment_id/preview-content`
///
/// Returns the small canonical preview without repeating its data URL in
/// every message snapshot. Clients fall back to `/content` when absent.
pub async fn preview_content(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
) -> Response {
    let (_, _, _, _, _, _, preview_url) =
        match attachment_access_row(&state, &session, &attachment_id).await {
            Ok(value) => value,
            Err(resp) => return *resp,
        };
    match preview_content_response(preview_url.as_deref()) {
        Ok(response) => response,
        Err(response) => *response,
    }
}
