//! Repairs deletions and hides that skipped the in-transaction rewrite, such
//! as changes made by an older server replica during a rolling upgrade.
//!
//! Automatic repair never reaches before `automatic_since`, the time this
//! schema was installed, so starting a new server does not rewrite content
//! changed before it. Once an operator has applied the history backfill,
//! `history_backfill_applied_at` is set and the caller's window applies.

use super::*;

/// The earliest change time a reconcile may touch.
async fn effective_since(pool: &PgPool, since: DateTime<Utc>) -> Result<DateTime<Utc>, StoreError> {
    let floor: Option<(Option<DateTime<Utc>>,)> = query_as(
        "SELECT CASE WHEN history_backfill_applied_at IS NULL THEN automatic_since END \
         FROM cloud_content_removal_state WHERE singleton",
    )
    .fetch_optional(pool)
    .await?;
    Ok(match floor {
        Some((Some(floor),)) => since.max(floor),
        Some((None,)) => since,
        // Without the state row, fail closed: nothing before now.
        None => since.max(Utc::now()),
    })
}

/// Messages deleted for everyone since `since` that have no removal job get
/// their replay rows redacted, unstarted runs cancelled, and a job queued.
/// Returns the number of messages handled.
pub async fn reconcile_deleted_messages(
    pool: &PgPool,
    since: DateTime<Utc>,
    limit: i64,
) -> Result<u32, StoreError> {
    let since = effective_since(pool, since).await?;
    let candidates: Vec<(Uuid,)> = query_as(
        "SELECT message.message_id FROM cloud_chat_messages message \
         WHERE message.deleted_at >= $1 \
           AND NOT EXISTS (SELECT 1 FROM cloud_content_removal_jobs job \
                           WHERE job.reason = 'message_deleted' \
                             AND job.message_id = message.message_id) \
         ORDER BY message.deleted_at LIMIT $2",
    )
    .bind(since)
    .bind(limit.max(0))
    .fetch_all(pool)
    .await?;
    let mut handled = 0;
    for (message_id,) in candidates {
        if reconcile_deleted_message(pool, message_id).await? {
            handled += 1;
        }
    }
    Ok(handled)
}

/// (conversation, client id, sender, version, deleted at) of a message.
type DeletedMessageRow = (Uuid, Uuid, String, i32, Option<DateTime<Utc>>);

async fn reconcile_deleted_message(pool: &PgPool, message_id: Uuid) -> Result<bool, StoreError> {
    let mut transaction = pool.begin().await?;
    let row: Option<DeletedMessageRow> = query_as(
        "SELECT conversation_id, client_message_id, sender_account_id, version, deleted_at \
         FROM cloud_chat_messages WHERE message_id = $1 FOR UPDATE",
    )
    .bind(message_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((conversation_id, client_message_id, sender_account_id, version, Some(_))) = row
    else {
        return Ok(false);
    };
    let (queued,): (bool,) = query_as(
        "SELECT EXISTS (SELECT 1 FROM cloud_content_removal_jobs \
                        WHERE reason = 'message_deleted' AND message_id = $1)",
    )
    .bind(message_id)
    .fetch_one(&mut *transaction)
    .await?;
    if queued {
        return Ok(false);
    }
    let snapshots: Vec<(Value,)> = query_as(
        "SELECT payload -> 'message' FROM cloud_chat_user_sync_events \
         WHERE entity_id = $1 AND payload ? 'message'",
    )
    .bind(message_id)
    .fetch_all(&mut *transaction)
    .await?;
    let mut identifiers = vec![
        message_id.to_string(),
        client_message_id.to_string(),
        format!("ios_{client_message_id}"),
    ];
    let mut attachment_ids = BTreeSet::new();
    for (snapshot,) in &snapshots {
        identifiers.extend(snapshot_identifiers(snapshot));
        attachment_ids.extend(
            snapshot
                .get("attachment_ids")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(ToString::to_string),
        );
    }
    let identifiers = normalize_identifiers(identifiers);
    let attachment_ids = attachment_ids.into_iter().collect::<Vec<_>>();
    redact_deleted_message_events(&mut transaction, message_id, version).await?;
    cancel_queued_runs_for_deleted_request(
        &mut transaction,
        &DeletedRequest {
            conversation_id,
            message_id,
            sender_account_id: Some(&sender_account_id),
            identifiers: &identifiers,
        },
    )
    .await?;
    enqueue_removal_job(
        &mut transaction,
        NewRemovalJob {
            reason: RemovalReason::MessageDeleted,
            account_id: None,
            conversation_id: Some(conversation_id),
            message_id: Some(message_id),
            source_identifiers: &identifiers,
            attachment_ids: &attachment_ids,
        },
    )
    .await?;
    transaction.commit().await?;
    Ok(true)
}

/// Messages removed from an account's view since `since` whose snapshots
/// remain in that account's stream get those rows redacted and a job queued.
/// Returns the number of hides handled.
pub async fn reconcile_hidden_messages(
    pool: &PgPool,
    since: DateTime<Utc>,
    limit: i64,
) -> Result<u32, StoreError> {
    let since = effective_since(pool, since).await?;
    let candidates: Vec<(String, Uuid)> = query_as(
        "SELECT visibility.account_id, visibility.message_id \
         FROM cloud_chat_message_visibility visibility \
         JOIN cloud_chat_messages message ON message.message_id = visibility.message_id \
         WHERE visibility.deleted_at >= $1 AND message.deleted_at IS NULL \
           AND EXISTS (SELECT 1 FROM cloud_chat_user_sync_events event \
                       WHERE event.entity_id = visibility.message_id \
                         AND event.account_id = visibility.account_id \
                         AND event.payload ? 'message') \
         ORDER BY visibility.deleted_at LIMIT $2",
    )
    .bind(since)
    .bind(limit.max(0))
    .fetch_all(pool)
    .await?;
    let mut handled = 0;
    for (account_id, message_id) in candidates {
        let mut transaction = pool.begin().await?;
        let row: Option<(Uuid, Option<DateTime<Utc>>)> = query_as(
            "SELECT conversation_id, deleted_at FROM cloud_chat_messages \
             WHERE message_id = $1 FOR UPDATE",
        )
        .bind(message_id)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some((conversation_id, None)) = row else {
            continue;
        };
        // The rows that changed are the dedupe: a hide whose rows were
        // already redacted queues nothing.
        if redact_hidden_message_events(&mut transaction, &account_id, message_id).await? > 0 {
            enqueue_removal_job(
                &mut transaction,
                NewRemovalJob {
                    reason: RemovalReason::MessageHidden,
                    account_id: Some(&account_id),
                    conversation_id: Some(conversation_id),
                    message_id: Some(message_id),
                    source_identifiers: &[message_id.to_string()],
                    attachment_ids: &[],
                },
            )
            .await?;
            handled += 1;
        }
        transaction.commit().await?;
    }
    Ok(handled)
}
