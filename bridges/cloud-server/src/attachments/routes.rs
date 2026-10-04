pub(crate) mod multipart;
mod single_part;
mod upload_claim;

use std::sync::Arc;
use std::time::SystemTime;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx_core::query::query;

use crate::attachments::access::attachment_access_row;
use crate::attachments::content_type::served_media_type;
use crate::attachments::preview::{normalize_preview_url, preview_content_response};
use crate::attachments::response::{boxed_err, err};
use crate::attachments::{
    presign_attachment_download_url, presign_upload_url, url_expires_at, S3Config,
};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

pub use single_part::{finalize, upload};

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
         WHERE attachment_id = $2 AND owner_account_id = $3 \
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
