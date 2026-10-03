//! Operator backfill for content changed before content removal shipped.
//!
//! Nothing here runs on deploy or startup. `kordi-cloud-server
//! backfill-content-removal` reports what it would change, and writes only
//! with `--apply`. Applying it:
//!
//! 1. queues file removal for photos already removed from live messages;
//! 2. turns an account's replay rows of messages it removed from its view
//!    into content-free `message.hidden`;
//! 3. turns replay rows carrying an earlier version of an edited message into
//!    content-free, noncritical `message.superseded`;
//! 4. clears the prompts of finished digest runs; and
//! 5. queues one `backfill` job, which redacts messages deleted in the last
//!    91 days and their stored files, and repairs stored digests.
//!
//! Every step is idempotent, so a partial run can be repeated. Steps 2 and 3
//! only remove copies; the canonical message keeps its current content.

use super::*;

/// How far back the queued backfill job reaches for deleted messages.
pub const BACKFILL_WINDOW_DAYS: i64 = 91;

/// What the backfill changed, or would change without `--apply`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HistoryBackfillReport {
    pub applied: bool,
    /// Live messages whose removed photos get a file removal job.
    pub photo_removal_jobs: u64,
    /// Attachment ids listed by those jobs.
    pub removed_photo_attachments: u64,
    /// Replay rows of messages an account removed from its own view.
    pub hidden_rows: u64,
    /// Replay rows carrying an earlier version of an edited message.
    pub superseded_rows: u64,
    /// Finished digest runs whose stored prompt is cleared.
    pub digest_prompts: u64,
    /// Messages deleted within the window that have no removal job yet. The
    /// queued backfill job redacts them and removes files nothing else uses.
    pub deleted_messages: u64,
    /// Whether the backfill job is newly queued by this run.
    pub backfill_job_queued: bool,
}

/// Live messages with photos that older replay rows still list but the
/// message no longer links, grouped per message.
macro_rules! removed_photo_candidates_sql {
    () => {
        "SELECT message.message_id, message.conversation_id, \
                array_agg(DISTINCT removed.attachment_id ORDER BY removed.attachment_id) \
                    AS attachment_ids \
         FROM cloud_chat_messages message \
         JOIN cloud_chat_user_sync_events event \
           ON event.entity_id = message.message_id AND event.payload ? 'message' \
         CROSS JOIN LATERAL jsonb_array_elements_text( \
             CASE WHEN jsonb_typeof(event.payload #> '{message,attachment_ids}') = 'array' \
                  THEN event.payload #> '{message,attachment_ids}' ELSE '[]'::jsonb END \
         ) AS removed(attachment_id) \
         WHERE message.deleted_at IS NULL AND message.edited_at IS NOT NULL \
           AND NOT EXISTS (SELECT 1 FROM cloud_chat_message_attachments link \
                           WHERE link.message_id = message.message_id \
                             AND link.attachment_id = removed.attachment_id) \
           AND NOT EXISTS (SELECT 1 FROM cloud_content_removal_jobs job \
                           WHERE job.job_id = md5('content-removal-backfill-attachments:' \
                                                  || message.message_id::text)::uuid) \
         GROUP BY message.message_id, message.conversation_id"
    };
}

macro_rules! hidden_rows_from_where_sql {
    () => {
        " cloud_chat_message_visibility visibility, cloud_chat_messages message \
         WHERE visibility.account_id = event.account_id \
           AND visibility.message_id = event.entity_id \
           AND message.message_id = event.entity_id AND message.deleted_at IS NULL \
           AND event.payload ? 'message'"
    };
}

macro_rules! earlier_versions_from_where_sql {
    () => {
        concat!(
            " cloud_chat_messages message \
             WHERE message.message_id = event.entity_id \
               AND message.deleted_at IS NULL AND message.edited_at IS NOT NULL \
               AND event.payload ? 'message' AND ",
            snapshot_version_sql!("event"),
            " < message.version \
               AND NOT EXISTS (SELECT 1 FROM cloud_chat_message_visibility hidden \
                               WHERE hidden.account_id = event.account_id \
                                 AND hidden.message_id = event.entity_id) \
               AND (EXISTS (SELECT 1 FROM cloud_chat_user_sync_events newer \
                            WHERE newer.entity_id = event.entity_id \
                              AND newer.account_id = event.account_id \
                              AND newer.payload ? 'message' AND ",
            snapshot_version_sql!("newer"),
            " > ",
            snapshot_version_sql!("event"),
            ") \
                    OR NOT EXISTS (SELECT 1 FROM cloud_chat_conversation_members member \
                                   WHERE member.conversation_id = message.conversation_id \
                                     AND member.account_id = event.account_id \
                                     AND member.membership_state = 'active'))"
        )
    };
}

macro_rules! finished_digest_prompts_where_sql {
    () => {
        " WHERE run_id LIKE 'digest\\_%' AND status IN ('completed', 'failed', 'cancelled') \
           AND prompt <> ''"
    };
}

const BACKFILL_JOB_ID_SQL: &str = "md5('content-removal-backfill')::uuid";

/// Reports, and with `apply` performs, the history backfill described above.
pub async fn backfill_content_removal_history(
    pool: &PgPool,
    apply: bool,
) -> Result<HistoryBackfillReport, StoreError> {
    let mut report = HistoryBackfillReport {
        applied: apply,
        ..HistoryBackfillReport::default()
    };
    let (deleted_messages,): (i64,) = query_as(
        "SELECT count(*)::bigint FROM cloud_chat_messages message \
         WHERE message.deleted_at >= now() - make_interval(days => $1::int) \
           AND NOT EXISTS (SELECT 1 FROM cloud_content_removal_jobs job \
                           WHERE job.reason = 'message_deleted' \
                             AND job.message_id = message.message_id)",
    )
    .bind(BACKFILL_WINDOW_DAYS as i32)
    .fetch_one(pool)
    .await?;
    report.deleted_messages = deleted_messages.max(0) as u64;
    if !apply {
        let (jobs, attachments): (i64, i64) = query_as(concat!(
            "SELECT count(*)::bigint, COALESCE(sum(cardinality(attachment_ids)), 0)::bigint FROM (",
            removed_photo_candidates_sql!(),
            ") candidates"
        ))
        .fetch_one(pool)
        .await?;
        let (hidden,): (i64,) = query_as(concat!(
            "SELECT count(*)::bigint FROM cloud_chat_user_sync_events event,",
            hidden_rows_from_where_sql!()
        ))
        .fetch_one(pool)
        .await?;
        let (superseded,): (i64,) = query_as(concat!(
            "SELECT count(*)::bigint FROM cloud_chat_user_sync_events event,",
            earlier_versions_from_where_sql!()
        ))
        .fetch_one(pool)
        .await?;
        let (prompts,): (i64,) = query_as(concat!(
            "SELECT count(*)::bigint FROM cloud_agent_fallback_runs",
            finished_digest_prompts_where_sql!()
        ))
        .fetch_one(pool)
        .await?;
        let (queued,): (bool,) = query_as(&format!(
            "SELECT NOT EXISTS (SELECT 1 FROM cloud_content_removal_jobs \
             WHERE job_id = {BACKFILL_JOB_ID_SQL})"
        ))
        .fetch_one(pool)
        .await?;
        report.photo_removal_jobs = jobs.max(0) as u64;
        report.removed_photo_attachments = attachments.max(0) as u64;
        report.hidden_rows = hidden.max(0) as u64;
        report.superseded_rows = superseded.max(0) as u64;
        report.digest_prompts = prompts.max(0) as u64;
        report.backfill_job_queued = queued;
        return Ok(report);
    }

    // Photo jobs read the attachment ids from replay rows, so they are queued
    // before step 3 rewrites those rows.
    let (jobs, attachments): (i64, i64) = query_as(concat!(
        "WITH inserted AS ( \
           INSERT INTO cloud_content_removal_jobs \
             (job_id, reason, conversation_id, message_id, attachment_ids, \
              digests_done_at, records_done_at, quotes_done_at) \
           SELECT md5('content-removal-backfill-attachments:' || message_id::text)::uuid, \
                  $1, conversation_id, message_id, attachment_ids, now(), now(), now() \
           FROM (",
        removed_photo_candidates_sql!(),
        ") candidates \
           ON CONFLICT (job_id) DO NOTHING \
           RETURNING cardinality(attachment_ids) AS attachment_count \
         ) SELECT count(*)::bigint, COALESCE(sum(attachment_count), 0)::bigint FROM inserted"
    ))
    .bind(RemovalReason::AttachmentRemoved.as_str())
    .fetch_one(pool)
    .await?;
    report.photo_removal_jobs = jobs.max(0) as u64;
    report.removed_photo_attachments = attachments.max(0) as u64;
    report.hidden_rows = query(concat!(
        "UPDATE cloud_chat_user_sync_events event \
         SET event_type = 'message.hidden', payload = ",
        content_free_payload_sql!(),
        " FROM",
        hidden_rows_from_where_sql!()
    ))
    .execute(pool)
    .await?
    .rows_affected();
    report.superseded_rows = query(concat!(
        "UPDATE cloud_chat_user_sync_events event \
         SET event_type = 'message.superseded', critical = false, payload = ",
        content_free_payload_sql!(),
        " FROM",
        earlier_versions_from_where_sql!()
    ))
    .execute(pool)
    .await?
    .rows_affected();
    report.digest_prompts = query(concat!(
        "UPDATE cloud_agent_fallback_runs SET prompt = ''",
        finished_digest_prompts_where_sql!()
    ))
    .execute(pool)
    .await?
    .rows_affected();

    // The job and the state change commit together: once history is applied,
    // reconciles may reach back over the whole window.
    let mut transaction = pool.begin().await?;
    report.backfill_job_queued = query(&format!(
        "INSERT INTO cloud_content_removal_jobs \
           (job_id, reason, attachments_done_at, quotes_done_at) \
         VALUES ({BACKFILL_JOB_ID_SQL}, $1, now(), now()) \
         ON CONFLICT (job_id) DO NOTHING"
    ))
    .bind(RemovalReason::Backfill.as_str())
    .execute(&mut *transaction)
    .await?
    .rows_affected()
        > 0;
    query(
        "INSERT INTO cloud_content_removal_state (singleton, history_backfill_applied_at) \
         VALUES (TRUE, now()) \
         ON CONFLICT (singleton) DO UPDATE SET history_backfill_applied_at = \
           COALESCE(cloud_content_removal_state.history_backfill_applied_at, now())",
    )
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(report)
}
