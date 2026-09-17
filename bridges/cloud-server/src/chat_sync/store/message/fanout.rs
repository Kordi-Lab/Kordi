use super::*;

/// Queues a message change for every member's sync feed and marks their
/// digests as changed when the message can matter to one.
pub(in crate::chat_sync::store) async fn fanout_message_sync_event(
    transaction: &mut Transaction<'_, Postgres>,
    event_type: &str,
    message: &MessageSnapshot,
) -> Result<(), StoreError> {
    let payloads = load_active_conversation_projections(transaction, message.conversation_id)
        .await?
        .into_iter()
        .map(|(account_id, conversation)| {
            (
                account_id,
                json!({ "message": message, "conversation": conversation }),
            )
        })
        .collect();
    insert_sync_event_fanout(
        transaction,
        event_type,
        Some(message.conversation_id),
        Some(message.id),
        Some(message.version),
        payloads,
    )
    .await?;
    crate::digest::changes::note_message(&mut **transaction, event_type, message).await?;
    Ok(())
}
