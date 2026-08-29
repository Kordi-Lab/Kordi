use std::sync::{Arc, OnceLock};

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::Utc;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use super::s3_or_503;
use crate::attachments::content_type::{
    detected_supported_content_type, normalized_verified_content_type,
};
use crate::attachments::presign_upload_part_url;
use crate::attachments::response::{boxed_err, err};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

mod completion;
mod lifecycle;

pub use completion::complete_multipart;
pub use lifecycle::{cancel_multipart, initiate_multipart};

type UploadRow = (
    String,
    String,
    String,
    i64,
    i64,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
);

#[derive(Debug, Clone, Serialize)]
pub struct MultipartPartResponse {
    #[serde(rename = "partNumber")]
    part_number: i32,
    #[serde(rename = "sizeBytes")]
    size_bytes: i64,
}

#[derive(Debug, Serialize)]
pub struct MultipartStatusResponse {
    #[serde(rename = "attachmentId")]
    attachment_id: String,
    status: String,
    #[serde(rename = "chunkSizeBytes")]
    chunk_size_bytes: i64,
    #[serde(rename = "totalSizeBytes")]
    total_size_bytes: i64,
    #[serde(rename = "uploadedBytes")]
    uploaded_bytes: i64,
    #[serde(rename = "uploadedParts")]
    uploaded_parts: Vec<MultipartPartResponse>,
    #[serde(rename = "objectKey")]
    object_key: String,
    #[serde(rename = "contentType")]
    content_type: Option<String>,
    #[serde(rename = "sha256Hex")]
    sha256_hex: Option<String>,
    #[serde(rename = "finalizedAt")]
    finalized_at: Option<String>,
}

fn object_store_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

fn expected_part_count(total_size: i64, chunk_size: i64) -> i32 {
    let total_size = u64::try_from(total_size.max(1)).unwrap_or(u64::MAX);
    let chunk_size = u64::try_from(chunk_size.max(1)).unwrap_or(u64::MAX);
    i32::try_from(total_size.div_ceil(chunk_size)).unwrap_or(i32::MAX)
}

fn expected_part_size(total_size: i64, chunk_size: i64, part_number: i32) -> Option<i64> {
    let part_count = expected_part_count(total_size, chunk_size);
    if !(1..=part_count).contains(&part_number) {
        return None;
    }
    if total_size == 0 {
        return Some(0);
    }
    if part_number < part_count {
        Some(chunk_size)
    } else {
        Some(total_size - chunk_size * i64::from(part_count - 1))
    }
}

async fn load_upload(
    state: &ServerState,
    session: &CloudSession,
    attachment_id: &str,
) -> Result<UploadRow, Box<Response>> {
    let row: Option<UploadRow> = query_as(
        "SELECT attachment.object_key, attachment.owner_account_id, upload.upload_id, \
                upload.chunk_size_bytes, upload.total_size_bytes, upload.content_type, upload.status, \
                attachment.sha256_hex, attachment.finalized_at \
         FROM cloud_attachment_uploads upload \
         JOIN cloud_attachments attachment ON attachment.attachment_id = upload.attachment_id \
         WHERE upload.attachment_id = $1",
    )
    .bind(attachment_id)
    .fetch_optional(state.db_pool())
    .await
    .map_err(|_| boxed_err("server_error", "Database error.", StatusCode::INTERNAL_SERVER_ERROR))?;
    let Some(row) = row else {
        return Err(boxed_err(
            "not_found",
            "Attachment upload not found.",
            StatusCode::NOT_FOUND,
        ));
    };
    if row.1 != session.account_id {
        return Err(boxed_err(
            "not_found",
            "Attachment upload not found.",
            StatusCode::NOT_FOUND,
        ));
    }
    Ok(row)
}

pub async fn multipart_status(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
) -> Response {
    let row = match load_upload(&state, &session, &attachment_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let parts: Vec<(i32, i64)> = match query_as(
        "SELECT part_number, size_bytes FROM cloud_attachment_upload_parts \
         WHERE attachment_id = $1 ORDER BY part_number ASC",
    )
    .bind(&attachment_id)
    .fetch_all(state.db_pool())
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not load attachment upload.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    let uploaded_bytes = parts.iter().map(|part| part.1).sum();
    Json(MultipartStatusResponse {
        attachment_id,
        status: row.6,
        chunk_size_bytes: row.3,
        total_size_bytes: row.4,
        uploaded_bytes,
        uploaded_parts: parts
            .into_iter()
            .map(|(part_number, size_bytes)| MultipartPartResponse {
                part_number,
                size_bytes,
            })
            .collect(),
        object_key: row.0,
        content_type: row.5,
        sha256_hex: row.7,
        finalized_at: row.8,
    })
    .into_response()
}

pub async fn upload_multipart_part(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((attachment_id, part_number)): Path<(String, i32)>,
    bytes: Bytes,
) -> Response {
    let s3 = match s3_or_503(&state) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let row = match load_upload(&state, &session, &attachment_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if row.6 != "uploading" {
        return err(
            "upload_not_active",
            "Attachment upload is not active.",
            StatusCode::CONFLICT,
        );
    }
    let Some(expected_size) = expected_part_size(row.4, row.3, part_number) else {
        return err(
            "invalid_attachment_part",
            "Attachment part number is invalid.",
            StatusCode::BAD_REQUEST,
        );
    };
    if i64::try_from(bytes.len()).ok() != Some(expected_size) {
        return err(
            "invalid_attachment_part",
            "Attachment part size is invalid.",
            StatusCode::BAD_REQUEST,
        );
    }

    let sha256_hex = hex::encode(Sha256::digest(&bytes));
    let existing: Option<(i64, String, String)> = match query_as(
        "SELECT size_bytes, sha256_hex, etag FROM cloud_attachment_upload_parts \
         WHERE attachment_id = $1 AND part_number = $2",
    )
    .bind(&attachment_id)
    .bind(part_number)
    .fetch_optional(state.db_pool())
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not inspect attachment part.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    if let Some((size_bytes, existing_sha256, _)) = existing {
        if size_bytes == expected_size && existing_sha256 == sha256_hex {
            return Json(MultipartPartResponse {
                part_number,
                size_bytes,
            })
            .into_response();
        }
        return err(
            "attachment_part_conflict",
            "Attachment part already exists with different bytes.",
            StatusCode::CONFLICT,
        );
    }

    let detected_content_type = (part_number == 1)
        .then(|| detected_supported_content_type(&bytes))
        .flatten();
    if part_number == 1 {
        if let Some(declared) = row.5.as_deref().and_then(normalized_verified_content_type) {
            if detected_content_type != Some(declared) {
                return err(
                    "invalid_attachment_content",
                    "The attachment bytes do not match the declared media type.",
                    StatusCode::BAD_REQUEST,
                );
            }
        }
    }

    let s3_part_number = match u16::try_from(part_number) {
        Ok(value) => value,
        Err(_) => {
            return err(
                "invalid_attachment_part",
                "Attachment part number is invalid.",
                StatusCode::BAD_REQUEST,
            )
        }
    };
    let upload_url = match presign_upload_part_url(s3, &row.0, s3_part_number, &row.2) {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not sign attachment part.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    let upload_response = match object_store_client()
        .put(upload_url)
        .body(bytes)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response,
        _ => {
            return err(
                "server_error",
                "Could not store attachment part.",
                StatusCode::BAD_GATEWAY,
            )
        }
    };
    let etag = match upload_response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 256)
    {
        Some(value) => value.to_string(),
        None => {
            return err(
                "server_error",
                "Object storage did not confirm the attachment part.",
                StatusCode::BAD_GATEWAY,
            )
        }
    };
    let now = Utc::now().to_rfc3339();
    let stored = query(
        "INSERT INTO cloud_attachment_upload_parts \
         (attachment_id, part_number, size_bytes, sha256_hex, etag, uploaded_at) \
         VALUES ($1, $2, $3, $4, $5, $6) \
         ON CONFLICT (attachment_id, part_number) DO NOTHING",
    )
    .bind(&attachment_id)
    .bind(part_number)
    .bind(expected_size)
    .bind(&sha256_hex)
    .bind(&etag)
    .bind(&now)
    .execute(state.db_pool())
    .await;
    if stored.is_err() {
        return err(
            "server_error",
            "Could not record attachment part.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }
    if let Some(detected_content_type) = detected_content_type {
        if query("UPDATE cloud_attachments SET detected_content_type = $2 WHERE attachment_id = $1")
            .bind(&attachment_id)
            .bind(detected_content_type)
            .execute(state.db_pool())
            .await
            .is_err()
        {
            return err(
                "server_error",
                "Could not record attachment content type.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }
    let _ = query("UPDATE cloud_attachment_uploads SET updated_at = $2 WHERE attachment_id = $1")
        .bind(&attachment_id)
        .bind(now)
        .execute(state.db_pool())
        .await;

    Json(MultipartPartResponse {
        part_number,
        size_bytes: expected_size,
    })
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::{expected_part_count, expected_part_size};

    #[test]
    fn multipart_shape_is_bounded_and_keeps_a_short_final_part() {
        let chunk = 8 * 1024 * 1024;
        assert_eq!(expected_part_count(0, chunk), 1);
        assert_eq!(expected_part_size(0, chunk, 1), Some(0));
        assert_eq!(expected_part_count(chunk * 2 + 7, chunk), 3);
        assert_eq!(expected_part_size(chunk * 2 + 7, chunk, 1), Some(chunk));
        assert_eq!(expected_part_size(chunk * 2 + 7, chunk, 3), Some(7));
        assert_eq!(expected_part_size(chunk * 2 + 7, chunk, 4), None);
    }
}
