use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::cloud_agent_runtime::runs::{claim_run, ClaimRunRequest, RunError};
use crate::scheduled_tasks::models::{
    CreateScheduledTaskRequest, ScheduledTaskResponse, ScheduledTaskRunResponse,
};
use crate::scheduled_tasks::schedule::{
    initial_next_run_at, next_run_after, ScheduledTaskSchedule,
};

type TaskRow = (
    String,
    String,
    String,
    Option<String>,
    Value,
    String,
    bool,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
);

type RunRow = (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
    Option<String>,
);

fn ts(value: DateTime<Utc>) -> String {
    value.to_rfc3339()
}

fn protocol_error(message: impl Into<String>) -> sqlx_core::Error {
    sqlx_core::Error::Protocol(message.into())
}

fn parse_schedule(value: Value) -> Result<ScheduledTaskSchedule, sqlx_core::Error> {
    serde_json::from_value(value)
        .map_err(|err| protocol_error(format!("invalid schedule_json: {err}")))
}

fn row_to_task(row: TaskRow) -> Result<ScheduledTaskResponse, sqlx_core::Error> {
    Ok(ScheduledTaskResponse {
        task_id: row.0,
        title: row.1,
        prompt: row.2,
        session_id: row.3,
        schedule: parse_schedule(row.4)?,
        target_runtime: row.5,
        enabled: row.6,
        status: row.7,
        next_run_at: row.8,
        last_run_at: row.9,
        last_run_status: row.10,
        last_run_error: row.11,
        created_at: row.12,
        updated_at: row.13,
    })
}

fn row_to_run(row: RunRow) -> ScheduledTaskRunResponse {
    ScheduledTaskRunResponse {
        run_id: row.0,
        task_id: row.1,
        status: row.2,
        target_runtime: row.3,
        due_at: row.4,
        result_message: row.5,
        error_code: row.6,
        error_message: row.7,
        created_at: row.8,
        updated_at: row.9,
        completed_at: row.10,
    }
}

pub async fn create_scheduled_task(
    pool: &PgPool,
    owner_account_id: &str,
    created_by_account_id: &str,
    input: CreateScheduledTaskRequest,
    now: DateTime<Utc>,
) -> Result<ScheduledTaskResponse, sqlx_core::Error> {
    let task_id = format!("scheduled_task_{}", Uuid::new_v4().simple());
    let next_run_at = initial_next_run_at(&input.schedule, now)
        .map_err(|err| protocol_error(err.to_string()))?
        .map(ts);
    let schedule_json = serde_json::to_value(&input.schedule)
        .map_err(|err| protocol_error(format!("serialize schedule: {err}")))?;
    let row = query_as::<_, TaskRow>(
        "INSERT INTO scheduled_tool_tasks(
            task_id, owner_account_id, created_by_account_id, title, prompt, tool_payload_json,
            schedule_json, timezone, target_runtime, enabled, status, next_run_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,'active',$10,$11,$11)
         RETURNING task_id, title, prompt, tool_payload_json->>'sessionId', schedule_json, target_runtime, enabled, status, next_run_at,
                   last_run_at, last_run_status, last_run_error, created_at, updated_at"
    )
    .bind(task_id)
    .bind(owner_account_id)
    .bind(created_by_account_id)
    .bind(input.title.trim())
    .bind(input.prompt.trim())
    .bind(input.tool_payload)
    .bind(schedule_json)
    .bind("UTC")
    .bind(input.target_runtime.as_str())
    .bind(next_run_at)
    .bind(ts(now))
    .fetch_one(pool)
    .await?;
    row_to_task(row)
}

pub async fn list_scheduled_tasks(
    pool: &PgPool,
    owner_account_id: &str,
) -> Result<Vec<ScheduledTaskResponse>, sqlx_core::Error> {
    let rows = query_as::<_, TaskRow>(
        "SELECT task_id, title, prompt, tool_payload_json->>'sessionId', schedule_json, target_runtime, enabled, status, next_run_at,
                last_run_at, last_run_status, last_run_error, created_at, updated_at
           FROM scheduled_tool_tasks
          WHERE owner_account_id = $1 AND status <> 'deleted'
          ORDER BY updated_at DESC, task_id ASC"
    )
    .bind(owner_account_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(row_to_task).collect()
}

pub async fn read_task(
    pool: &PgPool,
    owner_account_id: &str,
    task_id: &str,
) -> Result<Option<ScheduledTaskResponse>, sqlx_core::Error> {
    let row = query_as::<_, TaskRow>(
        "SELECT task_id, title, prompt, tool_payload_json->>'sessionId', schedule_json, target_runtime, enabled, status, next_run_at,
                last_run_at, last_run_status, last_run_error, created_at, updated_at
           FROM scheduled_tool_tasks
          WHERE owner_account_id = $1 AND task_id = $2 AND status <> 'deleted'"
    )
    .bind(owner_account_id)
    .bind(task_id)
    .fetch_optional(pool)
    .await?;
    row.map(row_to_task).transpose()
}

pub async fn pause_scheduled_task(
    pool: &PgPool,
    owner_account_id: &str,
    task_id: &str,
) -> Result<Option<ScheduledTaskResponse>, sqlx_core::Error> {
    update_task_status(pool, owner_account_id, task_id, false, "paused", Utc::now()).await
}

pub async fn resume_scheduled_task(
    pool: &PgPool,
    owner_account_id: &str,
    task_id: &str,
    now: DateTime<Utc>,
) -> Result<Option<ScheduledTaskResponse>, sqlx_core::Error> {
    let Some(current) = read_task(pool, owner_account_id, task_id).await? else {
        return Ok(None);
    };
    let next_run_at = next_run_after(&current.schedule, now)
        .map_err(|err| protocol_error(err.to_string()))?
        .map(ts);
    let row = query_as::<_, TaskRow>(
        "UPDATE scheduled_tool_tasks
            SET enabled = TRUE, status = 'active', next_run_at = $1, updated_at = $2
          WHERE owner_account_id = $3 AND task_id = $4 AND status <> 'deleted'
          RETURNING task_id, title, prompt, tool_payload_json->>'sessionId', schedule_json, target_runtime, enabled, status, next_run_at,
                    last_run_at, last_run_status, last_run_error, created_at, updated_at"
    )
    .bind(next_run_at)
    .bind(ts(now))
    .bind(owner_account_id)
    .bind(task_id)
    .fetch_optional(pool)
    .await?;
    row.map(row_to_task).transpose()
}

async fn update_task_status(
    pool: &PgPool,
    owner_account_id: &str,
    task_id: &str,
    enabled: bool,
    status: &str,
    now: DateTime<Utc>,
) -> Result<Option<ScheduledTaskResponse>, sqlx_core::Error> {
    let row = query_as::<_, TaskRow>(
        "UPDATE scheduled_tool_tasks
            SET enabled = $1, status = $2, updated_at = $3
          WHERE owner_account_id = $4 AND task_id = $5 AND status <> 'deleted'
          RETURNING task_id, title, prompt, tool_payload_json->>'sessionId', schedule_json, target_runtime, enabled, status, next_run_at,
                    last_run_at, last_run_status, last_run_error, created_at, updated_at"
    )
    .bind(enabled)
    .bind(status)
    .bind(ts(now))
    .bind(owner_account_id)
    .bind(task_id)
    .fetch_optional(pool)
    .await?;
    row.map(row_to_task).transpose()
}

pub async fn soft_delete_scheduled_task(
    pool: &PgPool,
    owner_account_id: &str,
    task_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let now = ts(Utc::now());
    let result = query("UPDATE scheduled_tool_tasks SET enabled = FALSE, status = 'deleted', deleted_at = $1, updated_at = $1 WHERE owner_account_id = $2 AND task_id = $3 AND status <> 'deleted'")
        .bind(now)
        .bind(owner_account_id)
        .bind(task_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn create_scheduled_task_run_now(
    pool: &PgPool,
    owner_account_id: &str,
    task_id: &str,
    now: DateTime<Utc>,
) -> Result<Option<ScheduledTaskRunResponse>, sqlx_core::Error> {
    let Some((task_id, created_by_account_id, target_runtime, prompt, tool_payload_json)) =
        query_as::<_, (String, String, String, String, Value)>(
            "SELECT task_id, created_by_account_id, target_runtime, prompt, tool_payload_json
               FROM scheduled_tool_tasks
              WHERE owner_account_id = $1 AND task_id = $2 AND status <> 'deleted'",
        )
        .bind(owner_account_id)
        .bind(task_id)
        .fetch_optional(pool)
        .await?
    else {
        return Ok(None);
    };
    let run =
        create_run_for_task(pool, owner_account_id, &task_id, &target_runtime, now, now).await?;
    if target_runtime == "cloud" {
        enqueue_cloud_agent_fallback_run_for_scheduled_run(
            pool,
            owner_account_id,
            &created_by_account_id,
            &prompt,
            &tool_payload_json,
            &run,
        )
        .await?;
    }
    Ok(Some(run))
}

pub async fn mark_scheduled_task_run_completed_in_transaction(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    run_id: &str,
    result_message: &str,
    now: DateTime<Utc>,
) -> Result<(), sqlx_core::Error> {
    if !run_id.starts_with("scheduled_run_") {
        return Ok(());
    }
    query(
        "WITH updated_run AS (
            UPDATE scheduled_tool_task_runs
               SET status = 'completed', result_message = $2, error_code = NULL, error_message = NULL, updated_at = $3, completed_at = $3
             WHERE run_id = $1
             RETURNING task_id, due_at
         )
         UPDATE scheduled_tool_tasks task
            SET last_run_at = updated_run.due_at, last_run_status = 'completed', last_run_error = NULL, updated_at = $3
           FROM updated_run
          WHERE task.task_id = updated_run.task_id",
    )
    .bind(run_id)
    .bind(result_message)
    .bind(ts(now))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn mark_scheduled_task_run_failed_in_transaction(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    run_id: &str,
    error_code: &str,
    error_message: &str,
    now: DateTime<Utc>,
) -> Result<(), sqlx_core::Error> {
    if !run_id.starts_with("scheduled_run_") {
        return Ok(());
    }
    query(
        "WITH updated_run AS (
            UPDATE scheduled_tool_task_runs
               SET status = 'failed', error_code = $2, error_message = $3, updated_at = $4, completed_at = $4
             WHERE run_id = $1
             RETURNING task_id, due_at
         )
         UPDATE scheduled_tool_tasks task
            SET last_run_at = updated_run.due_at, last_run_status = 'failed', last_run_error = $3, updated_at = $4
           FROM updated_run
          WHERE task.task_id = updated_run.task_id",
    )
    .bind(run_id)
    .bind(error_code)
    .bind(error_message)
    .bind(ts(now))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn create_run_for_task(
    pool: &PgPool,
    owner_account_id: &str,
    task_id: &str,
    target_runtime: &str,
    due_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<ScheduledTaskRunResponse, sqlx_core::Error> {
    let run_id = format!("scheduled_run_{}", Uuid::new_v4().simple());
    let status = if target_runtime == "local_required" {
        "waiting_for_desktop"
    } else {
        "queued"
    };
    let row = query_as::<_, RunRow>(
        "INSERT INTO scheduled_tool_task_runs(run_id, task_id, owner_account_id, status, target_runtime, due_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
         ON CONFLICT (task_id, due_at) DO UPDATE SET updated_at = scheduled_tool_task_runs.updated_at
         RETURNING run_id, task_id, status, target_runtime, due_at, result_message, error_code, error_message, created_at, updated_at, completed_at"
    )
    .bind(run_id)
    .bind(task_id)
    .bind(owner_account_id)
    .bind(status)
    .bind(target_runtime)
    .bind(ts(due_at))
    .bind(ts(now))
    .fetch_one(pool)
    .await?;
    Ok(row_to_run(row))
}

pub async fn list_scheduled_task_runs(
    pool: &PgPool,
    owner_account_id: &str,
    task_id: &str,
    limit: i64,
) -> Result<Vec<ScheduledTaskRunResponse>, sqlx_core::Error> {
    let rows = query_as::<_, RunRow>(
        "SELECT run_id, task_id, status, target_runtime, due_at, result_message, error_code, error_message, created_at, updated_at, completed_at
           FROM scheduled_tool_task_runs
          WHERE owner_account_id = $1 AND task_id = $2
          ORDER BY created_at DESC, run_id DESC
          LIMIT $3",
    )
    .bind(owner_account_id)
    .bind(task_id)
    .bind(limit.clamp(1, 50))
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(row_to_run).collect())
}

async fn enqueue_cloud_agent_fallback_run_for_scheduled_run(
    pool: &PgPool,
    owner_account_id: &str,
    created_by_account_id: &str,
    prompt: &str,
    tool_payload_json: &Value,
    run: &ScheduledTaskRunResponse,
) -> Result<(), sqlx_core::Error> {
    let session_id = tool_payload_json
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("session:scheduled:{}", owner_account_id));
    claim_run(
        pool,
        &ClaimRunRequest {
            request_message_id: run.run_id.clone(),
            session_id,
            owner_account_id: owner_account_id.to_string(),
            requester_account_id: created_by_account_id.to_string(),
            prompt: prompt.to_string(),
            idempotency_key: format!("scheduled:{}", run.run_id),
        },
    )
    .await
    .map_err(RunError::into_persistence_error)?;
    Ok(())
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
        let due_at = DateTime::parse_from_rfc3339(
            due_at_text
                .as_deref()
                .ok_or_else(|| protocol_error("missing due_at"))?,
        )
        .map_err(|err| protocol_error(format!("invalid next_run_at: {err}")))?
        .with_timezone(&Utc);
        let run = create_run_for_task(
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
                &run,
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
            .execute(pool)
            .await?;
        runs.push(run);
    }
    Ok(runs)
}
