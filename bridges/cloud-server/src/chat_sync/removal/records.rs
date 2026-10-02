//! The records step: agent runs, task summaries, and files-panel entries of a
//! message deleted for everyone, and the repair pass of the history backfill.
//!
//! Task summaries and files-panel entries are matched only through ids that
//! name the deleted message alone (see `Job::exclusive_identifiers`). Agent
//! runs are matched through every id of the message, but only runs its sender
//! requested, or runs that name its canonical id.

use super::*;

/// How far back the history backfill reconciles deleted and hidden messages.
const BACKFILL_RECONCILE_DAYS: i64 = store::BACKFILL_WINDOW_DAYS;
const BACKFILL_RECONCILE_PAGE: i64 = 500;

pub(super) async fn run(pool: &PgPool, job: &mut Job) -> StepOutcome {
    let result = match job.reason.as_str() {
        "message_deleted" => deleted_message_records(pool, job).await,
        "backfill" => backfill_reconcile(pool).await,
        _ => Ok(StepOutcome::Done),
    };
    result.unwrap_or_else(|error| StepOutcome::Failed(database_error(error)))
}

async fn deleted_message_records(pool: &PgPool, job: &mut Job) -> Result<StepOutcome, StoreError> {
    let (Some(conversation_id), Some(message_id)) = (job.conversation_id, job.message_id) else {
        return Ok(StepOutcome::Done);
    };
    let identifiers = job.identifiers();
    let exclusive = job.exclusive_identifiers(pool).await?;
    let sender: Option<(String,)> =
        query_as("SELECT sender_account_id FROM cloud_chat_messages WHERE message_id = $1")
            .bind(message_id)
            .fetch_optional(pool)
            .await?;
    let sender = sender.map(|(sender,)| sender);
    let request = store::DeletedRequest {
        conversation_id,
        message_id,
        sender_account_id: sender.as_deref(),
        identifiers: &identifiers,
    };
    let canonical = message_id.to_string();
    let mut transaction = pool.begin().await?;
    let sessions = store::conversation_session_ids(&mut transaction, conversation_id).await?;
    // A run claimed while the message was being deleted is cancelled here.
    store::cancel_queued_runs_for_deleted_request(&mut transaction, &request).await?;
    // A run whose lease expired is picked up again by a runner, so it is
    // cancelled like a queued one.
    query(concat!(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'cancelled', prompt = '', error_code = 'request_deleted', \
             error_message = 'The request was deleted before the agent finished.', \
             completed_at = $5, updated_at = $5 \
         WHERE status IN ('leased', 'running') AND subsession_id IS NULL \
           AND lease_expires_at IS NOT NULL AND lease_expires_at::timestamptz <= now() AND ",
        store::deleted_request_runs_sql!()
    ))
    .bind(&sessions)
    .bind(&identifiers)
    .bind(&canonical)
    .bind(request.sender_account_id)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut *transaction)
    .await?;
    // Finished runs keep no copy of the request, and neither do runs left
    // active without a lease, which no runner reclaims. `updated_at` is
    // unchanged so run history keeps its order.
    query(concat!(
        "UPDATE cloud_agent_fallback_runs SET prompt = '' \
         WHERE (status IN ('completed', 'failed', 'cancelled') \
                OR (status IN ('leased', 'running') AND lease_expires_at IS NULL)) \
           AND prompt <> '' AND ",
        store::deleted_request_runs_sql!()
    ))
    .bind(&sessions)
    .bind(&identifiers)
    .bind(&canonical)
    .bind(request.sender_account_id)
    .execute(&mut *transaction)
    .await?;
    // A run working on the request under a live lease keeps its prompt until
    // it ends; the step waits and clears the prompt once it finishes.
    let (running,): (bool,) = query_as(concat!(
        "SELECT EXISTS (SELECT 1 FROM cloud_agent_fallback_runs \
                        WHERE status IN ('leased', 'running') \
                          AND lease_expires_at IS NOT NULL \
                          AND lease_expires_at::timestamptz > now() AND ",
        store::deleted_request_runs_sql!(),
        ")"
    ))
    .bind(&sessions)
    .bind(&identifiers)
    .bind(&canonical)
    .bind(request.sender_account_id)
    .fetch_one(&mut *transaction)
    .await?;
    transaction.commit().await?;
    crate::auth::session_activity::clear_task_summaries_for_message(
        pool,
        conversation_id,
        &sessions,
        &exclusive,
    )
    .await?;
    crate::auth::session_activity::archive_artifacts_for_message(
        pool,
        conversation_id,
        &sessions,
        &exclusive,
    )
    .await?;
    Ok(if running {
        StepOutcome::Wait
    } else {
        StepOutcome::Done
    })
}

/// The operator history backfill: repair messages deleted or hidden within
/// the backfill window, a page at a time, until nothing is left.
async fn backfill_reconcile(pool: &PgPool) -> Result<StepOutcome, StoreError> {
    let since = Utc::now() - chrono::Duration::days(BACKFILL_RECONCILE_DAYS);
    let deleted = store::reconcile_deleted_messages(pool, since, BACKFILL_RECONCILE_PAGE).await?;
    let hidden = store::reconcile_hidden_messages(pool, since, BACKFILL_RECONCILE_PAGE).await?;
    Ok(if deleted == 0 && hidden == 0 {
        StepOutcome::Done
    } else {
        StepOutcome::More
    })
}
