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

use super::*;

mod history;
mod identifiers;
mod jobs;
mod reconcile;
#[cfg(test)]
mod server_message_tests;
#[cfg(test)]
mod tests;

pub use history::{backfill_content_removal_history, HistoryBackfillReport, BACKFILL_WINDOW_DAYS};
pub(crate) use identifiers::{exclusive_identifiers, message_identifiers};
use identifiers::{normalize_identifiers, snapshot_identifiers};
pub(crate) use jobs::{enqueue_removal_job, NewRemovalJob, RemovalReason};
pub use reconcile::{reconcile_deleted_messages, reconcile_hidden_messages};

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

/// Both session ids a run or task may name for the conversation.
pub(crate) async fn conversation_session_ids(
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

/// A message deleted for everyone, as agent runs refer to it.
pub(crate) struct DeletedRequest<'a> {
    pub(crate) conversation_id: Uuid,
    pub(crate) message_id: Uuid,
    /// The sender, when the message row still exists.
    pub(crate) sender_account_id: Option<&'a str>,
    /// Every id a run may use for the request.
    pub(crate) identifiers: &'a [String],
}

/// SQL that limits run statements to runs of the deleted request: runs that
/// name it by its canonical id (`$3`), or runs its sender (`$4`) requested
/// under any of its ids (`$2`). A client chooses every id except the canonical
/// one, so a run another person requested is never matched through them.
macro_rules! deleted_request_runs_sql {
    () => {
        "session_id = ANY($1) AND request_message_id = ANY($2) \
         AND (request_message_id = $3 OR requester_account_id = $4) \
         AND run_id NOT LIKE 'digest\\_%'"
    };
}
pub(crate) use deleted_request_runs_sql;

/// Agent runs that have not started for a deleted request are cancelled with
/// an empty prompt and no structured runtime input. Only `queued` rows match,
/// so this never waits on a run in progress. Digest runs and sub-session runs
/// are never touched.
pub(crate) async fn cancel_queued_runs_for_deleted_request(
    transaction: &mut Transaction<'_, Postgres>,
    request: &DeletedRequest<'_>,
) -> Result<u64, StoreError> {
    if request.identifiers.is_empty() {
        return Ok(0);
    }
    let sessions = conversation_session_ids(transaction, request.conversation_id).await?;
    let result = query(concat!(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'cancelled', prompt = '', omp_input_json = NULL, \
             error_code = 'request_deleted', \
             error_message = 'The request was deleted before the agent started.', \
             completed_at = $5, updated_at = $5 \
         WHERE status = 'queued' AND subsession_id IS NULL AND ",
        deleted_request_runs_sql!()
    ))
    .bind(&sessions)
    .bind(request.identifiers)
    .bind(request.message_id.to_string())
    .bind(request.sender_account_id)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut **transaction)
    .await?;
    Ok(result.rows_affected())
}

/// Whether `request_id` names a message of the session's conversation that
/// was deleted for everyone, for a run `requester_account_id` asks for. The
/// canonical id matches whoever asks. A client-chosen id (a client id, its
/// iOS form, or a group envelope id) matches only the requester's own deleted
/// message, because another member may reuse it for a different message.
/// Group envelope ids are matched through the removal job, because the
/// deleted content no longer carries them.
pub async fn request_was_deleted(
    pool: &PgPool,
    session_id: &str,
    request_id: &str,
    requester_account_id: &str,
) -> Result<bool, StoreError> {
    let (session_id, request_id) = (session_id.trim(), request_id.trim());
    let requester_account_id = requester_account_id.trim();
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
             AND (message.message_id = $3 \
                  OR (message.client_message_id = $3 AND message.sender_account_id = $5)) \
         ) OR EXISTS ( \
           SELECT 1 FROM cloud_content_removal_jobs job \
           JOIN conversation ON conversation.conversation_id = job.conversation_id \
           LEFT JOIN cloud_chat_messages message ON message.message_id = job.message_id \
           WHERE job.reason = 'message_deleted' AND $4 = ANY(job.source_identifiers) \
             AND (job.message_id::text = $4 OR message.sender_account_id = $5) \
         )",
    )
    .bind(session_id)
    .bind(canonical_session)
    .bind(request_uuid)
    .bind(request_id)
    .bind(requester_account_id)
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
    cancel_queued_runs_for_deleted_request(
        transaction,
        &DeletedRequest {
            conversation_id: tombstone.conversation_id,
            message_id: tombstone.id,
            sender_account_id: Some(&tombstone.sender_account_id),
            identifiers,
        },
    )
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
