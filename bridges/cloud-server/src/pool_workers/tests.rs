//! Pool workers against a real database. Ignored by default; run them with a
//! task-owned PostgreSQL in `DATABASE_URL`.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::query_scalar::query_scalar;
use sqlx_postgres::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use super::test_signer::TestSigner;
use crate::cloud_agent_runtime::runs::lease_canary_run;
use crate::plan_cards::tests::seed_account;
use crate::resource_pools::usage::tests::test_db;
use crate::resource_pools::{test_provider, ResourcePool, ResourcePoolRegistry, ResourcePools};
use crate::server::ServerState;
use crate::system_agent::pool_tests::{config_with, group_chat, say, sweep, team};

pub(super) struct Fixture {
    pub(super) db: PgPool,
    pub(super) app: Router,
    pub(super) registry: ResourcePoolRegistry,
    pub(super) system_agent: String,
    pub(super) jordan: String,
    pub(super) team: String,
    pub(super) shared: String,
    pub(super) partner: String,
    pub(super) other: String,
    pub(super) partner_signer: TestSigner,
    pub(super) other_signer: TestSigner,
}

pub(super) fn pools(
    fixture_ids: (&str, &str, &str),
    team: &str,
    signers: (&TestSigner, &TestSigner),
    stop: bool,
) -> ResourcePools {
    let (shared, partner, other) = fixture_ids;
    ResourcePools::new(
        vec![
            ResourcePool::new(shared, test_provider("shared-model")),
            ResourcePool::pool_worker(partner, Some(signers.0.identity()), 0).stopped(stop),
            ResourcePool::pool_worker(other, Some(signers.1.identity()), 0),
        ],
        shared,
        [(team.to_string(), partner.to_string())],
    )
    .unwrap()
}

pub(super) async fn fixture() -> Fixture {
    let db = test_db().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let (system_agent, jordan) = (format!("system-agent-{suffix}"), format!("jordan-{suffix}"));
    for account in [&system_agent, &jordan] {
        seed_account(&db, account).await;
    }
    let team = team(&db, &jordan).await;
    let (shared, partner, other) = (
        format!("shared-{suffix}"),
        format!("partner-{suffix}"),
        format!("other-{suffix}"),
    );
    let (partner_signer, other_signer) =
        (TestSigner::new("partner-key"), TestSigner::new("other-key"));
    let config = config_with(
        &system_agent,
        pools(
            (&shared, &partner, &other),
            &team,
            (&partner_signer, &other_signer),
            false,
        ),
    );
    let registry = config.resource_pool_registry().clone();
    let state = Arc::new(
        ServerState::new(db.clone(), crate::events::EventBus::noop())
            .with_system_agent(crate::system_agent::SystemAgentService::new(config)),
    );
    Fixture {
        db,
        app: super::routes(state),
        registry,
        system_agent,
        jordan,
        team,
        shared,
        partner,
        other,
        partner_signer,
        other_signer,
    }
}

pub(super) async fn call(
    app: &Router,
    path: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = http_body_util::BodyExt::collect(response.into_body())
        .await
        .unwrap()
        .to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

pub(super) async fn lease(
    f: &Fixture,
    pool: &str,
    signer: &TestSigner,
    worker: &str,
) -> (StatusCode, Value) {
    call(
        &f.app,
        "/v1/cloud/pool-workers/lease",
        Some(&signer.token()),
        json!({"poolId": pool, "workerId": worker}),
    )
    .await
}

pub(super) async fn run_call(
    f: &Fixture,
    run_id: &str,
    action: &str,
    body: Value,
) -> (StatusCode, Value) {
    call(
        &f.app,
        &format!("/v1/cloud/pool-workers/runs/{run_id}/{action}"),
        Some(&f.partner_signer.token()),
        body,
    )
    .await
}

/// The one System agent run queued for `chat`.
pub(super) async fn queued_run(f: &Fixture, chat: Uuid) -> String {
    say(&f.db, &f.jordan, chat, "Dinner Friday at 7?").await;
    assert_eq!(
        sweep(
            &f.db,
            &config_with(&f.system_agent, (*f.registry.current()).clone())
        )
        .await,
        1
    );
    query_scalar(
        "SELECT run.run_id FROM cloud_agent_fallback_runs run
         JOIN cloud_chat_conversations c ON c.legacy_session_id = run.session_id
         WHERE c.conversation_id = $1 AND run.status = 'queued'",
    )
    .bind(chat)
    .fetch_one(&f.db)
    .await
    .unwrap()
}

pub(super) async fn team_chat(f: &Fixture) -> Uuid {
    let chat = group_chat(&f.db, &f.jordan, &f.system_agent).await;
    query("UPDATE cloud_chat_conversations SET organization_id = $2 WHERE conversation_id = $1")
        .bind(chat)
        .bind(&f.team)
        .execute(&f.db)
        .await
        .unwrap();
    chat
}

pub(super) async fn status_of(db: &PgPool, run_id: &str) -> (String, Option<String>) {
    query_as("SELECT status, error_code FROM cloud_agent_fallback_runs WHERE run_id = $1")
        .bind(run_id)
        .fetch_one(db)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn a_worker_pool_run_waits_for_its_own_worker_and_its_reply_is_applied() {
    let f = fixture().await;
    // A personal chat uses the control plane pool as before: untagged, and
    // the control plane runner may lease it.
    let personal_chat = group_chat(&f.db, &f.jordan, &f.system_agent).await;
    let personal_run = queued_run(&f, personal_chat).await;
    let tagged: Option<String> =
        query_scalar("SELECT pool_id FROM cloud_pool_worker_runs WHERE run_id = $1")
            .bind(&personal_run)
            .fetch_optional(&f.db)
            .await
            .unwrap();
    assert!(tagged.is_none());
    assert!(lease_canary_run(&f.db, "control-runner", &personal_run)
        .await
        .unwrap()
        .is_some());

    // The team chat's run is tagged for the team's worker pool and the
    // control plane runner never leases it.
    let chat = team_chat(&f).await;
    let run_id = queued_run(&f, chat).await;
    let (pool_id, feature): (String, String) =
        query_as("SELECT pool_id, feature FROM cloud_pool_worker_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(
        (pool_id.as_str(), feature.as_str()),
        (f.partner.as_str(), "system_agent")
    );
    let route: Value =
        query_scalar("SELECT runtime_route_json FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(
        route,
        json!({"resourcePool": f.partner, "poolExecutor": "pool_worker"})
    );
    assert!(lease_canary_run(&f.db, "control-runner", &run_id)
        .await
        .unwrap()
        .is_none());

    // Another pool's worker finds nothing; a token from another identity, no
    // token, and a control plane pool are refused.
    let (status, body) = lease(&f, &f.other, &f.other_signer, "worker-b").await;
    assert_eq!((status, body), (StatusCode::OK, json!({"run": null})));
    let (status, _) = lease(&f, &f.partner, &f.other_signer, "worker-b").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(
        &f.app,
        "/v1/cloud/pool-workers/lease",
        None,
        json!({"poolId": f.partner, "workerId": "w"}),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = lease(&f, &f.shared, &f.partner_signer, "worker-a").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "pools cannot be probed");

    // The pool's own worker leases it and gets only the model input.
    let (status, body) = lease(&f, &f.partner, &f.partner_signer, "worker-a").await;
    assert_eq!(status, StatusCode::OK);
    let run = &body["run"];
    assert_eq!(run["runId"], json!(run_id));
    assert_eq!(run["feature"], "system_agent");
    assert!(run["prompt"].as_str().unwrap().contains("Dinner Friday"));
    assert!(!run["systemPrompt"].as_str().unwrap().is_empty());
    let token = run["leaseToken"].as_str().unwrap().to_string();
    assert_eq!(token.len(), 64);
    for field in ["ownerAccountId", "sessionId", "apiKey", "organizationId"] {
        assert!(
            run.get(field).is_none(),
            "{field} must not reach the worker"
        );
    }
    let stored: String =
        query_scalar("SELECT lease_token_hash FROM cloud_pool_worker_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_ne!(stored, token, "only a hash of the lease token is stored");

    // Calls need the lease token, the pool and the worker that leased it.
    let held = |token: &str, worker: &str| json!({"poolId": f.partner, "workerId": worker, "leaseToken": token});
    let wrong = "0".repeat(64);
    assert_eq!(
        run_call(&f, &run_id, "heartbeat", held(&wrong, "worker-a"))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        run_call(&f, &run_id, "heartbeat", held(&token, "worker-z"))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let (status, _) = call(
        &f.app,
        &format!("/v1/cloud/pool-workers/runs/{run_id}/complete"),
        Some(&f.other_signer.token()),
        json!({"poolId": f.other, "workerId": "worker-a", "leaseToken": token, "responseText": "{}"}),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "another pool cannot complete this run"
    );
    let (status, body) = run_call(&f, &run_id, "heartbeat", held(&token, "worker-a")).await;
    assert_eq!(
        (status, body),
        (StatusCode::OK, json!({"cancelRequested": false}))
    );

    // The reply is validated and written into the conversation.
    let mut complete = held(&token, "worker-a");
    complete["responseText"] =
        json!(r#"{"message":"Friday at 7 works for me.","hooksHandled":[]}"#);
    let (status, _) = run_call(&f, &run_id, "complete", complete.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(status_of(&f.db, &run_id).await.0, "completed");
    let posted: i64 = query_scalar(
        "SELECT count(*) FROM cloud_chat_messages WHERE conversation_id = $1 AND sender_account_id = $2",
    )
    .bind(chat)
    .bind(&f.system_agent)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(posted, 1);
    // The lease is spent: a replay is refused.
    assert_eq!(
        run_call(&f, &run_id, "complete", complete).await.0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn the_stop_switch_and_rebinding_end_worker_runs() {
    let f = fixture().await;
    let signers = (&f.partner_signer, &f.other_signer);
    let ids = (f.shared.as_str(), f.partner.as_str(), f.other.as_str());

    // Stopped by a reload: leases are refused and queued runs fail.
    let chat = team_chat(&f).await;
    let queued = queued_run(&f, chat).await;
    f.registry.replace(pools(ids, &f.team, signers, true));
    assert_eq!(
        lease(&f, &f.partner, &f.partner_signer, "worker-a").await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    super::store::expire(&f.db, &f.registry.current())
        .await
        .unwrap();
    assert_eq!(
        status_of(&f.db, &queued).await,
        ("failed".to_string(), Some("pool_stopped".to_string()))
    );

    // Started again, a held lease whose pool stops cannot complete.
    f.registry.replace(pools(ids, &f.team, signers, false));
    let chat = team_chat(&f).await;
    let held_run = queued_run(&f, chat).await;
    let (_, body) = lease(&f, &f.partner, &f.partner_signer, "worker-a").await;
    assert_eq!(body["run"]["runId"], json!(held_run));
    let token = body["run"]["leaseToken"].as_str().unwrap().to_string();
    f.registry.replace(pools(ids, &f.team, signers, true));
    let (status, _) = run_call(
        &f,
        &held_run,
        "complete",
        json!({"poolId": f.partner, "workerId": "worker-a", "leaseToken": token, "responseText": "{}"}),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        status_of(&f.db, &held_run).await,
        ("failed".to_string(), Some("pool_stopped".to_string()))
    );

    // A run whose organization is rebound to another pool never reaches the
    // old pool's worker.
    f.registry.replace(pools(ids, &f.team, signers, false));
    let chat = team_chat(&f).await;
    let rebound = queued_run(&f, chat).await;
    let moved = ResourcePools::new(
        vec![
            ResourcePool::new(ids.0, test_provider("shared-model")),
            ResourcePool::pool_worker(ids.1, Some(f.partner_signer.identity()), 0),
        ],
        ids.0,
        Vec::<(String, String)>::new(),
    )
    .unwrap();
    f.registry.replace(moved);
    let (status, body) = lease(&f, &f.partner, &f.partner_signer, "worker-a").await;
    assert_eq!((status, body), (StatusCode::OK, json!({"run": null})));
    assert_eq!(
        status_of(&f.db, &rebound).await,
        (
            "failed".to_string(),
            Some("pool_binding_changed".to_string())
        )
    );
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn worker_failures_and_unleased_runs_end_the_run() {
    let f = fixture().await;
    let chat = team_chat(&f).await;
    let run_id = queued_run(&f, chat).await;
    let (_, body) = lease(&f, &f.partner, &f.partner_signer, "worker-a").await;
    let token = body["run"]["leaseToken"].as_str().unwrap().to_string();
    let fail = |code: &str| json!({"poolId": f.partner, "workerId": "worker-a", "leaseToken": token, "errorCode": code});
    assert_eq!(
        run_call(&f, &run_id, "fail", fail("Not A Code")).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        run_call(&f, &run_id, "fail", fail("pool_worker_run_failed"))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        status_of(&f.db, &run_id).await,
        (
            "failed".to_string(),
            Some("pool_worker_run_failed".to_string())
        )
    );

    // A run no worker leases within the queue timeout fails.
    let chat = team_chat(&f).await;
    let waiting = queued_run(&f, chat).await;
    query("UPDATE cloud_agent_fallback_runs SET created_at = $2 WHERE run_id = $1")
        .bind(&waiting)
        .bind((chrono::Utc::now() - chrono::Duration::minutes(20)).to_rfc3339())
        .execute(&f.db)
        .await
        .unwrap();
    super::store::expire(&f.db, &f.registry.current())
        .await
        .unwrap();
    assert_eq!(
        status_of(&f.db, &waiting).await,
        (
            "failed".to_string(),
            Some("pool_worker_unavailable".to_string())
        )
    );
    // The System agent may run in that conversation again.
    let active: Option<String> = query_scalar(
        "SELECT active_run_id FROM cloud_pip_conversation_state WHERE conversation_id = $1",
    )
    .bind(chat)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert!(active.is_none());
}
