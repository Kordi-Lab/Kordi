//! Claims due scheduled task occurrences. Several schedulers can sweep at the
//! same time, for example one on each server instance, and each due
//! occurrence is started by exactly one of them.

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};

use super::models::ScheduledTaskRunResponse;
use super::schedule::next_run_after;
use super::store::{
    create_run_for_task, enqueue_cloud_agent_fallback_run_for_scheduled_run, parse_schedule,
    protocol_error, ts,
};

/// Holds a due task for this scheduler until its next run time is recorded.
/// Returns `None` when another scheduler holds the task or has already moved
/// it past this occurrence. The hold is an advisory lock, so recording the run
/// on other connections never waits on it.
async fn hold_due_task(
    pool: &PgPool,
    task_id: &str,
    next_run_at: &str,
) -> Result<Option<Transaction<'static, Postgres>>, sqlx_core::Error> {
    let mut transaction = pool.begin().await?;
    let (held,): (bool,) = query_as("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("scheduled-task-due:{task_id}"))
        .fetch_one(&mut *transaction)
        .await?;
    if !held {
        return Ok(None);
    }
    let still_due: Option<(String,)> = query_as(
        "SELECT task_id FROM scheduled_tool_tasks \
         WHERE task_id = $1 AND next_run_at = $2 AND enabled = TRUE AND status = 'active'",
    )
    .bind(task_id)
    .bind(next_run_at)
    .fetch_optional(&mut *transaction)
    .await?;
    Ok(still_due.map(|_| transaction))
}

pub async fn claim_due_scheduled_task_runs(
    pool: &PgPool,
    now: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<ScheduledTaskRunResponse>, sqlx_core::Error> {
    let rows = query_as::<_, (String, String, String, String, String, Value, Value, String, Option<String>)>(
        "SELECT task_id, owner_account_id, created_by_account_id, target_runtime, prompt, tool_payload_json, schedule_json, next_run_at, next_run_at
           FROM scheduled_tool_tasks
          WHERE enabled = TRUE AND status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= $1
          ORDER BY next_run_at ASC, task_id ASC
          LIMIT $2"
    )
    .bind(ts(now))
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let mut runs = Vec::new();
    for (
        task_id,
        owner_account_id,
        created_by_account_id,
        target_runtime,
        prompt,
        tool_payload_json,
        schedule_json,
        next_run_at,
        due_at_text,
    ) in rows
    {
        let Some(mut held) = hold_due_task(pool, &task_id, &next_run_at).await? else {
            continue;
        };
        let due_at = DateTime::parse_from_rfc3339(
            due_at_text
                .as_deref()
                .ok_or_else(|| protocol_error("missing due_at"))?,
        )
        .map_err(|err| protocol_error(format!("invalid next_run_at: {err}")))?
        .with_timezone(&Utc);
        let mut run = create_run_for_task(
            pool,
            &owner_account_id,
            &task_id,
            &target_runtime,
            due_at,
            now,
        )
        .await?;
        if target_runtime == "cloud" {
            enqueue_cloud_agent_fallback_run_for_scheduled_run(
                pool,
                &owner_account_id,
                &created_by_account_id,
                &prompt,
                &tool_payload_json,
                &mut run,
                now,
            )
            .await?;
        }
        let schedule = parse_schedule(schedule_json)?;
        let next = next_run_after(&schedule, due_at)
            .map_err(|err| protocol_error(err.to_string()))?
            .map(ts);
        query("UPDATE scheduled_tool_tasks SET next_run_at = $1, last_run_at = $2, last_run_status = $3, updated_at = $4 WHERE task_id = $5")
            .bind(next)
            .bind(next_run_at)
            .bind(&run.status)
            .bind(ts(now))
            .bind(&task_id)
            .execute(&mut *held)
            .await?;
        held.commit().await?;
        runs.push(run);
    }
    Ok(runs)
}
