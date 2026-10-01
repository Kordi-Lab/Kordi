//! The attachments step: delete stored bytes nothing else uses.
//!
//! A file is kept while a message that is not deleted links it, a saved
//! sticker or GIF uses it, or an agent run artifact of a message that is not
//! deleted points at it. Files-panel entries do not keep a file, because any
//! client can write them. A kept file is marked as a candidate and checked
//! again later. Once nothing uses a file, every read of it is denied before
//! its bytes are deleted, and the denial stays if the deletion fails.

use std::collections::BTreeSet;

use super::*;

/// The most files one attempt deletes, so an attempt stays within its lease.
const FILES_PER_ATTEMPT: usize = 5;

/// What happened to one file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PurgeOutcome {
    /// Reads are denied and the bytes were deleted.
    Purged,
    /// Something else still uses the file; it is checked again later.
    Retained,
    /// There is no such file, or its bytes were already deleted.
    AlreadyGone,
}

/// Deletes the attachment's bytes unless something still uses it. Errors are
/// codes: `database_error` or an object store code.
pub async fn purge_attachment(
    pool: &PgPool,
    objects: &dyn ObjectStoreDeleter,
    attachment_id: &str,
) -> Result<PurgeOutcome, &'static str> {
    let mut transaction = pool.begin().await.map_err(database_error)?;
    let row: Option<(String, bool, bool)> = query_as(
        "SELECT object_key, purge_requested_at IS NOT NULL, object_deleted_at IS NOT NULL \
         FROM cloud_attachments WHERE attachment_id = $1 FOR UPDATE",
    )
    .bind(attachment_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?;
    let Some((object_key, purge_requested, object_deleted)) = row else {
        return Ok(PurgeOutcome::AlreadyGone);
    };
    if object_deleted {
        return Ok(PurgeOutcome::AlreadyGone);
    }
    if !purge_requested {
        // Message sends and media library saves take a share lock on the
        // attachment row and require `purge_requested_at IS NULL`, so a new
        // reference either commits before this check or is refused after it.
        let (referenced,): (bool,) = query_as(
            "SELECT EXISTS (SELECT 1 FROM cloud_chat_message_attachments link \
                            JOIN cloud_chat_messages message ON message.message_id = link.message_id \
                            WHERE link.attachment_id = $1 AND message.deleted_at IS NULL) \
                 OR EXISTS (SELECT 1 FROM cloud_expressive_media_items item \
                            WHERE item.attachment_id = $1 AND item.deleted_at IS NULL) \
                 OR EXISTS (SELECT 1 FROM cloud_agent_run_artifacts artifact \
                            JOIN cloud_chat_messages message ON message.message_id = artifact.message_id \
                            WHERE artifact.attachment_id = $1 AND message.deleted_at IS NULL)",
        )
        .bind(attachment_id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(database_error)?;
        if referenced {
            query(
                "UPDATE cloud_attachments SET purge_candidate_at = now() WHERE attachment_id = $1",
            )
            .bind(attachment_id)
            .execute(&mut *transaction)
            .await
            .map_err(database_error)?;
            transaction.commit().await.map_err(database_error)?;
            return Ok(PurgeOutcome::Retained);
        }
        // From here every read of the file is denied, owner included.
        query(
            "UPDATE cloud_attachments SET purge_requested_at = now(), purge_candidate_at = NULL, \
                 preview_url = NULL, sha256_hex = NULL \
             WHERE attachment_id = $1",
        )
        .bind(attachment_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    }
    transaction.commit().await.map_err(database_error)?;
    if let Err(error) = objects.delete_object(&object_key).await {
        if error == ObjectDeleteError::Forbidden {
            // Deletion is not working, so clients go back to the wording that
            // does not promise it until the hourly probe succeeds again.
            crate::chat_sync::set_content_removal_ready(false);
        }
        return Err(error.code());
    }
    // Entries are archived before the deletion is recorded, so a failed
    // archive is retried with the deletion, which is idempotent.
    crate::auth::session_activity::archive_artifacts_for_attachment(pool, attachment_id)
        .await
        .map_err(database_error)?;
    query(
        "UPDATE cloud_attachments SET object_deleted_at = now() \
         WHERE attachment_id = $1 AND object_deleted_at IS NULL",
    )
    .bind(attachment_id)
    .execute(pool)
    .await
    .map_err(database_error)?;
    Ok(PurgeOutcome::Purged)
}

/// Purges the job's files that are not finished yet, a few per attempt.
pub(super) async fn run(
    pool: &PgPool,
    objects: Option<&dyn ObjectStoreDeleter>,
    job: &mut Job,
) -> StepOutcome {
    let Some(objects) = objects else {
        return StepOutcome::Failed("object_store_unavailable");
    };
    let mut finished = job.progress["attachmentsFinished"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToString::to_string)
        .collect::<BTreeSet<_>>();
    let mut retained = job.progress["attachmentsRetained"].as_bool() == Some(true);
    let mut failure = None;
    let pending = job
        .attachment_ids
        .iter()
        .filter(|id| !finished.contains(id.as_str()))
        .take(FILES_PER_ATTEMPT)
        .cloned()
        .collect::<Vec<_>>();
    for attachment_id in pending {
        match purge_attachment(pool, objects, &attachment_id).await {
            Ok(outcome) => {
                retained |= outcome == PurgeOutcome::Retained;
                finished.insert(attachment_id);
            }
            Err(code) => {
                failure.get_or_insert(code);
            }
        }
    }
    let all_finished = job
        .attachment_ids
        .iter()
        .all(|id| finished.contains(id.as_str()));
    job.progress["attachmentsFinished"] = json!(finished);
    job.progress["attachmentsRetained"] = Value::Bool(retained);
    match (failure, all_finished, retained) {
        (Some(code), _, _) => StepOutcome::Failed(code),
        (None, true, true) => StepOutcome::Retained,
        (None, true, false) => StepOutcome::Done,
        (None, false, _) => StepOutcome::More,
    }
}
