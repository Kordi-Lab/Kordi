//! How pool worker runs end: lease caps, deadlines, refused and repeated
//! completions, lapsed leases, disabled organizations and expiry. Ignored by
//! default; run them with a task-owned PostgreSQL in `DATABASE_URL`.

use std::sync::Arc;

use axum::http::StatusCode;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_scalar::query_scalar;
use uuid::Uuid;

use super::store::{self, MAX_LEASES};
use super::tests::{fixture, lease, pools, queued_run, run_call, status_of, team_chat, Fixture};
use crate::server::ServerState;
use crate::system_agent::pool_tests::{config_with, say, sweep};

fn failed(code: &str) -> (String, Option<String>) {
    ("failed".to_string(), Some(code.to_string()))
}

async fn lapse(f: &Fixture, run_id: &str) {
    query("UPDATE cloud_agent_fallback_runs SET lease_expires_at = $2 WHERE run_id = $1")
        .bind(run_id)
        .bind((chrono::Utc::now() - chrono::Duration::seconds(5)).to_rfc3339())
        .execute(&f.db)
        .await
        .unwrap();
}

async fn leased(f: &Fixture, worker: &str) -> (String, String) {
    let (status, body) = lease(f, &f.partner, &f.partner_signer, worker).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    (
        body["run"]["runId"].as_str().expect("a run").to_string(),
        body["run"]["leaseToken"].as_str().unwrap().to_string(),
    )
}

fn held(f: &Fixture, worker: &str, token: &str) -> Value {
    json!({"poolId": f.partner, "workerId": worker, "leaseToken": token})
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn a_run_is_leased_a_bounded_number_of_times() {
    let f = fixture().await;
    let chat = team_chat(&f).await;
    let run_id = queued_run(&f, chat).await;
    for _ in 0..MAX_LEASES {
        let (leased_id, _) = leased(&f, "worker-a").await;
        assert_eq!(leased_id, run_id);
        // The worker crashes; its lease lapses.
        lapse(&f, &run_id).await;
    }
    let (status, body) = lease(&f, &f.partner, &f.partner_signer, "worker-a").await;
    assert_eq!((status, body), (StatusCode::OK, json!({"run": null})));
    store::expire(&f.db, &f.registry.current()).await.unwrap();
    assert_eq!(status_of(&f.db, &run_id).await, failed("lease_limit"));
    // The conversation is free for the next pass.
    let active: Option<String> = query_scalar(
        "SELECT active_run_id FROM cloud_pip_conversation_state WHERE conversation_id = $1",
    )
    .bind(chat)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert!(active.is_none());
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn a_run_past_its_deadline_fails_even_with_a_live_lease() {
    let f = fixture().await;
    let chat = team_chat(&f).await;
    let run_id = queued_run(&f, chat).await;
    let (_, token) = leased(&f, "worker-a").await;
    query("UPDATE cloud_agent_fallback_runs SET created_at = $2 WHERE run_id = $1")
        .bind(&run_id)
        .bind((chrono::Utc::now() - chrono::Duration::minutes(45)).to_rfc3339())
        .execute(&f.db)
        .await
        .unwrap();
    store::expire(&f.db, &f.registry.current()).await.unwrap();
    assert_eq!(
        status_of(&f.db, &run_id).await,
        failed("pool_worker_deadline")
    );
    let (status, _) = run_call(&f, &run_id, "heartbeat", held(&f, "worker-a", &token)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn an_ignored_or_repeated_completion_is_not_reported_as_done() {
    let f = fixture().await;
    let chat = team_chat(&f).await;
    let run_id = queued_run(&f, chat).await;
    let (_, token) = leased(&f, "worker-a").await;
    // The conversation lets go of the run, so the System agent ignores the
    // reply.
    query(
        "UPDATE cloud_pip_conversation_state SET active_run_id = NULL WHERE conversation_id = $1",
    )
    .bind(chat)
    .execute(&f.db)
    .await
    .unwrap();
    let mut complete = held(&f, "worker-a", &token);
    complete["responseText"] = json!(r#"{"message":"Too late.","hooksHandled":[]}"#);
    let (status, body) = run_call(&f, &run_id, "complete", complete.clone()).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(
        status_of(&f.db, &run_id).await,
        failed("pool_worker_result_ignored")
    );
    // The token was spent: the same call again finds no lease.
    let (status, _) = run_call(&f, &run_id, "complete", complete).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A malformed reply leaves the lease, so the worker can still fail it.
    let chat = team_chat(&f).await;
    let run_id = queued_run(&f, chat).await;
    let (_, token) = leased(&f, "worker-a").await;
    let (status, _) = run_call(&f, &run_id, "complete", held(&f, "worker-a", &token)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let mut fail = held(&f, "worker-a", &token);
    fail["errorCode"] = json!("pool_worker_run_failed");
    assert_eq!(
        run_call(&f, &run_id, "fail", fail.clone()).await.0,
        StatusCode::OK
    );
    assert_eq!(
        run_call(&f, &run_id, "fail", fail).await.0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn a_lapsed_lease_taken_again_refuses_the_old_token() {
    let f = fixture().await;
    let chat = team_chat(&f).await;
    let run_id = queued_run(&f, chat).await;
    let (_, old_token) = leased(&f, "worker-a").await;
    lapse(&f, &run_id).await;
    // The same worker id leases it again and gets a new token.
    let (again, new_token) = leased(&f, "worker-a").await;
    assert_eq!(again, run_id);
    assert_ne!(old_token, new_token);
    let (status, _) = run_call(&f, &run_id, "heartbeat", held(&f, "worker-a", &old_token)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let mut complete = held(&f, "worker-a", &old_token);
    complete["responseText"] = json!(r#"{"message":"Stale.","hooksHandled":[]}"#);
    assert_eq!(
        run_call(&f, &run_id, "complete", complete).await.0,
        StatusCode::NOT_FOUND
    );
    let (status, _) = run_call(&f, &run_id, "heartbeat", held(&f, "worker-a", &new_token)).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn a_disabled_organization_gets_no_work() {
    let f = fixture().await;
    let signers = (&f.partner_signer, &f.other_signer);
    let ids = (f.shared.as_str(), f.partner.as_str(), f.other.as_str());
    let chat = team_chat(&f).await;
    let queued = queued_run(&f, chat).await;
    f.registry
        .replace(pools(ids, &f.team, signers, false).with_blocked([f.team.clone()]));
    // A queued run of the organization never reaches the worker.
    let (status, body) = lease(&f, &f.partner, &f.partner_signer, "worker-a").await;
    assert_eq!((status, body), (StatusCode::OK, json!({"run": null})));
    assert_eq!(
        status_of(&f.db, &queued).await,
        failed("organization_disabled")
    );
    // Nothing new is queued for it: the System agent stays silent.
    say(&f.db, &f.jordan, chat, "Lunch Monday?").await;
    let config = config_with(&f.system_agent, (*f.registry.current()).clone());
    assert_eq!(sweep(&f.db, &config).await, 0);
}

/// Queues `count` runs for `pool_id` directly, already overdue.
async fn overdue_runs(f: &Fixture, pool_id: &str, count: i32) -> String {
    let prefix = format!("pip_bulk_{}_", &Uuid::new_v4().simple().to_string()[..8]);
    let created = (chrono::Utc::now() - chrono::Duration::minutes(20)).to_rfc3339();
    query(
        "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id,
             session_id, owner_account_id, requester_account_id, status, prompt,
             created_at, updated_at)
         SELECT $1 || n, $1 || n, $1 || n, 'bulk-session', $2, $2, 'queued', '{}', $4, $4
         FROM generate_series(1, $3) AS n",
    )
    .bind(&prefix)
    .bind(&f.system_agent)
    .bind(count)
    .bind(&created)
    .execute(&f.db)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_pool_worker_runs (run_id, pool_id, feature)
         SELECT $1 || n, $2, 'system_agent' FROM generate_series(1, $3) AS n",
    )
    .bind(&prefix)
    .bind(pool_id)
    .bind(count)
    .execute(&f.db)
    .await
    .unwrap();
    prefix
}

async fn count_with(f: &Fixture, prefix: &str, status: &str) -> i64 {
    query_scalar(
        "SELECT count(*) FROM cloud_agent_fallback_runs WHERE starts_with(run_id, $1) AND status = $2",
    )
    .bind(prefix)
    .bind(status)
    .fetch_one(&f.db)
    .await
    .unwrap()
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn expiry_handles_more_than_one_batch_and_forgets_ended_runs() {
    let f = fixture().await;
    let prefix = overdue_runs(&f, &f.partner, 250).await;
    assert!(store::expire(&f.db, &f.registry.current()).await.unwrap() >= 250);
    assert_eq!(count_with(&f, &prefix, "failed").await, 250);
    let tags: i64 =
        query_scalar("SELECT count(*) FROM cloud_pool_worker_runs WHERE starts_with(run_id, $1)")
            .bind(&prefix)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(tags, 0, "tags of ended runs are deleted");
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn expiry_runs_without_the_system_agent_group_chat() {
    let f = fixture().await;
    let mut config = config_with(&f.system_agent, (*f.registry.current()).clone());
    config.group_chat_enabled = false;
    let state = Arc::new(
        ServerState::new(f.db.clone(), crate::events::EventBus::noop())
            .with_system_agent(crate::system_agent::SystemAgentService::new(config)),
    );
    let prefix = overdue_runs(&f, &f.partner, 3).await;
    // A pass that is not the once-a-minute one still expires runs while a
    // pool has a worker.
    super::maintain(&state, 1).await;
    assert_eq!(count_with(&f, &prefix, "failed").await, 3);
}
