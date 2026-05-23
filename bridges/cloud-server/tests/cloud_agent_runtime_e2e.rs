//! End-to-end tests for Cloud-hosted agent fallback runtime state.
//!
//! Skipped when `DATABASE_URL` is not set. These tests exercise the HTTP
//! surface against real Postgres migrations so idempotency and presence
//! gating match production behavior.

use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use kordi_cloud_server::auth::rate_limit::{CloudRateLimitConfig, CloudRateLimiter};
use kordi_cloud_server::events::EventBus;
use kordi_cloud_server::pg::init_pool;
use kordi_cloud_server::server::{router_with_rate_limiter, ServerState};
use serde_json::{json, Value};
use tower::util::ServiceExt;

static INIT_POOL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Debug)]
struct TestAccount {
    account_id: String,
    token: String,
}

async fn try_pool() -> Option<sqlx_postgres::PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    let _guard = INIT_POOL_LOCK.lock().await;
    match init_pool(&url).await {
        Ok(pool) => Some(pool),
        Err(err) => {
            eprintln!("[cloud_agent_runtime_e2e] init_pool failed, skipping: {err}");
            None
        }
    }
}

fn test_router(state: Arc<ServerState>) -> axum::Router {
    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig {
        per_ip_limit: 10_000,
        per_ip_window: Duration::from_secs(60),
        per_email_failure_limit: 5,
        per_email_lockout: Duration::from_secs(900),
    });
    router_with_rate_limiter(state, limiter)
}

fn unique_email(prefix: &str) -> String {
    format!(
        "{prefix}-{}@agent-runtime.e2e.local",
        uuid::Uuid::new_v4().simple()
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

fn post_with_token(uri: &str, token: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

fn post_json_with_token(uri: &str, token: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn get_with_token(uri: &str, token: &str) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

fn delete_with_token(uri: &str, token: &str) -> Request<Body> {
    Request::builder()
        .method("DELETE")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

async fn read_json(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    if bytes.is_empty() {
        return Value::Null;
    }
    serde_json::from_slice(&bytes).unwrap()
}

async fn signup(router: &axum::Router, prefix: &str, display_name: &str) -> TestAccount {
    let email = unique_email(prefix);
    let response = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            Body::from(
                json!({
                    "email": email,
                    "password": "correct horse",
                    "displayName": display_name,
                    "avatarUrl": "data:image/png;base64,iVBORw0KGgo=",
                })
                .to_string(),
            ),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = read_json(response).await;
    TestAccount {
        account_id: body["account"]["accountId"].as_str().unwrap().to_string(),
        token: body["session"]["token"].as_str().unwrap().to_string(),
    }
}

async fn accept_contacts(router: &axum::Router, from: &TestAccount, to: &TestAccount) {
    let request = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/contacts/requests",
            &from.token,
            json!({ "peerAccountId": to.account_id }),
        ))
        .await
        .unwrap();
    assert_eq!(request.status(), StatusCode::CREATED);
    let body = read_json(request).await;
    let request_id = body["request"]["requestId"].as_str().unwrap();
    let accept_path = format!("/v1/cloud/contacts/requests/{request_id}/accept");
    let accepted = router
        .clone()
        .oneshot(post_with_token(&accept_path, &to.token))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::OK);
}

async fn count_cloud_agent_runs_for_key(
    pool: &sqlx_postgres::PgPool,
    idempotency_key: &str,
) -> i64 {
    let row: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_fallback_runs WHERE idempotency_key = $1",
    )
    .bind(idempotency_key)
    .fetch_one(pool)
    .await
    .unwrap();
    row.0
}

fn claim_body(owner: &TestAccount, requester: &TestAccount, request_message_id: &str) -> Value {
    json!({
        "requestMessageId": request_message_id,
        "sessionId": format!("session:direct-person:{}:{}", requester.account_id, owner.account_id),
        "ownerAccountId": owner.account_id,
        "requesterAccountId": requester.account_id,
        "prompt": "@OwnerKordi make a small plan",
        "idempotencyKey": format!("session:direct-person:{}:{}:{}:{}", requester.account_id, owner.account_id, request_message_id, owner.account_id),
    })
}

#[tokio::test]
async fn cloud_agent_runtime_fallback_claim_is_idempotent_when_owner_is_offline() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "offline-owner", "Owner").await;
    let requester = signup(&router, "offline-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;

    let offline = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
        .await
        .unwrap();
    assert_eq!(offline.status(), StatusCode::OK);

    let first = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_agent_request_1"),
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first_body = read_json(first).await;

    let second = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_agent_request_1"),
        ))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::OK);
    let second_body = read_json(second).await;

    assert_eq!(first_body["runId"], second_body["runId"]);
    assert_eq!(first_body["status"], "queued");
    assert_eq!(second_body["status"], "queued");
    let idempotency_key = claim_body(&owner, &requester, "msg_agent_request_1")["idempotencyKey"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        count_cloud_agent_runs_for_key(&pool, &idempotency_key).await,
        1
    );
}

#[tokio::test]
async fn cloud_agent_runtime_fallback_claim_is_rejected_when_owner_is_online() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "online-owner", "Owner").await;
    let requester = signup(&router, "online-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;

    let online = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/online", &owner.token))
        .await
        .unwrap();
    assert_eq!(online.status(), StatusCode::OK);

    let response = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_online_owner"),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn cloud_agent_runtime_fallback_claim_requires_accepted_contact_or_self() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "unauth-owner", "Owner").await;
    let requester = signup(&router, "unauth-requester", "Requester").await;

    let offline = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
        .await
        .unwrap();
    assert_eq!(offline.status(), StatusCode::OK);

    let response = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_unauthorized"),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn provider_auth_snapshot_create_current_revoke_and_audit() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "provider-auth-owner", "Owner").await;

    let create = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots",
            &owner.token,
            json!({
                "provider": "openai",
                "authChoice": "default",
                "payload": {
                    "accessToken": "secret-access-token",
                    "refreshToken": "secret-refresh-token"
                }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::CREATED);
    let created = read_json(create).await;
    let snapshot_id = created["snapshotId"].as_str().unwrap().to_string();
    assert_eq!(created["provider"], "openai");
    assert_eq!(created["authChoice"], "default");
    assert_eq!(created["revokedAt"], Value::Null);
    assert!(
        created.get("payload").is_none(),
        "snapshot response must not echo secrets"
    );

    let encrypted: (Vec<u8>,) = sqlx_core::query_as::query_as(
        "SELECT encrypted_payload FROM cloud_agent_provider_auth_snapshots WHERE snapshot_id = $1",
    )
    .bind(&snapshot_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let encrypted_text = String::from_utf8_lossy(&encrypted.0);
    assert!(!encrypted_text.contains("secret-access-token"));

    let current = router
        .clone()
        .oneshot(get_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/current?provider=openai&authChoice=default",
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(current.status(), StatusCode::OK);
    let current_body = read_json(current).await;
    assert_eq!(current_body["snapshot"]["snapshotId"], snapshot_id);
    assert!(current_body["snapshot"].get("payload").is_none());

    kordi_cloud_server::cloud_agent_runtime::provider_auth::record_snapshot_used(
        &pool,
        &snapshot_id,
        &owner.account_id,
        Some("car_test_run"),
    )
    .await
    .unwrap();

    let revoke = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/agent-provider-auth/snapshots/{snapshot_id}"),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(revoke.status(), StatusCode::OK);

    let current_after_revoke = router
        .clone()
        .oneshot(get_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/current?provider=openai&authChoice=default",
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(current_after_revoke.status(), StatusCode::OK);
    let current_after_revoke_body = read_json(current_after_revoke).await;
    assert_eq!(current_after_revoke_body["snapshot"], Value::Null);

    let audit_count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_provider_auth_snapshot_audit WHERE snapshot_id = $1 AND action IN ('created', 'used', 'revoked')",
    )
    .bind(&snapshot_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit_count.0, 3);
}

#[tokio::test]
async fn provider_auth_snapshot_is_account_scoped() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "provider-auth-owner-scope", "Owner").await;
    let other = signup(&router, "provider-auth-other-scope", "Other").await;

    let create = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots",
            &owner.token,
            json!({
                "provider": "openai",
                "authChoice": "default",
                "payload": { "accessToken": "owner-only" }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::CREATED);

    let other_current = router
        .clone()
        .oneshot(get_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/current?provider=openai&authChoice=default",
            &other.token,
        ))
        .await
        .unwrap();
    assert_eq!(other_current.status(), StatusCode::OK);
    let body = read_json(other_current).await;
    assert_eq!(body["snapshot"], Value::Null);
}
