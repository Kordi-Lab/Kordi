//! Abuse reports: request validation, server-built evidence, and idempotent
//! storage.
//!
//! The evidence is assembled by the server from the messages a person chose,
//! never from content the client sends, and attachment bytes are never
//! copied. Nothing here logs report content.

use std::collections::{BTreeSet, HashMap};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

pub const MAX_DETAILS_CHARS: usize = 1000;
pub const MAX_EVIDENCE_MESSAGES: usize = 50;
pub const MAX_EVIDENCE_BYTES: usize = 2 * 1024 * 1024;
pub const REASONS: [&str; 6] = [
    "spam",
    "harassment",
    "scam",
    "impersonation",
    "inappropriate",
    "other",
];
/// How many of their own reports a person can list.
pub const LIST_LIMIT: i64 = 100;

const MESSAGES_UNAVAILABLE: &str =
    "Some selected messages can't be included. Refresh the chat and try again.";
const NO_MESSAGE_FROM_REPORTED: &str =
    "Choose at least one message from the person you're reporting.";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateReportRequest {
    pub client_report_id: Uuid,
    pub reason: String,
    #[serde(default)]
    pub details: Option<String>,
    #[serde(default)]
    pub reported_account_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<Uuid>,
    #[serde(default)]
    pub message_ids: Vec<Uuid>,
    #[serde(default)]
    pub contact_request_id: Option<String>,
}

/// A request that passed shape validation, with its idempotency fingerprint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ValidReport {
    pub client_report_id: Uuid,
    pub reason: &'static str,
    pub details: Option<String>,
    pub reported_account_id: Option<String>,
    pub conversation_id: Option<Uuid>,
    pub message_ids: Vec<Uuid>,
    pub contact_request_id: Option<String>,
    #[serde(skip)]
    pub fingerprint: String,
}

impl ValidReport {
    pub fn target_kind(&self) -> &'static str {
        if self.message_ids.is_empty() {
            "account"
        } else {
            "message"
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportReceipt {
    pub report_id: String,
    pub reference: String,
    pub status: &'static str,
    pub reason: String,
    pub target_kind: String,
    pub evidence_message_count: i32,
    pub reported_display_name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub closed_at: Option<DateTime<Utc>>,
}

#[derive(Debug)]
pub enum ReportError {
    /// 400 `invalid_report`.
    Invalid(&'static str),
    /// 400 `invalid_report_evidence`.
    InvalidEvidence(&'static str),
    /// 409 `report_conflict`.
    Conflict,
    /// 404 `account_missing`.
    AccountMissing,
    /// 400 `self_report`.
    SelfReport,
    /// 413 `report_too_large`.
    TooLarge,
    Database(sqlx_core::Error),
}

impl From<sqlx_core::Error> for ReportError {
    fn from(error: sqlx_core::Error) -> Self {
        Self::Database(error)
    }
}

/// The reference a person can quote: `R-` and the first eight hex digits of
/// the report id.
pub fn reference(report_id: &str) -> String {
    let hex = report_id.strip_prefix("rpt_").unwrap_or(report_id);
    format!(
        "R-{}",
        hex.chars().take(8).collect::<String>().to_uppercase()
    )
}

fn new_report_id() -> String {
    format!("rpt_{}", Uuid::new_v4().simple())
}

fn trimmed(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Checks the request shape and normalizes it. Content is checked later
/// against the database.
pub fn validate(request: CreateReportRequest) -> Result<ValidReport, ReportError> {
    let reason = REASONS
        .into_iter()
        .find(|reason| *reason == request.reason.trim())
        .ok_or(ReportError::Invalid("Choose a reason for your report."))?;
    let details = trimmed(request.details.map(|details| details.replace('\0', "")));
    if details
        .as_ref()
        .is_some_and(|details| details.chars().count() > MAX_DETAILS_CHARS)
    {
        return Err(ReportError::Invalid("Keep details under 1,000 characters."));
    }
    if request.message_ids.len() > MAX_EVIDENCE_MESSAGES {
        return Err(ReportError::Invalid("Choose up to 50 messages."));
    }
    let unique = request.message_ids.iter().collect::<BTreeSet<_>>();
    if unique.len() != request.message_ids.len() {
        return Err(ReportError::Invalid(
            "Each message can be included only once.",
        ));
    }
    let reported_account_id = trimmed(request.reported_account_id);
    let conversation_id = if request.message_ids.is_empty() {
        if reported_account_id.is_none() {
            return Err(ReportError::Invalid("Choose the account you're reporting."));
        }
        None
    } else {
        Some(request.conversation_id.ok_or(ReportError::Invalid(
            "Choose the conversation the messages are in.",
        ))?)
    };
    let mut report = ValidReport {
        client_report_id: request.client_report_id,
        reason,
        details,
        reported_account_id,
        conversation_id,
        message_ids: request.message_ids,
        contact_request_id: trimmed(request.contact_request_id),
        fingerprint: String::new(),
    };
    let canonical = serde_json::to_vec(&report).map_err(|_| ReportError::Invalid("invalid"))?;
    report.fingerprint = hex::encode(Sha256::digest(canonical));
    Ok(report)
}

type ReceiptRow = (
    String,
    String,
    String,
    String,
    i32,
    Option<String>,
    DateTime<Utc>,
    Option<DateTime<Utc>>,
);

type FingerprintedRow = (
    String,
    String,
    String,
    String,
    String,
    i32,
    Option<String>,
    DateTime<Utc>,
    Option<DateTime<Utc>>,
);

/// One attachment of an evidence message: message, id, type, size, hash.
type AttachmentRow = (Uuid, String, Option<String>, Option<i64>, Option<String>);

const RECEIPT_COLUMNS: &str = "report_id, status, reason, target_kind, evidence_message_count, \
     reported_display_name, created_at, closed_at";

fn receipt(row: ReceiptRow) -> ReportReceipt {
    let (report_id, status, reason, target_kind, count, name, created_at, closed_at) = row;
    ReportReceipt {
        reference: reference(&report_id),
        report_id,
        status: if status == "closed" {
            "closed"
        } else {
            "received"
        },
        reason,
        target_kind,
        evidence_message_count: count,
        reported_display_name: name,
        created_at,
        closed_at,
    }
}

/// A report this person already sent with this client id, with the
/// fingerprint of the request that created it.
pub async fn existing(
    pool: &PgPool,
    reporter: &str,
    client_report_id: Uuid,
) -> Result<Option<(String, ReportReceipt)>, sqlx_core::Error> {
    let row: Option<FingerprintedRow> = query_as(&format!(
        "SELECT request_fingerprint, {RECEIPT_COLUMNS} FROM cloud_abuse_reports \
         WHERE reporter_account_id = $1 AND client_report_id = $2"
    ))
    .bind(reporter)
    .bind(client_report_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| {
        let (fingerprint, id, status, reason, kind, count, name, created, closed) = row;
        (
            fingerprint,
            receipt((id, status, reason, kind, count, name, created, closed)),
        )
    }))
}

/// The person's own reports, newest first.
pub async fn list(pool: &PgPool, reporter: &str) -> Result<Vec<ReportReceipt>, sqlx_core::Error> {
    let rows: Vec<ReceiptRow> = query_as(&format!(
        "SELECT {RECEIPT_COLUMNS} FROM cloud_abuse_reports WHERE reporter_account_id = $1 \
         ORDER BY created_at DESC, report_id DESC LIMIT $2"
    ))
    .bind(reporter)
    .bind(LIST_LIMIT)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(receipt).collect())
}

type MessageRow = (
    Uuid,
    String,
    String,
    DateTime<Utc>,
    Option<DateTime<Utc>>,
    i32,
    Value,
);

/// Copies the chosen messages and finds who they report. The reporter must
/// still be an active member, and every message must be in the conversation
/// and not deleted.
async fn message_evidence(
    transaction: &mut Transaction<'_, Postgres>,
    reporter: &str,
    report: &ValidReport,
) -> Result<(Value, Vec<Value>, String), ReportError> {
    let conversation_id = report
        .conversation_id
        .ok_or(ReportError::InvalidEvidence(MESSAGES_UNAVAILABLE))?;
    let conversation: Option<(String, Option<String>, i64)> = query_as(
        "SELECT conversation.kind, conversation.legacy_session_id, \
                (SELECT COUNT(*) FROM cloud_chat_conversation_members member \
                 WHERE member.conversation_id = conversation.conversation_id \
                   AND member.membership_state = 'active') \
         FROM cloud_chat_conversations conversation \
         JOIN cloud_chat_conversation_members reporter \
           ON reporter.conversation_id = conversation.conversation_id \
         WHERE conversation.conversation_id = $1 AND reporter.account_id = $2 \
           AND reporter.membership_state = 'active'",
    )
    .bind(conversation_id)
    .bind(reporter)
    .fetch_optional(&mut **transaction)
    .await?;
    let (kind, legacy_session_id, active_members) =
        conversation.ok_or(ReportError::InvalidEvidence(MESSAGES_UNAVAILABLE))?;
    let rows: Vec<MessageRow> = query_as(
        "SELECT message_id, sender_account_id, message_kind, created_at, edited_at, version, content \
         FROM cloud_chat_messages \
         WHERE conversation_id = $1 AND message_id = ANY($2) AND deleted_at IS NULL \
         ORDER BY conversation_sequence",
    )
    .bind(conversation_id)
    .bind(&report.message_ids)
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
            |(id, sender, kind, created_at, edited_at, version, content)| {
                let files = attachments
                    .iter()
                    .filter(|row| row.0 == id)
                    .map(|(_, attachment_id, content_type, size, sha256)| {
                        json!({ "attachmentId": attachment_id, "contentType": content_type,
                            "sizeBytes": size, "sha256Hex": sha256 })
                    })
                    .collect::<Vec<_>>();
                json!({ "messageId": id, "senderAccountId": sender, "messageKind": kind,
                    "createdAt": created_at, "editedAt": edited_at, "version": version,
                    "content": content, "attachments": files })
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

/// Builds the evidence and stores the report. Returns the receipt and
/// whether this call created it (a concurrent identical request may have).
pub async fn create(
    pool: &PgPool,
    reporter: &str,
    report: &ValidReport,
) -> Result<(ReportReceipt, bool), ReportError> {
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
    let inserted: Option<ReceiptRow> = query_as(&format!(
        "INSERT INTO cloud_abuse_reports (report_id, reporter_account_id, client_report_id, \
           request_fingerprint, reported_account_id, reported_display_name, target_kind, reason, \
           details, conversation_id, evidence, evidence_message_count) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) \
         ON CONFLICT (reporter_account_id, client_report_id) DO NOTHING \
         RETURNING {RECEIPT_COLUMNS}"
    ))
    .bind(new_report_id())
    .bind(reporter)
    .bind(report.client_report_id)
    .bind(&report.fingerprint)
    .bind(&reported)
    .bind(&reported_display_name)
    .bind(report.target_kind())
    .bind(report.reason)
    .bind(&report.details)
    .bind(report.conversation_id)
    .bind(&evidence)
    .bind(message_count)
    .fetch_optional(&mut *transaction)
    .await?;
    transaction.commit().await?;
    if let Some(row) = inserted {
        return Ok((receipt(row), true));
    }
    match existing(pool, reporter, report.client_report_id).await? {
        Some((fingerprint, receipt)) if fingerprint == report.fingerprint => Ok((receipt, false)),
        _ => Err(ReportError::Conflict),
    }
}

#[cfg(test)]
mod tests;
