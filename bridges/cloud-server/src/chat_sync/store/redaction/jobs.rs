//! Removal jobs: the work a content change leaves for the background worker.
//!
//! A job holds identifiers only. Steps that do not apply to its reason are
//! marked done when the job is queued.

use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RemovalReason {
    MessageDeleted,
    MessageEdited,
    MessageHidden,
    AttachmentRemoved,
    /// Queued by the media library when a saved sticker or GIF that kept a
    /// file alive is deleted.
    #[allow(dead_code)]
    AttachmentReleased,
}

/// Which worker steps a job runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RemovalSteps {
    pub(crate) digests: bool,
    pub(crate) records: bool,
    pub(crate) attachments: bool,
    pub(crate) quotes: bool,
}

impl RemovalReason {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::MessageDeleted => "message_deleted",
            Self::MessageEdited => "message_edited",
            Self::MessageHidden => "message_hidden",
            Self::AttachmentRemoved => "attachment_removed",
            Self::AttachmentReleased => "attachment_released",
        }
    }

    pub(crate) fn steps(self) -> RemovalSteps {
        let (digests, records, attachments, quotes) = match self {
            Self::MessageDeleted => (true, true, true, true),
            Self::MessageEdited | Self::MessageHidden => (true, false, false, false),
            Self::AttachmentRemoved | Self::AttachmentReleased => (false, false, true, false),
        };
        RemovalSteps {
            digests,
            records,
            attachments,
            quotes,
        }
    }
}

pub(crate) struct NewRemovalJob<'a> {
    pub(crate) reason: RemovalReason,
    pub(crate) account_id: Option<&'a str>,
    pub(crate) conversation_id: Option<Uuid>,
    pub(crate) message_id: Option<Uuid>,
    pub(crate) source_identifiers: &'a [String],
    pub(crate) attachment_ids: &'a [String],
}

/// Queues a removal job in the caller's transaction. Returns false when an
/// equivalent job already exists, such as a second deletion of one message.
pub(crate) async fn enqueue_removal_job(
    transaction: &mut Transaction<'_, Postgres>,
    job: NewRemovalJob<'_>,
) -> Result<bool, StoreError> {
    let steps = job.reason.steps();
    let result = query(
        "INSERT INTO cloud_content_removal_jobs \
         (job_id, reason, account_id, conversation_id, message_id, source_identifiers, \
          attachment_ids, digests_done_at, records_done_at, attachments_done_at, quotes_done_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, \
                 CASE WHEN $8 THEN NULL ELSE now() END, \
                 CASE WHEN $9 THEN NULL ELSE now() END, \
                 CASE WHEN $10 THEN NULL ELSE now() END, \
                 CASE WHEN $11 THEN NULL ELSE now() END) \
         ON CONFLICT DO NOTHING",
    )
    .bind(Uuid::now_v7())
    .bind(job.reason.as_str())
    .bind(job.account_id)
    .bind(job.conversation_id)
    .bind(job.message_id)
    .bind(job.source_identifiers)
    .bind(job.attachment_ids)
    .bind(steps.digests)
    .bind(steps.records)
    .bind(steps.attachments)
    .bind(steps.quotes)
    .execute(&mut **transaction)
    .await?;
    Ok(result.rows_affected() > 0)
}
