use super::*;

/// Replace the kind and content of a trusted server-authored message while
/// keeping its original timeline position. Call lifecycle records use this to
/// transition one durable message from `started` to `ended` for every member.
/// An agent reply that other people read loses the owner's local paths here,
/// as it does when it is first stored.
pub(crate) async fn replace_server_message_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    sender_account_id: &str,
    client_message_id: Uuid,
    message_kind: &str,
    mut content: Value,
) -> Result<Option<MessageSnapshot>, StoreError> {
    let message_kind = message_kind.trim();
    if message_kind.is_empty() || message_kind.chars().count() > 64 {
        return Err(StoreError::InvalidInput("message kind is invalid"));
    }
    let row: Option<(Uuid, Uuid, String, Value)> = query_as(
        "SELECT message_id, conversation_id, message_kind, content \
         FROM cloud_chat_messages \
         WHERE sender_account_id = $1 AND client_message_id = $2 FOR UPDATE",
    )
    .bind(sender_account_id)
    .bind(client_message_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some((message_id, conversation_id, stored_kind, stored_content)) = row else {
        return Ok(None);
    };
    crate::chat_sync::local_paths::strip_shared_agent_reply(
        transaction,
        conversation_id,
        &mut content,
    )
    .await?;
    if stored_kind == message_kind && stored_content == content {
        return Ok(Some(load_message(transaction, message_id).await?));
    }

    query(
        "UPDATE cloud_chat_messages \
         SET message_kind = $2, content = $3, version = version + 1, edited_at = now() \
         WHERE message_id = $1",
    )
    .bind(message_id)
    .bind(message_kind)
    .bind(&content)
    .execute(&mut **transaction)
    .await?;
    let message = load_message(transaction, message_id).await?;
    fanout_message_sync_event(transaction, "message.updated", &message).await?;
    Ok(Some(message))
}
