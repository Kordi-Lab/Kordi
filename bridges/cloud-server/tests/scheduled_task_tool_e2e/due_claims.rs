//! Schedulers on several server instances can sweep due tasks at the same
//! time. Each due occurrence starts exactly one run.

use super::*;

/// A due sweep claims every due task, not only the calling test's task, so
/// tests that sweep take turns.
pub(super) static SWEEP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn concurrent_due_claims_start_each_occurrence_once() {
    let Some(pool) = try_pool().await else { return };
    let _sweep = SWEEP.lock().await;
    let account_id = format!("acct_owner_{}", uuid::Uuid::new_v4().simple());
    seed_account(&pool, &account_id).await;
    let task = create_scheduled_task(
        &pool,
        &account_id,
        &account_id,
        CreateScheduledTaskRequest {
            title: "Concurrent check".to_string(),
            prompt: "Check the status once.".to_string(),
            schedule: ScheduledTaskSchedule::Once {
                at: "2026-06-07T09:00:00Z".to_string(),
            },
            target_runtime: ScheduledTaskTargetRuntime::Cloud,
            tool_payload: serde_json::json!({
                "sessionId": format!("session:scheduled:concurrent-{account_id}")
            }),
        },
        Utc.with_ymd_and_hms(2026, 6, 7, 8, 0, 0).unwrap(),
    )
    .await
    .expect("cloud task");

    let now = Utc.with_ymd_and_hms(2026, 6, 7, 9, 1, 0).unwrap();
    let (first, second, third, fourth) = tokio::join!(
        claim_due_scheduled_task_runs(&pool, now, 500),
        claim_due_scheduled_task_runs(&pool, now, 500),
        claim_due_scheduled_task_runs(&pool, now, 500),
        claim_due_scheduled_task_runs(&pool, now, 500),
    );
    let mut started = Vec::new();
    for claimed in [first, second, third, fourth] {
        let claimed = claimed.expect("concurrent due claim");
        started.extend(
            claimed
                .into_iter()
                .filter(|run| run.task_id == task.task_id),
        );
    }
    assert_eq!(started.len(), 1, "exactly one scheduler starts the run");

    let (runs,): (i64,) =
        query_as("SELECT COUNT(*) FROM scheduled_tool_task_runs WHERE task_id = $1")
            .bind(&task.task_id)
            .fetch_one(&pool)
            .await
            .expect("count scheduled runs");
    assert_eq!(runs, 1);
    let (agent_runs,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_agent_fallback_runs WHERE idempotency_key = $1")
            .bind(format!("scheduled:{}", started[0].run_id))
            .fetch_one(&pool)
            .await
            .expect("count agent runs");
    assert_eq!(agent_runs, 1);
}

async fn create_once_cloud_task(
    pool: &PgPool,
    account_id: &str,
    session_id: &str,
    at: &str,
) -> kordi_cloud_server::scheduled_tasks::models::ScheduledTaskResponse {
    create_scheduled_task(
        pool,
        account_id,
        account_id,
        CreateScheduledTaskRequest {
            title: "Due check".to_string(),
            prompt: "Check the status once.".to_string(),
            schedule: ScheduledTaskSchedule::Once { at: at.to_string() },
            target_runtime: ScheduledTaskTargetRuntime::Cloud,
            tool_payload: serde_json::json!({ "sessionId": session_id }),
        },
        Utc.with_ymd_and_hms(2026, 6, 7, 8, 0, 0).unwrap(),
    )
    .await
    .expect("cloud task")
}

/// A conversation in a project on the owner's Mac cannot run in the cloud.
/// Its due run is recorded as failed and the task moves on, so a task due
/// after it, here from another account, still starts.
#[tokio::test]
async fn a_project_conversation_task_fails_without_blocking_later_due_tasks() {
    let Some(pool) = try_pool().await else { return };
    let _sweep = SWEEP.lock().await;
    let owner = format!("acct_owner_{}", uuid::Uuid::new_v4().simple());
    let other = format!("acct_other_{}", uuid::Uuid::new_v4().simple());
    seed_account(&pool, &owner).await;
    seed_account(&pool, &other).await;
    let device_id = format!("dev_{}", uuid::Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, device_platform, created_at, last_seen_at) \
         VALUES ($1, $2, 'Project Mac', $3, 'macos', '2026-06-07T08:00:00Z', '2026-06-07T08:00:00Z')",
    )
    .bind(&device_id)
    .bind(&owner)
    .bind(format!("legacy:{device_id}"))
    .execute(&pool)
    .await
    .expect("seed device");
    let project_session = format!("session:project:{owner}");
    query(
        "INSERT INTO cloud_project_devices (device_id, account_id, projects) VALUES ($1, $2, $3)",
    )
    .bind(&device_id)
    .bind(&owner)
    .bind(serde_json::json!([{ "sessions": [project_session] }]))
    .execute(&pool)
    .await
    .expect("seed project catalog");
    let project_task =
        create_once_cloud_task(&pool, &owner, &project_session, "2026-06-07T09:00:00Z").await;
    let later_task = create_once_cloud_task(
        &pool,
        &other,
        &format!("session:scheduled:{other}"),
        "2026-06-07T09:05:00Z",
    )
    .await;

    let now = Utc.with_ymd_and_hms(2026, 6, 7, 9, 10, 0).unwrap();
    let claimed = claim_due_scheduled_task_runs(&pool, now, 500)
        .await
        .expect("due sweep");
    let project_run = claimed
        .iter()
        .find(|run| run.task_id == project_task.task_id)
        .expect("project task run");
    assert_eq!(project_run.status, "failed");
    assert_eq!(
        project_run.error_code.as_deref(),
        Some("project_mac_required")
    );
    let later_run = claimed
        .iter()
        .find(|run| run.task_id == later_task.task_id)
        .expect("later task run");
    assert_eq!(later_run.status, "queued");

    let (next_run_at, last_run_status): (Option<String>, Option<String>) = query_as(
        "SELECT next_run_at, last_run_status FROM scheduled_tool_tasks WHERE task_id = $1",
    )
    .bind(&project_task.task_id)
    .fetch_one(&pool)
    .await
    .expect("project task row");
    assert_eq!(next_run_at, None, "the once task moved past its occurrence");
    assert_eq!(last_run_status.as_deref(), Some("failed"));
    let (project_agent_runs,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_agent_fallback_runs WHERE session_id = $1")
            .bind(&project_session)
            .fetch_one(&pool)
            .await
            .expect("count project agent runs");
    assert_eq!(project_agent_runs, 0, "no cloud run reads the project");

    let again = claim_due_scheduled_task_runs(&pool, now, 500)
        .await
        .expect("second sweep");
    assert!(again
        .iter()
        .all(|run| run.task_id != project_task.task_id && run.task_id != later_task.task_id));

    let manual = create_scheduled_task_run_now(
        &pool,
        &owner,
        &project_task.task_id,
        Utc.with_ymd_and_hms(2026, 6, 7, 9, 20, 0).unwrap(),
    )
    .await
    .expect("run now records the refusal")
    .expect("project task");
    assert_eq!(manual.status, "failed");
    assert_eq!(manual.error_code.as_deref(), Some("project_mac_required"));
}
