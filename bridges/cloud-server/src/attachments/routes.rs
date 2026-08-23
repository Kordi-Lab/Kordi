pub(crate) mod multipart;

use std::sync::Arc;
use std::time::SystemTime;

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use crate::attachments::access::attachment_access_row;
use crate::attachments::content_type::{
    detected_raster_content_type, normalized_supported_raster_content_type,
};
use crate::attachments::preview::{normalize_preview_url, preview_content_response};
use crate::attachments::response::{boxed_err, err};
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

pub(super) fn s3_or_503(state: &ServerState) -> Result<&S3Config, Box<Response>> {
    state.s3().ok_or_else(|| {
        boxed_err(
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

    let upload_url = match presign_upload_url(s3, &object_key) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[attachments] presign proxy upload: {error}");
            return err(
                "server_error",
                "Could not sign upload URL.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let content_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let detected_content_type = detected_raster_content_type(&bytes);
    if let Some(declared) = content_type
        .as_deref()
        .and_then(normalized_supported_raster_content_type)
    {
        if detected_content_type != Some(declared) {
            return err(
                "invalid_attachment_content",
                "The attachment bytes do not match the declared image type.",
                StatusCode::BAD_REQUEST,
            );
        }
    }

    let mut req = reqwest::Client::new()
        .put(upload_url.to_string())
        .body(bytes.clone());
    if let Some(value) = content_type.as_deref() {
        req = req.header(reqwest::header::CONTENT_TYPE, value);
    }
    match req.send().await {
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => {
            eprintln!("[attachments] proxy upload failed: {}", resp.status());
            return err(
                "server_error",
                "Could not upload attachment.",
                StatusCode::BAD_GATEWAY,
            );
        }
        Err(error) => {
            eprintln!("[attachments] proxy upload request failed: {error}");
            return err(
                "server_error",
                "Could not upload attachment.",
                StatusCode::BAD_GATEWAY,
            );
        }
    }

    let now = Utc::now().to_rfc3339();
    let size_bytes = i64::try_from(bytes.len()).unwrap_or(i64::MAX);
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
/// Returns a presigned GET URL. The attachment owner can always request
/// one; recipients can request one once the attachment is linked to a
/// cloud message addressed to them. This route is kept for compatibility;
/// desktop previews use `/content` so object storage can remain private to
/// the cluster.
pub async fn download_url(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
) -> Response {
    let s3 = match s3_or_503(&state) {
        Ok(value) => value,
        Err(resp) => return *resp,
    };

    let (object_key, _, _, _, _, _, _) =
        match attachment_access_row(&state, &session, &attachment_id).await {
            Ok(value) => value,
            Err(resp) => return *resp,
        };

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

/// `GET /v1/cloud/attachments/:attachment_id/content`
///
/// Streams attachment bytes through the authenticated Cloud API. This keeps
/// S3/MinIO private and lets desktop clients auto-fetch small previews using
/// their Bearer token rather than exposing session tokens in image URLs.
pub async fn content(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
) -> Response {
    let s3 = match s3_or_503(&state) {
        Ok(value) => value,
        Err(resp) => return *resp,
    };

    let (object_key, _, _, content_type, detected_content_type, size_bytes, _) =
        match attachment_access_row(&state, &session, &attachment_id).await {
            Ok(value) => value,
            Err(resp) => return *resp,
        };

    let url = match presign_download_url(s3, &object_key) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[attachments] presign content download: {error}");
            return err(
                "server_error",
                "Could not sign download URL.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    let object_response = match reqwest::Client::new().get(url.to_string()).send().await {
        Ok(resp) if resp.status().is_success() => resp,
        Ok(resp) => {
            eprintln!("[attachments] content fetch failed: {}", resp.status());
            return err(
                "server_error",
                "Could not download attachment.",
                StatusCode::BAD_GATEWAY,
            );
        }
        Err(error) => {
            eprintln!("[attachments] content fetch request failed: {error}");
            return err(
                "server_error",
                "Could not download attachment.",
                StatusCode::BAD_GATEWAY,
            );
        }
    };

    let object_content_type = object_response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let object_content_length = object_response.content_length();

    let mut headers = HeaderMap::new();
    if let Some(value) = detected_content_type
        .as_deref()
        .or(object_content_type.as_deref())
        .or(content_type.as_deref())
    {
        if let Ok(header_value) = HeaderValue::from_str(value) {
            headers.insert(header::CONTENT_TYPE, header_value);
        }
    }
    let length =
        object_content_length.or_else(|| size_bytes.and_then(|value| u64::try_from(value).ok()));
    if let Some(length) = length {
        if let Ok(header_value) = HeaderValue::from_str(&length.to_string()) {
            headers.insert(header::CONTENT_LENGTH, header_value);
        }
    }
    let mut response = Response::new(Body::from_stream(object_response.bytes_stream()));
    *response.headers_mut() = headers;
    response
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
