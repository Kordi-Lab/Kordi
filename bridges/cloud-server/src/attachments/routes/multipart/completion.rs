use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::Utc;
use serde::Deserialize;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use super::{expected_part_count, expected_part_size, load_upload, object_store_client};
use crate::attachments::response::err;
use crate::attachments::{presign_complete_multipart, presign_head_url};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

use super::super::{s3_or_503, AttachmentSummary};

#[derive(Debug, Deserialize)]
pub struct MultipartCompleteRequest {
    #[serde(rename = "sha256Hex")]
    sha256_hex: String,
}

fn valid_sha256(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    (normalized.len() == 64 && normalized.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(normalized)
}

async fn completed_object_has_size(state: &ServerState, object_key: &str, size_bytes: i64) -> bool {
    let Some(s3) = state.s3() else {
        return false;
    };
    let Ok(url) = presign_head_url(s3, object_key) else {
        return false;
    };
    let Ok(response) = object_store_client().head(url).send().await else {
        return false;
    };
    response.status().is_success()
        && response
            .content_length()
            .and_then(|value| i64::try_from(value).ok())
            == Some(size_bytes)
}

pub async fn complete_multipart(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
    Json(request): Json<MultipartCompleteRequest>,
) -> Response {
    let s3 = match s3_or_503(&state) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let row = match load_upload(&state, &session, &attachment_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let Some(sha256_hex) = valid_sha256(&request.sha256_hex) else {
        return err(
            "invalid_attachment",
            "Attachment SHA-256 is invalid.",
            StatusCode::BAD_REQUEST,
        );
    };
    if row.6 == "completed" {
        return Json(AttachmentSummary {
            attachment_id,
            object_key: row.0,
            size_bytes: Some(row.4),
            content_type: row.5,
            sha256_hex: row.7,
            finalized_at: row.8,
        })
        .into_response();
    }
    if row.6 != "uploading" {
        return err(
            "upload_not_active",
            "Attachment upload is not active.",
            StatusCode::CONFLICT,
        );
    }

    let parts: Vec<(i32, i64, String)> = match query_as(
        "SELECT part_number, size_bytes, etag FROM cloud_attachment_upload_parts \
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
                "Could not load attachment parts.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    let expected_count = expected_part_count(row.4, row.3);
    if parts.len() != usize::try_from(expected_count).unwrap_or(usize::MAX)
        || parts.iter().enumerate().any(|(index, part)| {
            let part_number = i32::try_from(index + 1).unwrap_or(i32::MAX);
            part.0 != part_number || expected_part_size(row.4, row.3, part_number) != Some(part.1)
        })
    {
        return err(
            "attachment_incomplete",
            "Attachment upload is missing one or more parts.",
            StatusCode::CONFLICT,
        );
    }
    let etags = parts.iter().map(|part| part.2.clone()).collect::<Vec<_>>();
    let (complete_url, complete_body) = match presign_complete_multipart(s3, &row.0, &row.2, &etags)
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not sign attachment completion.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    let _ = object_store_client()
        .post(complete_url)
        .header(reqwest::header::CONTENT_TYPE, "application/xml")
        .body(complete_body)
        .send()
        .await;
    if !completed_object_has_size(&state, &row.0, row.4).await {
        return err(
            "server_error",
            "Could not complete attachment upload.",
            StatusCode::BAD_GATEWAY,
        );
    }

    let now = Utc::now().to_rfc3339();
    let mut transaction = match state.db_pool().begin().await {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not finalize attachment upload.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    let attachment_update = query(
        "UPDATE cloud_attachments \
         SET size_bytes = $2, content_type = $3, sha256_hex = $4, finalized_at = $5 \
         WHERE attachment_id = $1",
    )
    .bind(&attachment_id)
    .bind(row.4)
    .bind(row.5.as_deref())
    .bind(&sha256_hex)
    .bind(&now)
    .execute(&mut *transaction)
    .await;
    let upload_update = query(
        "UPDATE cloud_attachment_uploads SET status = 'completed', updated_at = $2 \
         WHERE attachment_id = $1 AND status = 'uploading'",
    )
    .bind(&attachment_id)
    .bind(&now)
    .execute(&mut *transaction)
    .await;
    if attachment_update.is_err() || upload_update.is_err() || transaction.commit().await.is_err() {
        return err(
            "server_error",
            "Could not finalize attachment upload.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    Json(AttachmentSummary {
        attachment_id,
        object_key: row.0,
        size_bytes: Some(row.4),
        content_type: row.5,
        sha256_hex: Some(sha256_hex),
        finalized_at: Some(now),
    })
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::valid_sha256;

    #[test]
    fn completion_requires_a_sha256_digest() {
        assert!(valid_sha256(&"a".repeat(64)).is_some());
        assert!(valid_sha256("not-a-digest").is_none());
    }
}
