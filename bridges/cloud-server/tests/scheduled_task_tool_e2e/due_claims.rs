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
