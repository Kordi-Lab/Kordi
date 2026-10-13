//! `document.updated` and `document.agent_request` user sync events.
//!
//! Saves publish `"change": "content"`; reactions and comments publish
//! `"change": "annotations"`. Clients that show the document refetch on
//! both. Delivery failures are logged and never undo the write.

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::access::{document_session, DocumentRecord};
use super::canonical::family_audience;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DocumentChange {
    Content,
    Annotations,
}

impl DocumentChange {
    fn as_str(self) -> &'static str {
        match self {
            Self::Content => "content",
            Self::Annotations => "annotations",
        }
    }
}

/// The current revision: the stored source's, or 1 before the first read.
pub(crate) async fn current_revision(pool: &PgPool, attachment_id: &str) -> i64 {
    let row: Result<Option<(i64,)>, _> =
        query_as("SELECT revision FROM cloud_document_contents WHERE attachment_id = $1")
            .bind(attachment_id)
            .fetch_optional(pool)
            .await;
    row.ok().flatten().map_or(1, |(revision,)| revision)
}

pub(crate) fn update_payload(
    record: &DocumentRecord,
    revision: i64,
    session_id: Option<&str>,
    change: DocumentChange,
    updated_by: Option<&str>,
) -> serde_json::Value {
    serde_json::json!({
        "attachmentId": record.attachment_id,
        "revision": revision,
        "sessionId": session_id,
        "updatedByAccountId": updated_by,
        "change": change.as_str(),
    })
}

/// Publishes `document.updated` to the owner and the active members of every
/// conversation that carries the document or a copy of it. `updated_by` is
/// `None` for public readers.
pub(crate) async fn publish_document_updated(
    pool: &PgPool,
    record: &DocumentRecord,
    revision: Option<i64>,
    change: DocumentChange,
    updated_by: Option<&str>,
) {
    let revision = match revision {
        Some(revision) => revision,
        None => current_revision(pool, &record.attachment_id).await,
    };
    let recipients = match family_audience(pool, record).await {
        Ok(recipients) => recipients,
        Err(error) => {
            eprintln!("[documents] document.updated audience failed: {error}");
            return;
        }
    };
    let session_id = document_session(pool, &record.attachment_id, None)
        .await
        .ok()
        .flatten()
        .map(|(id, _)| id);
    let payload = update_payload(record, revision, session_id.as_deref(), change, updated_by);
    if let Err(error) = publish_noncritical(pool, "document.updated", &recipients, &payload).await {
        eprintln!("[documents] publish document.updated failed: {error:?}");
    }
}

/// `document.agent_request`: a comment run waits for the agent owner's Mac.
pub(crate) const AGENT_REQUEST_EVENT: &str = "document.agent_request";

/// Publishes `document.agent_request` to the agent owner's devices only.
pub(crate) async fn publish_agent_request(
    pool: &PgPool,
    owner_account_id: &str,
    payload: &serde_json::Value,
) {
    let recipients = [owner_account_id.to_string()];
    if let Err(error) = publish_noncritical(pool, AGENT_REQUEST_EVENT, &recipients, payload).await {
        eprintln!("[documents] publish {AGENT_REQUEST_EVENT} failed: {error:?}");
    }
}

/// Older clients reject unknown critical events and stall sync, so these
/// events are non-critical: clients that do not know them skip them.
async fn publish_noncritical(
    pool: &PgPool,
    event_type: &str,
    recipients: &[String],
    payload: &serde_json::Value,
) -> Result<(), crate::chat_sync::store::StoreError> {
    let mut transaction = pool.begin().await?;
    for recipient in recipients {
        crate::chat_sync::store::insert_noncritical_sync_event(
            &mut transaction,
            recipient,
            event_type,
            None,
            None,
            None,
            payload,
        )
        .await?;
    }
    transaction.commit().await?;
    Ok(())
}
