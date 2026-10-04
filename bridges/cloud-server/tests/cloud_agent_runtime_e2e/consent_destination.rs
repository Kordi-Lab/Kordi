//! A run answers in its chat as the agent's owner. When the owner and the
//! other person in a direct chat stop being contacts, the owner's own runs
//! there, scheduled tasks among them, end as cancelled instead of failing to
//! deliver and running again after every lease expiry.
use super::*;
use kordi_cloud_server::scheduled_tasks::models::{
    CreateScheduledTaskRequest, ScheduledTaskTargetRuntime,
};
use kordi_cloud_server::scheduled_tasks::schedule::ScheduledTaskSchedule;
use kordi_cloud_server::scheduled_tasks::store::{
    create_scheduled_task, create_scheduled_task_run_now,
};

const RUNNER: &str = "destination-runner";
const RUNNER_TOKEN: &str = "runner-test-token";

async fn runner_call(router: &axum::Router, run_id: &str, token: &str, action: &str) -> Value {
    let body = if action == "complete" {
        json!({"runnerId": RUNNER, "responseText": "DESTINATION_ANSWER"})
    } else {
        json!({"runnerId": RUNNER, "errorCode": "model_provider_error", "message": "failed"})
    };
    let response = router
        .clone()
        .oneshot(post_json_with_run_token(
            &format!("/v1/cloud/agent-runs/{run_id}/{action}"),
            RUNNER_TOKEN,
            token,
            body,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK, "{action} {run_id}");
    read_json(response).await
}

async fn run_state(pool: &sqlx_postgres::PgPool, run_id: &str) -> (String, Option<String>) {
    sqlx_core::query_as::query_as(
        "SELECT status, error_code FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

fn revoked() -> (String, Option<String>) {
    (
        "cancelled".to_string(),
        Some("relationship_revoked".to_string()),
    )
}

async fn owner_messages(pool: &sqlx_postgres::PgPool, owner: &TestAccount) -> i64 {
    sqlx_core::query_as::query_as::<_, (i64,)>(
        "SELECT count(*) FROM cloud_chat_messages WHERE sender_account_id = $1",
    )
    .bind(&owner.account_id)
    .fetch_one(pool)
    .await
    .unwrap()
    .0
}

#[tokio::test]
async fn owner_runs_in_a_direct_chat_end_when_the_contact_ends() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", RUNNER_TOKEN);
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "destination-owner", "Owner").await;
    let peer = signup(&router, "destination-peer", "Peer").await;
    accept_contacts(&router, &peer, &owner).await;
    let mut ids = [owner.account_id.clone(), peer.account_id.clone()];
    ids.sort();
    let session = format!("session:direct-person:{}:{}", ids[0], ids[1]);
    let delivered_before = owner_messages(&pool, &owner).await;
    let set_contacts = |on: bool| {
        let pool = pool.clone();
        let (owner, peer) = (owner.account_id.clone(), peer.account_id.clone());
        async move {
            let sql = if on {
                "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) \
                 VALUES ($1, $2, now()::text), ($2, $1, now()::text)"
            } else {
                "DELETE FROM cloud_contacts WHERE (account_id = $1 AND peer_account_id = $2) \
                 OR (account_id = $2 AND peer_account_id = $1)"
            };
            sqlx_core::query::query(sql)
                .bind(owner)
                .bind(peer)
                .execute(&pool)
                .await
                .unwrap();
        }
    };

    // The owner removes the peer while three of the owner's runs are leased.
    let mut runs = Vec::new();
    for _ in 0..3 {
        let run = insert_leased_scheduled_run(&pool, &owner, &owner, &session, RUNNER).await;
        let token = issue_test_run_token(&pool, &run).await;
        runs.push((run, token));
    }
    set_contacts(false).await;
    for ((run, token), action) in runs.iter().zip(["complete", "fail"]) {
        let finished = runner_call(&router, run, token, action).await;
        assert_eq!(finished["run"]["status"], "cancelled", "{action}");
        assert!(finished["run"]["responseMessageId"].is_null());
        assert_eq!(run_state(&pool, run).await, revoked());
    }
    // A run whose lease expired is not handed out again with its prompt.
    let (expired, _) = &runs[2];
    sqlx_core::query::query(
        "UPDATE cloud_agent_fallback_runs SET lease_expires_at = (now() - interval '1 minute')::text \
         WHERE run_id = $1",
    )
    .bind(expired)
    .execute(&pool)
    .await
    .unwrap();
    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            RUNNER_TOKEN,
            json!({"runnerId": RUNNER, "canaryRunId": expired}),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    let lease = read_json(lease).await;
    assert_eq!(lease["run"]["status"], "cancelled");
    assert_eq!(lease["run"]["prompt"], "");
    assert_eq!(run_state(&pool, expired).await, revoked());

    // A scheduled task that answers in that chat is refused when it is due.
    let task = create_scheduled_task(
        &pool,
        &owner.account_id,
        &owner.account_id,
        CreateScheduledTaskRequest {
            title: "Weekly plan".to_string(),
            prompt: "Plan our week".to_string(),
            schedule: ScheduledTaskSchedule::Once {
                at: "2030-01-01T09:00:00Z".to_string(),
            },
            target_runtime: ScheduledTaskTargetRuntime::Cloud,
            tool_payload: json!({ "sessionId": session }),
        },
        chrono::Utc::now(),
    )
    .await
    .unwrap();
    let refused =
        create_scheduled_task_run_now(&pool, &owner.account_id, &task.task_id, chrono::Utc::now())
            .await
            .unwrap()
            .expect("a run record");
    assert_eq!(refused.status, "failed");
    assert_eq!(refused.error_code.as_deref(), Some("relationship_required"));
    let (queued,): (i64,) = sqlx_core::query_as::query_as(
        "SELECT count(*) FROM cloud_agent_fallback_runs WHERE request_message_id = $1",
    )
    .bind(&refused.run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(queued, 0);

    // A block ends delivery the same way, even with both contact rows present.
    set_contacts(true).await;
    sqlx_core::query::query(
        "INSERT INTO cloud_account_blocks (blocker_account_id, blocked_account_id) VALUES ($1, $2)",
    )
    .bind(&peer.account_id)
    .bind(&owner.account_id)
    .execute(&pool)
    .await
    .unwrap();
    let run = insert_leased_scheduled_run(&pool, &owner, &owner, &session, RUNNER).await;
    let token = issue_test_run_token(&pool, &run).await;
    let finished = runner_call(&router, &run, &token, "complete").await;
    assert_eq!(finished["run"]["status"], "cancelled");
    assert_eq!(run_state(&pool, &run).await, revoked());
    assert_eq!(owner_messages(&pool, &owner).await, delivered_before);
}
