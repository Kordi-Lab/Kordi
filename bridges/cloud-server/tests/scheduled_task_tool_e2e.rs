//! Scheduled task tool tests. Store/API integration tests use DATABASE_URL when
//! available and skip on developer machines without Postgres, matching the
//! existing cloud-server e2e test pattern.

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use chrono::{TimeZone, Utc};
use kordi_cloud_server::events::EventBus;
use kordi_cloud_server::pg::init_pool;
use kordi_cloud_server::server::{router, ServerState};
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
use tower::util::ServiceExt;

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

fn unique_email(prefix: &str) -> String {
    format!("{prefix}-{}@e2e.local", uuid::Uuid::new_v4().simple())
}

fn signup_body(email: &str, password: &str) -> Body {
    Body::from(
        serde_json::json!({
            "email": email,
            "password": password,
            "displayName": "Scheduled Tool E2E",
            "avatarUrl": "data:image/png;base64,iVBORw0KGgo=",
        })
        .to_string(),
    )
}

fn post(uri: &str, body: Body) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(body)
        .unwrap()
}

fn post_json_with_token(uri: &str, token: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

async fn read_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    if bytes.is_empty() {
        return serde_json::Value::Null;
    }
    serde_json::from_slice(&bytes).unwrap()
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
async fn scheduled_task_tool_api_creates_local_required_task_and_run_now_waits_for_desktop() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("scheduled-tool-create");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let app = router(state);

    let signup_response = app
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    assert_eq!(signup_response.status(), StatusCode::OK);
    let signup_json = read_json(signup_response).await;
    let token = signup_json["session"]["token"].as_str().expect("session token");

    let create_response = app
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/scheduled-tasks",
            token,
            serde_json::json!({
                "title": "Morning local check",
                "prompt": "Check my Downloads folder every morning when my Mac is online.",
                "schedule": { "kind": "daily", "time": "09:00", "timezone": "UTC" },
                "targetRuntime": "localRequired",
                "toolPayload": { "tool": "agent.run", "requiresLocalMac": true }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(create_response.status(), StatusCode::OK);
    let create_json = read_json(create_response).await;
    assert_eq!(create_json["task"]["title"], "Morning local check");
    assert_eq!(create_json["task"]["targetRuntime"], "local_required");
    let task_id = create_json["task"]["taskId"].as_str().expect("task id");

    let run_response = app
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/scheduled-tasks/{task_id}/run-now"),
            token,
            serde_json::json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(run_response.status(), StatusCode::OK);
    let run_json = read_json(run_response).await;
    assert_eq!(run_json["run"]["taskId"], task_id);
    assert_eq!(run_json["run"]["status"], "waiting_for_desktop");
}

#[test]
fn scheduled_task_schema_migration_is_embedded_in_pool_runner() {
    let pool_source = std::fs::read_to_string("src/pg/pool.rs").expect("read pool source");
    assert!(pool_source.contains("version: 22"));
    assert!(pool_source.contains("0022_scheduled_task_tool.sql"));
    assert!(pool_source.contains("scheduled task tool"));
}

#[test]
fn scheduled_task_worker_claims_due_jobs_on_interval() {
    let worker = std::fs::read_to_string("src/scheduled_tasks/worker.rs").expect("read worker");
    assert!(worker.contains("scheduled_task_sweep_interval"));
    assert!(worker.contains("claim_due_scheduled_task_runs"));
    assert!(worker.contains("waiting_for_desktop"));

    let server = std::fs::read_to_string("src/server.rs").expect("read server");
    assert!(server.contains("scheduled_tasks::worker::spawn_scheduled_task_worker"));
}

#[test]
fn scheduled_task_routes_are_registered_under_cloud_api() {
    let source = std::fs::read_to_string("src/scheduled_tasks/routes.rs").expect("read routes");
    assert!(source.contains("/v1/cloud/scheduled-tasks"));
    assert!(source.contains("/v1/cloud/scheduled-tasks/:task_id/pause"));
    assert!(source.contains("/v1/cloud/scheduled-tasks/:task_id/resume"));
    assert!(source.contains("/v1/cloud/scheduled-tasks/:task_id/run-now"));
    assert!(source.contains("/v1/cloud/scheduled-task-runs/claim"));
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
