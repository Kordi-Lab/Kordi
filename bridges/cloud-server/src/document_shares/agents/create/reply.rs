//! Attaches a run's documents to the agent's reply when the reply is
//! published, so the document shows inside the reply, from the agent.
//!
//! Every path that publishes a reply calls in here:
//! - the Mac's progress route, for a completed run ([`attach_run_documents`]);
//! - cloud completion ([`pending_for_run`] and [`mark_attached`] around the
//!   reply it sends);
//! - a background task's follow-up, which the Mac publishes as an ordinary
//!   group message ([`attach_follow_up_documents`], from the chat store).
//!
//! Adding a document writes the reference into the group envelope's
//! `message.attachments` and the canonical `legacy_attachments`, and links the
//! attachment to the message. The attachment belongs to the agent's owner,
//! who is the reply's sender, so the chat store's ownership check holds.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgConnection;
use uuid::Uuid;

use crate::chat_sync::models::SendMessageRequest;

const GROUP_PREFIX: &str = "kordi-cloud-group:";
/// Request id prefix of a background task's follow-up reply on the Mac.
pub(crate) const FOLLOW_UP_PREFIX: &str = "background-result:";

/// A document waiting for its reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RunDocument {
    pub attachment_id: String,
    pub file_name: String,
    pub content_type: String,
    pub size_bytes: i64,
}

type DocumentRow = (String, String, String, i64);

fn documents(rows: Vec<DocumentRow>) -> Vec<RunDocument> {
    rows.into_iter()
        .map(
            |(attachment_id, file_name, content_type, size_bytes)| RunDocument {
                attachment_id,
                file_name,
                content_type,
                size_bytes,
            },
        )
        .collect()
}

/// The attachment reference clients read from a message.
pub(crate) fn attachment_reference(document: &RunDocument) -> Value {
    json!({
        "attachmentId": document.attachment_id,
        "name": document.file_name,
        "kind": "file",
        "mimeType": document.content_type,
        "sizeBytes": document.size_bytes,
        "previewUrl": null
    })
}

/// The documents of `run_id` that no reply has taken yet, oldest first.
pub(crate) async fn pending_for_run(
    conn: &mut PgConnection,
    run_id: &str,
) -> Result<Vec<RunDocument>, sqlx_core::Error> {
    let rows: Vec<DocumentRow> = query_as(
        "SELECT attachment_id, file_name, content_type, size_bytes \
         FROM cloud_agent_run_documents \
         WHERE run_id = $1 AND attached_at IS NULL AND NOT after_reply \
         ORDER BY created_at, attachment_id",
    )
    .bind(run_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(documents(rows))
}

pub(crate) async fn mark_attached(
    conn: &mut PgConnection,
    documents: &[RunDocument],
) -> Result<(), sqlx_core::Error> {
    let ids: Vec<&str> = documents
        .iter()
        .map(|document| document.attachment_id.as_str())
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    query(
        "UPDATE cloud_agent_run_documents SET attached_at = now() \
         WHERE attachment_id = ANY($1) AND attached_at IS NULL",
    )
    .bind(&ids)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

fn decode_group(body: &str) -> Option<Value> {
    let encoded = body.strip_prefix(GROUP_PREFIX)?;
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()
}

fn encode_group(envelope: &Value) -> Option<String> {
    Some(format!(
        "{GROUP_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(envelope).ok()?)
    ))
}

fn push_unique(target: &mut Value, reference: &Value) {
    if !target.is_array() {
        *target = json!([]);
    }
    if let Some(items) = target.as_array_mut() {
        let id = &reference["attachmentId"];
        if !items.iter().any(|item| &item["attachmentId"] == id) {
            items.push(reference.clone());
        }
    }
}

/// Adds `documents` to a reply about to be stored: the group envelope, the
/// canonical attachment list, and the attachment links.
pub(crate) fn add_to_request(request: &mut SendMessageRequest, documents: &[RunDocument]) {
    if documents.is_empty() {
        return;
    }
    let references: Vec<Value> = documents.iter().map(attachment_reference).collect();
    if let Some(text) = request
        .content
        .get_mut("blocks")
        .and_then(|blocks| blocks.get_mut(0))
        .and_then(|block| block.get_mut("text"))
    {
        let envelope = text.as_str().and_then(decode_group);
        if let Some(mut envelope) = envelope {
            if let Some(message) = envelope.get_mut("message").and_then(Value::as_object_mut) {
                let attachments = message.entry("attachments").or_insert_with(|| json!([]));
                for reference in &references {
                    push_unique(attachments, reference);
                }
            }
            if let Some(encoded) = encode_group(&envelope) {
                *text = Value::String(encoded);
            }
        }
    }
    if let Some(object) = request.content.as_object_mut() {
        let attachments = object
            .entry("legacy_attachments")
            .or_insert_with(|| json!([]));
        for reference in &references {
            push_unique(attachments, reference);
        }
    }
    for document in documents {
        if !request.attachment_ids.contains(&document.attachment_id) {
            request.attachment_ids.push(document.attachment_id.clone());
        }
    }
}

/// The Mac's completed reply for `run_id` takes the run's documents.
pub(crate) async fn attach_run_documents(
    conn: &mut PgConnection,
    run_id: &str,
    mut request: SendMessageRequest,
) -> Result<SendMessageRequest, sqlx_core::Error> {
    let documents = pending_for_run(conn, run_id).await?;
    add_to_request(&mut request, &documents);
    mark_attached(conn, &documents).await?;
    Ok(request)
}

/// The body and attachments a reply was stored with, for the route that
/// answers the Mac with it. Storing adds the run's documents, so echoing the
/// sent body would leave the Mac's copy without them.
pub(crate) fn stored_reply_fields(content: &Value, sent_body: &str) -> (String, Option<Value>) {
    let body = content
        .pointer("/blocks/0/text")
        .and_then(Value::as_str)
        .unwrap_or(sent_body)
        .to_string();
    let attachments = content
        .get("legacy_attachments")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .map(|items| Value::Array(items.clone()));
    (body, attachments)
}

/// A completed follow-up reply of a background task: the agent's group
/// message whose request id is a follow-up id.
fn is_follow_up_reply(content: &Value, sender_account_id: &str) -> bool {
    let Some(envelope) = content
        .pointer("/blocks/0/text")
        .and_then(Value::as_str)
        .and_then(decode_group)
    else {
        return false;
    };
    let message = &envelope["message"];
    message["senderKind"] == "agent"
        && message["senderAccountId"] == sender_account_id
        && message["deliveryState"] == "complete"
        && message["requestId"]
            .as_str()
            .is_some_and(|id| id.starts_with(FOLLOW_UP_PREFIX))
        && message["text"]
            .as_str()
            .is_some_and(|text| !text.trim().is_empty())
}

/// A background task's follow-up reply takes the documents its task created
/// after the run answered, in the same group, by the same owner.
pub(crate) async fn attach_follow_up_documents(
    conn: &mut PgConnection,
    sender_account_id: &str,
    conversation_id: Uuid,
    request: &mut SendMessageRequest,
) -> Result<(), sqlx_core::Error> {
    if !is_follow_up_reply(&request.content, sender_account_id) {
        return Ok(());
    }
    let rows: Vec<DocumentRow> = query_as(
        "SELECT document.attachment_id, document.file_name, document.content_type, \
                document.size_bytes \
         FROM cloud_agent_run_documents document \
         JOIN cloud_chat_conversations conversation \
           ON conversation.legacy_session_id = document.session_id \
         WHERE conversation.conversation_id = $1 AND document.owner_account_id = $2 \
           AND document.after_reply AND document.attached_at IS NULL \
         ORDER BY document.created_at, document.attachment_id",
    )
    .bind(conversation_id)
    .bind(sender_account_id)
    .fetch_all(&mut *conn)
    .await?;
    let documents = documents(rows);
    add_to_request(request, &documents);
    mark_attached(conn, &documents).await
}
