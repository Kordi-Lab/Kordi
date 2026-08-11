use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::chat_sync::models::{ConversationKind, CreateConversationRequest, SendMessageRequest};
use crate::chat_sync::store;

const CLOUD_AGENT_RESPONSE_PREFIX: &str = "kordi-cloud-agent-response:";

fn canonical_response_request_id(body: &str) -> Option<Uuid> {
    let encoded = body.trim().strip_prefix(CLOUD_AGENT_RESPONSE_PREFIX)?;
    let decoded = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let envelope: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    envelope
        .get("requestId")
        .and_then(serde_json::Value::as_str)
        .and_then(|request_id| Uuid::parse_str(request_id.trim()).ok())
}

pub(super) struct CloudAgentResponseSyncEvent<'a> {
    pub account_id: &'a str,
    pub peer_account_id: &'a str,
    pub message_id: &'a str,
    pub from_account_id: &'a str,
    pub to_account_id: &'a str,
    pub body: &'a str,
    pub session_id: &'a str,
    pub direction: &'a str,
}

fn deterministic_message_uuid(event: &CloudAgentResponseSyncEvent<'_>) -> Uuid {
    // The run/response identity is stable across retries and recipients. Body
    // text is intentionally excluded because durable AI snapshots may advance
    // while retaining one timeline position.
    let digest = Sha256::digest(format!(
        "{}\0{}\0{}",
        event.session_id, event.from_account_id, event.message_id
    ));
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

fn deterministic_conversation_operation_id(session_id: &str) -> Uuid {
    let digest = Sha256::digest(format!("cloud-agent-conversation\0{}", session_id.trim()));
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

fn group_conversation_metadata(body: &str) -> Option<(Option<String>, Vec<String>)> {
    let encoded = body.trim().strip_prefix("kordi-cloud-group:")?;
    let decoded = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let envelope: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    let title = envelope
        .get("groupTitle")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(ToString::to_string);
    let members = envelope
        .get("participants")?
        .as_array()?
        .iter()
        .filter_map(|participant| participant.get("accountId"))
        .filter_map(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|account_id| !account_id.is_empty())
        .map(ToString::to_string)
        .collect();
    Some((title, members))
}

async fn ensure_response_conversation(
    pool: &PgPool,
    event: &CloudAgentResponseSyncEvent<'_>,
) -> Result<(), sqlx_core::Error> {
    let exists: Option<(Uuid,)> = query_as(
        "SELECT conversation_id FROM cloud_chat_conversations WHERE legacy_session_id = $1",
    )
    .bind(event.session_id)
    .fetch_optional(pool)
    .await?;
    if exists.is_some() {
        return Ok(());
    }

    let (kind, title, mut members) = if event.session_id.starts_with("session:group:") {
        let Some((title, members)) = group_conversation_metadata(event.body) else {
            return Ok(());
        };
        (ConversationKind::Group, title, members)
    } else if event.from_account_id == event.to_account_id {
        (
            ConversationKind::Ai,
            None,
            vec![event.from_account_id.to_string()],
        )
    } else {
        (
            ConversationKind::Direct,
            None,
            vec![
                event.from_account_id.to_string(),
                event.to_account_id.to_string(),
            ],
        )
    };
    members.sort();
    members.dedup();
    let request = CreateConversationRequest {
        client_operation_id: deterministic_conversation_operation_id(event.session_id),
        kind,
        shared_title: title,
        client_session_id: event.session_id.to_string(),
        member_account_ids: members,
    };
    store::create_conversation(pool, event.from_account_id, request)
        .await
        .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
    Ok(())
}

/// Publish hosted-agent terminal output into the same durable v2 stream used
/// by human messages. The retired v1 mailbox is intentionally not written:
/// clients cannot consume that stream after the v2 cutover.
pub(super) async fn append_cloud_agent_response_sync_event(
    pool: &PgPool,
    event: CloudAgentResponseSyncEvent<'_>,
) -> Result<Option<String>, sqlx_core::Error> {
    // Retain these fields in the call contract until the old agent persistence
    // rows are removed in a later storage migration.
    let _legacy_diagnostics = (
        event.account_id,
        event.peer_account_id,
        event.message_id,
        event.to_account_id,
        event.direction,
    );
    ensure_response_conversation(pool, &event).await?;
    let conversation: Option<(Uuid,)> = query_as(
        "SELECT conversation.conversation_id
         FROM cloud_chat_conversations conversation
         JOIN cloud_chat_conversation_members member
           ON member.conversation_id = conversation.conversation_id
         WHERE conversation.legacy_session_id = $1
           AND member.account_id = $2
           AND member.membership_state = 'active'",
    )
    .bind(event.session_id)
    .bind(event.from_account_id)
    .fetch_optional(pool)
    .await?;
    let Some((conversation_id,)) = conversation else {
        // A run created before the v2 conversation existed has no safe
        // canonical destination. Do not resurrect the retired v1 stream.
        return Ok(None);
    };
    let reply_to_message_id = if let Some(request_id) = canonical_response_request_id(event.body) {
        query_as::<_, (Uuid,)>(
            "SELECT message_id FROM cloud_chat_messages
             WHERE message_id = $1 AND conversation_id = $2",
        )
        .bind(request_id)
        .bind(conversation_id)
        .fetch_optional(pool)
        .await?
        .map(|(message_id,)| message_id)
    } else {
        None
    };
    let client_message_id = deterministic_message_uuid(&event);
    let content = json!({
        "schema": 1,
        "blocks": [{ "type": "text", "text": event.body }]
    });
    let outcome = store::send_message(
        pool,
        event.from_account_id,
        conversation_id,
        SendMessageRequest {
            client_message_id,
            kind: "text".to_string(),
            content: content.clone(),
            reply_to_message_id,
            attachment_ids: Vec::new(),
        },
    )
    .await;
    match outcome {
        Ok(outcome) => Ok(Some(outcome.value.id.to_string())),
        Err(store::StoreError::IdempotencyKeyReused) => {
            let existing: Option<(Uuid,)> = query_as(
                "SELECT message_id FROM cloud_chat_messages \
                 WHERE sender_account_id = $1 AND client_message_id = $2",
            )
            .bind(event.from_account_id)
            .bind(client_message_id)
            .fetch_optional(pool)
            .await?;
            let Some((message_id,)) = existing else {
                return Err(sqlx_core::Error::Protocol(
                    "agent response idempotency row is missing".to_string(),
                ));
            };
            let attachment_ids = query_as::<_, (String,)>(
                "SELECT attachment_id FROM cloud_chat_message_attachments \
                 WHERE message_id = $1 ORDER BY position ASC",
            )
            .bind(message_id)
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|(attachment_id,)| attachment_id)
            .collect();
            let message = store::replace_message_snapshot(
                pool,
                event.from_account_id,
                message_id,
                content,
                attachment_ids,
            )
            .await
            .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
            Ok(Some(message.id.to_string()))
        }
        Err(error) => Err(sqlx_core::Error::Protocol(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::{canonical_response_request_id, CLOUD_AGENT_RESPONSE_PREFIX};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use uuid::Uuid;

    #[test]
    fn direct_response_extracts_only_a_canonical_uuid_request_id() {
        let request_id = Uuid::parse_str("019fef23-7704-7070-9d74-37e462f3108f").unwrap();
        let body = format!(
            "{}{}",
            CLOUD_AGENT_RESPONSE_PREFIX,
            URL_SAFE_NO_PAD.encode(
                serde_json::json!({
                    "kind": "agent-response",
                    "requestId": request_id,
                    "text": "done",
                    "deliveryState": "complete"
                })
                .to_string()
            )
        );
        assert_eq!(canonical_response_request_id(&body), Some(request_id));

        let scheduled = format!(
            "{}{}",
            CLOUD_AGENT_RESPONSE_PREFIX,
            URL_SAFE_NO_PAD
                .encode(serde_json::json!({ "requestId": "scheduled_run_123" }).to_string())
        );
        assert_eq!(canonical_response_request_id(&scheduled), None);
        assert_eq!(canonical_response_request_id("not-an-envelope"), None);
    }
}
