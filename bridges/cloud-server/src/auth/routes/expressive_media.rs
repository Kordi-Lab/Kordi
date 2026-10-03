use super::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SaveExpressiveMediaRequest {
    attachment_id: String,
    kind: String,
    name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CloudExpressiveMediaItem {
    item_id: String,
    attachment_id: String,
    kind: String,
    name: String,
    mime_type: String,
    size_bytes: i64,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
pub(super) struct CloudExpressiveMediaListResponse {
    items: Vec<CloudExpressiveMediaItem>,
}

#[derive(Debug, Serialize)]
pub(super) struct CloudExpressiveMediaMutationResponse {
    item: CloudExpressiveMediaItem,
}

type ExpressiveMediaRow = (String, String, String, String, String, i64, String, String);

const MAX_EXPRESSIVE_MEDIA_BYTES: i64 = 2 * 1024 * 1024;

fn normalized_kind(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "sticker" => Some("sticker"),
        "gif" => Some("gif"),
        _ => None,
    }
}

fn kind_for_content_type(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "image/gif" => Some("gif"),
        "image/png" | "image/jpeg" | "image/jpg" | "image/webp" => Some("sticker"),
        _ => None,
    }
}

fn kind_matches_content_type(kind: &str, content_type: &str) -> bool {
    match kind_for_content_type(content_type) {
        Some("gif") => matches!(kind, "gif" | "sticker"),
        Some("sticker") => kind == "sticker",
        _ => false,
    }
}

fn clean_media_name(value: &str) -> Option<String> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > 255 || name.contains(['\0', '\r', '\n']) {
        return None;
    }
    Some(name.to_string())
}

fn media_size_allowed(size_bytes: i64) -> bool {
    (1..=MAX_EXPRESSIVE_MEDIA_BYTES).contains(&size_bytes)
}

fn media_item_from_row(row: ExpressiveMediaRow) -> CloudExpressiveMediaItem {
    CloudExpressiveMediaItem {
        item_id: row.0,
        attachment_id: row.1,
        kind: row.2,
        name: row.3,
        mime_type: row.4,
        size_bytes: row.5,
        created_at: row.6,
        updated_at: row.7,
    }
}

pub(super) async fn list_expressive_media(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let rows: Vec<ExpressiveMediaRow> = match query_as(
        "SELECT item_id, attachment_id, kind, name, mime_type, size_bytes, created_at, updated_at \
             FROM cloud_expressive_media_items \
             WHERE account_id = $1 AND deleted_at IS NULL \
             ORDER BY created_at DESC, item_id DESC",
    )
    .bind(&session.account_id)
    .fetch_all(state.db_pool())
    .await
    {
        Ok(rows) => rows,
        Err(_) => {
            return err(
                "server_error",
                "Could not load the saved media library.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    Json(CloudExpressiveMediaListResponse {
        items: rows.into_iter().map(media_item_from_row).collect(),
    })
    .into_response()
}

pub(super) async fn save_expressive_media(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(request): Json<SaveExpressiveMediaRequest>,
) -> Response {
    let attachment_id = request.attachment_id.trim();
    if attachment_id.is_empty() || attachment_id.len() > 512 {
        return err(
            "invalid_attachment",
            "attachmentId is invalid.",
            StatusCode::BAD_REQUEST,
        );
    }
    let Some(requested_kind) = normalized_kind(&request.kind) else {
        return err(
            "invalid_media_kind",
            "kind must be sticker or gif.",
            StatusCode::BAD_REQUEST,
        );
    };
    let Some(name) = clean_media_name(&request.name) else {
        return err(
            "invalid_media_name",
            "name must contain 1 to 255 characters without line breaks.",
            StatusCode::BAD_REQUEST,
        );
    };

    let (_, _, _, declared_content_type, detected_content_type, size_bytes, _) =
        match crate::attachments::access::attachment_access_row(&state, &session, attachment_id)
            .await
        {
            Ok(row) => row,
            Err(response) => return *response,
        };
    let Some(size_bytes) = size_bytes else {
        return err(
            "attachment_not_finalized",
            "The attachment must finish uploading before it can be saved.",
            StatusCode::CONFLICT,
        );
    };
    if !media_size_allowed(size_bytes) {
        return err(
            "media_too_large",
            "Saved stickers and GIFs must be no larger than 2 MB.",
            StatusCode::PAYLOAD_TOO_LARGE,
        );
    }
    let Some(content_type) = detected_content_type.or(declared_content_type) else {
        return err(
            "unsupported_media",
            "The attachment is not a supported sticker or GIF.",
            StatusCode::BAD_REQUEST,
        );
    };
    if kind_for_content_type(&content_type).is_none() {
        return err(
            "unsupported_media",
            "The attachment is not a supported sticker or GIF.",
            StatusCode::BAD_REQUEST,
        );
    }
    if !kind_matches_content_type(requested_kind, &content_type) {
        return err(
            "media_kind_mismatch",
            "The saved media kind does not match the uploaded file.",
            StatusCode::BAD_REQUEST,
        );
    }

    let now = Utc::now().to_rfc3339();
    let item_id = format!("media_{}", uuid::Uuid::new_v4().simple());
    let saved = async {
        let mut transaction = state.db_pool().begin().await?;
        // The share lock keeps a file from being queued for deletion while it
        // is saved; a file already queued is not found.
        let available: Option<(i32,)> = query_as(
            "SELECT 1 FROM cloud_attachments \
             WHERE attachment_id = $1 AND purge_requested_at IS NULL FOR SHARE",
        )
        .bind(attachment_id)
        .fetch_optional(&mut *transaction)
        .await?;
        if available.is_none() {
            return Ok(None);
        }
        let row: Option<ExpressiveMediaRow> = query_as(
            "INSERT INTO cloud_expressive_media_items \
             (item_id, account_id, attachment_id, kind, name, mime_type, size_bytes, created_at, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) \
             ON CONFLICT (account_id, attachment_id) DO UPDATE SET \
               kind = EXCLUDED.kind, name = EXCLUDED.name, mime_type = EXCLUDED.mime_type, \
               size_bytes = EXCLUDED.size_bytes, updated_at = EXCLUDED.updated_at \
             WHERE cloud_expressive_media_items.deleted_at IS NULL \
             RETURNING item_id, attachment_id, kind, name, mime_type, size_bytes, created_at, updated_at",
        )
        .bind(&item_id)
        .bind(&session.account_id)
        .bind(attachment_id)
        .bind(requested_kind)
        .bind(&name)
        .bind(content_type.trim().to_ascii_lowercase())
        .bind(size_bytes)
        .bind(&now)
        .fetch_optional(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok::<_, sqlx_core::Error>(Some(row))
    }
    .await;
    let row = match saved {
        Ok(Some(row)) => row,
        Ok(None) => return err("not_found", "Attachment not found.", StatusCode::NOT_FOUND),
        Err(_) => {
            return err(
                "server_error",
                "Could not save this media to your library.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    let Some(row) = row else {
        return err(
            "media_deleted",
            "This saved media was deleted. Add it as a new upload to save it again.",
            StatusCode::CONFLICT,
        );
    };

    Json(CloudExpressiveMediaMutationResponse {
        item: media_item_from_row(row),
    })
    .into_response()
}

pub(super) async fn delete_expressive_media(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(media_id): axum::extract::Path<String>,
) -> Response {
    let media_id = media_id.trim();
    if media_id.is_empty() || media_id.len() > 512 {
        return err(
            "invalid_media_item",
            "mediaId is invalid.",
            StatusCode::BAD_REQUEST,
        );
    }

    let now = Utc::now().to_rfc3339();
    match delete_saved_media(state.db_pool(), &session.account_id, media_id, &now).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => err(
            "server_error",
            "Could not delete this saved media.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

/// Deletes a saved sticker or GIF. A file it kept from being deleted with its
/// message is queued to be checked again at once.
async fn delete_saved_media(
    pool: &PgPool,
    account_id: &str,
    media_id: &str,
    now: &str,
) -> Result<(), crate::chat_sync::store::StoreError> {
    use crate::chat_sync::store::{enqueue_removal_job, NewRemovalJob, RemovalReason};
    let mut transaction = pool.begin().await?;
    let deleted: Vec<(String,)> = query_as(
        "UPDATE cloud_expressive_media_items SET deleted_at = $1, updated_at = $1 \
         WHERE account_id = $2 AND (item_id = $3 OR attachment_id = $3) AND deleted_at IS NULL \
         RETURNING attachment_id",
    )
    .bind(now)
    .bind(account_id)
    .bind(media_id)
    .fetch_all(&mut *transaction)
    .await?;
    let attachment_ids = deleted.into_iter().map(|(id,)| id).collect::<Vec<_>>();
    let released: Vec<(String,)> = query_as(
        "SELECT attachment_id FROM cloud_attachments \
         WHERE attachment_id = ANY($1) AND purge_candidate_at IS NOT NULL \
           AND purge_requested_at IS NULL ORDER BY attachment_id",
    )
    .bind(&attachment_ids)
    .fetch_all(&mut *transaction)
    .await?;
    for (attachment_id,) in released {
        enqueue_removal_job(
            &mut transaction,
            NewRemovalJob {
                reason: RemovalReason::AttachmentReleased,
                account_id: None,
                conversation_id: None,
                message_id: None,
                source_identifiers: &[],
                attachment_ids: &[attachment_id],
            },
        )
        .await?;
    }
    transaction.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_supported_media_kinds_and_content_types() {
        assert_eq!(normalized_kind(" Sticker "), Some("sticker"));
        assert_eq!(normalized_kind("video"), None);
        assert_eq!(kind_for_content_type("image/gif"), Some("gif"));
        assert_eq!(kind_for_content_type("image/webp"), Some("sticker"));
        assert!(kind_matches_content_type("sticker", "image/gif"));
        assert!(kind_matches_content_type("gif", "image/gif"));
        assert!(!kind_matches_content_type("gif", "image/png"));
        assert_eq!(kind_for_content_type("text/html"), None);
    }

    #[test]
    fn rejects_empty_long_or_multiline_media_names() {
        assert_eq!(
            clean_media_name(" sticker.png ").as_deref(),
            Some("sticker.png")
        );
        assert!(clean_media_name("").is_none());
        assert!(clean_media_name("bad\nname.png").is_none());
        assert!(clean_media_name(&"a".repeat(256)).is_none());
    }

    #[test]
    fn enforces_the_saved_media_size_limit() {
        assert!(!media_size_allowed(0));
        assert!(media_size_allowed(MAX_EXPRESSIVE_MEDIA_BYTES));
        assert!(!media_size_allowed(MAX_EXPRESSIVE_MEDIA_BYTES + 1));
    }
}
