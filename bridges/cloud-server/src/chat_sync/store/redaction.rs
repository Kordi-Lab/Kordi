//! Content-free replay for deleted, hidden, and edited messages.
//!
//! "Delete for everyone", "Remove from my view", and "Edit" rewrite every
//! retained replay row that still carries an earlier snapshot of the message,
//! in the same transaction as the change. Replay also checks deletion and hide
//! state when it reads, so rows written by an older server during an upgrade
//! never return removed content. A removal job queued with the change finishes
//! the work that does not belong in the request, such as digests, agent run
//! prompts, quote previews, and stored files. See `docs/data-deletion.md`.
//!
//! Content changed before this server version is left as it is until an
//! operator runs `kordi-cloud-server backfill-content-removal --apply`.

use std::collections::HashSet;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

use super::message::CLOUD_GROUP_PREFIX;
use super::*;

mod history;
mod jobs;
mod reconcile;
#[cfg(test)]
mod server_message_tests;
#[cfg(test)]
mod tests;

pub use history::{backfill_content_removal_history, HistoryBackfillReport, BACKFILL_WINDOW_DAYS};
pub(crate) use jobs::{enqueue_removal_job, NewRemovalJob, RemovalReason};
pub use reconcile::{reconcile_deleted_messages, reconcile_hidden_messages};

/// The longest identifier kept for a removal job.
const MAX_IDENTIFIER_CHARS: usize = 300;

/// The content-free payload of a rewritten replay row, as SQL over a row
/// aliased `event`; the single source of truth for every statement that
/// rewrites a replay row. It keeps the message id and the conversation
/// projection the row already carried, and nothing from the message itself.
macro_rules! content_free_payload_sql {
    () => {
        "(jsonb_build_object('message_id', event.entity_id::text) \
          || CASE WHEN event.payload ? 'conversation' \
                  THEN jsonb_build_object('conversation', event.payload -> 'conversation') \
                  ELSE '{}'::jsonb END)"
    };
}

/// The message version a replay row's snapshot carries, or 0 when it has
/// none. Malformed versions read as 0 instead of failing the statement.
macro_rules! snapshot_version_sql {
    ($alias:literal) => {
        concat!(
            "COALESCE(CASE WHEN jsonb_typeof(",
            $alias,
            ".payload #> '{message,version}') = 'number' THEN (",
            $alias,
            ".payload #> '{message,version}')::numeric END, 0)"
        )
    };
}
pub(super) use {content_free_payload_sql, snapshot_version_sql};

/// The payload of a new content-free row for one recipient.
pub(super) fn content_free_payload(message_id: Uuid, conversation: Option<&Value>) -> Value {
    let mut payload = serde_json::Map::new();
    payload.insert(
        "message_id".to_string(),
        Value::String(message_id.to_string()),
    );
    if let Some(conversation) = conversation {
        payload.insert("conversation".to_string(), conversation.clone());
    }
    Value::Object(payload)
}

/// Rows of `message_id` that carry a snapshot older than `current_version`, in
/// every account's stream, become noncritical content-free
/// `message.superseded`. Call it after the fanout of the current version, so
/// each active member keeps exactly the newest snapshot.
pub(super) async fn supersede_message_events(
    transaction: &mut Transaction<'_, Postgres>,
    message_id: Uuid,
    current_version: i32,
) -> Result<u64, StoreError> {
    let result = query(concat!(
        "UPDATE cloud_chat_user_sync_events event \
         SET event_type = 'message.superseded', critical = false, payload = ",
        content_free_payload_sql!(),
        " WHERE event.entity_id = $1 AND event.payload ? 'message' AND ",
        snapshot_version_sql!("event"),
        " < $2"
    ))
    .bind(message_id)
    .bind(current_version)
    .execute(&mut **transaction)
    .await?;
    Ok(result.rows_affected())
}

/// Every row that still carries a snapshot of the message, in every account's
/// stream, becomes a content-free `message.deleted`. This also converts
/// tombstone snapshots that an older server wrote.
pub(super) async fn redact_deleted_message_events(
    transaction: &mut Transaction<'_, Postgres>,
    message_id: Uuid,
    tombstone_version: i32,
) -> Result<u64, StoreError> {
    let result = query(concat!(
        "UPDATE cloud_chat_user_sync_events event \
         SET event_type = 'message.deleted', entity_version = $2, payload = ",
        content_free_payload_sql!(),
        " WHERE event.entity_id = $1 AND event.payload ? 'message'"
    ))
    .bind(message_id)
    .bind(tombstone_version)
    .execute(&mut **transaction)
    .await?;
    Ok(result.rows_affected())
}

/// The account's own snapshot-bearing rows of the message become content-free
/// `message.hidden`. Other members' rows are unchanged.
pub(super) async fn redact_hidden_message_events(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    message_id: Uuid,
) -> Result<u64, StoreError> {
    let result = query(concat!(
        "UPDATE cloud_chat_user_sync_events event \
         SET event_type = 'message.hidden', payload = ",
        content_free_payload_sql!(),
        " WHERE event.account_id = $1 AND event.entity_id = $2 \
           AND event.payload ? 'message'"
    ))
    .bind(account_id)
    .bind(message_id)
    .execute(&mut **transaction)
    .await?;
    Ok(result.rows_affected())
}

/// Accounts that removed the message from their own view.
pub(super) async fn hidden_recipients(
    transaction: &mut Transaction<'_, Postgres>,
    message_id: Uuid,
) -> Result<HashSet<String>, StoreError> {
    let rows: Vec<(String,)> =
        query_as("SELECT account_id FROM cloud_chat_message_visibility WHERE message_id = $1")
            .bind(message_id)
            .fetch_all(&mut **transaction)
            .await?;
    Ok(rows.into_iter().map(|(account_id,)| account_id).collect())
}

fn snapshot_message_id(event: &SyncEventSnapshot) -> Option<Uuid> {
    event
        .payload
        .get("message")?
        .get("id")?
        .as_str()?
        .parse()
        .ok()
}

/// Read-time guard for replay. Any event that carries a snapshot of a
/// message deleted for everyone becomes a content-free `message.deleted`, and
/// one of a message this account removed from its view becomes a content-free
/// `message.hidden`. Deletion wins. `critical` and `occurred_at` are kept.
pub(super) async fn guard_replayed_events(
    pool: &PgPool,
    account_id: &str,
    events: &mut [SyncEventSnapshot],
) -> Result<(), StoreError> {
    let ids = events
        .iter()
        .filter_map(snapshot_message_id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(());
    }
    let deleted: Vec<(Uuid,)> = query_as(
        "SELECT message_id FROM cloud_chat_messages \
         WHERE message_id = ANY($1) AND deleted_at IS NOT NULL",
    )
    .bind(&ids)
    .fetch_all(pool)
    .await?;
    let hidden: Vec<(Uuid,)> = query_as(
        "SELECT message_id FROM cloud_chat_message_visibility \
         WHERE account_id = $1 AND message_id = ANY($2)",
    )
    .bind(account_id)
    .bind(&ids)
    .fetch_all(pool)
    .await?;
    let deleted = deleted.into_iter().map(|(id,)| id).collect::<HashSet<_>>();
    let hidden = hidden.into_iter().map(|(id,)| id).collect::<HashSet<_>>();
    for event in events.iter_mut() {
        let Some(id) = snapshot_message_id(event) else {
            continue;
        };
        let event_type = if deleted.contains(&id) {
            "message.deleted"
        } else if hidden.contains(&id) {
            "message.hidden"
        } else {
            continue;
        };
        let payload = content_free_payload(id, event.payload.get("conversation"));
        event.event_type = event_type.to_string();
        event.entity_id = Some(id);
        event.payload = payload;
    }
    Ok(())
}

/// Every id another record may use to refer to this message: the canonical
/// id, the client id, the iOS form of the client id, and the logical id of a
/// group envelope. Direct envelopes carry no id of their own; direct quotes
/// use the canonical id. Compute it before the content is emptied.
pub(crate) fn message_identifiers(message: &MessageSnapshot) -> Vec<String> {
    let mut values = vec![
        message.id.to_string(),
        message.client_message_id.to_string(),
        format!("ios_{}", message.client_message_id),
    ];
    values.extend(group_envelope_ids(&message.content));
    normalize_identifiers(values)
}

/// The same ids read from a stored snapshot, which may be incomplete.
pub(super) fn snapshot_identifiers(snapshot: &Value) -> Vec<String> {
    let mut values = Vec::new();
    if let Some(id) = snapshot.get("id").and_then(Value::as_str) {
        values.push(id.to_string());
    }
    if let Some(client_id) = snapshot.get("client_message_id").and_then(Value::as_str) {
        values.push(client_id.to_string());
        values.push(format!("ios_{client_id}"));
    }
    if let Some(content) = snapshot.get("content") {
        values.extend(group_envelope_ids(content));
    }
    normalize_identifiers(values)
}

fn group_envelope_ids(content: &Value) -> Vec<String> {
    content
        .get("blocks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .filter_map(|text| text.trim_start().strip_prefix(CLOUD_GROUP_PREFIX))
        .filter_map(|encoded| URL_SAFE_NO_PAD.decode(encoded.trim()).ok())
        .filter_map(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter_map(|envelope| {
            envelope
                .get("message")?
                .get("id")?
                .as_str()
                .map(ToString::to_string)
        })
        .collect()
}

pub(super) fn normalize_identifiers(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value.chars().count() <= MAX_IDENTIFIER_CHARS)
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

/// Both session ids a run or task may name for the conversation.
pub(super) async fn conversation_session_ids(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
) -> Result<Vec<String>, StoreError> {
    let legacy: Option<(Option<String>,)> = query_as(
        "SELECT legacy_session_id FROM cloud_chat_conversations WHERE conversation_id = $1",
    )
    .bind(conversation_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let mut sessions = legacy
        .and_then(|(legacy,)| legacy)
        .into_iter()
        .collect::<Vec<_>>();
    sessions.push(conversation_id.to_string());
    Ok(sessions)
}

/// Agent runs that have not started for a deleted request are cancelled with
/// an empty prompt. Only `queued` rows match, so this never waits on a run in
/// progress. Digest runs and sub-session runs are never touched.
pub(super) async fn cancel_queued_runs_for_deleted_request(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    identifiers: &[String],
) -> Result<u64, StoreError> {
    if identifiers.is_empty() {
        return Ok(0);
    }
    let sessions = conversation_session_ids(transaction, conversation_id).await?;
    let result = query(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'cancelled', prompt = '', error_code = 'request_deleted', \
             error_message = 'The request was deleted before the agent started.', \
             completed_at = $3, updated_at = $3 \
         WHERE status = 'queued' AND session_id = ANY($1) AND request_message_id = ANY($2) \
           AND run_id NOT LIKE 'digest\\_%' AND subsession_id IS NULL",
    )
    .bind(&sessions)
    .bind(identifiers)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut **transaction)
    .await?;
    Ok(result.rows_affected())
}

/// Whether `request_id` names a message of the session's conversation that
/// was deleted for everyone. Group envelope ids are matched through the
/// removal job, because the deleted content no longer carries them.
pub async fn request_was_deleted(
    pool: &PgPool,
    session_id: &str,
    request_id: &str,
) -> Result<bool, StoreError> {
    let (session_id, request_id) = (session_id.trim(), request_id.trim());
    if session_id.is_empty() || request_id.is_empty() {
        return Ok(false);
    }
    let canonical_session = Uuid::parse_str(session_id).ok();
    let request_uuid = Uuid::parse_str(request_id.strip_prefix("ios_").unwrap_or(request_id)).ok();
    let (deleted,): (bool,) = query_as(
        "WITH conversation AS ( \
           SELECT conversation_id FROM cloud_chat_conversations \
           WHERE legacy_session_id = $1 OR conversation_id = $2 \
         ) \
         SELECT EXISTS ( \
           SELECT 1 FROM cloud_chat_messages message \
           JOIN conversation ON conversation.conversation_id = message.conversation_id \
           WHERE message.deleted_at IS NOT NULL \
             AND (message.message_id = $3 OR message.client_message_id = $3) \
         ) OR EXISTS ( \
           SELECT 1 FROM cloud_content_removal_jobs job \
           JOIN conversation ON conversation.conversation_id = job.conversation_id \
           WHERE job.reason = 'message_deleted' AND $4 = ANY(job.source_identifiers) \
         )",
    )
    .bind(session_id)
    .bind(canonical_session)
    .bind(request_uuid)
    .bind(request_id)
    .fetch_one(pool)
    .await?;
    Ok(deleted)
}

/// Completes "Delete for everyone" after the tombstone and its content-free
/// fanout: every retained snapshot becomes `message.deleted`, unstarted runs
/// for the request are cancelled, and a removal job is queued.
pub(super) async fn finish_delete_for_everyone(
    transaction: &mut Transaction<'_, Postgres>,
    tombstone: &MessageSnapshot,
    identifiers: &[String],
    attachment_ids: &[String],
) -> Result<(), StoreError> {
    redact_deleted_message_events(transaction, tombstone.id, tombstone.version).await?;
    cancel_queued_runs_for_deleted_request(transaction, tombstone.conversation_id, identifiers)
        .await?;
    enqueue_removal_job(
        transaction,
        NewRemovalJob {
            reason: RemovalReason::MessageDeleted,
            account_id: None,
            conversation_id: Some(tombstone.conversation_id),
            message_id: Some(tombstone.id),
            source_identifiers: identifiers,
            attachment_ids,
        },
    )
    .await?;
    Ok(())
}

/// Completes "Remove from my view" after the visibility row and the
/// account's `message.hidden` event.
pub(super) async fn finish_hide(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    conversation_id: Uuid,
    message_id: Uuid,
) -> Result<(), StoreError> {
    redact_hidden_message_events(transaction, account_id, message_id).await?;
    enqueue_removal_job(
        transaction,
        NewRemovalJob {
            reason: RemovalReason::MessageHidden,
            account_id: Some(account_id),
            conversation_id: Some(conversation_id),
            message_id: Some(message_id),
            source_identifiers: &[message_id.to_string()],
            attachment_ids: &[],
        },
    )
    .await?;
    Ok(())
}

/// Completes a content change after the fanout of the new version: earlier
/// snapshots are superseded and a removal job is queued.
pub(super) async fn finish_content_change(
    transaction: &mut Transaction<'_, Postgres>,
    message: &MessageSnapshot,
    reason: RemovalReason,
    removed_attachment_ids: &[String],
) -> Result<(), StoreError> {
    supersede_message_events(transaction, message.id, message.version).await?;
    enqueue_removal_job(
        transaction,
        NewRemovalJob {
            reason,
            account_id: None,
            conversation_id: Some(message.conversation_id),
            message_id: Some(message.id),
            source_identifiers: &[message.id.to_string()],
            attachment_ids: removed_attachment_ids,
        },
    )
    .await?;
    Ok(())
}
