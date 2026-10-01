use super::super::redaction::{content_free_payload, hidden_recipients};
use super::super::sync_events::{insert_sync_event_fanout_rows, FanoutRow};
use super::*;

/// Queues a message change for every member's sync feed and marks their
/// digests as changed when the message can matter to one.
///
/// A deletion reaches every member without content. A member who removed
/// the message from their own view receives a content-free `message.hidden`
/// for any later change instead of the snapshot.
pub(in crate::chat_sync::store) async fn fanout_message_sync_event(
    transaction: &mut Transaction<'_, Postgres>,
    event_type: &str,
    message: &MessageSnapshot,
) -> Result<(), StoreError> {
    let deleted = event_type == "message.deleted";
    let hidden = if deleted {
        Default::default()
    } else {
        hidden_recipients(transaction, message.id).await?
    };
    let mut rows = Vec::new();
    for (account_id, conversation) in
        load_active_conversation_projections(transaction, message.conversation_id).await?
    {
        let (event_type, payload) = if deleted || hidden.contains(&account_id) {
            let conversation = serde_json::to_value(&conversation)
                .map_err(|_| StoreError::InvariantViolation("conversation projection failed"))?;
            (
                if deleted {
                    "message.deleted"
                } else {
                    "message.hidden"
                },
                content_free_payload(message.id, Some(&conversation)),
            )
        } else {
            (
                event_type,
                json!({ "message": message, "conversation": conversation }),
            )
        };
        rows.push(FanoutRow {
            account_id,
            event_type,
            payload,
        });
    }
    insert_sync_event_fanout_rows(
        transaction,
        Some(message.conversation_id),
        Some(message.id),
        Some(message.version),
        rows,
    )
    .await?;
    crate::digest::changes::note_message(&mut **transaction, event_type, message).await?;
    Ok(())
}
