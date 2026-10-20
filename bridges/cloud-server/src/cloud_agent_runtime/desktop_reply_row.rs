//! One reply row per desktop-run chat request.
//!
//! Every progress snapshot from the Mac carries its own client id. Inserting
//! each one gave a request a new processing message per tick, and a snapshot
//! that arrived late could show the request running after its terminal reply.
//! The run's reply row is now edited in place: progress replaces a processing
//! row, the terminal reply replaces it once, and a terminal row never changes.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_postgres::Postgres;
use uuid::Uuid;

use crate::chat_sync::models::{MessageSnapshot, SendMessageRequest};
use crate::chat_sync::store::{
    replace_server_message_in_transaction, send_message_in_transaction, StoreError,
};

const RESPONSE_PREFIX: &str = "kordi-cloud-agent-response:";

/// The delivery state a stored direct agent reply carries.
fn stored_delivery_state(content: &Value) -> Option<String> {
    let encoded = content
        .pointer("/blocks/0/text")
        .and_then(Value::as_str)?
        .strip_prefix(RESPONSE_PREFIX)?;
    let envelope: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?;
    envelope
        .get("deliveryState")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Publishes `reply` into the run's reply row: the first publication inserts
/// it, later ones edit a processing row in place, and a terminal row stays.
pub(super) async fn publish_into_reply_row(
    transaction: &mut sqlx_core::transaction::Transaction<'_, Postgres>,
    run_id: &str,
    sender_account_id: &str,
    conversation_id: Uuid,
    reply: SendMessageRequest,
) -> Result<MessageSnapshot, StoreError> {
    let row: Option<(Uuid, Value)> = query_as(
        "SELECT m.client_message_id, m.content FROM cloud_agent_fallback_runs run \
         JOIN cloud_chat_messages m ON m.message_id::text = run.response_message_id \
         WHERE run.run_id = $1 AND m.sender_account_id = $2 AND m.conversation_id = $3 \
           AND m.deleted_at IS NULL FOR UPDATE OF m",
    )
    .bind(run_id)
    .bind(sender_account_id)
    .bind(conversation_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some((row_client_id, content)) = row else {
        return Ok(send_message_in_transaction(
            transaction,
            sender_account_id,
            conversation_id,
            reply,
        )
        .await?
        .value);
    };
    // A retry of the same publication, or a row that already ended, is kept.
    let content = if row_client_id == reply.client_message_id
        || stored_delivery_state(&content).is_some_and(|state| state != "processing")
    {
        content
    } else {
        reply.content
    };
    replace_server_message_in_transaction(
        transaction,
        sender_account_id,
        row_client_id,
        "text",
        content,
    )
    .await?
    .ok_or(StoreError::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stored(envelope: Value) -> Value {
        let text = format!(
            "{RESPONSE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(envelope.to_string())
        );
        json!({"schema": 1, "blocks": [{"type": "text", "text": text}]})
    }

    #[test]
    fn reads_the_delivery_state_of_a_stored_reply() {
        let processing = stored(json!({"kind": "agent-response", "deliveryState": "processing"}));
        let cancelled = stored(json!({"kind": "agent-response", "deliveryState": "cancelled"}));
        assert_eq!(
            stored_delivery_state(&processing).as_deref(),
            Some("processing")
        );
        assert_eq!(
            stored_delivery_state(&cancelled).as_deref(),
            Some("cancelled")
        );
        assert_eq!(
            stored_delivery_state(&json!({"blocks": [{"text": "plain"}]})),
            None
        );
    }
}
