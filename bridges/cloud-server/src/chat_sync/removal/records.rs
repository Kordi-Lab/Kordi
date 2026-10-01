//! The records step: agent runs, task summaries, and files-panel entries of a
//! message deleted for everyone, and the repair pass of the history backfill.

use super::*;

/// How far back the history backfill reconciles deleted and hidden messages.
const BACKFILL_RECONCILE_DAYS: i64 = store::BACKFILL_WINDOW_DAYS;
const BACKFILL_RECONCILE_PAGE: i64 = 500;

pub(super) async fn run(pool: &PgPool, job: &Job) -> StepOutcome {
    let result = match job.reason.as_str() {
        "message_deleted" => deleted_message_records(pool, job).await,
        "backfill" => backfill_reconcile(pool).await,
        _ => Ok(StepOutcome::Done),
    };
    result.unwrap_or_else(|error| StepOutcome::Failed(database_error(error)))
}

async fn deleted_message_records(pool: &PgPool, job: &Job) -> Result<StepOutcome, StoreError> {
    let Some(conversation_id) = job.conversation_id else {
        return Ok(StepOutcome::Done);
    };
    let identifiers = job.identifiers();
    let mut transaction = pool.begin().await?;
    let sessions = store::conversation_session_ids(&mut transaction, conversation_id).await?;
    // A run claimed while the message was being deleted is cancelled here.
    store::cancel_queued_runs_for_deleted_request(&mut transaction, conversation_id, &identifiers)
        .await?;
    // Finished runs keep no copy of the request. `updated_at` is unchanged so
    // run history keeps its order.
    query(
        "UPDATE cloud_agent_fallback_runs SET prompt = '' \
         WHERE session_id = ANY($1) AND request_message_id = ANY($2) \
           AND status IN ('completed', 'failed', 'cancelled') \
           AND run_id NOT LIKE 'digest\\_%' AND prompt <> ''",
    )
    .bind(&sessions)
    .bind(&identifiers)
    .execute(&mut *transaction)
    .await?;
    // A run already working on the request keeps its prompt until it ends;
    // the step stays open so the prompt is cleared once it finishes.
    let (running,): (bool,) = query_as(
        "SELECT EXISTS (SELECT 1 FROM cloud_agent_fallback_runs \
                        WHERE session_id = ANY($1) AND request_message_id = ANY($2) \
                          AND status IN ('leased', 'running') \
                          AND run_id NOT LIKE 'digest\\_%' \
                          AND (lease_expires_at IS NULL OR lease_expires_at > $3))",
    )
    .bind(&sessions)
    .bind(&identifiers)
    .bind(Utc::now().to_rfc3339())
    .fetch_one(&mut *transaction)
    .await?;
    transaction.commit().await?;
    crate::auth::session_activity::clear_task_summaries_for_message(
        pool,
        conversation_id,
        &sessions,
        &identifiers,
    )
    .await?;
    crate::auth::session_activity::archive_artifacts_for_message(
        pool,
        conversation_id,
        &sessions,
        &identifiers,
    )
    .await?;
    Ok(if running {
        StepOutcome::More
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
