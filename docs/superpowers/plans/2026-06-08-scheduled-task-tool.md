# Scheduled Task Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Cloud-backed scheduled task building tool so agents can create, list, pause/resume, delete, and run recurring or one-shot work, while local-Mac-required runs wait until Desktop is online.

**Architecture:** Implement scheduling as tool infrastructure, not as Kordi's core task model. The Cloud server owns durable scheduled tool rows, run logs, schedule parsing/next-run calculation, due-run claiming, and runner endpoints; Desktop consumes the user-facing API and later can execute local-required runs when online. Borrow OpenClaw's durable cron concepts (job rows, run logs, enabled state, next-run timestamps, due-job claims) but keep Kordi's MVP limited to one-shot and daily schedules.

**Tech Stack:** Rust Cloud server (`axum`, `sqlx-postgres`, Postgres migrations, `chrono`), TypeScript Desktop client/tests (`tsx --test`, React static rendering), existing Kordi Cloud auth/session middleware and runner-token authorization.

---

## Scope and Boundaries

This plan implements the scheduling substrate and a minimal management surface as a building tool. It does not implement full cron syntax, natural-language LLM extraction, or actual local Mac execution in the first PR. It does include the server/client contracts that make local-required runs durable with `waiting_for_desktop` status so the Desktop pickup loop can be added in a follow-up without changing persisted shape.

## File Structure

- `bridges/cloud-server/migrations/0022_scheduled_task_tool.sql` — durable scheduled tool tables and indexes.
- `bridges/cloud-server/src/scheduled_tasks/mod.rs` — module root exporting scheduler, models, and routes.
- `bridges/cloud-server/src/scheduled_tasks/models.rs` — request/response structs, enum-ish constants, validation helpers.
- `bridges/cloud-server/src/scheduled_tasks/schedule.rs` — supported schedule parsing and next-run calculation for `once` and `daily`.
- `bridges/cloud-server/src/scheduled_tasks/store.rs` — SQL functions for create/list/update/delete/run-now/claim/complete/fail.
- `bridges/cloud-server/src/scheduled_tasks/routes.rs` — user API and runner API for scheduled task tools.
- `bridges/cloud-server/src/scheduled_tasks/worker.rs` — optional Cloud boot worker that periodically claims due Cloud-runnable jobs and records queued runs. Local-required work remains waiting.
- `bridges/cloud-server/src/lib.rs` — add `pub mod scheduled_tasks;`.
- `bridges/cloud-server/src/server.rs` — merge scheduled task routes and start the scheduler worker.
- `bridges/cloud-server/tests/scheduled_task_tool_e2e.rs` — Cloud API and store integration tests.
- `app/desktop/src/features/cloud/scheduledTasksClient.ts` — pure TS HTTP client for scheduled task tool APIs.
- `app/desktop/src/kordi-app/components/ScheduledTasksPanel.tsx` — minimal management UI list/actions.
- `app/desktop/src/kordi-app/types.ts` — scheduled task UI types if shared UI model types are needed.
- `app/desktop/tests/scheduledTasksClient.test.tsx` — client serialization/error tests.
- `app/desktop/tests/scheduledTasksPanel.test.tsx` — static rendering/action affordance tests.

---

### Task 1: Add Cloud DB schema and schedule calculation

**Files:**
- Create: `bridges/cloud-server/migrations/0022_scheduled_task_tool.sql`
- Create: `bridges/cloud-server/src/scheduled_tasks/mod.rs`
- Create: `bridges/cloud-server/src/scheduled_tasks/models.rs`
- Create: `bridges/cloud-server/src/scheduled_tasks/schedule.rs`
- Modify: `bridges/cloud-server/src/lib.rs`

- [ ] **Step 1: Write failing schedule calculation tests**

Create `bridges/cloud-server/src/scheduled_tasks/schedule.rs` with tests first:

```rust
use chrono::{DateTime, Datelike, Duration, NaiveTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScheduledTaskSchedule {
    Once { at: String },
    Daily { time: String, timezone: Option<String> },
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ScheduleError {
    #[error("scheduled time must be a valid RFC3339 timestamp")]
    InvalidOnceAt,
    #[error("daily time must use HH:MM 24-hour format")]
    InvalidDailyTime,
    #[error("timezone is not supported in this build")]
    UnsupportedTimezone,
}

pub fn next_run_after(
    schedule: &ScheduledTaskSchedule,
    after: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, ScheduleError> {
    match schedule {
        ScheduledTaskSchedule::Once { at } => {
            let at = DateTime::parse_from_rfc3339(at)
                .map_err(|_| ScheduleError::InvalidOnceAt)?
                .with_timezone(&Utc);
            Ok((at > after).then_some(at))
        }
        ScheduledTaskSchedule::Daily { time, timezone } => {
            if timezone.as_deref().filter(|value| *value != "UTC").is_some() {
                return Err(ScheduleError::UnsupportedTimezone);
            }
            let time = NaiveTime::parse_from_str(time, "%H:%M")
                .map_err(|_| ScheduleError::InvalidDailyTime)?;
            let today = after.date_naive();
            let candidate = Utc
                .with_ymd_and_hms(today.year(), today.month(), today.day(), time.hour(), time.minute(), 0)
                .single()
                .ok_or(ScheduleError::InvalidDailyTime)?;
            if candidate > after {
                Ok(Some(candidate))
            } else {
                Ok(Some(candidate + Duration::days(1)))
            }
        }
    }
}

trait NaiveTimeParts {
    fn hour(&self) -> u32;
    fn minute(&self) -> u32;
}

impl NaiveTimeParts for NaiveTime {
    fn hour(&self) -> u32 { chrono::Timelike::hour(self) }
    fn minute(&self) -> u32 { chrono::Timelike::minute(self) }
}

#[cfg(test)]
mod tests {
    use super::{next_run_after, ScheduleError, ScheduledTaskSchedule};
    use chrono::{TimeZone, Utc};

    #[test]
    fn once_schedule_returns_future_instant_and_none_after_it_passes() {
        let schedule = ScheduledTaskSchedule::Once { at: "2026-06-09T14:30:00Z".to_string() };
        assert_eq!(
            next_run_after(&schedule, Utc.with_ymd_and_hms(2026, 6, 9, 14, 0, 0).unwrap()).unwrap(),
            Some(Utc.with_ymd_and_hms(2026, 6, 9, 14, 30, 0).unwrap())
        );
        assert_eq!(
            next_run_after(&schedule, Utc.with_ymd_and_hms(2026, 6, 9, 14, 31, 0).unwrap()).unwrap(),
            None
        );
    }

    #[test]
    fn daily_schedule_rolls_to_today_or_tomorrow_in_utc() {
        let schedule = ScheduledTaskSchedule::Daily { time: "09:00".to_string(), timezone: Some("UTC".to_string()) };
        assert_eq!(
            next_run_after(&schedule, Utc.with_ymd_and_hms(2026, 6, 9, 8, 45, 0).unwrap()).unwrap(),
            Some(Utc.with_ymd_and_hms(2026, 6, 9, 9, 0, 0).unwrap())
        );
        assert_eq!(
            next_run_after(&schedule, Utc.with_ymd_and_hms(2026, 6, 9, 9, 1, 0).unwrap()).unwrap(),
            Some(Utc.with_ymd_and_hms(2026, 6, 10, 9, 0, 0).unwrap())
        );
    }

    #[test]
    fn daily_schedule_rejects_invalid_time_and_non_utc_timezone_for_mvp() {
        let bad_time = ScheduledTaskSchedule::Daily { time: "morning".to_string(), timezone: Some("UTC".to_string()) };
        assert_eq!(
            next_run_after(&bad_time, Utc.with_ymd_and_hms(2026, 6, 9, 8, 0, 0).unwrap()).unwrap_err(),
            ScheduleError::InvalidDailyTime
        );
        let local_zone = ScheduledTaskSchedule::Daily { time: "09:00".to_string(), timezone: Some("America/Los_Angeles".to_string()) };
        assert_eq!(
            next_run_after(&local_zone, Utc.with_ymd_and_hms(2026, 6, 9, 8, 0, 0).unwrap()).unwrap_err(),
            ScheduleError::UnsupportedTimezone
        );
    }
}
```

- [ ] **Step 2: Run test to verify it fails because module is not wired**

Run:

```bash
cargo test -p kordi-cloud-server scheduled_tasks::schedule -- --nocapture
```

Expected: FAIL to compile because `crate::scheduled_tasks` is not declared in `lib.rs`.

- [ ] **Step 3: Wire module root and fix schedule imports**

Create `bridges/cloud-server/src/scheduled_tasks/mod.rs`:

```rust
pub mod models;
pub mod schedule;
pub mod store;
pub mod routes;
pub mod worker;
```

Create placeholder files so module wiring compiles in this task:

`bridges/cloud-server/src/scheduled_tasks/models.rs`
```rust
// Scheduled task request/response models are added in Task 2.
```

`bridges/cloud-server/src/scheduled_tasks/store.rs`
```rust
// Scheduled task persistence is added in Task 2.
```

`bridges/cloud-server/src/scheduled_tasks/routes.rs`
```rust
// Scheduled task HTTP routes are added in Task 3.
```

`bridges/cloud-server/src/scheduled_tasks/worker.rs`
```rust
// Scheduled task scheduler worker is added in Task 4.
```

Modify `bridges/cloud-server/src/lib.rs`:

```rust
pub mod attachments;
pub mod auth;
pub mod cloud_agent_runtime;
pub mod events;
pub mod messages;
pub mod pg;
pub mod presence;
pub mod scheduled_tasks;
pub mod server;
pub mod ws;
```

- [ ] **Step 4: Add migration**

Create `bridges/cloud-server/migrations/0022_scheduled_task_tool.sql`:

```sql
CREATE TABLE IF NOT EXISTS scheduled_tool_tasks (
    task_id TEXT PRIMARY KEY,
    owner_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    created_by_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    tool_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    schedule_json JSONB NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    target_runtime TEXT NOT NULL CHECK (target_runtime IN ('cloud', 'local_required')),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'deleted')),
    next_run_at TEXT,
    last_run_at TEXT,
    last_run_status TEXT,
    last_run_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tool_tasks_owner_updated
    ON scheduled_tool_tasks(owner_account_id, updated_at DESC, task_id);

CREATE INDEX IF NOT EXISTS idx_scheduled_tool_tasks_due
    ON scheduled_tool_tasks(enabled, status, next_run_at, task_id)
    WHERE enabled = TRUE AND status = 'active' AND next_run_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS scheduled_tool_task_runs (
    run_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES scheduled_tool_tasks(task_id) ON DELETE CASCADE,
    owner_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'waiting_for_desktop', 'leased', 'running', 'completed', 'failed', 'cancelled')),
    target_runtime TEXT NOT NULL CHECK (target_runtime IN ('cloud', 'local_required')),
    due_at TEXT NOT NULL,
    lease_expires_at TEXT,
    claimed_by TEXT,
    result_message TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_tool_task_runs_task_due
    ON scheduled_tool_task_runs(task_id, due_at);

CREATE INDEX IF NOT EXISTS idx_scheduled_tool_task_runs_owner_updated
    ON scheduled_tool_task_runs(owner_account_id, updated_at DESC, run_id);

CREATE INDEX IF NOT EXISTS idx_scheduled_tool_task_runs_claim_cloud
    ON scheduled_tool_task_runs(status, target_runtime, lease_expires_at, created_at)
    WHERE target_runtime = 'cloud' AND status IN ('queued', 'leased');

CREATE INDEX IF NOT EXISTS idx_scheduled_tool_task_runs_waiting_desktop
    ON scheduled_tool_task_runs(owner_account_id, status, created_at)
    WHERE target_runtime = 'local_required' AND status = 'waiting_for_desktop';
```

- [ ] **Step 5: Run schedule test to verify it passes**

Run:

```bash
cargo test -p kordi-cloud-server scheduled_tasks::schedule -- --nocapture
```

Expected: PASS for 3 schedule tests.

- [ ] **Step 6: Commit**

```bash
git add bridges/cloud-server/migrations/0022_scheduled_task_tool.sql \
  bridges/cloud-server/src/lib.rs \
  bridges/cloud-server/src/scheduled_tasks
git commit -m "feat: add scheduled task tool schema and schedule math"
```

---

### Task 2: Add Cloud store operations for scheduled task tools

**Files:**
- Modify: `bridges/cloud-server/src/scheduled_tasks/models.rs`
- Modify: `bridges/cloud-server/src/scheduled_tasks/store.rs`
- Test: `bridges/cloud-server/tests/scheduled_task_tool_e2e.rs`

- [ ] **Step 1: Write failing store/API-shaped tests**

Create `bridges/cloud-server/tests/scheduled_task_tool_e2e.rs`:

```rust
use chrono::{TimeZone, Utc};
use kordi_cloud_server::scheduled_tasks::models::{
    CreateScheduledTaskRequest, ScheduledTaskTargetRuntime,
};
use kordi_cloud_server::scheduled_tasks::schedule::ScheduledTaskSchedule;
use kordi_cloud_server::scheduled_tasks::store::{
    claim_due_scheduled_task_runs, create_scheduled_task, create_scheduled_task_run_now,
    list_scheduled_tasks, pause_scheduled_task, resume_scheduled_task, soft_delete_scheduled_task,
};
use sqlx_core::query::query;
use sqlx_postgres::PgPool;

async fn seed_account(pool: &PgPool, account_id: &str) {
    query(
        "INSERT INTO cloud_accounts(account_id, email, password_hash, display_name, avatar_url, created_at, updated_at)
         VALUES ($1, $2, 'hash', $3, NULL, '2026-06-08T00:00:00Z', '2026-06-08T00:00:00Z')
         ON CONFLICT (account_id) DO NOTHING",
    )
    .bind(account_id)
    .bind(format!("{account_id}@example.com"))
    .bind(account_id)
    .execute(pool)
    .await
    .expect("seed account");
}

#[sqlx_macros::test(migrations = "./migrations")]
async fn scheduled_task_store_creates_lists_pauses_resumes_and_deletes(pool: PgPool) {
    seed_account(&pool, "acct_owner").await;
    let task = create_scheduled_task(
        &pool,
        "acct_owner",
        "acct_owner",
        CreateScheduledTaskRequest {
            title: "Daily standup prep".to_string(),
            prompt: "Summarize yesterday and prepare today priorities.".to_string(),
            schedule: ScheduledTaskSchedule::Daily { time: "09:00".to_string(), timezone: Some("UTC".to_string()) },
            target_runtime: ScheduledTaskTargetRuntime::Cloud,
            tool_payload: serde_json::json!({ "tool": "agent.run" }),
        },
        Utc.with_ymd_and_hms(2026, 6, 8, 8, 0, 0).unwrap(),
    ).await.expect("create task");

    assert_eq!(task.title, "Daily standup prep");
    assert_eq!(task.status, "active");
    assert_eq!(task.next_run_at.as_deref(), Some("2026-06-08T09:00:00+00:00"));

    let listed = list_scheduled_tasks(&pool, "acct_owner").await.expect("list tasks");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].task_id, task.task_id);

    let paused = pause_scheduled_task(&pool, "acct_owner", &task.task_id).await.expect("pause").expect("paused task");
    assert_eq!(paused.status, "paused");
    assert!(!paused.enabled);

    let resumed = resume_scheduled_task(&pool, "acct_owner", &task.task_id, Utc.with_ymd_and_hms(2026, 6, 8, 8, 30, 0).unwrap()).await.expect("resume").expect("resumed task");
    assert_eq!(resumed.status, "active");
    assert!(resumed.enabled);
    assert_eq!(resumed.next_run_at.as_deref(), Some("2026-06-08T09:00:00+00:00"));

    let deleted = soft_delete_scheduled_task(&pool, "acct_owner", &task.task_id).await.expect("delete");
    assert!(deleted);
    assert!(list_scheduled_tasks(&pool, "acct_owner").await.expect("list after delete").is_empty());
}

#[sqlx_macros::test(migrations = "./migrations")]
async fn run_now_and_due_claim_separate_cloud_and_local_required_runs(pool: PgPool) {
    seed_account(&pool, "acct_owner").await;
    let cloud = create_scheduled_task(&pool, "acct_owner", "acct_owner", CreateScheduledTaskRequest {
        title: "Cloud check".to_string(),
        prompt: "Check cloud status.".to_string(),
        schedule: ScheduledTaskSchedule::Once { at: "2026-06-08T09:00:00Z".to_string() },
        target_runtime: ScheduledTaskTargetRuntime::Cloud,
        tool_payload: serde_json::json!({}),
    }, Utc.with_ymd_and_hms(2026, 6, 8, 8, 0, 0).unwrap()).await.expect("cloud task");
    let local = create_scheduled_task(&pool, "acct_owner", "acct_owner", CreateScheduledTaskRequest {
        title: "Mac check".to_string(),
        prompt: "Read a local file when my Mac is online.".to_string(),
        schedule: ScheduledTaskSchedule::Once { at: "2026-06-08T09:00:00Z".to_string() },
        target_runtime: ScheduledTaskTargetRuntime::LocalRequired,
        tool_payload: serde_json::json!({ "requiresLocalMac": true }),
    }, Utc.with_ymd_and_hms(2026, 6, 8, 8, 0, 0).unwrap()).await.expect("local task");

    let manual_local = create_scheduled_task_run_now(&pool, "acct_owner", &local.task_id, Utc.with_ymd_and_hms(2026, 6, 8, 8, 5, 0).unwrap()).await.expect("run now").expect("local run");
    assert_eq!(manual_local.status, "waiting_for_desktop");

    let claimed = claim_due_scheduled_task_runs(&pool, Utc.with_ymd_and_hms(2026, 6, 8, 9, 1, 0).unwrap(), 10).await.expect("claim due");
    assert!(claimed.iter().any(|run| run.task_id == cloud.task_id && run.status == "queued"));
    assert!(claimed.iter().any(|run| run.task_id == local.task_id && run.status == "waiting_for_desktop"));
}
```

- [ ] **Step 2: Run test to verify it fails because models/store functions are missing**

Run:

```bash
cargo test -p kordi-cloud-server --test scheduled_task_tool_e2e -- --nocapture
```

Expected: FAIL to compile with missing `CreateScheduledTaskRequest`, `ScheduledTaskTargetRuntime`, and store functions.

- [ ] **Step 3: Implement models**

Replace `bridges/cloud-server/src/scheduled_tasks/models.rs` with:

```rust
use serde::{Deserialize, Serialize};

use crate::scheduled_tasks::schedule::ScheduledTaskSchedule;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScheduledTaskTargetRuntime {
    Cloud,
    LocalRequired,
}

impl ScheduledTaskTargetRuntime {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Cloud => "cloud",
            Self::LocalRequired => "local_required",
        }
    }

    pub fn initial_run_status(&self) -> &'static str {
        match self {
            Self::Cloud => "queued",
            Self::LocalRequired => "waiting_for_desktop",
        }
    }
}

impl TryFrom<&str> for ScheduledTaskTargetRuntime {
    type Error = ();

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "cloud" => Ok(Self::Cloud),
            "local_required" => Ok(Self::LocalRequired),
            _ => Err(()),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateScheduledTaskRequest {
    pub title: String,
    pub prompt: String,
    pub schedule: ScheduledTaskSchedule,
    pub target_runtime: ScheduledTaskTargetRuntime,
    #[serde(default)]
    pub tool_payload: serde_json::Value,
}

impl CreateScheduledTaskRequest {
    pub fn is_well_formed(&self) -> bool {
        !self.title.trim().is_empty() && !self.prompt.trim().is_empty()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskResponse {
    pub task_id: String,
    pub title: String,
    pub prompt: String,
    pub schedule: ScheduledTaskSchedule,
    pub target_runtime: String,
    pub enabled: bool,
    pub status: String,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    pub last_run_status: Option<String>,
    pub last_run_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskRunResponse {
    pub run_id: String,
    pub task_id: String,
    pub status: String,
    pub target_runtime: String,
    pub due_at: String,
    pub result_message: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}
```

- [ ] **Step 4: Implement store operations**

Replace `bridges/cloud-server/src/scheduled_tasks/store.rs` with SQLx functions matching the tests. The implementation must:

```rust
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::scheduled_tasks::models::{
    CreateScheduledTaskRequest, ScheduledTaskResponse, ScheduledTaskRunResponse,
};
use crate::scheduled_tasks::schedule::{next_run_after, ScheduledTaskSchedule};

fn ts(value: DateTime<Utc>) -> String {
    value.to_rfc3339()
}

fn parse_schedule(value: Value) -> Result<ScheduledTaskSchedule, sqlx_core::Error> {
    serde_json::from_value(value).map_err(|err| sqlx_core::Error::Protocol(format!("invalid schedule_json: {err}")))
}

fn row_to_task(row: (String, String, String, Value, String, bool, String, Option<String>, Option<String>, Option<String>, Option<String>, String, String)) -> Result<ScheduledTaskResponse, sqlx_core::Error> {
    Ok(ScheduledTaskResponse {
        task_id: row.0,
        title: row.1,
        prompt: row.2,
        schedule: parse_schedule(row.3)?,
        target_runtime: row.4,
        enabled: row.5,
        status: row.6,
        next_run_at: row.7,
        last_run_at: row.8,
        last_run_status: row.9,
        last_run_error: row.10,
        created_at: row.11,
        updated_at: row.12,
    })
}

pub async fn create_scheduled_task(
    pool: &PgPool,
    owner_account_id: &str,
    created_by_account_id: &str,
    input: CreateScheduledTaskRequest,
    now: DateTime<Utc>,
) -> Result<ScheduledTaskResponse, sqlx_core::Error> {
    let task_id = format!("scheduled_task_{}", Uuid::new_v4());
    let next_run_at = next_run_after(&input.schedule, now)
        .map_err(|err| sqlx_core::Error::Protocol(err.to_string()))?
        .map(ts);
    let schedule_json = serde_json::to_value(&input.schedule)
        .map_err(|err| sqlx_core::Error::Protocol(format!("serialize schedule: {err}")))?;
    let row = query_as::<_, (String, String, String, Value, String, bool, String, Option<String>, Option<String>, Option<String>, Option<String>, String, String)>(
        "INSERT INTO scheduled_tool_tasks(
            task_id, owner_account_id, created_by_account_id, title, prompt, tool_payload_json,
            schedule_json, timezone, target_runtime, enabled, status, next_run_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,'active',$10,$11,$11)
         RETURNING task_id, title, prompt, schedule_json, target_runtime, enabled, status, next_run_at,
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

pub async fn list_scheduled_tasks(pool: &PgPool, owner_account_id: &str) -> Result<Vec<ScheduledTaskResponse>, sqlx_core::Error> {
    let rows = query_as::<_, (String, String, String, Value, String, bool, String, Option<String>, Option<String>, Option<String>, Option<String>, String, String)>(
        "SELECT task_id, title, prompt, schedule_json, target_runtime, enabled, status, next_run_at,
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

pub async fn pause_scheduled_task(pool: &PgPool, owner_account_id: &str, task_id: &str) -> Result<Option<ScheduledTaskResponse>, sqlx_core::Error> {
    update_task_status(pool, owner_account_id, task_id, false, "paused", Utc::now()).await
}

pub async fn resume_scheduled_task(pool: &PgPool, owner_account_id: &str, task_id: &str, now: DateTime<Utc>) -> Result<Option<ScheduledTaskResponse>, sqlx_core::Error> {
    let current = read_task(pool, owner_account_id, task_id).await?;
    let Some(current) = current else { return Ok(None); };
    let next_run_at = next_run_after(&current.schedule, now)
        .map_err(|err| sqlx_core::Error::Protocol(err.to_string()))?
        .map(ts);
    let row = query_as::<_, (String, String, String, Value, String, bool, String, Option<String>, Option<String>, Option<String>, Option<String>, String, String)>(
        "UPDATE scheduled_tool_tasks
            SET enabled = TRUE, status = 'active', next_run_at = $1, updated_at = $2
          WHERE owner_account_id = $3 AND task_id = $4 AND status <> 'deleted'
          RETURNING task_id, title, prompt, schedule_json, target_runtime, enabled, status, next_run_at,
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

async fn update_task_status(pool: &PgPool, owner_account_id: &str, task_id: &str, enabled: bool, status: &str, now: DateTime<Utc>) -> Result<Option<ScheduledTaskResponse>, sqlx_core::Error> {
    let row = query_as::<_, (String, String, String, Value, String, bool, String, Option<String>, Option<String>, Option<String>, Option<String>, String, String)>(
        "UPDATE scheduled_tool_tasks
            SET enabled = $1, status = $2, updated_at = $3
          WHERE owner_account_id = $4 AND task_id = $5 AND status <> 'deleted'
          RETURNING task_id, title, prompt, schedule_json, target_runtime, enabled, status, next_run_at,
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

pub async fn soft_delete_scheduled_task(pool: &PgPool, owner_account_id: &str, task_id: &str) -> Result<bool, sqlx_core::Error> {
    let result = query("UPDATE scheduled_tool_tasks SET enabled = FALSE, status = 'deleted', deleted_at = $1, updated_at = $1 WHERE owner_account_id = $2 AND task_id = $3 AND status <> 'deleted'")
        .bind(ts(Utc::now()))
        .bind(owner_account_id)
        .bind(task_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn read_task(pool: &PgPool, owner_account_id: &str, task_id: &str) -> Result<Option<ScheduledTaskResponse>, sqlx_core::Error> {
    let row = query_as::<_, (String, String, String, Value, String, bool, String, Option<String>, Option<String>, Option<String>, Option<String>, String, String)>(
        "SELECT task_id, title, prompt, schedule_json, target_runtime, enabled, status, next_run_at,
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

fn row_to_run(row: (String, String, String, String, String, Option<String>, Option<String>, Option<String>, String, String, Option<String>)) -> ScheduledTaskRunResponse {
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

pub async fn create_scheduled_task_run_now(pool: &PgPool, owner_account_id: &str, task_id: &str, now: DateTime<Utc>) -> Result<Option<ScheduledTaskRunResponse>, sqlx_core::Error> {
    let task = read_task(pool, owner_account_id, task_id).await?;
    let Some(task) = task else { return Ok(None); };
    create_run_for_task(pool, owner_account_id, &task.task_id, &task.target_runtime, now).await.map(Some)
}

async fn create_run_for_task(pool: &PgPool, owner_account_id: &str, task_id: &str, target_runtime: &str, due_at: DateTime<Utc>) -> Result<ScheduledTaskRunResponse, sqlx_core::Error> {
    let run_id = format!("scheduled_run_{}", Uuid::new_v4());
    let status = if target_runtime == "local_required" { "waiting_for_desktop" } else { "queued" };
    let row = query_as::<_, (String, String, String, String, String, Option<String>, Option<String>, Option<String>, String, String, Option<String>)>(
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
    .bind(ts(Utc::now()))
    .fetch_one(pool)
    .await?;
    Ok(row_to_run(row))
}

pub async fn claim_due_scheduled_task_runs(pool: &PgPool, now: DateTime<Utc>, limit: i64) -> Result<Vec<ScheduledTaskRunResponse>, sqlx_core::Error> {
    let tasks = query_as::<_, (String, String, String, Value, String, bool, String, Option<String>, Option<String>, Option<String>, Option<String>, String, String)>(
        "SELECT task_id, title, prompt, schedule_json, target_runtime, enabled, status, next_run_at,
                last_run_at, last_run_status, last_run_error, created_at, updated_at
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
    for row in tasks {
        let task = row_to_task(row)?;
        let due_at = DateTime::parse_from_rfc3339(task.next_run_at.as_deref().unwrap_or(""))
            .map_err(|err| sqlx_core::Error::Protocol(format!("invalid next_run_at: {err}")))?
            .with_timezone(&Utc);
        let run = create_run_for_task(pool, owner_account_id_for_task(pool, &task.task_id).await?.as_str(), &task.task_id, &task.target_runtime, due_at).await?;
        let next = next_run_after(&task.schedule, due_at)
            .map_err(|err| sqlx_core::Error::Protocol(err.to_string()))?
            .map(ts);
        query("UPDATE scheduled_tool_tasks SET next_run_at = $1, last_run_at = $2, last_run_status = $3, updated_at = $4 WHERE task_id = $5")
            .bind(next)
            .bind(ts(due_at))
            .bind(&run.status)
            .bind(ts(now))
            .bind(&task.task_id)
            .execute(pool)
            .await?;
        runs.push(run);
    }
    Ok(runs)
}

async fn owner_account_id_for_task(pool: &PgPool, task_id: &str) -> Result<String, sqlx_core::Error> {
    let row: (String,) = query_as("SELECT owner_account_id FROM scheduled_tool_tasks WHERE task_id = $1")
        .bind(task_id)
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}
```

- [ ] **Step 5: Run store tests to verify they pass**

Run:

```bash
cargo test -p kordi-cloud-server --test scheduled_task_tool_e2e -- --nocapture
```

Expected: PASS for 2 scheduled task store tests.

- [ ] **Step 6: Commit**

```bash
git add bridges/cloud-server/src/scheduled_tasks/models.rs \
  bridges/cloud-server/src/scheduled_tasks/store.rs \
  bridges/cloud-server/tests/scheduled_task_tool_e2e.rs
git commit -m "feat: persist scheduled task tool jobs"
```

---

### Task 3: Add Cloud user and runner HTTP APIs

**Files:**
- Modify: `bridges/cloud-server/src/scheduled_tasks/routes.rs`
- Modify: `bridges/cloud-server/src/server.rs`
- Modify: `bridges/cloud-server/tests/scheduled_task_tool_e2e.rs`

- [ ] **Step 1: Add failing route tests**

Append route-level tests to `bridges/cloud-server/tests/scheduled_task_tool_e2e.rs` using the existing cloud auth test helpers in nearby tests as reference. The tests must cover:

```rust
#[test]
fn scheduled_task_routes_are_registered_under_cloud_api() {
    let source = std::fs::read_to_string("src/scheduled_tasks/routes.rs").expect("read routes");
    assert!(source.contains("/v1/cloud/scheduled-tasks"));
    assert!(source.contains("/v1/cloud/scheduled-tasks/:task_id/pause"));
    assert!(source.contains("/v1/cloud/scheduled-tasks/:task_id/resume"));
    assert!(source.contains("/v1/cloud/scheduled-tasks/:task_id/run-now"));
    assert!(source.contains("/v1/cloud/scheduled-task-runs/claim"));
}
```

- [ ] **Step 2: Run route test to verify it fails**

Run:

```bash
cargo test -p kordi-cloud-server --test scheduled_task_tool_e2e scheduled_task_routes_are_registered_under_cloud_api -- --nocapture
```

Expected: FAIL because routes file still has placeholder content.

- [ ] **Step 3: Implement routes**

Replace `bridges/cloud-server/src/scheduled_tasks/routes.rs` with:

```rust
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Extension, Json, Router};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::routes::{cloud_session_middleware, CloudSession};
use crate::cloud_agent_runtime::routes::runner_authorized_for_scheduled_tasks;
use crate::scheduled_tasks::models::{CreateScheduledTaskRequest, ScheduledTaskResponse, ScheduledTaskRunResponse};
use crate::scheduled_tasks::store::{
    claim_due_scheduled_task_runs, create_scheduled_task, create_scheduled_task_run_now,
    list_scheduled_tasks, pause_scheduled_task, resume_scheduled_task, soft_delete_scheduled_task,
};
use crate::server::ServerState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledTasksListResponse {
    tasks: Vec<ScheduledTaskResponse>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledTaskEnvelope {
    task: ScheduledTaskResponse,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledTaskRunEnvelope {
    run: ScheduledTaskRunResponse,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledTaskRunsEnvelope {
    runs: Vec<ScheduledTaskRunResponse>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimRunsRequest {
    runner_id: String,
    limit: Option<i64>,
}

pub fn routes(state: Arc<ServerState>) -> Router {
    let user_routes = Router::new()
        .route("/v1/cloud/scheduled-tasks", get(list_tasks).post(create_task))
        .route("/v1/cloud/scheduled-tasks/:task_id", delete(delete_task))
        .route("/v1/cloud/scheduled-tasks/:task_id/pause", post(pause_task))
        .route("/v1/cloud/scheduled-tasks/:task_id/resume", post(resume_task))
        .route("/v1/cloud/scheduled-tasks/:task_id/run-now", post(run_task_now))
        .layer(axum::middleware::from_fn_with_state(state.clone(), cloud_session_middleware))
        .with_state(state.clone());

    let runner_routes = Router::new()
        .route("/v1/cloud/scheduled-task-runs/claim", post(claim_runs))
        .with_state(state);

    user_routes.merge(runner_routes)
}

fn error_response(error_code: &'static str, message: &'static str, status: StatusCode) -> Response {
    (status, Json(json!({ "errorCode": error_code, "message": message }))).into_response()
}

async fn list_tasks(State(state): State<Arc<ServerState>>, Extension(session): Extension<CloudSession>) -> Response {
    match list_scheduled_tasks(state.db_pool(), &session.account_id).await {
        Ok(tasks) => Json(ScheduledTasksListResponse { tasks }).into_response(),
        Err(err) => {
            eprintln!("[scheduled_tasks] list: {err}");
            error_response("server_error", "Could not list scheduled tasks.", StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn create_task(State(state): State<Arc<ServerState>>, Extension(session): Extension<CloudSession>, Json(input): Json<CreateScheduledTaskRequest>) -> Response {
    if !input.is_well_formed() {
        return error_response("invalid_scheduled_task", "title and prompt are required.", StatusCode::BAD_REQUEST);
    }
    match create_scheduled_task(state.db_pool(), &session.account_id, &session.account_id, input, Utc::now()).await {
        Ok(task) => Json(ScheduledTaskEnvelope { task }).into_response(),
        Err(err) => {
            eprintln!("[scheduled_tasks] create: {err}");
            error_response("server_error", "Could not create scheduled task.", StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn pause_task(State(state): State<Arc<ServerState>>, Extension(session): Extension<CloudSession>, Path(task_id): Path<String>) -> Response {
    match pause_scheduled_task(state.db_pool(), &session.account_id, &task_id).await {
        Ok(Some(task)) => Json(ScheduledTaskEnvelope { task }).into_response(),
        Ok(None) => error_response("scheduled_task_not_found", "Scheduled task was not found.", StatusCode::NOT_FOUND),
        Err(err) => {
            eprintln!("[scheduled_tasks] pause: {err}");
            error_response("server_error", "Could not pause scheduled task.", StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn resume_task(State(state): State<Arc<ServerState>>, Extension(session): Extension<CloudSession>, Path(task_id): Path<String>) -> Response {
    match resume_scheduled_task(state.db_pool(), &session.account_id, &task_id, Utc::now()).await {
        Ok(Some(task)) => Json(ScheduledTaskEnvelope { task }).into_response(),
        Ok(None) => error_response("scheduled_task_not_found", "Scheduled task was not found.", StatusCode::NOT_FOUND),
        Err(err) => {
            eprintln!("[scheduled_tasks] resume: {err}");
            error_response("server_error", "Could not resume scheduled task.", StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn delete_task(State(state): State<Arc<ServerState>>, Extension(session): Extension<CloudSession>, Path(task_id): Path<String>) -> Response {
    match soft_delete_scheduled_task(state.db_pool(), &session.account_id, &task_id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => error_response("scheduled_task_not_found", "Scheduled task was not found.", StatusCode::NOT_FOUND),
        Err(err) => {
            eprintln!("[scheduled_tasks] delete: {err}");
            error_response("server_error", "Could not delete scheduled task.", StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn run_task_now(State(state): State<Arc<ServerState>>, Extension(session): Extension<CloudSession>, Path(task_id): Path<String>) -> Response {
    match create_scheduled_task_run_now(state.db_pool(), &session.account_id, &task_id, Utc::now()).await {
        Ok(Some(run)) => Json(ScheduledTaskRunEnvelope { run }).into_response(),
        Ok(None) => error_response("scheduled_task_not_found", "Scheduled task was not found.", StatusCode::NOT_FOUND),
        Err(err) => {
            eprintln!("[scheduled_tasks] run now: {err}");
            error_response("server_error", "Could not run scheduled task.", StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn claim_runs(State(state): State<Arc<ServerState>>, headers: HeaderMap, Json(input): Json<ClaimRunsRequest>) -> Response {
    if !runner_authorized_for_scheduled_tasks(&headers) {
        return error_response("invalid_runner_token", "Missing or invalid Cloud runner token.", StatusCode::UNAUTHORIZED);
    }
    if input.runner_id.trim().is_empty() {
        return error_response("invalid_runner_request", "runnerId is required.", StatusCode::BAD_REQUEST);
    }
    let limit = input.limit.unwrap_or(10).clamp(1, 50);
    match claim_due_scheduled_task_runs(state.db_pool(), Utc::now(), limit).await {
        Ok(runs) => Json(ScheduledTaskRunsEnvelope { runs }).into_response(),
        Err(err) => {
            eprintln!("[scheduled_tasks] claim runs: {err}");
            error_response("server_error", "Could not claim scheduled task runs.", StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}
```

Also expose runner auth in `bridges/cloud-server/src/cloud_agent_runtime/routes.rs` by adding this public wrapper near `runner_authorized`:

```rust
pub fn runner_authorized_for_scheduled_tasks(headers: &HeaderMap) -> bool {
    runner_authorized(headers)
}
```

- [ ] **Step 4: Merge routes in server**

Modify `bridges/cloud-server/src/server.rs` router builder:

```rust
        .merge(crate::cloud_agent_runtime::routes::routes(state.clone()))
        .merge(crate::scheduled_tasks::routes::routes(state.clone()))
        .merge(ws_router)
```

- [ ] **Step 5: Run route tests**

Run:

```bash
cargo test -p kordi-cloud-server --test scheduled_task_tool_e2e -- --nocapture
```

Expected: PASS for store and route-registration tests.

- [ ] **Step 6: Commit**

```bash
git add bridges/cloud-server/src/cloud_agent_runtime/routes.rs \
  bridges/cloud-server/src/scheduled_tasks/routes.rs \
  bridges/cloud-server/src/server.rs \
  bridges/cloud-server/tests/scheduled_task_tool_e2e.rs
git commit -m "feat: expose scheduled task tool cloud api"
```

---

### Task 4: Add Cloud scheduler worker loop

**Files:**
- Modify: `bridges/cloud-server/src/scheduled_tasks/worker.rs`
- Modify: `bridges/cloud-server/src/server.rs`
- Test: `bridges/cloud-server/tests/scheduled_task_tool_e2e.rs`

- [ ] **Step 1: Add failing source-level worker test**

Append to `bridges/cloud-server/tests/scheduled_task_tool_e2e.rs`:

```rust
#[test]
fn scheduled_task_worker_claims_due_jobs_on_interval() {
    let worker = std::fs::read_to_string("src/scheduled_tasks/worker.rs").expect("read worker");
    assert!(worker.contains("scheduled_task_sweep_interval"));
    assert!(worker.contains("claim_due_scheduled_task_runs"));
    assert!(worker.contains("waiting_for_desktop"));

    let server = std::fs::read_to_string("src/server.rs").expect("read server");
    assert!(server.contains("scheduled_tasks::worker::spawn_scheduled_task_worker"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p kordi-cloud-server --test scheduled_task_tool_e2e scheduled_task_worker_claims_due_jobs_on_interval -- --nocapture
```

Expected: FAIL because worker file is still placeholder.

- [ ] **Step 3: Implement worker**

Replace `bridges/cloud-server/src/scheduled_tasks/worker.rs`:

```rust
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tokio::task::JoinHandle;

use crate::scheduled_tasks::store::claim_due_scheduled_task_runs;
use crate::server::ServerState;

pub fn scheduled_task_sweep_interval() -> Duration {
    Duration::from_secs(
        std::env::var("KORDI_SCHEDULED_TASK_SWEEP_SECONDS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| (5..=3600).contains(value))
            .unwrap_or(30),
    )
}

pub fn spawn_scheduled_task_worker(state: Arc<ServerState>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(scheduled_task_sweep_interval());
        loop {
            interval.tick().await;
            match claim_due_scheduled_task_runs(state.db_pool(), Utc::now(), 25).await {
                Ok(runs) => {
                    for run in runs {
                        if run.status == "waiting_for_desktop" {
                            eprintln!("[scheduled_tasks] run {} waiting_for_desktop", run.run_id);
                        }
                    }
                }
                Err(err) => eprintln!("[scheduled_tasks] sweep due jobs: {err}"),
            }
        }
    })
}
```

- [ ] **Step 4: Spawn worker from server**

In `bridges/cloud-server/src/server.rs`, after presence sweeper spawn, add:

```rust
    crate::scheduled_tasks::worker::spawn_scheduled_task_worker(state.clone());
```

- [ ] **Step 5: Run worker test**

Run:

```bash
cargo test -p kordi-cloud-server --test scheduled_task_tool_e2e scheduled_task_worker_claims_due_jobs_on_interval -- --nocapture
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bridges/cloud-server/src/scheduled_tasks/worker.rs \
  bridges/cloud-server/src/server.rs \
  bridges/cloud-server/tests/scheduled_task_tool_e2e.rs
git commit -m "feat: run scheduled task due-job worker"
```

---

### Task 5: Add Desktop scheduled task client and management panel

**Files:**
- Create: `app/desktop/src/features/cloud/scheduledTasksClient.ts`
- Create: `app/desktop/src/kordi-app/components/ScheduledTasksPanel.tsx`
- Test: `app/desktop/tests/scheduledTasksClient.test.tsx`
- Test: `app/desktop/tests/scheduledTasksPanel.test.tsx`

- [ ] **Step 1: Write failing client tests**

Create `app/desktop/tests/scheduledTasksClient.test.tsx`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createScheduledTask,
  deleteScheduledTask,
  listScheduledTasks,
  pauseScheduledTask,
  resumeScheduledTask,
  runScheduledTaskNow,
} from '../src/features/cloud/scheduledTasksClient';

test('scheduled tasks client calls cloud tool endpoints with bearer auth', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/run-now')) return new Response(JSON.stringify({ run: { runId: 'run1', taskId: 'task1', status: 'queued', targetRuntime: 'cloud', dueAt: '2026-06-08T09:00:00Z', resultMessage: null, errorCode: null, errorMessage: null, createdAt: '2026-06-08T09:00:00Z', updatedAt: '2026-06-08T09:00:00Z', completedAt: null } }), { status: 200 });
    if (init.method === 'DELETE') return new Response('', { status: 204 });
    if (url.endsWith('/scheduled-tasks')) return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
    return new Response(JSON.stringify({ task: { taskId: 'task1', title: 'Daily', prompt: 'Do it', schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' }, targetRuntime: 'cloud', enabled: true, status: 'active', nextRunAt: '2026-06-09T09:00:00Z', lastRunAt: null, lastRunStatus: null, lastRunError: null, createdAt: '2026-06-08T09:00:00Z', updatedAt: '2026-06-08T09:00:00Z' } }), { status: 200 });
  };

  await listScheduledTasks({ apiBase: 'https://cloud.example', token: 'tok', fetcher });
  await createScheduledTask({ apiBase: 'https://cloud.example', token: 'tok', fetcher }, { title: 'Daily', prompt: 'Do it', schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' }, targetRuntime: 'cloud', toolPayload: {} });
  await pauseScheduledTask({ apiBase: 'https://cloud.example', token: 'tok', fetcher }, 'task1');
  await resumeScheduledTask({ apiBase: 'https://cloud.example', token: 'tok', fetcher }, 'task1');
  await runScheduledTaskNow({ apiBase: 'https://cloud.example', token: 'tok', fetcher }, 'task1');
  await deleteScheduledTask({ apiBase: 'https://cloud.example', token: 'tok', fetcher }, 'task1');

  assert.deepEqual(calls.map((call) => call.url), [
    'https://cloud.example/v1/cloud/scheduled-tasks',
    'https://cloud.example/v1/cloud/scheduled-tasks',
    'https://cloud.example/v1/cloud/scheduled-tasks/task1/pause',
    'https://cloud.example/v1/cloud/scheduled-tasks/task1/resume',
    'https://cloud.example/v1/cloud/scheduled-tasks/task1/run-now',
    'https://cloud.example/v1/cloud/scheduled-tasks/task1',
  ]);
  assert.ok(calls.every((call) => (call.init.headers as Record<string, string>).Authorization === 'Bearer tok'));
});
```

- [ ] **Step 2: Run client test to verify it fails**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/scheduledTasksClient.test.tsx
```

Expected: FAIL because `scheduledTasksClient.ts` does not exist.

- [ ] **Step 3: Implement client**

Create `app/desktop/src/features/cloud/scheduledTasksClient.ts`:

```ts
export type ScheduledTaskSchedule =
  | { kind: 'once'; at: string }
  | { kind: 'daily'; time: string; timezone?: string };

export type ScheduledTaskTargetRuntime = 'cloud' | 'localRequired';

export type ScheduledTask = {
  taskId: string;
  title: string;
  prompt: string;
  schedule: ScheduledTaskSchedule;
  targetRuntime: 'cloud' | 'local_required';
  enabled: boolean;
  status: 'active' | 'paused' | 'deleted' | string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScheduledTaskRun = {
  runId: string;
  taskId: string;
  status: string;
  targetRuntime: string;
  dueAt: string;
  resultMessage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type CreateScheduledTaskInput = {
  title: string;
  prompt: string;
  schedule: ScheduledTaskSchedule;
  targetRuntime: ScheduledTaskTargetRuntime;
  toolPayload?: unknown;
};

export type ScheduledTasksClientConfig = {
  apiBase: string;
  token: string;
  fetcher?: typeof fetch;
};

async function requestJson<T>(config: ScheduledTasksClientConfig, path: string, init: RequestInit = {}): Promise<T> {
  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(`${config.apiBase}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${config.token}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!response.ok) throw new Error(`Scheduled task request failed: ${response.status}`);
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export async function listScheduledTasks(config: ScheduledTasksClientConfig): Promise<ScheduledTask[]> {
  const result = await requestJson<{ tasks: ScheduledTask[] }>(config, '/v1/cloud/scheduled-tasks');
  return result.tasks;
}

export async function createScheduledTask(config: ScheduledTasksClientConfig, input: CreateScheduledTaskInput): Promise<ScheduledTask> {
  const result = await requestJson<{ task: ScheduledTask }>(config, '/v1/cloud/scheduled-tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return result.task;
}

export async function pauseScheduledTask(config: ScheduledTasksClientConfig, taskId: string): Promise<ScheduledTask> {
  const result = await requestJson<{ task: ScheduledTask }>(config, `/v1/cloud/scheduled-tasks/${encodeURIComponent(taskId)}/pause`, { method: 'POST' });
  return result.task;
}

export async function resumeScheduledTask(config: ScheduledTasksClientConfig, taskId: string): Promise<ScheduledTask> {
  const result = await requestJson<{ task: ScheduledTask }>(config, `/v1/cloud/scheduled-tasks/${encodeURIComponent(taskId)}/resume`, { method: 'POST' });
  return result.task;
}

export async function runScheduledTaskNow(config: ScheduledTasksClientConfig, taskId: string): Promise<ScheduledTaskRun> {
  const result = await requestJson<{ run: ScheduledTaskRun }>(config, `/v1/cloud/scheduled-tasks/${encodeURIComponent(taskId)}/run-now`, { method: 'POST' });
  return result.run;
}

export async function deleteScheduledTask(config: ScheduledTasksClientConfig, taskId: string): Promise<void> {
  await requestJson<void>(config, `/v1/cloud/scheduled-tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
}
```

- [ ] **Step 4: Write failing panel test**

Create `app/desktop/tests/scheduledTasksPanel.test.tsx`:

```tsx
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ScheduledTasksPanel } from '../src/kordi-app/components/ScheduledTasksPanel';

test('scheduled tasks panel renders management actions and waiting for desktop state', () => {
  const markup = renderToStaticMarkup(createElement(ScheduledTasksPanel, {
    tasks: [{
      taskId: 'task1',
      title: 'Morning local check',
      prompt: 'Check my Downloads folder.',
      schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' },
      targetRuntime: 'local_required',
      enabled: true,
      status: 'active',
      nextRunAt: '2026-06-09T09:00:00Z',
      lastRunAt: '2026-06-08T09:00:00Z',
      lastRunStatus: 'waiting_for_desktop',
      lastRunError: null,
      createdAt: '2026-06-08T08:00:00Z',
      updatedAt: '2026-06-08T08:00:00Z',
    }],
    onPause: () => {},
    onResume: () => {},
    onRunNow: () => {},
    onDelete: () => {},
  }));

  assert.match(markup, /Scheduled tools/);
  assert.match(markup, /Morning local check/);
  assert.match(markup, /Daily at 09:00 UTC/);
  assert.match(markup, /Requires Desktop/);
  assert.match(markup, /Waiting for Desktop/);
  assert.match(markup, /Pause/);
  assert.match(markup, /Run now/);
  assert.match(markup, /Delete/);
});
```

- [ ] **Step 5: Implement panel**

Create `app/desktop/src/kordi-app/components/ScheduledTasksPanel.tsx`:

```tsx
import type { ScheduledTask } from '@/features/cloud/scheduledTasksClient';

function scheduleLabel(task: ScheduledTask): string {
  if (task.schedule.kind === 'daily') return `Daily at ${task.schedule.time} ${task.schedule.timezone ?? 'UTC'}`;
  return `Once at ${task.schedule.at}`;
}

function runtimeLabel(task: ScheduledTask): string {
  return task.targetRuntime === 'local_required' ? 'Requires Desktop' : 'Cloud';
}

function statusLabel(task: ScheduledTask): string {
  if (task.lastRunStatus === 'waiting_for_desktop') return 'Waiting for Desktop';
  if (task.status === 'paused') return 'Paused';
  return task.lastRunStatus ?? 'Active';
}

export function ScheduledTasksPanel({
  tasks,
  onPause,
  onResume,
  onRunNow,
  onDelete,
}: {
  tasks: ScheduledTask[];
  onPause: (taskId: string) => void;
  onResume: (taskId: string) => void;
  onRunNow: (taskId: string) => void;
  onDelete: (taskId: string) => void;
}) {
  return (
    <section className="app-scheduled-tools-panel grid gap-3">
      <header className="grid gap-1">
        <h2 className="text-[15px] font-semibold text-foreground">Scheduled tools</h2>
        <p className="text-[12px] text-muted-foreground">Cloud-backed tool runs created by agents.</p>
      </header>
      {tasks.length === 0 ? (
        <p className="rounded-2xl border border-[var(--app-divider)] bg-[var(--app-card-bg)] p-4 text-[13px] text-muted-foreground">
          No scheduled tools yet. Ask Kordi to run something every morning.
        </p>
      ) : (
        <div className="grid gap-2">
          {tasks.map((task) => (
            <article key={task.taskId} className="rounded-2xl border border-[var(--app-divider)] bg-[var(--app-card-bg)] p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="grid gap-1">
                  <h3 className="text-[14px] font-semibold text-foreground">{task.title}</h3>
                  <p className="text-[12px] text-muted-foreground">{scheduleLabel(task)} · {runtimeLabel(task)}</p>
                  <p className="text-[12px] text-muted-foreground">{statusLabel(task)}</p>
                </div>
                <div className="flex flex-wrap justify-end gap-1.5">
                  {task.status === 'paused' ? (
                    <button type="button" onClick={() => onResume(task.taskId)}>Resume</button>
                  ) : (
                    <button type="button" onClick={() => onPause(task.taskId)}>Pause</button>
                  )}
                  <button type="button" onClick={() => onRunNow(task.taskId)}>Run now</button>
                  <button type="button" onClick={() => onDelete(task.taskId)}>Delete</button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 6: Run desktop scheduled task tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/scheduledTasksClient.test.tsx tests/scheduledTasksPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/desktop/src/features/cloud/scheduledTasksClient.ts \
  app/desktop/src/kordi-app/components/ScheduledTasksPanel.tsx \
  app/desktop/tests/scheduledTasksClient.test.tsx \
  app/desktop/tests/scheduledTasksPanel.test.tsx
git commit -m "feat: add scheduled task tool desktop client"
```

---

### Task 6: Final verification and PR

**Files:**
- Modify only if verification reveals issues.

- [ ] **Step 1: Run Cloud scheduled-task tests**

```bash
cargo test -p kordi-cloud-server --test scheduled_task_tool_e2e -- --nocapture
```

Expected: PASS.

- [ ] **Step 2: Run full Cloud server tests**

```bash
cargo test -p kordi-cloud-server
```

Expected: PASS with all Cloud server unit and e2e tests.

- [ ] **Step 3: Run desktop scheduled-task tests**

```bash
pnpm --dir app/desktop exec tsx --test tests/scheduledTasksClient.test.tsx tests/scheduledTasksPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Run desktop typecheck**

```bash
pnpm --dir app/desktop typecheck
```

Expected: PASS.

- [ ] **Step 5: Review diff**

```bash
git diff --check
git status --short
git log --oneline -6
```

Expected: no whitespace errors, clean status after commits, and six task commits.

- [ ] **Step 6: Push and open PR**

```bash
git push -u origin issue-558-scheduled-task-tool
gh pr create --title "Add Cloud-backed scheduled task tool" --body "Closes #558. Adds scheduled task tool persistence, Cloud APIs, due-run worker, and a minimal Desktop client/panel for managing scheduled tool runs."
```

---

## Self-Review

- **Spec coverage:** Tool framing, Cloud-backed default, local-required waiting state, create/list/pause/resume/delete/run-now, OpenClaw-inspired durable jobs/run logs, and minimal management UI are all covered.
- **Placeholder scan:** The plan intentionally leaves follow-up implementation of actual local Mac run execution out of scope and explicitly preserves the `waiting_for_desktop` contract. No task uses TBD/TODO placeholders for in-scope implementation.
- **Type consistency:** The persisted runtime values are `cloud` and `local_required`; the Desktop create input uses `localRequired` because Rust serde `camelCase` maps to `LocalRequired`; response rendering expects `local_required` from persisted responses.
