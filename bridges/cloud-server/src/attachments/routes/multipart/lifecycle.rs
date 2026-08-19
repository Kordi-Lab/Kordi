use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::Utc;
use rusty_s3::actions::CreateMultipartUpload;
use serde::{Deserialize, Serialize};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use super::{load_upload, object_store_client};
use crate::attachments::response::{boxed_err, err};
use crate::attachments::{
    presign_abort_multipart_url, presign_create_multipart_url, MAX_ATTACHMENT_SIZE_BYTES,
    MULTIPART_CHUNK_SIZE,
};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

use super::super::s3_or_503;

const STALE_UPLOAD_HOURS: i64 = 24;
const STALE_UPLOAD_BATCH: i64 = 20;
const MAX_ACTIVE_UPLOADS_PER_ACCOUNT: i64 = 4;
const MAX_ACTIVE_UPLOAD_BYTES_PER_ACCOUNT: i64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct MultipartInitiateRequest {
    #[serde(rename = "sizeBytes")]
    size_bytes: i64,
    #[serde(rename = "contentType")]
    content_type: Option<String>,
}

#[derive(Debug, Serialize)]
struct MultipartInitiateResponse {
    #[serde(rename = "attachmentId")]
    attachment_id: String,
    #[serde(rename = "objectKey")]
    object_key: String,
    #[serde(rename = "chunkSizeBytes")]
    chunk_size_bytes: usize,
}

fn normalized_content_type(value: Option<&str>) -> Result<Option<String>, Box<Response>> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.len() > 255 || HeaderValue::from_str(value).is_err() {
        return Err(boxed_err(
            "invalid_attachment",
            "Attachment content type is invalid.",
            StatusCode::BAD_REQUEST,
        ));
    }
    Ok(Some(value.to_ascii_lowercase()))
}

async fn abort_object_store_upload(
    state: &ServerState,
    object_key: &str,
    upload_id: &str,
) -> Result<(), ()> {
    let s3 = state.s3().ok_or(())?;
    let url = presign_abort_multipart_url(s3, object_key, upload_id).map_err(|_| ())?;
    let response = object_store_client()
        .delete(url)
        .send()
        .await
        .map_err(|_| ())?;
    if response.status().is_success() || response.status() == reqwest::StatusCode::NOT_FOUND {
        Ok(())
    } else {
        Err(())
    }
}

async fn cleanup_stale_uploads(state: Arc<ServerState>) {
    // ponytail: cleanup is demand-driven; use a scheduled worker if uploads can stay idle for days.
    let cutoff = (Utc::now() - chrono::Duration::hours(STALE_UPLOAD_HOURS)).to_rfc3339();
    let rows: Vec<(String, String, String)> = match query_as(
        "SELECT upload.attachment_id, attachment.object_key, upload.upload_id \
         FROM cloud_attachment_uploads upload \
         JOIN cloud_attachments attachment ON attachment.attachment_id = upload.attachment_id \
         WHERE upload.status = 'uploading' AND upload.created_at::timestamptz < $1::timestamptz \
         ORDER BY upload.created_at ASC LIMIT $2",
    )
    .bind(cutoff)
    .bind(STALE_UPLOAD_BATCH)
    .fetch_all(state.db_pool())
    .await
    {
        Ok(rows) => rows,
        Err(_) => return,
    };
    for (attachment_id, object_key, upload_id) in rows {
        if abort_object_store_upload(&state, &object_key, &upload_id)
            .await
            .is_ok()
        {
            let _ = query("DELETE FROM cloud_attachments WHERE attachment_id = $1")
                .bind(attachment_id)
                .execute(state.db_pool())
                .await;
        }
    }
}

pub async fn initiate_multipart(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(request): Json<MultipartInitiateRequest>,
) -> Response {
    let s3 = match s3_or_503(&state) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if !(0..=MAX_ATTACHMENT_SIZE_BYTES).contains(&request.size_bytes) {
        return err(
            "attachment_too_large",
            "Attachments must be 2 GiB or smaller.",
            StatusCode::PAYLOAD_TOO_LARGE,
        );
    }
    let content_type = match normalized_content_type(request.content_type.as_deref()) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let active_cutoff = (Utc::now() - chrono::Duration::hours(STALE_UPLOAD_HOURS)).to_rfc3339();
    let active: (i64, Option<i64>) = match query_as(
        "SELECT COUNT(*)::BIGINT, SUM(upload.total_size_bytes)::BIGINT \
         FROM cloud_attachment_uploads upload \
         JOIN cloud_attachments attachment ON attachment.attachment_id = upload.attachment_id \
         WHERE attachment.owner_account_id = $1 AND upload.status = 'uploading' \
           AND upload.created_at::timestamptz >= $2::timestamptz",
    )
    .bind(&session.account_id)
    .bind(&active_cutoff)
    .fetch_one(state.db_pool())
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not inspect attachment upload quota.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    if active.0 >= MAX_ACTIVE_UPLOADS_PER_ACCOUNT
        || active
            .1
            .unwrap_or_default()
            .saturating_add(request.size_bytes)
            > MAX_ACTIVE_UPLOAD_BYTES_PER_ACCOUNT
    {
        return err(
            "upload_quota_exceeded",
            "Too many attachment uploads are already active. Finish or cancel one and try again.",
            StatusCode::TOO_MANY_REQUESTS,
        );
    }
    tokio::spawn(cleanup_stale_uploads(state.clone()));

    let attachment_id = format!("att_{}", uuid::Uuid::new_v4().simple());
    let object_key = format!("attachments/{}/{}", session.account_id, attachment_id);
    let create_url = match presign_create_multipart_url(s3, &object_key) {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not start attachment upload.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    let create_response = match object_store_client().post(create_url).send().await {
        Ok(response) if response.status().is_success() => response,
        _ => {
            return err(
                "server_error",
                "Could not start attachment upload.",
                StatusCode::BAD_GATEWAY,
            )
        }
    };
    let create_body = match create_response.bytes().await {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not read object storage response.",
                StatusCode::BAD_GATEWAY,
            )
        }
    };
    let upload_id = match CreateMultipartUpload::parse_response(&create_body) {
        Ok(value) => value.upload_id().to_string(),
        Err(_) => {
            return err(
                "server_error",
                "Object storage returned an invalid upload response.",
                StatusCode::BAD_GATEWAY,
            )
        }
    };

    let now = Utc::now().to_rfc3339();
    let mut transaction = match state.db_pool().begin().await {
        Ok(value) => value,
        Err(_) => {
            let _ = abort_object_store_upload(&state, &object_key, &upload_id).await;
            return err(
                "server_error",
                "Could not record attachment upload.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let inserted_attachment = query(
        "INSERT INTO cloud_attachments \
         (attachment_id, owner_account_id, object_key, created_at) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(&attachment_id)
    .bind(&session.account_id)
    .bind(&object_key)
    .bind(&now)
    .execute(&mut *transaction)
    .await;
    let inserted_upload = query(
        "INSERT INTO cloud_attachment_uploads \
         (attachment_id, upload_id, chunk_size_bytes, total_size_bytes, content_type, status, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, 'uploading', $6, $6)",
    )
    .bind(&attachment_id)
    .bind(&upload_id)
    .bind(i64::try_from(MULTIPART_CHUNK_SIZE).unwrap_or(i64::MAX))
    .bind(request.size_bytes)
    .bind(content_type.as_deref())
    .bind(&now)
    .execute(&mut *transaction)
    .await;
    if inserted_attachment.is_err()
        || inserted_upload.is_err()
        || transaction.commit().await.is_err()
    {
        let _ = abort_object_store_upload(&state, &object_key, &upload_id).await;
        return err(
            "server_error",
            "Could not record attachment upload.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    Json(MultipartInitiateResponse {
        attachment_id,
        object_key,
        chunk_size_bytes: MULTIPART_CHUNK_SIZE,
    })
    .into_response()
}

pub async fn cancel_multipart(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
) -> Response {
    let row = match load_upload(&state, &session, &attachment_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if row.6 == "completed" {
        return err(
            "upload_completed",
            "Completed attachments cannot be cancelled.",
            StatusCode::CONFLICT,
        );
    }
    if abort_object_store_upload(&state, &row.0, &row.2)
        .await
        .is_err()
    {
        return err(
            "server_error",
            "Could not cancel attachment upload.",
            StatusCode::BAD_GATEWAY,
        );
    }
    if query("DELETE FROM cloud_attachments WHERE attachment_id = $1")
        .bind(attachment_id)
        .execute(state.db_pool())
        .await
        .is_err()
    {
        return err(
            "server_error",
            "Could not remove cancelled attachment upload.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }
    StatusCode::NO_CONTENT.into_response()
}
