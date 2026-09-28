//! Fail-closed account selection, single-flight Codex refresh, per-account
//! limits on provider checks, and publish bounds. Every credential below is
//! synthetic.

use kordi_cloud_server::cloud_agent_runtime::provider_auth::{
    EnvProviderAuthCipher, ProviderAuthCipher,
};

use super::omp_worker::mock_worker;
use super::route_test::{request_test_route, CODEX_MODEL};
use super::*;

pub(super) fn set_provider_auth_env() {
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
}

pub(super) async fn publish(router: &axum::Router, owner: &TestAccount, body: Value) -> Value {
    let response = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots?intent=explicit",
            &owner.token,
            body,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    read_json(response).await
}

async fn publish_codex(
    router: &axum::Router,
    owner: &TestAccount,
    auth_choice: &str,
    access_token: &str,
    refresh_token: &str,
    expires_at_ms: i64,
) -> String {
    let snapshot = publish(
        router,
        owner,
        json!({
            "provider": "openai-codex",
            "authChoice": auth_choice,
            "payload": {
                "apiMode": "openai-codex-oauth",
                "accessToken": access_token,
                "refreshToken": refresh_token,
                "expiresAtMs": expires_at_ms.to_string()
            }
        }),
    )
    .await;
    snapshot["snapshotId"].as_str().unwrap().to_string()
}

/// Claims and leases one run for `route`, then asks for its provider auth.
pub(super) async fn run_provider_auth(
    router: &axum::Router,
    pool: &sqlx_postgres::PgPool,
    owner: &TestAccount,
    route: Value,
) -> (bool, StatusCode, Value) {
    let request_id = format!("msg_route_safety_{}", uuid::Uuid::new_v4().simple());
    let mut body = claim_body(owner, owner, &request_id);
    body["runtimeRoute"] = route;
    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &owner.token,
            body,
        ))
        .await
        .unwrap();
    let run_id = read_json(claim).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    cancel_other_queued_runs(pool, &run_id).await;
    let runner_id = format!("runner-route-safety-{}", uuid::Uuid::new_v4().simple());
    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": runner_id, "canaryRunId": run_id }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    let available = read_json(lease).await["run"]["providerAuthAvailable"] == true;
    let material = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": runner_id }),
        ))
        .await
        .unwrap();
    let status = material.status();
    (available, status, read_json(material).await)
}

#[tokio::test]
async fn a_route_without_an_account_choice_needs_exactly_one_live_account() {
    let Some(pool) = try_pool().await else { return };
    set_provider_auth_env();
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "route-safety-choice-owner", "Owner").await;
    let far_future = 4_102_444_800_000;
    let work = publish_codex(
        &router,
        &owner,
        "profile:work",
        "synthetic-work-access",
        "synthetic-refresh-work",
        far_future,
    )
    .await;
    let personal = publish_codex(
        &router,
        &owner,
        "profile:personal",
        "synthetic-personal-access",
        "synthetic-refresh-personal",
        far_future,
    )
    .await;
    let _ = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
        .await
        .unwrap();
    let route = json!({ "defaultModel": CODEX_MODEL, "defaultAuthProvider": "openai" });

    let (available, status, body) = run_provider_auth(&router, &pool, &owner, route.clone()).await;
    assert!(
        !available,
        "two saved accounts without a choice are ambiguous"
    );
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["errorCode"], "provider_auth_not_found");

    let revoke = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/agent-provider-auth/snapshots/{personal}?intent=explicit"),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(revoke.status(), StatusCode::OK);
    let (available, status, body) = run_provider_auth(&router, &pool, &owner, route).await;
    assert!(available);
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["providerAuth"]["snapshotId"], work.as_str());
    assert_eq!(
        body["providerAuth"]["payload"]["accessToken"],
        "synthetic-work-access"
    );
}

#[tokio::test]
async fn concurrent_route_tests_refresh_an_expiring_codex_token_once() {
    let Some(pool) = try_pool().await else { return };
    set_provider_auth_env();
    let (worker, _worker_env) = mock_worker().await;
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "route-safety-refresh-owner", "Owner").await;
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let refresh_token = format!("synthetic-refresh-{suffix}");
    let rotated = format!("synthetic-refresh-rotated-{suffix}");
    let refreshes = || worker.token_calls_for(&refresh_token) + worker.token_calls_for(&rotated);
    let renewed = format!("synthetic-renewed-access-{suffix}");
    let expiring = chrono::Utc::now().timestamp_millis() + 60_000;
    let snapshot_id = publish_codex(
        &router,
        &owner,
        "profile:expiring",
        "synthetic-expiring-access",
        &refresh_token,
        expiring,
    )
    .await;

    let test_route =
        || request_test_route(&router, Some(&owner.token), "profile:expiring", CODEX_MODEL);
    let ((first, first_body), (second, second_body)) = tokio::join!(test_route(), test_route());
    assert_eq!(first, StatusCode::OK, "{first_body}");
    assert_eq!(second, StatusCode::OK, "{second_body}");
    assert_eq!(refreshes(), 1, "exactly one upstream refresh");
    assert_eq!(worker.calls_for(&[renewed.as_str()]).len(), 2);

    // The refreshed token is stored once, and a later route test reuses it.
    let (status, text) =
        request_test_route(&router, Some(&owner.token), "profile:expiring", CODEX_MODEL).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert_eq!(refreshes(), 1, "exactly one upstream refresh");
    let stored: (Vec<u8>, i64) = sqlx_core::query_as::query_as(
        "SELECT encrypted_payload, payload_version FROM cloud_agent_provider_auth_snapshots \
         WHERE snapshot_id = $1",
    )
    .bind(&snapshot_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored.1, 1);
    let payload: Value = serde_json::from_slice(
        &EnvProviderAuthCipher::from_env()
            .unwrap()
            .decrypt(&stored.0)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(payload["accessToken"], renewed.as_str());
    assert_eq!(payload["refreshToken"], rotated.as_str());
    worker.assert_no_violations();
}

#[tokio::test]
async fn provider_checks_are_limited_per_account_and_labels_are_shortened() {
    let Some(pool) = try_pool().await else { return };
    set_provider_auth_env();
    let router = test_router(Arc::new(ServerState::new(pool, EventBus::noop())));
    let owner = signup(&router, "route-safety-limit-owner", "Owner").await;
    let other = signup(&router, "route-safety-limit-other", "Other").await;
    // Both calls are rejected before any worker is contacted, and still count.
    let route_test = |token: &str| {
        router.clone().oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/test-route",
            token,
            json!({ "provider": "openai-codex", "authChoice": "default", "model": "anthropic/x" }),
        ))
    };
    let validate_key = |token: &str| {
        router.clone().oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/validate-key",
            token,
            json!({ "provider": "groq", "apiKey": " " }),
        ))
    };
    for _ in 0..10 {
        assert_eq!(
            route_test(&owner.token).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            validate_key(&owner.token).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
    }
    for limited in [
        route_test(&owner.token).await.unwrap(),
        validate_key(&owner.token).await.unwrap(),
    ] {
        assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(limited.headers().contains_key("retry-after"));
        assert_eq!(read_json(limited).await["errorCode"], "rate_limited");
    }
    assert_eq!(
        route_test(&other.token).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );

    let snapshot = publish(
        &router,
        &owner,
        json!({
            "provider": "openai",
            "authChoice": "default",
            "label": "L".repeat(100),
            "payload": { "apiKey": "synthetic-long-label-key" }
        }),
    )
    .await;
    assert_eq!(snapshot["label"], "L".repeat(80));
    let rejected = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots?intent=explicit",
            &owner.token,
            json!({
                "provider": "openai/codex",
                "authChoice": "default",
                "payload": { "apiKey": "synthetic-bad-provider-key" }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
}

async fn listed_status(router: &axum::Router, owner: &TestAccount, snapshot_id: &str) -> Value {
    let listed = router
        .clone()
        .oneshot(get_with_token(
            "/v1/cloud/agent-provider-auth/snapshots?provider=openai-codex",
            &owner.token,
        ))
        .await
        .unwrap();
    let listed = read_json(listed).await;
    listed["snapshots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|snapshot| snapshot["snapshotId"] == snapshot_id)
        .map(|snapshot| snapshot["status"].clone())
        .unwrap_or(Value::Null)
}

#[tokio::test]
async fn an_expired_access_only_account_needs_reconnecting_and_is_never_used() {
    let Some(pool) = try_pool().await else { return };
    set_provider_auth_env();
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "route-safety-reconnect-owner", "Owner").await;
    let expired = chrono::Utc::now().timestamp_millis() - 60_000;
    let stale = publish(
        &router,
        &owner,
        json!({
            "provider": "openai-codex",
            "authChoice": "desktop:stale",
            "payload": {
                "apiMode": "openai-codex-oauth",
                "accessToken": "synthetic-stale-access",
                "expiresAtMs": expired
            }
        }),
    )
    .await;
    assert_eq!(stale["status"], "needs-reconnect");
    let stale_id = stale["snapshotId"].as_str().unwrap().to_string();
    // The server can refresh this one, so it stays ready despite its expiry.
    let refreshable = publish_codex(
        &router,
        &owner,
        "profile:refreshable",
        "synthetic-refreshable-access",
        "synthetic-refresh-refreshable",
        expired,
    )
    .await;
    assert_eq!(
        listed_status(&router, &owner, &stale_id).await,
        "needs-reconnect"
    );
    assert_eq!(listed_status(&router, &owner, &refreshable).await, "ready");
    let current = router
        .clone()
        .oneshot(get_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/current?provider=openai-codex&authChoice=desktop:stale",
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(
        read_json(current).await["snapshot"]["status"],
        "needs-reconnect"
    );

    let _ = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
        .await
        .unwrap();
    let (available, status, body) = run_provider_auth(
        &router,
        &pool,
        &owner,
        json!({
            "defaultModel": CODEX_MODEL,
            "defaultAuthProvider": "openai",
            "defaultAuthChoice": "desktop:stale"
        }),
    )
    .await;
    assert!(!available);
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert!(!body.to_string().contains("synthetic-"), "{body}");
}
