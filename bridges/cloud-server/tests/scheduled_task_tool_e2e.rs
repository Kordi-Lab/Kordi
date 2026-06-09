//! Scheduled task tool tests. Store/API integration tests use DATABASE_URL when
//! available and skip on developer machines without Postgres, matching the
//! existing cloud-server e2e test pattern.

use std::sync::Arc;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use chrono::{TimeZone, Utc};
use kordi_cloud_server::events::EventBus;
use kordi_cloud_server::pg::init_pool;
use kordi_cloud_server::scheduled_tasks::models::{
    CreateScheduledTaskRequest, ScheduledTaskTargetRuntime,
};
use kordi_cloud_server::scheduled_tasks::schedule::ScheduledTaskSchedule;
use kordi_cloud_server::scheduled_tasks::store::{
    claim_due_scheduled_task_runs, create_scheduled_task, create_scheduled_task_run_now,
    list_scheduled_task_runs, list_scheduled_tasks, pause_scheduled_task, resume_scheduled_task,
    soft_delete_scheduled_task,
};
use kordi_cloud_server::server::{ServerState, router};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
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
            schedule: ScheduledTaskSchedule::Daily {
                time: "09:00".to_string(),
                timezone: Some("UTC".to_string()),
            },
            target_runtime: ScheduledTaskTargetRuntime::Cloud,
            tool_payload: serde_json::json!({ "tool": "agent.run" }),
        },
        Utc.with_ymd_and_hms(2026, 6, 8, 8, 0, 0).unwrap(),
    )
    .await
    .expect("create task");

    assert_eq!(task.title, "Daily standup prep");
    assert_eq!(task.status, "active");
    assert_eq!(
        task.next_run_at.as_deref(),
        Some("2026-06-08T09:00:00+00:00")
    );

    let listed = list_scheduled_tasks(&pool, &account_id)
        .await
        .expect("list tasks");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].task_id, task.task_id);

    let paused = pause_scheduled_task(&pool, &account_id, &task.task_id)
        .await
        .expect("pause")
        .expect("paused task");
    assert_eq!(paused.status, "paused");
    assert!(!paused.enabled);

    let resumed = resume_scheduled_task(
        &pool,
        &account_id,
        &task.task_id,
        Utc.with_ymd_and_hms(2026, 6, 8, 8, 30, 0).unwrap(),
    )
    .await
    .expect("resume")
    .expect("resumed task");
    assert_eq!(resumed.status, "active");
    assert!(resumed.enabled);
    assert_eq!(
        resumed.next_run_at.as_deref(),
        Some("2026-06-08T09:00:00+00:00")
    );

    let deleted = soft_delete_scheduled_task(&pool, &account_id, &task.task_id)
        .await
        .expect("delete");
    assert!(deleted);
    assert!(
        list_scheduled_tasks(&pool, &account_id)
            .await
            .expect("list after delete")
            .is_empty()
    );
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
    let token = signup_json["session"]["token"]
        .as_str()
        .expect("session token");

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
fn scheduled_task_store_enqueues_cloud_agent_fallback_runs_for_cloud_jobs() {
    let store_source = std::fs::read_to_string("src/scheduled_tasks/store.rs")
        .expect("read scheduled store source");
    assert!(store_source.contains("claim_run("));
    assert!(store_source.contains("ClaimRunRequest"));
    assert!(store_source.contains("scheduled:"));
    assert!(store_source.contains("sessionId"));
}

#[test]
fn cloud_agent_scheduled_responses_are_written_to_cloud_sync_events() {
    let runs_source = std::fs::read_to_string("src/cloud_agent_runtime/runs.rs")
        .expect("read cloud agent runs source");
    assert!(runs_source.contains("INSERT INTO cloud_sync_events"));
    assert!(runs_source.contains("message.upsert"));
    assert!(runs_source.contains("\"messageId\""));
    assert!(runs_source.contains("\"sessionId\""));
}

#[test]
fn cloud_agent_completion_updates_scheduled_task_run_status() {
    let runs_source = std::fs::read_to_string("src/cloud_agent_runtime/runs.rs")
        .expect("read cloud agent runs source");
    assert!(runs_source.contains("mark_scheduled_task_run_completed"));
    assert!(runs_source.contains("mark_scheduled_task_run_failed"));
}

#[test]
fn scheduled_task_run_now_enqueues_cloud_agent_fallback_runs_for_cloud_jobs() {
    let store_source = std::fs::read_to_string("src/scheduled_tasks/store.rs")
        .expect("read scheduled store source");
    let run_now_start = store_source
        .find("pub async fn create_scheduled_task_run_now")
        .expect("run now function");
    let create_run_start = store_source
        .find("async fn create_run_for_task")
        .expect("create run function");
    let run_now_source = &store_source[run_now_start..create_run_start];
    assert!(run_now_source.contains("enqueue_cloud_agent_fallback_run_for_scheduled_run"));
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
fn scheduled_task_run_history_store_and_route_are_available() {
    let store_source = std::fs::read_to_string("src/scheduled_tasks/store.rs").expect("read store");
    let routes_source =
        std::fs::read_to_string("src/scheduled_tasks/routes.rs").expect("read routes");
    assert!(store_source.contains("pub async fn list_scheduled_task_runs"));
    assert!(routes_source.contains("/v1/cloud/scheduled-tasks/:task_id/runs"));
}

#[test]
fn scheduled_task_routes_are_registered_under_cloud_api() {
    let source = std::fs::read_to_string("src/scheduled_tasks/routes.rs").expect("read routes");
    assert!(source.contains("/v1/cloud/scheduled-tasks"));
    assert!(source.contains("/v1/cloud/scheduled-tasks/:task_id/pause"));
    assert!(source.contains("/v1/cloud/scheduled-tasks/:task_id/resume"));
    assert!(source.contains("/v1/cloud/scheduled-tasks/:task_id/run-now"));
    assert!(source.contains("/v1/cloud/scheduled-tasks/:task_id/runs"));
    assert!(source.contains("/v1/cloud/scheduled-task-runs/claim"));
}

#[tokio::test]
async fn scheduled_task_run_history_lists_latest_runs_for_owned_task() {
    let Some(pool) = try_pool().await else { return };
    let account_id = format!("acct_owner_{}", uuid::Uuid::new_v4().simple());
    seed_account(&pool, &account_id).await;
    let task = create_scheduled_task(
        &pool,
        &account_id,
        &account_id,
        CreateScheduledTaskRequest {
            title: "Search latest OpenAI news".to_string(),
            prompt: "Search the web for the latest OpenAI news.".to_string(),
            schedule: ScheduledTaskSchedule::Once {
                at: "2026-06-09T20:16:00+08:00".to_string(),
            },
            target_runtime: ScheduledTaskTargetRuntime::Cloud,
            tool_payload: serde_json::json!({ "sessionId": "session:scheduled:history" }),
        },
        Utc.with_ymd_and_hms(2026, 6, 9, 12, 15, 0).unwrap(),
    )
    .await
    .expect("task");
    let run = create_scheduled_task_run_now(
        &pool,
        &account_id,
        &task.task_id,
        Utc.with_ymd_and_hms(2026, 6, 9, 12, 16, 0).unwrap(),
    )
    .await
    .expect("run now")
    .expect("run");

    let runs = list_scheduled_task_runs(&pool, &account_id, &task.task_id, 5)
        .await
        .expect("list runs");

    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].run_id, run.run_id);
    assert_eq!(runs[0].task_id, task.task_id);
}

#[tokio::test]
async fn run_now_and_due_claim_separate_cloud_and_local_required_runs() {
    let Some(pool) = try_pool().await else { return };
    let account_id = format!("acct_owner_{}", uuid::Uuid::new_v4().simple());
    seed_account(&pool, &account_id).await;
    let cloud = create_scheduled_task(
        &pool,
        &account_id,
        &account_id,
        CreateScheduledTaskRequest {
            title: "Cloud check".to_string(),
            prompt: "Check cloud status.".to_string(),
            schedule: ScheduledTaskSchedule::Once {
                at: "2026-06-08T09:00:00Z".to_string(),
            },
            target_runtime: ScheduledTaskTargetRuntime::Cloud,
            tool_payload: serde_json::json!({ "sessionId": "session:scheduled:cloud-check" }),
        },
        Utc.with_ymd_and_hms(2026, 6, 8, 8, 0, 0).unwrap(),
    )
    .await
    .expect("cloud task");
    let local = create_scheduled_task(
        &pool,
        &account_id,
        &account_id,
        CreateScheduledTaskRequest {
            title: "Mac check".to_string(),
            prompt: "Read a local file when my Mac is online.".to_string(),
            schedule: ScheduledTaskSchedule::Once {
                at: "2026-06-08T09:00:00Z".to_string(),
            },
            target_runtime: ScheduledTaskTargetRuntime::LocalRequired,
            tool_payload: serde_json::json!({ "requiresLocalMac": true }),
        },
        Utc.with_ymd_and_hms(2026, 6, 8, 8, 0, 0).unwrap(),
    )
    .await
    .expect("local task");

    let manual_local = create_scheduled_task_run_now(
        &pool,
        &account_id,
        &local.task_id,
        Utc.with_ymd_and_hms(2026, 6, 8, 8, 5, 0).unwrap(),
    )
    .await
    .expect("run now")
    .expect("local run");
    assert_eq!(manual_local.status, "waiting_for_desktop");

    let claimed = claim_due_scheduled_task_runs(
        &pool,
        Utc.with_ymd_and_hms(2026, 6, 8, 9, 1, 0).unwrap(),
        10,
    )
    .await
    .expect("claim due");
    let cloud_run = claimed
        .iter()
        .find(|run| run.task_id == cloud.task_id)
        .expect("cloud run");
    assert_eq!(cloud_run.status, "queued");
    assert!(
        claimed
            .iter()
            .any(|run| run.task_id == local.task_id && run.status == "waiting_for_desktop")
    );

    let fallback: (String, String, String, String, String) = query_as(
        "SELECT idempotency_key, request_message_id, session_id, status, prompt FROM cloud_agent_fallback_runs WHERE idempotency_key = $1",
    )
    .bind(format!("scheduled:{}", cloud_run.run_id))
    .fetch_one(&pool)
    .await
    .expect("scheduled cloud run should enqueue fallback agent run");
    assert_eq!(fallback.1, cloud_run.run_id);
    assert_eq!(fallback.2, "session:scheduled:cloud-check");
    assert_eq!(fallback.3, "queued");
    assert_eq!(fallback.4, "Check cloud status.");
}
