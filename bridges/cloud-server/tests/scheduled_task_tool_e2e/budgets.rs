//! Scheduled task requests that start agent runs draw from the requester's
//! agent run budget.

use super::*;
use kordi_cloud_server::auth::rate_limit::{
    CloudRateLimitConfig, CloudRateLimiter, AGENT_RUN_CLAIM_LIMIT,
};
use kordi_cloud_server::server::router_with_rate_limiter;

#[tokio::test]
async fn scheduled_task_run_now_and_new_cloud_tasks_share_the_agent_run_budget() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(signup_email_fixture::state(pool.clone()));
    let setup = router(state.clone());
    let email = unique_email("scheduled-tool-budget");
    let signup_response = setup
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse").await,
        ))
        .await
        .unwrap();
    assert_eq!(signup_response.status(), StatusCode::CREATED);
    let signup_json = read_json(signup_response).await;
    let token = signup_json["session"]["token"]
        .as_str()
        .expect("session token")
        .to_string();
    let account_id = signup_json["account"]["accountId"]
        .as_str()
        .expect("account id")
        .to_string();
    let task_body = |target_runtime: &str| {
        serde_json::json!({
            "title": "Budgeted check",
            "prompt": "Summarize the project status.",
            "schedule": { "kind": "once", "at": "2099-01-01T00:00:00Z" },
            "targetRuntime": target_runtime,
            "toolPayload": { "sessionId": "session:scheduled:budget" }
        })
    };
    let created = setup
        .oneshot(post_json_with_token(
            "/v1/cloud/scheduled-tasks",
            &token,
            task_body("cloud"),
        ))
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    let task_id = read_json(created).await["task"]["taskId"]
        .as_str()
        .expect("task id")
        .to_string();

    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig::production());
    for _ in 1..AGENT_RUN_CLAIM_LIMIT.limit {
        limiter.observe_agent_run(&account_id).await;
    }
    let app = router_with_rate_limiter(state, limiter);
    let run_now_uri = format!("/v1/cloud/scheduled-tasks/{task_id}/run-now");

    let last_allowed = app
        .clone()
        .oneshot(post_json_with_token(
            &run_now_uri,
            &token,
            serde_json::json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(last_allowed.status(), StatusCode::OK);
    let run_id = read_json(last_allowed).await["run"]["runId"]
        .as_str()
        .expect("run id")
        .to_string();

    let limited = app
        .clone()
        .oneshot(post_json_with_token(
            &run_now_uri,
            &token,
            serde_json::json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(limited.headers().contains_key("retry-after"));
    assert_eq!(read_json(limited).await["errorCode"], "rate_limited");

    let refused_task = app
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/scheduled-tasks",
            &token,
            task_body("cloud"),
        ))
        .await
        .unwrap();
    assert_eq!(refused_task.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(refused_task.headers().contains_key("retry-after"));

    let local_task = app
        .oneshot(post_json_with_token(
            "/v1/cloud/scheduled-tasks",
            &token,
            task_body("localRequired"),
        ))
        .await
        .unwrap();
    assert_eq!(
        local_task.status(),
        StatusCode::OK,
        "a task that waits for the desktop queues no cloud run on creation"
    );

    let (task_runs,): (i64,) =
        query_as("SELECT COUNT(*) FROM scheduled_tool_task_runs WHERE task_id = $1")
            .bind(&task_id)
            .fetch_one(&pool)
            .await
            .expect("count task runs");
    assert_eq!(task_runs, 1, "a refused run-now must not record a run");
    let queued: Vec<(String,)> = query_as(
        "SELECT idempotency_key FROM cloud_agent_fallback_runs
          WHERE owner_account_id = $1 AND idempotency_key LIKE 'scheduled:%'",
    )
    .bind(&account_id)
    .fetch_all(&pool)
    .await
    .expect("queued cloud runs");
    assert_eq!(queued, vec![(format!("scheduled:{run_id}"),)]);
    let (cloud_tasks,): (i64,) = query_as(
        "SELECT COUNT(*) FROM scheduled_tool_tasks
          WHERE owner_account_id = $1 AND target_runtime = 'cloud'",
    )
    .bind(&account_id)
    .fetch_one(&pool)
    .await
    .expect("count cloud tasks");
    assert_eq!(cloud_tasks, 1, "a refused cloud task must not be stored");
}
