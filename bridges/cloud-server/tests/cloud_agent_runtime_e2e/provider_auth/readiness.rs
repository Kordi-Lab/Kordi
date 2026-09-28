//! Which saved accounts stay ready: refresh tokens the server cannot use, a
//! refused Codex refresh, rows saved before readiness was stored, and routes
//! that do not name a provider. Every credential is synthetic.

use super::login_session::login_router;
use super::omp_worker::mock_worker;
use super::route_safety::{publish, run_provider_auth, set_provider_auth_env};
use super::route_test::{error_code, request_test_route, CODEX_MODEL};
use super::*;

async fn listed_status(router: &axum::Router, owner: &TestAccount, snapshot_id: &str) -> Value {
    let listed = router
        .clone()
        .oneshot(get_with_token(
            "/v1/cloud/agent-provider-auth/snapshots",
            &owner.token,
        ))
        .await
        .unwrap();
    read_json(listed).await["snapshots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|snapshot| snapshot["snapshotId"] == snapshot_id)
        .map(|snapshot| snapshot["status"].clone())
        .unwrap_or(Value::Null)
}

async fn test_anthropic_route(router: &axum::Router, owner: &TestAccount) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/test-route",
            &owner.token,
            json!({
                "provider": "anthropic",
                "authChoice": "cloud-login:anthropic",
                "model": "anthropic/claude-sonnet-5"
            }),
        ))
        .await
        .unwrap();
    let status = response.status();
    (status, read_json(response).await)
}

#[tokio::test]
async fn an_expired_anthropic_oauth_account_needs_reconnecting_despite_its_refresh_token() {
    let Some(pool) = try_pool().await else { return };
    let (worker, _worker_env) = mock_worker().await;
    let router = login_router(&pool);
    let owner = signup(&router, "readiness-anthropic-owner", "Owner").await;
    let credential = format!("synthetic-anthropic-{}", uuid::Uuid::new_v4().simple());
    let snapshot = publish(
        &router,
        &owner,
        json!({
            "provider": "anthropic",
            "authChoice": "cloud-login:anthropic",
            "payload": {
                "apiMode": "anthropic-oauth",
                "accessToken": credential,
                "refreshToken": "synthetic-refresh-anthropic",
                "expiresAtMs": chrono::Utc::now().timestamp_millis() - 60_000
            }
        }),
    )
    .await;
    // Only the Anthropic client can use that refresh token, so the server
    // cannot keep this account ready past its expiry.
    assert_eq!(snapshot["status"], "needs-reconnect");
    let (status, body) = test_anthropic_route(&router, &owner).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["errorCode"], "account_unavailable");

    // A row saved while any refresh token counted as refreshable still reads
    // `ready`; its first use withdraws that claim instead of running it.
    let snapshot_id = snapshot["snapshotId"].as_str().unwrap();
    sqlx_core::query::query(
        "UPDATE cloud_agent_provider_auth_snapshots SET refreshable = true WHERE snapshot_id = $1",
    )
    .bind(snapshot_id)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(listed_status(&router, &owner, snapshot_id).await, "ready");
    let (status, body) = test_anthropic_route(&router, &owner).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["errorCode"], "account_unavailable");
    assert_eq!(
        listed_status(&router, &owner, snapshot_id).await,
        "needs-reconnect"
    );
    assert!(worker.calls_for(&[credential.as_str()]).is_empty());
}

#[tokio::test]
async fn a_refused_codex_refresh_marks_the_account_for_reconnecting() {
    let Some(pool) = try_pool().await else { return };
    let (worker, _worker_env) = mock_worker().await;
    let router = login_router(&pool);
    let owner = signup(&router, "readiness-refused-owner", "Owner").await;
    let refresh_token = format!(
        "synthetic-refresh-revoked-{}",
        uuid::Uuid::new_v4().simple()
    );
    let snapshot = publish(
        &router,
        &owner,
        json!({
            "provider": "openai-codex",
            "authChoice": "profile:revoked",
            "payload": {
                "apiMode": "openai-codex-oauth",
                "accessToken": "synthetic-revoked-access",
                "refreshToken": refresh_token,
                "expiresAtMs": (chrono::Utc::now().timestamp_millis() + 60_000).to_string()
            }
        }),
    )
    .await;
    let snapshot_id = snapshot["snapshotId"].as_str().unwrap().to_string();
    assert_eq!(snapshot["status"], "ready");

    for _ in 0..2 {
        let (status, text) =
            request_test_route(&router, Some(&owner.token), "profile:revoked", CODEX_MODEL).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{text}");
        assert_eq!(error_code(&text), "account_unavailable");
    }
    // The refused token is tried once; afterwards the account is not ready.
    assert_eq!(worker.token_calls_for(&refresh_token), 1);
    assert!(worker.calls_for(&["synthetic-revoked-access"]).is_empty());
    assert_eq!(
        listed_status(&router, &owner, &snapshot_id).await,
        "needs-reconnect"
    );
    let actions: Vec<(Value,)> = sqlx_core::query_as::query_as(
        "SELECT payload FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND event_type = 'provider-auth.updated' ORDER BY stream_seq",
    )
    .bind(&owner.account_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        actions.last().unwrap().0,
        json!({
            "action": "needs-reconnect",
            "provider": "openai-codex",
            "snapshotId": snapshot_id
        })
    );
}

#[tokio::test]
async fn rows_saved_before_readiness_columns_are_judged_by_their_payload() {
    let Some(pool) = try_pool().await else { return };
    let (worker, _worker_env) = mock_worker().await;
    let router = login_router(&pool);
    let owner = signup(&router, "readiness-legacy-owner", "Owner").await;
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let mut snapshots = Vec::new();
    for (choice, expires_at_ms) in [
        ("profile:stale", now - 60_000),
        ("profile:fresh", now + 3_600_000),
    ] {
        let snapshot = publish(
            &router,
            &owner,
            json!({
                "provider": "openai-codex",
                "authChoice": choice,
                "payload": {
                    "apiMode": "openai-codex-oauth",
                    "accessToken": format!("synthetic-legacy-{choice}-{suffix}"),
                    "expiresAtMs": expires_at_ms
                }
            }),
        )
        .await;
        snapshots.push(snapshot["snapshotId"].as_str().unwrap().to_string());
    }
    // Before migration 0105 no row stored its expiry.
    sqlx_core::query::query(
        "UPDATE cloud_agent_provider_auth_snapshots SET expires_at_ms = NULL, refreshable = false \
         WHERE account_id = $1",
    )
    .bind(&owner.account_id)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(listed_status(&router, &owner, &snapshots[0]).await, "ready");

    let stale_access = format!("synthetic-legacy-profile:stale-{suffix}");
    let (status, text) =
        request_test_route(&router, Some(&owner.token), "profile:stale", CODEX_MODEL).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{text}");
    assert_eq!(error_code(&text), "account_unavailable");
    assert!(worker.calls_for(&[stale_access.as_str()]).is_empty());
    assert_eq!(
        listed_status(&router, &owner, &snapshots[0]).await,
        "needs-reconnect"
    );

    let (status, text) =
        request_test_route(&router, Some(&owner.token), "profile:fresh", CODEX_MODEL).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let stored: (Option<i64>,) = sqlx_core::query_as::query_as(
        "SELECT expires_at_ms FROM cloud_agent_provider_auth_snapshots WHERE snapshot_id = $1",
    )
    .bind(&snapshots[1])
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored.0, Some(now + 3_600_000));
}

#[tokio::test]
async fn a_route_without_a_provider_never_chooses_between_providers() {
    let Some(pool) = try_pool().await else { return };
    set_provider_auth_env();
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "readiness-provider-owner", "Owner").await;
    let anthropic = publish(
        &router,
        &owner,
        json!({
            "provider": "anthropic",
            "authChoice": "local-active-oauth",
            "payload": { "apiMode": "anthropic-oauth", "accessToken": "synthetic-claude-access" }
        }),
    )
    .await;
    let codex = publish(
        &router,
        &owner,
        json!({
            "provider": "openai-codex",
            "authChoice": "local-active-oauth",
            "payload": { "apiMode": "openai-codex-oauth", "accessToken": "synthetic-codex-access" }
        }),
    )
    .await;
    let _ = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
        .await
        .unwrap();
    let route = json!({
        "defaultModel": "anthropic/claude-sonnet-5",
        "defaultAuthChoice": "local-active-oauth"
    });

    let (available, status, body) = run_provider_auth(&router, &pool, &owner, route.clone()).await;
    assert!(!available, "two providers share this choice");
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["errorCode"], "provider_auth_not_found");

    let revoke = router
        .clone()
        .oneshot(delete_with_token(
            &format!(
                "/v1/cloud/agent-provider-auth/snapshots/{}?intent=explicit",
                codex["snapshotId"].as_str().unwrap()
            ),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(revoke.status(), StatusCode::OK);
    let (available, status, body) = run_provider_auth(&router, &pool, &owner, route).await;
    assert!(available);
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["providerAuth"]["snapshotId"], anthropic["snapshotId"]);
}
