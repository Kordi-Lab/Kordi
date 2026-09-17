use super::*;

/// Refresh a trusted server-authored message's content in place, without
/// marking it edited. The message keeps its timeline position, its version
/// moves so every client replaces its copy, and readers see no edit marker.
/// PiP uses this to keep one plan card current as members respond.
pub async fn refresh_server_message_content(
    pool: &PgPool,
    sender_account_id: &str,
    message_id: Uuid,
    content: Value,
) -> Result<MessageSnapshot, StoreError> {
    let mut transaction = pool.begin().await?;
    let row: Option<(String,)> = query_as(
        "SELECT sender_account_id FROM cloud_chat_messages \
         WHERE message_id = $1 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(message_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((stored_sender_account_id,)) = row else {
        return Err(StoreError::NotFound);
    };
    if stored_sender_account_id != sender_account_id {
        return Err(StoreError::Forbidden);
    }
    let current = load_message(&mut transaction, message_id).await?;
    if current.content == content {
        transaction.commit().await?;
        return Ok(current);
    }
    query(
        "UPDATE cloud_chat_messages SET content = $2, version = version + 1 WHERE message_id = $1",
    )
    .bind(message_id)
    .bind(&content)
    .execute(&mut *transaction)
    .await?;
    let message = load_message(&mut transaction, message_id).await?;
    fanout_message_sync_event(&mut transaction, "message.updated", &message).await?;
    transaction.commit().await?;
    Ok(message)
}
