//! Background worker for content removal jobs.
//!
//! A delete, hide, or edit rewrites replay rows in its own transaction and
//! queues a job for the work that does not belong in the request: stored
//! digests, quote and thread previews, agent run prompts, task summaries,
//! files-panel entries, and stored file bytes. Every 10 seconds the worker
//! leases due jobs and runs each pending step in the order digests, records,
//! attachments, quotes. A failing step does not stop the others. Steps do
//! bounded work and keep their place in `progress`, so a long job finishes
//! over several attempts. Due jobs are leased in `next_attempt_at` order, so a
//! job with more work never starves newer ones. A job waiting on an agent run
//! that is still working on its request checks again after a minute. Failed
//! attempts back off from 30 seconds to at most 6 hours, and jobs never give
//! up.
//!
//! Log lines carry job ids, reasons, steps, and codes only; never content,
//! object keys, or URLs. See `docs/data-deletion.md`.

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::chat_sync::store::{self, StoreError};

mod attachments;
mod records;
mod schedule;
mod steps;

pub use attachments::{purge_attachment, PurgeOutcome};
pub use schedule::{
    bucket_attested, probe_object_store, readiness, spawn_removal_worker, BUCKET_ATTESTATION_ENV,
};

/// A job's attempt count at which the worker logs it once more.
const ATTEMPTS_WORTH_REPORTING: i32 = 10;
/// How long a job waits before checking again on an agent run that is still
/// working on its deleted request.
const WAIT_SECONDS: f64 = 60.0;

/// Why an object could not be deleted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjectDeleteError {
    /// The object store refused the deletion (HTTP 403).
    Forbidden,
    /// Any other failure: a network error, a timeout, or another status.
    Failed,
}

impl ObjectDeleteError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Forbidden => "object_store_forbidden",
            Self::Failed => "object_store_error",
        }
    }
}

/// Deletes stored bytes. A missing object counts as deleted.
#[async_trait::async_trait]
pub trait ObjectStoreDeleter: Send + Sync {
    async fn delete_object(&self, object_key: &str) -> Result<(), ObjectDeleteError>;
}

/// The result of one step in one attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StepOutcome {
    Done,
    /// Done, and at least one file is kept because something else uses it.
    Retained,
    /// Progress was made and more work remains.
    More,
    /// Something else must finish first, such as an agent run still working
    /// on the deleted request; the job checks again after `WAIT_SECONDS`.
    Wait,
    Failed(&'static str),
}

impl StepOutcome {
    fn finished(self) -> bool {
        matches!(self, Self::Done | Self::Retained)
    }

    fn label(self) -> String {
        match self {
            Self::Done => "done".to_string(),
            Self::Retained => "retained".to_string(),
            Self::More => "more".to_string(),
            Self::Wait => "wait".to_string(),
            Self::Failed(code) => format!("error:{code}"),
        }
    }
}

fn database_error(_: impl std::fmt::Debug) -> &'static str {
    "database_error"
}

/// A leased job.
struct Job {
    job_id: Uuid,
    reason: String,
    account_id: Option<String>,
    conversation_id: Option<Uuid>,
    message_id: Option<Uuid>,
    source_identifiers: Vec<String>,
    attachment_ids: Vec<String>,
    pending: [bool; 4],
    progress: Value,
    attempts: i32,
    leased_until: DateTime<Utc>,
}

impl Job {
    /// Ids a reply, run, or task may use for the job's message.
    fn identifiers(&self) -> Vec<String> {
        if self.source_identifiers.is_empty() {
            self.message_id.iter().map(ToString::to_string).collect()
        } else {
            self.source_identifiers.clone()
        }
    }

    /// The job's ids that no other message of the conversation also uses, so
    /// records of other people's messages are never matched. Computed once and
    /// kept in `progress`.
    async fn exclusive_identifiers(&mut self, pool: &PgPool) -> Result<Vec<String>, StoreError> {
        if let Some(cached) = self.progress["exclusiveIdentifiers"].as_array() {
            return Ok(cached
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect());
        }
        let identifiers = match (self.conversation_id, self.message_id) {
            (Some(conversation_id), Some(message_id)) => {
                store::exclusive_identifiers(pool, conversation_id, message_id, &self.identifiers())
                    .await?
            }
            _ => self.identifiers(),
        };
        self.progress["exclusiveIdentifiers"] = json!(identifiers);
        Ok(identifiers)
    }
}

const STEPS: [&str; 4] = ["digests", "records", "attachments", "quotes"];

type JobRow = (
    Uuid,
    String,
    Option<String>,
    Option<Uuid>,
    Option<Uuid>,
    Vec<String>,
    Vec<String>,
    bool,
    bool,
    bool,
    bool,
    Value,
    i32,
    DateTime<Utc>,
);

/// Leases one due job, optionally only from `only`, skipping `skip`.
async fn lease_job(
    pool: &PgPool,
    only: Option<&[Uuid]>,
    skip: &[Uuid],
) -> Result<Option<Job>, StoreError> {
    let row: Option<JobRow> = query_as(
        "UPDATE cloud_content_removal_jobs \
         SET leased_until = now() + interval '2 minutes', updated_at = now() \
         WHERE job_id IN (SELECT job_id FROM cloud_content_removal_jobs \
           WHERE completed_at IS NULL AND next_attempt_at <= now() \
             AND (leased_until IS NULL OR leased_until < now()) \
             AND ($1::uuid[] IS NULL OR job_id = ANY($1)) AND NOT (job_id = ANY($2)) \
           ORDER BY next_attempt_at, created_at LIMIT 1 FOR UPDATE SKIP LOCKED) \
         RETURNING job_id, reason, account_id, conversation_id, message_id, source_identifiers, \
           attachment_ids, digests_done_at IS NULL, records_done_at IS NULL, \
           attachments_done_at IS NULL, quotes_done_at IS NULL, progress, attempts, leased_until",
    )
    .bind(only)
    .bind(skip)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| Job {
        job_id: row.0,
        reason: row.1,
        account_id: row.2,
        conversation_id: row.3,
        message_id: row.4,
        source_identifiers: row.5,
        attachment_ids: row.6,
        pending: [row.7, row.8, row.9, row.10],
        progress: if row.11.is_object() {
            row.11
        } else {
            json!({})
        },
        attempts: row.12,
        leased_until: row.13,
    }))
}

/// Runs up to `limit` due jobs, one lease at a time. Returns how many ran.
pub async fn run_due_jobs(
    pool: &PgPool,
    objects: Option<&dyn ObjectStoreDeleter>,
    limit: i64,
) -> Result<u32, StoreError> {
    let mut seen = Vec::new();
    while (seen.len() as i64) < limit {
        let Some(job) = lease_job(pool, None, &seen).await? else {
            break;
        };
        seen.push(job.job_id);
        run_job(pool, objects, job).await?;
    }
    Ok(seen.len() as u32)
}

/// Runs the given jobs once each if they are due. Returns how many ran.
pub async fn run_jobs(
    pool: &PgPool,
    objects: Option<&dyn ObjectStoreDeleter>,
    job_ids: &[Uuid],
) -> Result<u32, StoreError> {
    let mut seen = Vec::new();
    while let Some(job) = lease_job(pool, Some(job_ids), &seen).await? {
        seen.push(job.job_id);
        run_job(pool, objects, job).await?;
    }
    Ok(seen.len() as u32)
}

async fn run_job(
    pool: &PgPool,
    objects: Option<&dyn ObjectStoreDeleter>,
    mut job: Job,
) -> Result<(), StoreError> {
    let mut outcomes = [StepOutcome::Done; 4];
    for (index, step) in STEPS.into_iter().enumerate() {
        if !job.pending[index] {
            continue;
        }
        let outcome = match index {
            0 => steps::digests(pool, &mut job).await,
            1 => records::run(pool, &mut job).await,
            2 => attachments::run(pool, objects, &mut job).await,
            _ => steps::quotes(pool, &mut job).await,
        };
        eprintln!(
            "[content-removal] job={} reason={} step={step} outcome={}",
            job.job_id,
            job.reason,
            outcome.label()
        );
        outcomes[index] = outcome;
    }
    let done = std::array::from_fn::<bool, 4, _>(|index| {
        !job.pending[index] || outcomes[index].finished()
    });
    let failure = outcomes.iter().find_map(|outcome| match outcome {
        StepOutcome::Failed(code) => Some(*code),
        _ => None,
    });
    let completed = done.iter().all(|done| *done);
    let failure = failure.filter(|_| !completed);
    // Unfinished work runs again at once; due jobs are leased in
    // `next_attempt_at` order, so it never starves newer jobs. A job with
    // nothing left but a wait checks again later.
    let waiting = outcomes.contains(&StepOutcome::Wait) && !outcomes.contains(&StepOutcome::More);
    let delay_seconds = match (failure, waiting) {
        (Some(_), _) => retry_delay(job.attempts.saturating_add(1)).as_secs_f64(),
        (None, true) => WAIT_SECONDS,
        (None, false) => 0.0,
    };
    let attempts: Option<(i32,)> = query_as(
        "UPDATE cloud_content_removal_jobs SET \
           digests_done_at = CASE WHEN $2 THEN COALESCE(digests_done_at, now()) ELSE digests_done_at END, \
           records_done_at = CASE WHEN $3 THEN COALESCE(records_done_at, now()) ELSE records_done_at END, \
           attachments_done_at = CASE WHEN $4 \
             THEN COALESCE(attachments_done_at, now()) ELSE attachments_done_at END, \
           quotes_done_at = CASE WHEN $5 THEN COALESCE(quotes_done_at, now()) ELSE quotes_done_at END, \
           progress = $6, \
           completed_at = CASE WHEN $7 THEN now() END, \
           attempts = attempts + CASE WHEN $8::text IS NULL THEN 0 ELSE 1 END, \
           last_error_code = CASE WHEN $7 THEN NULL ELSE COALESCE($8, last_error_code) END, \
           next_attempt_at = now() + make_interval(secs => $9), \
           leased_until = NULL, updated_at = now() \
         WHERE job_id = $1 AND leased_until = $10 \
         RETURNING attempts",
    )
    .bind(job.job_id)
    .bind(done[0])
    .bind(done[1])
    .bind(done[2])
    .bind(done[3])
    .bind(&job.progress)
    .bind(completed)
    .bind(failure)
    .bind(delay_seconds)
    .bind(job.leased_until)
    .fetch_optional(pool)
    .await?;
    if let (Some((attempts,)), Some(code)) = (attempts, failure) {
        if attempts == ATTEMPTS_WORTH_REPORTING {
            eprintln!(
                "[content-removal] job={} reason={} attempts={attempts} outcome=error:{code}",
                job.job_id, job.reason
            );
        }
    }
    Ok(())
}

/// The wait before the next attempt after `attempts` failed attempts: 30
/// seconds, doubling, at most 6 hours.
pub fn retry_delay(attempts: i32) -> Duration {
    const BASE_SECONDS: u64 = 30;
    const MAX_SECONDS: u64 = 6 * 60 * 60;
    let doublings = attempts.saturating_sub(1).clamp(0, 20) as u32;
    Duration::from_secs((BASE_SECONDS << doublings).min(MAX_SECONDS))
}

/// Re-checks files kept because something else used them, at least a day
/// after they were last checked, and finishes deletions that failed after
/// reads were already denied. Returns the number of files deleted.
pub async fn recheck_purge_candidates(
    pool: &PgPool,
    objects: Option<&dyn ObjectStoreDeleter>,
    limit: i64,
) -> Result<u32, StoreError> {
    let Some(objects) = objects else {
        return Ok(0);
    };
    let candidates: Vec<(String,)> = query_as(
        "(SELECT attachment_id FROM cloud_attachments \
          WHERE purge_candidate_at < now() - interval '24 hours' AND purge_requested_at IS NULL \
          ORDER BY purge_candidate_at LIMIT $1) \
         UNION \
         (SELECT attachment_id FROM cloud_attachments \
          WHERE purge_requested_at < now() - interval '1 hour' AND object_deleted_at IS NULL \
          ORDER BY purge_requested_at LIMIT $1)",
    )
    .bind(limit.max(0))
    .fetch_all(pool)
    .await?;
    let mut purged = 0;
    for (attachment_id,) in candidates {
        match purge_attachment(pool, objects, &attachment_id).await {
            Ok(PurgeOutcome::Purged) => purged += 1,
            Ok(_) => {}
            Err(code) => eprintln!("[content-removal] step=recheck outcome=error:{code}"),
        }
    }
    Ok(purged)
}

#[cfg(test)]
mod tests;
