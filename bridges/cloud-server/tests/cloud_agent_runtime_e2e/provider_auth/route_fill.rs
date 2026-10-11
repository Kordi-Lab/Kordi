//! A Cloud claim without a model reuses the owner's latest recorded route that
//! a hosted account can serve, and a Cloud run always records its account.
//! Every credential below is synthetic.

use super::route_safety::{publish, run_provider_auth, set_provider_auth_env};
use super::*;

const SESSION_MODEL: &str = "openai-codex/gpt-5.6-sol";
const OTHER_SESSION_MODEL: &str = "openai-codex/gpt-5.5";

async fn publish_cloud_login(router: &axum::Router, owner: &TestAccount, auth_choice: &str) {
    publish(
        router,
        owner,
        json!({
            "provider": "openai-codex",
            "authChoice": auth_choice,
            "payload": {
                "apiMode": "openai-codex-oauth",
                "accessToken": "synthetic-fill-access",
                "refreshToken": "synthetic-fill-refresh",
                "expiresAtMs": "4102444800000"
            }
        }),
    )
    .await;
}

fn codex_route(model: &str, auth_choice: &str) -> Value {
    json!({
        "defaultModel": model,
        "defaultAuthProvider": "openai-codex",
        "defaultAuthChoice": auth_choice,
        "thinking": "medium"
    })
}

/// Records a finished desktop run with `route`, `age_minutes` in the past.
async fn record_run(
    pool: &sqlx_postgres::PgPool,
    owner: &TestAccount,
    session_id: &str,
    status: &str,
    route: Value,
    age_minutes: i64,
) {
    let at = (chrono::Utc::now() - chrono::Duration::minutes(age_minutes)).to_rfc3339();
    let id = uuid::Uuid::new_v4().simple().to_string();
    sqlx_core::query::query(
        "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id, \
         session_id, owner_account_id, requester_account_id, status, prompt, created_at, \
         updated_at, runtime_route_json, execution_backend, execution_agent_id) \
         VALUES ($1, $1, $2, $3, $4, $4, $5, 'earlier', $6, $6, $7, 'desktop', $8)",
    )
    .bind(format!("car_fill_{id}"))
    .bind(format!("msg_fill_{id}"))
    .bind(session_id)
    .bind(&owner.account_id)
    .bind(status)
    .bind(at)
    .bind(route)
    .bind(format!("cloud-agent:{}", owner.account_id))
    .execute(pool)
    .await
    .unwrap();
}

async fn claim_route(
    router: &axum::Router,
    pool: &sqlx_postgres::PgPool,
    owner: &TestAccount,
    session_id: &str,
    route: Option<Value>,
) -> Value {
    let request_id = format!("msg_fill_claim_{}", uuid::Uuid::new_v4().simple());
    let mut body = claim_body_with_session(owner, owner, &request_id, session_id);
    if let Some(route) = route {
        body["runtimeRoute"] = route;
    }
    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &owner.token,
            body,
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::OK);
    let run_id = read_json(claim).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    let (route,): (Value,) = sqlx_core::query_as::query_as(
        "SELECT runtime_route_json FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(pool)
    .await
    .unwrap();
    route
}

async fn offline_owner(router: &axum::Router, prefix: &str) -> TestAccount {
    let owner = signup(router, prefix, "Owner").await;
    let _ = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
        .await
        .unwrap();
    owner
}

#[tokio::test]
async fn a_claim_without_a_model_reuses_the_owners_latest_hosted_route() {
    let Some(pool) = try_pool().await else { return };
    set_provider_auth_env();
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let owner = offline_owner(&router, "route-fill-owner").await;
    publish_cloud_login(&router, &owner, "cloud-login:main").await;
    let session = format!(
        "session:direct-person:{}:{}",
        owner.account_id, owner.account_id
    );
    let other_session = format!("session:self-agent:{}", uuid::Uuid::new_v4());
    record_run(
        &pool,
        &owner,
        &session,
        "completed",
        codex_route(SESSION_MODEL, "cloud-login:main"),
        30,
    )
    .await;
    record_run(
        &pool,
        &owner,
        &other_session,
        "completed",
        codex_route(OTHER_SESSION_MODEL, "cloud-login:main"),
        20,
    )
    .await;
    // Newer runs without a model, or for a Mac-only account, are skipped.
    record_run(&pool, &owner, &session, "cancelled", json!({}), 10).await;
    record_run(
        &pool,
        &owner,
        &session,
        "completed",
        codex_route("openai-codex/gpt-5.4", "profile:work"),
        5,
    )
    .await;

    // A new session falls back to the owner's latest route in any session.
    let fresh = format!("session:self-agent:{}", uuid::Uuid::new_v4());
    let any_session = claim_route(&router, &pool, &owner, &fresh, None).await;
    assert_eq!(any_session["defaultModel"], OTHER_SESSION_MODEL);

    let filled = claim_route(&router, &pool, &owner, &session, None).await;
    assert_eq!(filled, codex_route(SESSION_MODEL, "cloud-login:main"));

    // A model-less route keeps its own thinking level.
    let thinking = claim_route(
        &router,
        &pool,
        &owner,
        &session,
        Some(json!({ "thinking": "high" })),
    )
    .await;
    assert_eq!(thinking["defaultModel"], SESSION_MODEL);
    assert_eq!(thinking["thinking"], "high");

    // A route that already names a model is kept as sent.
    let explicit = codex_route("openai-codex/gpt-5.4-mini", "cloud-login:main");
    let kept = claim_route(&router, &pool, &owner, &session, Some(explicit.clone())).await;
    assert_eq!(kept, explicit);
}

#[tokio::test]
async fn a_cloud_run_without_history_records_the_account_it_resolved() {
    let Some(pool) = try_pool().await else { return };
    set_provider_auth_env();
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let owner = offline_owner(&router, "route-fill-record-owner").await;
    publish_cloud_login(&router, &owner, "cloud-login:only").await;

    let (available, status, body) = run_provider_auth(&router, &pool, &owner, Value::Null).await;
    assert!(available);
    assert_eq!(status, StatusCode::OK, "{body}");
    let (route,): (Value,) = sqlx_core::query_as::query_as(
        "SELECT runtime_route_json FROM cloud_agent_fallback_runs \
         WHERE owner_account_id = $1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&owner.account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(route["defaultAuthProvider"], "openai-codex");
    assert_eq!(route["defaultAuthChoice"], "cloud-login:only");
    assert!(route.get("defaultModel").is_none(), "{route}");
}
