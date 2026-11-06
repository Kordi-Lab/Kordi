//! Server-built evidence: the chosen messages, the conversation, and a
//! contact request, checked against what the reporter could see.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use super::{
    ReportError, ValidReport, MAX_EVIDENCE_BYTES, MESSAGES_UNAVAILABLE, NO_MESSAGE_FROM_REPORTED,
};

/// One attachment of an evidence message: message, id, type, size, hash.
type AttachmentRow = (Uuid, String, Option<String>, Option<i64>, Option<String>);

/// Kind, session id, active member count, and when the reporter left.
type ConversationRow = (String, Option<String>, i64, Option<DateTime<Utc>>);

type MessageRow = (
    Uuid,
    String,
    String,
    DateTime<Utc>,
    Option<DateTime<Utc>>,
    i32,
    Value,
    Option<DateTime<Utc>>,
);

/// Copies the chosen messages and finds who they report. The reporter must
/// be or have been a member, and every message must be in the conversation
/// and, for a former member, sent before they left.
async fn message_evidence(
    transaction: &mut Transaction<'_, Postgres>,
    reporter: &str,
    report: &ValidReport,
) -> Result<(Value, Vec<Value>, String), ReportError> {
    let conversation_id = report
        .conversation_id
        .ok_or(ReportError::InvalidEvidence(MESSAGES_UNAVAILABLE))?;
    // Someone who left or was removed can still report what they saw while
    // they were a member: messages up to the time they left.
    let conversation: Option<ConversationRow> = query_as(
        "SELECT conversation.kind, conversation.legacy_session_id, \
                (SELECT COUNT(*) FROM cloud_chat_conversation_members member \
                 WHERE member.conversation_id = conversation.conversation_id \
                   AND member.membership_state = 'active'), \
                CASE WHEN reporter.membership_state = 'active' THEN NULL \
                     ELSE COALESCE(reporter.left_at, now()) END \
         FROM cloud_chat_conversations conversation \
         JOIN cloud_chat_conversation_members reporter \
           ON reporter.conversation_id = conversation.conversation_id \
         WHERE conversation.conversation_id = $1 AND reporter.account_id = $2",
    )
    .bind(conversation_id)
    .bind(reporter)
    .fetch_optional(&mut **transaction)
    .await?;
    let (kind, legacy_session_id, active_members, left_at) =
        conversation.ok_or(ReportError::InvalidEvidence(MESSAGES_UNAVAILABLE))?;
    // A message its sender deleted for everyone stays reportable; the copy
    // keeps its metadata and whatever content remains.
    let rows: Vec<MessageRow> = query_as(
        "SELECT message_id, sender_account_id, message_kind, created_at, edited_at, version, \
                content, deleted_at \
         FROM cloud_chat_messages \
         WHERE conversation_id = $1 AND message_id = ANY($2) \
           AND ($3::TIMESTAMPTZ IS NULL OR created_at <= $3) \
         ORDER BY conversation_sequence",
    )
    .bind(conversation_id)
    .bind(&report.message_ids)
    .bind(left_at)
    .fetch_all(&mut **transaction)
    .await?;
    if rows.len() != report.message_ids.len() {
        return Err(ReportError::InvalidEvidence(MESSAGES_UNAVAILABLE));
    }
    let senders = rows
        .iter()
        .map(|row| (row.0, row.1.clone()))
        .collect::<HashMap<_, _>>();
    // Agent messages are sent as their owner, so they count for the owner.
    let reported = match &report.reported_account_id {
        Some(reported) => reported.clone(),
        None => report
            .message_ids
            .iter()
            .filter_map(|id| senders.get(id))
            .find(|sender| sender.as_str() != reporter)
            .cloned()
            .ok_or(ReportError::InvalidEvidence(NO_MESSAGE_FROM_REPORTED))?,
    };
    if !senders.values().any(|sender| *sender == reported) {
        return Err(ReportError::InvalidEvidence(NO_MESSAGE_FROM_REPORTED));
    }
    let attachments: Vec<AttachmentRow> = query_as(
        "SELECT link.message_id, attachment.attachment_id, \
                COALESCE(attachment.detected_content_type, attachment.content_type), \
                attachment.size_bytes, attachment.sha256_hex \
         FROM cloud_chat_message_attachments link \
         JOIN cloud_attachments attachment ON attachment.attachment_id = link.attachment_id \
         WHERE link.message_id = ANY($1) ORDER BY link.message_id, link.position",
    )
    .bind(&report.message_ids)
    .fetch_all(&mut **transaction)
    .await?;
    let messages = rows
        .into_iter()
        .map(
            |(id, sender, kind, created_at, edited_at, version, content, deleted_at)| {
                let files = attachments
                    .iter()
                    .filter(|row| row.0 == id)
                    .map(|(_, attachment_id, content_type, size, sha256)| {
                        json!({ "attachmentId": attachment_id, "contentType": content_type,
                            "sizeBytes": size, "sha256Hex": sha256 })
                    })
                    .collect::<Vec<_>>();
                json!({ "messageId": id, "senderAccountId": sender, "messageKind": kind,
                    "createdAt": created_at, "editedAt": edited_at, "deletedAt": deleted_at,
                    "version": version, "content": content, "attachments": files })
            },
        )
        .collect();
    let conversation = json!({ "conversationId": conversation_id, "kind": kind,
                               "legacySessionId": legacy_session_id,
                               "activeMemberCount": active_members });
    Ok((conversation, messages, reported))
}

/// Whether serialized evidence fits in [`MAX_EVIDENCE_BYTES`].
pub fn within_size_limit(evidence: &Value) -> bool {
    serde_json::to_vec(evidence).is_ok_and(|bytes| bytes.len() <= MAX_EVIDENCE_BYTES)
}

/// The checked evidence for a report, before it is stored.
#[derive(Debug)]
pub struct Prepared {
    pub reported: String,
    pub reported_display_name: Option<String>,
    pub evidence: Value,
    pub message_count: i32,
}

/// Runs every evidence check and builds the evidence. Nothing is written.
pub async fn prepare(
    pool: &PgPool,
    reporter: &str,
    report: &ValidReport,
) -> Result<Prepared, ReportError> {
    let mut transaction = pool.begin().await?;
    let (conversation, messages, reported) = if report.message_ids.is_empty() {
        (
            Value::Null,
            Vec::new(),
            report.reported_account_id.clone().unwrap_or_default(),
        )
    } else {
        message_evidence(&mut transaction, reporter, report).await?
    };
    let account: Option<(Option<String>,)> =
        query_as("SELECT display_name FROM cloud_accounts WHERE account_id = $1")
            .bind(&reported)
            .fetch_optional(&mut *transaction)
            .await?;
    let (reported_display_name,) = account.ok_or(ReportError::AccountMissing)?;
    if reported == reporter {
        return Err(ReportError::SelfReport);
    }
    let contact_request = match &report.contact_request_id {
        None => Value::Null,
        Some(request_id) => {
            let row: Option<(Option<String>, String, String)> = query_as(
                "SELECT message, created_at, status FROM cloud_contact_requests \
                 WHERE request_id = $1 AND to_account_id = $2 AND from_account_id = $3",
            )
            .bind(request_id)
            .bind(reporter)
            .bind(&reported)
            .fetch_optional(&mut *transaction)
            .await?;
            let (message, created_at, status) = row.ok_or(ReportError::InvalidEvidence(
                "This contact request can't be included in the report.",
            ))?;
            json!({ "requestId": request_id, "message": message,
                    "createdAt": created_at, "status": status })
        }
    };
    let message_count = messages.len() as i32;
    let evidence = json!({
        "schema": 1,
        "capturedAt": Utc::now(),
        "conversation": conversation,
        "messages": messages,
        "contactRequest": contact_request,
    });
    if !within_size_limit(&evidence) {
        return Err(ReportError::TooLarge);
    }
    transaction.commit().await?;
    Ok(Prepared {
        reported,
        reported_display_name,
        evidence,
        message_count,
    })
}
