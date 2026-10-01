//! Write-once guards for single-part attachment uploads.

use axum::http::StatusCode;
use axum::response::Response;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use crate::attachments::response::{boxed_err, err};

/// Marks a compatibility upload whose bytes are being written, so a second
/// request cannot write the same object before the first one finalizes.
pub(super) const UPLOAD_IN_PROGRESS_SIZE: i64 = -1;

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

pub(super) struct WritableAttachmentRow {
    pub(super) object_key: String,
    pub(super) owner_account_id: String,
    pub(super) finalized_at: Option<String>,
    pub(super) size_bytes: Option<i64>,
    pub(super) content_type: Option<String>,
    pub(super) sha256_hex: Option<String>,
    has_multipart_upload: bool,
    linked_to_message: bool,
}

impl WritableAttachmentRow {
    /// Attachment bytes are written once, before finalization. Multipart
    /// uploads write through their own part routes.
    pub(super) fn accepts_bytes(&self) -> bool {
        self.finalized_at.is_none()
            && self.size_bytes.is_none()
            && !self.has_multipart_upload
            && !self.linked_to_message
    }
}

pub(super) async fn writable_attachment_row(
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

pub(super) fn immutable_attachment() -> Response {
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
pub(super) struct UploadClaim {
    pool: sqlx_postgres::PgPool,
    attachment_id: String,
    settled: bool,
}

impl UploadClaim {
    pub(super) fn new(pool: &sqlx_postgres::PgPool, attachment_id: &str) -> Self {
        Self {
            pool: pool.clone(),
            attachment_id: attachment_id.to_string(),
            settled: false,
        }
    }

    pub(super) fn finalized(mut self) {
        self.settled = true;
    }

    /// Releases the claim before the error response is sent, so an immediate
    /// retry can claim the attachment again.
    pub(super) async fn release(mut self) {
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
