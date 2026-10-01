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
    detected_supported_content_type, inline_media_type, normalized_verified_content_type,
    served_media_type, OPAQUE_CONTENT_TYPE,
};
use crate::attachments::preview::{normalize_preview_url, preview_content_response};
use crate::attachments::response::{boxed_err, err};
use crate::attachments::{
    presign_attachment_download_url, presign_head_url, presign_upload_url, url_expires_at, S3Config,
};
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

/// Marks a compatibility upload whose bytes are being written, so a second
/// request cannot write the same object before the first one finalizes.
const UPLOAD_IN_PROGRESS_SIZE: i64 = -1;

type WritableAttachmentColumns = (
    String,
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<String>,
    bool,
    bool,
);

struct WritableAttachmentRow {
    object_key: String,
    owner_account_id: String,
    finalized_at: Option<String>,
    size_bytes: Option<i64>,
    content_type: Option<String>,
    sha256_hex: Option<String>,
    has_multipart_upload: bool,
    linked_to_message: bool,
}

impl WritableAttachmentRow {
    /// Attachment bytes are written once, before finalization. Multipart
    /// uploads write through their own part routes.
    fn accepts_bytes(&self) -> bool {
        self.finalized_at.is_none()
            && self.size_bytes.is_none()
            && !self.has_multipart_upload
            && !self.linked_to_message
    }
}

async fn writable_attachment_row(
    pool: &sqlx_postgres::PgPool,
    attachment_id: &str,
) -> Result<Option<WritableAttachmentRow>, Box<Response>> {
    let row: Option<WritableAttachmentColumns> = query_as(
        "SELECT attachment.object_key, attachment.owner_account_id, attachment.finalized_at, \
                attachment.size_bytes, attachment.content_type, attachment.sha256_hex, \
                EXISTS (SELECT 1 FROM cloud_attachment_uploads upload \
                        WHERE upload.attachment_id = attachment.attachment_id), \
                EXISTS (SELECT 1 FROM cloud_chat_message_attachments link \
                        WHERE link.attachment_id = attachment.attachment_id) \
         FROM cloud_attachments attachment \
         WHERE attachment.attachment_id = $1",
    )
    .bind(attachment_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| {
        boxed_err(
            "server_error",
            "Database error.",
            StatusCode::INTERNAL_SERVER_ERROR,
        )
    })?;
    Ok(row.map(
        |(
            object_key,
            owner_account_id,
            finalized_at,
            size_bytes,
            content_type,
            sha256_hex,
            has_multipart_upload,
            linked_to_message,
        )| WritableAttachmentRow {
            object_key,
            owner_account_id,
            finalized_at,
            size_bytes,
            content_type,
            sha256_hex,
            has_multipart_upload,
            linked_to_message,
        },
    ))
}

fn immutable_attachment() -> Response {
    err(
        "attachment_immutable",
        "Attachment bytes cannot be replaced after the upload is finalized.",
        StatusCode::CONFLICT,
    )
}

async fn release_upload_claim(pool: &sqlx_postgres::PgPool, attachment_id: &str) {
    let _ = query(
        "UPDATE cloud_attachments SET size_bytes = NULL \
         WHERE attachment_id = $1 AND size_bytes = $2 AND finalized_at IS NULL",
    )
    .bind(attachment_id)
    .bind(UPLOAD_IN_PROGRESS_SIZE)
    .execute(pool)
    .await;
}

/// Holds a compatibility upload claim until the upload finalizes. Every other
/// exit releases it, including a request that is dropped because the client
/// disconnected or timed out while the bytes were being written.
struct UploadClaim {
    pool: sqlx_postgres::PgPool,
    attachment_id: String,
    settled: bool,
}

impl UploadClaim {
    fn new(pool: &sqlx_postgres::PgPool, attachment_id: &str) -> Self {
        Self {
            pool: pool.clone(),
            attachment_id: attachment_id.to_string(),
            settled: false,
        }
    }

    fn finalized(mut self) {
        self.settled = true;
    }

    /// Releases the claim before the error response is sent, so an immediate
    /// retry can claim the attachment again.
    async fn release(mut self) {
        release_upload_claim(&self.pool, &self.attachment_id).await;
        self.settled = true;
    }
}

impl Drop for UploadClaim {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let pool = self.pool.clone();
        let attachment_id = std::mem::take(&mut self.attachment_id);
        runtime.spawn(async move {
            release_upload_claim(&pool, &attachment_id).await;
        });
    }
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

    let (object_key, _, _, content_type, detected_content_type, _, _) =
        match attachment_access_row(&state, &session, &attachment_id).await {
            Ok(value) => value,
            Err(resp) => return *resp,
        };

    let media_type = served_media_type([detected_content_type.as_deref(), content_type.as_deref()]);
    let url = match presign_attachment_download_url(s3, &object_key, media_type) {
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
/// Only the attachment owner can set the shared preview. Members of a linked
/// conversation may still generate previews locally; their request succeeds
/// without changing the stored preview, like a request after the preview is
/// already set, so existing clients keep their local preview.
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

    let (_, owner_account_id, _, _, _, _, _) =
        match attachment_access_row(&state, &session, &attachment_id).await {
            Ok(row) => row,
            Err(resp) => return *resp,
        };

    if owner_account_id != session.account_id {
        return Json(UpdatePreviewResponse {
            attachment_id,
            preview_url,
            updated_links: 0,
        })
        .into_response();
    }

    let result = match query(
        "UPDATE cloud_attachments \
         SET preview_url = $1 \
         WHERE attachment_id = $2 AND owner_account_id = $3 AND purge_requested_at IS NULL \
           AND (preview_url IS NULL OR preview_url = '')",
    )
    .bind(&preview_url)
    .bind(&attachment_id)
    .bind(&session.account_id)
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
