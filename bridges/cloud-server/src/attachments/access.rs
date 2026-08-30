use axum::http::StatusCode;
use axum::response::Response;
use sqlx_core::query_as::query_as;

use crate::attachments::response::boxed_err;
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

pub(crate) type AttachmentAccessRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<String>,
);

pub(crate) async fn attachment_access_row(
    state: &ServerState,
    session: &CloudSession,
    attachment_id: &str,
) -> Result<AttachmentAccessRow, Box<Response>> {
    let pool = state.db_pool();
    let row: Option<AttachmentAccessRow> = match query_as(
        "SELECT object_key, owner_account_id, finalized_at, content_type, detected_content_type, size_bytes, preview_url \
         FROM cloud_attachments \
         WHERE attachment_id = $1",
    )
    .bind(attachment_id)
    .fetch_optional(pool)
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return Err(boxed_err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            ))
        }
    };

    let Some(row) = row else {
        return Err(boxed_err(
            "not_found",
            "Attachment not found.",
            StatusCode::NOT_FOUND,
        ));
    };
    if row.1 != session.account_id {
        let allowed: Option<(i32,)> = match query_as(
            "SELECT 1 FROM cloud_expressive_media_items \
             WHERE attachment_id = $1 AND account_id = $2 AND deleted_at IS NULL \
             UNION ALL \
             SELECT 1 \
             FROM cloud_chat_message_attachments attachment \
             JOIN cloud_chat_messages message \
               ON message.message_id = attachment.message_id \
             JOIN cloud_chat_conversation_members member \
               ON member.conversation_id = message.conversation_id \
             WHERE attachment.attachment_id = $1 \
               AND member.account_id = $2 \
               AND member.membership_state = 'active' \
             LIMIT 1",
        )
        .bind(attachment_id)
        .bind(&session.account_id)
        .fetch_optional(pool)
        .await
        {
            Ok(value) => value,
            Err(_) => {
                return Err(boxed_err(
                    "server_error",
                    "Database error.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                ))
            }
        };
        if allowed.is_none() {
            return Err(boxed_err(
                "not_found",
                "Attachment not found.",
                StatusCode::NOT_FOUND,
            ));
        }
    }
    if row.2.is_none() {
        return Err(boxed_err(
            "not_finalized",
            "Attachment upload has not been finalized.",
            StatusCode::CONFLICT,
        ));
    }

    Ok(row)
}
