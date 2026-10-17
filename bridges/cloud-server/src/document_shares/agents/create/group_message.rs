//! Posts a created document in its group as the agent's message and lists it
//! in the session's Artifacts.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Map, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::super::tools::ToolError;
use super::NewDocument;
use crate::chat_sync::models::SendMessageRequest;
use crate::chat_sync::store::{self, StoreError};

const GROUP_PREFIX: &str = "kordi-cloud-group:";
/// Recent messages searched for the group's participant list.
const ENVELOPE_SCAN: i64 = 200;

pub(super) struct DocumentMessage<'a> {
    pub conversation_id: Uuid,
    pub client_message_id: Uuid,
    pub session_id: &'a str,
    pub owner_account_id: &'a str,
    pub agent_id: &'a str,
    pub attachment_id: &'a str,
    pub document: &'a NewDocument,
}

fn decoded_group_message(content: &Value) -> Option<Value> {
    let body = crate::chat_sync::voice::body_for_agent(content);
    let encoded = body.trim().strip_prefix(GROUP_PREFIX)?;
    let envelope: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?;
    let participants = envelope.get("participants")?.as_array()?;
    (envelope.get("kind").and_then(Value::as_str) == Some("group-message")
        && !participants.is_empty())
    .then_some(envelope)
}

/// The newest group message envelope of the conversation, for its
/// participants and group identity.
async fn latest_envelope(
    pool: &PgPool,
    conversation_id: Uuid,
) -> Result<Option<Value>, sqlx_core::Error> {
    let rows: Vec<(Value,)> = query_as(
        "SELECT content FROM cloud_chat_messages \
         WHERE conversation_id = $1 AND deleted_at IS NULL \
         ORDER BY conversation_sequence DESC LIMIT $2",
    )
    .bind(conversation_id)
    .bind(ENVELOPE_SCAN)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .find_map(|(content,)| decoded_group_message(content)))
}

pub(super) fn attachment_reference(attachment_id: &str, document: &NewDocument) -> Value {
    json!({
        "attachmentId": attachment_id,
        "name": document.file_name,
        "kind": "file",
        "mimeType": document.content_type,
        "sizeBytes": document.content.len(),
        "previewUrl": null
    })
}

/// The group envelope of the document message. It answers no request, so
/// clients never take it for the run's reply.
pub(super) fn document_envelope(
    latest: &Value,
    message: &DocumentMessage<'_>,
    created_at_ms: i64,
) -> Value {
    let participants = latest
        .get("participants")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let actor = participants
        .as_array()
        .and_then(|all| {
            all.iter().find(|participant| {
                participant.get("accountId").and_then(Value::as_str)
                    == Some(message.owner_account_id)
            })
        })
        .cloned()
        .unwrap_or_else(|| {
            json!({ "accountId": message.owner_account_id, "displayName": "Kordi", "role": "person" })
        });
    let mut envelope = Map::new();
    envelope.insert("kind".into(), json!("group-message"));
    envelope.insert("groupId".into(), json!(message.session_id));
    for key in ["groupSpaceId", "createdByAccountId"] {
        if let Some(value) = latest.get(key).filter(|value| !value.is_null()) {
            envelope.insert(key.into(), value.clone());
        }
    }
    envelope.insert("groupTitle".into(), Value::Null);
    envelope.insert("actor".into(), actor);
    envelope.insert("participants".into(), participants);
    envelope.insert(
        "message".into(),
        json!({
            "id": format!("msg:cloud-agent-document:{}", message.attachment_id),
            "senderAccountId": message.owner_account_id,
            "senderAgentId": message.agent_id,
            "senderKind": "agent",
            "text": "",
            "createdAtMs": created_at_ms,
            "deliveryState": "complete",
            "attachments": [attachment_reference(message.attachment_id, message.document)],
        }),
    );
    Value::Object(envelope)
}

/// Sends the document message as the agent's owner; returns its id.
pub(super) async fn post(pool: &PgPool, message: DocumentMessage<'_>) -> Result<String, ToolError> {
    let latest = latest_envelope(pool, message.conversation_id)
        .await?
        .ok_or(ToolError::Forbidden(
            "This group has no members to share the document with yet.",
        ))?;
    let envelope = document_envelope(&latest, &message, chrono::Utc::now().timestamp_millis());
    let body = format!(
        "{GROUP_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).map_err(|_| ToolError::Server)?)
    );
    let content = json!({
        "schema": 1,
        "blocks": [{ "type": "text", "text": body }],
        "legacy_attachments": [attachment_reference(message.attachment_id, message.document)],
    });
    let sent = store::send_message(
        pool,
        message.owner_account_id,
        message.conversation_id,
        SendMessageRequest {
            client_message_id: message.client_message_id,
            kind: "text".to_string(),
            content,
            reply_to_message_id: None,
            attachment_ids: vec![message.attachment_id.to_string()],
        },
    )
    .await;
    match sent {
        Ok(outcome) => Ok(outcome.value.id.to_string()),
        // A retry: the first call already posted it.
        Err(StoreError::IdempotencyKeyReused) => {
            let existing: Option<(Uuid,)> = query_as(
                "SELECT message_id FROM cloud_chat_messages \
                 WHERE sender_account_id = $1 AND client_message_id = $2",
            )
            .bind(message.owner_account_id)
            .bind(message.client_message_id)
            .fetch_optional(pool)
            .await?;
            existing
                .map(|(id,)| id.to_string())
                .ok_or(ToolError::Server)
        }
        Err(error) => {
            eprintln!("[documents] create_document message: {error}");
            Err(ToolError::Server)
        }
    }
}

/// Lists the document in the session's Artifacts activity, so it shows even
/// when the message is outside the loaded history.
pub(super) async fn record_artifact(
    pool: &PgPool,
    session_id: &str,
    artifact_id: &str,
    owner_account_id: &str,
    message_id: &str,
    attachment_id: &str,
    document: &NewDocument,
) -> Result<(), sqlx_core::Error> {
    let now = chrono::Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_session_artifacts (artifact_activity_id, session_id, artifact_id, \
         name, path, kind, category, summary, created_by_account_id, source_message_id, \
         attachment_id, content_type, size_bytes, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $4, 'document', 'artifact', NULL, $5, $6, $7, $8, $9, $10, $10) \
         ON CONFLICT (session_id, artifact_id) DO NOTHING",
    )
    .bind(format!("artifact_activity_{}", Uuid::new_v4().simple()))
    .bind(session_id)
    .bind(artifact_id)
    .bind(&document.file_name)
    .bind(owner_account_id)
    .bind(message_id)
    .bind(attachment_id)
    .bind(document.content_type)
    .bind(document.content.len() as i64)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(())
}
