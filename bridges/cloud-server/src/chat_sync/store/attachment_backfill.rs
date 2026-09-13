use super::support::*;
use super::*;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MissingImageInput {
    #[serde(rename = "attachmentId")]
    pub attachment_id: String,
    pub name: String,
}

/// Repair the old text-only desktop history export without changing its timeline
/// position or permitting deleted, edited, or already-attached messages to return.
pub async fn backfill_missing_images(
    pool: &PgPool,
    account: &str,
    conversation: Uuid,
    message_id: Uuid,
    images: Vec<MissingImageInput>,
) -> Result<MessageSnapshot, StoreError> {
    if images.is_empty() || images.len() > 32 {
        return Err(StoreError::InvalidInput("image count is invalid"));
    }
    let mut ids = BTreeSet::new();
    for image in &images {
        if image.attachment_id.trim().is_empty()
            || !ids.insert(&image.attachment_id)
            || image.name.trim().is_empty()
            || image.name.len() > 512
        {
            return Err(StoreError::InvalidInput("image metadata is invalid"));
        }
    }
    let mut tx = pool.begin().await?;
    let row: Option<(Uuid, String)> = query_as("SELECT conversation_id,sender_account_id FROM cloud_chat_messages WHERE message_id=$1 FOR UPDATE")
        .bind(message_id).fetch_optional(&mut *tx).await?;
    let Some((stored_conversation, sender)) = row else {
        return Err(StoreError::NotFound);
    };
    if stored_conversation != conversation {
        return Err(StoreError::NotFound);
    }
    require_active_member(&mut tx, conversation, account).await?;
    if sender != account {
        return Err(StoreError::Forbidden);
    }
    let current = load_message(&mut tx, message_id).await?;
    let private: (bool,) = query_as("SELECT kind='ai' AND created_by_account_id=$2 FROM cloud_chat_conversations WHERE conversation_id=$1")
        .bind(conversation).bind(account).fetch_one(&mut *tx).await?;
    if !private.0
        || current.kind != "canonical-history-user"
        || current.deleted_at.is_some()
        || current.version != 1
        || current.edited_at.is_some()
        || !current.attachment_ids.is_empty()
        || current
            .content
            .pointer("/canonical_history/localMessageId")
            .and_then(Value::as_str)
            .is_none()
    {
        return Err(StoreError::Forbidden);
    }
    let mut metadata = Vec::new();
    for (position, image) in images.iter().enumerate() {
        let blob: Option<(String, i64)> = query_as("SELECT content_type,size_bytes FROM cloud_attachments WHERE attachment_id=$1 AND owner_account_id=$2 AND finalized_at IS NOT NULL AND content_type IN ('image/png','image/jpeg','image/webp','image/gif')")
            .bind(&image.attachment_id).bind(account).fetch_optional(&mut *tx).await?;
        let Some((mime, size)) = blob else {
            return Err(StoreError::InvalidInput("image is unavailable"));
        };
        query("INSERT INTO cloud_chat_message_attachments(message_id,attachment_id,position) VALUES($1,$2,$3)")
            .bind(message_id).bind(&image.attachment_id).bind(position as i32).execute(&mut *tx).await?;
        metadata.push(json!({"attachmentId":image.attachment_id,"name":image.name,"kind":"image","mimeType":mime,"sizeBytes":size}));
    }
    let mut content = current.content;
    content["legacy_attachments"] = json!(metadata);
    query("UPDATE cloud_chat_messages SET content=$2,version=version+1 WHERE message_id=$1")
        .bind(message_id)
        .bind(content)
        .execute(&mut *tx)
        .await?;
    let message = load_message(&mut tx, message_id).await?;
    super::message::fanout_message_sync_event(&mut tx, "message.updated", &message).await?;
    tx.commit().await?;
    Ok(message)
}
