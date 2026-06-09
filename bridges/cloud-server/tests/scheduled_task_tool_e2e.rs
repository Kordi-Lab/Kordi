//! Scheduled task tool tests. Store/API integration tests use DATABASE_URL when
//! available and skip on developer machines without Postgres, matching the
//! existing cloud-server e2e test pattern.

use chrono::{TimeZone, Utc};
use kordi_cloud_server::pg::init_pool;
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

async fn try_pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    match init_pool(&url).await {
        Ok(pool) => Some(pool),
        Err(err) => {
            eprintln!("[scheduled_task_tool_e2e] init_pool failed, skipping: {err}");
            None
        }
    }
}

async fn seed_account(pool: &PgPool, account_id: &str) {
    query(
        "INSERT INTO cloud_accounts(account_id, primary_email, password_hash, display_name, avatar_url, created_at, updated_at)
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

#[tokio::test]
async fn scheduled_task_store_creates_lists_pauses_resumes_and_deletes() {
    let Some(pool) = try_pool().await else { return };
    let account_id = format!("acct_owner_{}", uuid::Uuid::new_v4().simple());
    seed_account(&pool, &account_id).await;
    let task = create_scheduled_task(
        &pool,
        &account_id,
        &account_id,
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

    let listed = list_scheduled_tasks(&pool, &account_id).await.expect("list tasks");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].task_id, task.task_id);

    let paused = pause_scheduled_task(&pool, &account_id, &task.task_id).await.expect("pause").expect("paused task");
    assert_eq!(paused.status, "paused");
    assert!(!paused.enabled);

    let resumed = resume_scheduled_task(&pool, &account_id, &task.task_id, Utc.with_ymd_and_hms(2026, 6, 8, 8, 30, 0).unwrap()).await.expect("resume").expect("resumed task");
    assert_eq!(resumed.status, "active");
    assert!(resumed.enabled);
    assert_eq!(resumed.next_run_at.as_deref(), Some("2026-06-08T09:00:00+00:00"));

    let deleted = soft_delete_scheduled_task(&pool, &account_id, &task.task_id).await.expect("delete");
    assert!(deleted);
    assert!(list_scheduled_tasks(&pool, &account_id).await.expect("list after delete").is_empty());
}

#[tokio::test]
async fn run_now_and_due_claim_separate_cloud_and_local_required_runs() {
    let Some(pool) = try_pool().await else { return };
    let account_id = format!("acct_owner_{}", uuid::Uuid::new_v4().simple());
    seed_account(&pool, &account_id).await;
    let cloud = create_scheduled_task(&pool, &account_id, &account_id, CreateScheduledTaskRequest {
        title: "Cloud check".to_string(),
        prompt: "Check cloud status.".to_string(),
        schedule: ScheduledTaskSchedule::Once { at: "2026-06-08T09:00:00Z".to_string() },
        target_runtime: ScheduledTaskTargetRuntime::Cloud,
        tool_payload: serde_json::json!({}),
    }, Utc.with_ymd_and_hms(2026, 6, 8, 8, 0, 0).unwrap()).await.expect("cloud task");
    let local = create_scheduled_task(&pool, &account_id, &account_id, CreateScheduledTaskRequest {
        title: "Mac check".to_string(),
        prompt: "Read a local file when my Mac is online.".to_string(),
        schedule: ScheduledTaskSchedule::Once { at: "2026-06-08T09:00:00Z".to_string() },
        target_runtime: ScheduledTaskTargetRuntime::LocalRequired,
        tool_payload: serde_json::json!({ "requiresLocalMac": true }),
    }, Utc.with_ymd_and_hms(2026, 6, 8, 8, 0, 0).unwrap()).await.expect("local task");

    let manual_local = create_scheduled_task_run_now(&pool, &account_id, &local.task_id, Utc.with_ymd_and_hms(2026, 6, 8, 8, 5, 0).unwrap()).await.expect("run now").expect("local run");
    assert_eq!(manual_local.status, "waiting_for_desktop");

    let claimed = claim_due_scheduled_task_runs(&pool, Utc.with_ymd_and_hms(2026, 6, 8, 9, 1, 0).unwrap(), 10).await.expect("claim due");
    assert!(claimed.iter().any(|run| run.task_id == cloud.task_id && run.status == "queued"));
    assert!(claimed.iter().any(|run| run.task_id == local.task_id && run.status == "waiting_for_desktop"));
}
