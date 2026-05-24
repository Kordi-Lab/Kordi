//! End-to-end tests for Cloud-hosted agent fallback runtime state.
//!
//! Skipped when `DATABASE_URL` is not set. These tests exercise the HTTP
//! surface against real Postgres migrations so idempotency and presence
//! gating match production behavior.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::extract::OriginalUri;
use axum::http::{Method, Request, StatusCode};
use axum::response::IntoResponse;
use kordi_cloud_server::attachments::S3Config;
use kordi_cloud_server::auth::rate_limit::{CloudRateLimitConfig, CloudRateLimiter};
use kordi_cloud_server::events::EventBus;
use kordi_cloud_server::pg::init_pool;
use kordi_cloud_server::server::{router_with_rate_limiter, ServerState};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tower::util::ServiceExt;
use url::Url;

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

#[derive(Clone)]
struct TestObjectStore {
    endpoint: String,
}

impl TestObjectStore {
    async fn spawn() -> Self {
        Self::spawn_with_put_status(StatusCode::OK).await
    }

    async fn spawn_rejecting_puts() -> Self {
        Self::spawn_with_put_status(StatusCode::BAD_GATEWAY).await
    }

    async fn spawn_with_put_status(put_status: StatusCode) -> Self {
        let objects = Arc::new(Mutex::new(HashMap::<String, Vec<u8>>::new()));
        let app_objects = objects.clone();
        let app =
            axum::Router::new().fallback(move |method: Method, uri: OriginalUri, body: Body| {
                let objects = app_objects.clone();
                async move {
                    let key = uri.0.path().trim_start_matches('/').to_string();
                    match method {
                        Method::PUT => {
                            if !put_status.is_success() {
                                return put_status.into_response();
                            }
                            let bytes = to_bytes(body, 8 * 1024 * 1024).await.unwrap();
                            objects.lock().await.insert(key, bytes.to_vec());
                            StatusCode::OK.into_response()
                        }
                        Method::GET => {
                            let value = objects.lock().await.get(&key).cloned();
                            match value {
                                Some(bytes) => bytes.into_response(),
                                None => StatusCode::NOT_FOUND.into_response(),
                            }
                        }
                        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
                    }
                }
            });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            endpoint: format!("http://{}", addr),
        }
    }

    fn s3_config(&self) -> S3Config {
        S3Config {
            endpoint: Url::parse(&self.endpoint).unwrap(),
            region: "us-east-1".to_string(),
            bucket: "kordi-test".to_string(),
            access_key: "test-access".to_string(),
            secret_key: "test-secret".to_string(),
        }
    }
}

fn test_router_with_s3(pool: sqlx_postgres::PgPool, store: &TestObjectStore) -> axum::Router {
    let state = Arc::new(ServerState::new(pool, EventBus::noop()).with_s3(store.s3_config()));
    test_router(state)
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

fn post_json_with_runner_token(uri: &str, token: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn export_body(runner_id: &str, name: &str, sandbox_path: &str, bytes: &[u8]) -> Value {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let sha = Sha256::digest(bytes);
    json!({
        "runnerId": runner_id,
        "name": name,
        "sandboxPath": sandbox_path,
        "contentType": "text/markdown",
        "sha256Hex": format!("{sha:x}"),
        "bytesBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
    })
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

async fn cancel_other_queued_runs(pool: &sqlx_postgres::PgPool, run_id: &str) {
    sqlx_core::query::query(
        "UPDATE cloud_agent_fallback_runs SET status = 'cancelled', updated_at = $2 WHERE run_id <> $1 AND status = 'queued'",
    )
    .bind(run_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await
    .unwrap();
}

fn claim_body(owner: &TestAccount, requester: &TestAccount, request_message_id: &str) -> Value {
    claim_body_with_session(
        owner,
        requester,
        request_message_id,
        &format!(
            "session:direct-person:{}:{}",
            requester.account_id, owner.account_id
        ),
    )
}

fn claim_body_with_session(
    owner: &TestAccount,
    requester: &TestAccount,
    request_message_id: &str,
    session_id: &str,
) -> Value {
    json!({
        "requestMessageId": request_message_id,
        "sessionId": session_id,
        "ownerAccountId": owner.account_id,
        "requesterAccountId": requester.account_id,
        "prompt": "@OwnerKordi make a small plan",
        "idempotencyKey": format!("{}:{}:{}", session_id, request_message_id, owner.account_id),
    })
}

async fn run_sandbox_id(pool: &sqlx_postgres::PgPool, run_id: &str) -> Option<String> {
    let row: (Option<String>,) = sqlx_core::query_as::query_as(
        "SELECT sandbox_id FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await
    .unwrap();
    row.0
}

async fn expire_sandbox(pool: &sqlx_postgres::PgPool, sandbox_id: &str) {
    sqlx_core::query::query(
        "UPDATE cloud_agent_sandboxes SET expires_at = $2 WHERE sandbox_id = $1",
    )
    .bind(sandbox_id)
    .bind((chrono::Utc::now() - chrono::Duration::seconds(60)).to_rfc3339())
    .execute(pool)
    .await
    .unwrap();
}

async fn count_sandboxes_for_session(pool: &sqlx_postgres::PgPool, session_id: &str) -> i64 {
    let row: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_sandboxes WHERE session_id = $1",
    )
    .bind(session_id)
    .fetch_one(pool)
    .await
    .unwrap();
    row.0
}

async fn lease_claimed_run_for_export(
    router: &axum::Router,
    pool: &sqlx_postgres::PgPool,
    owner: &TestAccount,
    requester: &TestAccount,
    request_message_id: &str,
    runner_id: &str,
) -> String {
    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(owner, requester, request_message_id),
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::OK);
    let run_id = read_json(claim).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    cancel_other_queued_runs(pool, &run_id).await;
    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": runner_id }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    assert_eq!(read_json(lease).await["run"]["runId"], run_id);
    run_id
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

#[tokio::test]
async fn provider_auth_material_is_run_scoped_runner_only_and_audited() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "provider-material-owner", "Owner").await;
    let requester = signup(&router, "provider-material-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;

    let snapshot = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots",
            &owner.token,
            json!({
                "provider": "openai",
                "authChoice": "default",
                "payload": {
                    "apiKey": "runner-secret",
                    "baseUrl": "https://api.openai.com/v1",
                    "model": "gpt-4.1-mini"
                }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(snapshot.status(), StatusCode::CREATED);
    let snapshot_id = read_json(snapshot).await["snapshotId"]
        .as_str()
        .unwrap()
        .to_string();

    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_provider_material"),
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::OK);
    let run_id = read_json(claim).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    cancel_other_queued_runs(&pool, &run_id).await;

    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": "runner-material" }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);

    let user_token_response = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            &requester.token,
            json!({ "runnerId": "runner-material" }),
        ))
        .await
        .unwrap();
    assert_eq!(user_token_response.status(), StatusCode::UNAUTHORIZED);

    let wrong_runner_response = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "runner-other" }),
        ))
        .await
        .unwrap();
    assert_eq!(wrong_runner_response.status(), StatusCode::NOT_FOUND);
    let wrong_runner_body = read_json(wrong_runner_response).await;
    assert_eq!(wrong_runner_body["errorCode"], "agent_run_not_found");

    let provider_auth = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "runner-material" }),
        ))
        .await
        .unwrap();
    assert_eq!(provider_auth.status(), StatusCode::OK);
    let body = read_json(provider_auth).await;
    assert_eq!(body["providerAuth"]["snapshotId"], snapshot_id);
    assert_eq!(body["providerAuth"]["provider"], "openai");
    assert_eq!(body["providerAuth"]["authChoice"], "default");
    assert_eq!(body["providerAuth"]["payload"]["apiKey"], "runner-secret");
    assert_eq!(
        body["providerAuth"]["payload"]["baseUrl"],
        "https://api.openai.com/v1"
    );
    assert_eq!(body["providerAuth"]["payload"]["model"], "gpt-4.1-mini");

    let audit_count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_provider_auth_snapshot_audit WHERE snapshot_id = $1 AND run_id = $2 AND action = 'used'",
    )
    .bind(&snapshot_id)
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit_count.0, 1);
}

#[tokio::test]
async fn provider_auth_material_missing_snapshot_returns_not_found() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "provider-material-missing-owner", "Owner").await;
    let requester = signup(&router, "provider-material-missing-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;

    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_provider_material_missing"),
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::OK);
    let run_id = read_json(claim).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    cancel_other_queued_runs(&pool, &run_id).await;

    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": "runner-material-missing" }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);

    let missing_snapshot_response = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "runner-material-missing" }),
        ))
        .await
        .unwrap();
    assert_eq!(missing_snapshot_response.status(), StatusCode::NOT_FOUND);
    let body = read_json(missing_snapshot_response).await;
    assert_eq!(body["errorCode"], "provider_auth_not_found");
}

#[tokio::test]
async fn runner_leases_marks_running_and_completes_claimed_run() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "runner-owner", "Owner").await;
    let requester = signup(&router, "runner-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;

    let snapshot = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots",
            &owner.token,
            json!({
                "provider": "openai",
                "authChoice": "default",
                "payload": { "accessToken": "runner-secret" }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(snapshot.status(), StatusCode::CREATED);

    let offline = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
        .await
        .unwrap();
    assert_eq!(offline.status(), StatusCode::OK);

    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_runner_lifecycle"),
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::OK);
    let claimed = read_json(claim).await;
    let run_id = claimed["runId"].as_str().unwrap().to_string();
    cancel_other_queued_runs(&pool, &run_id).await;

    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": "runner-a" }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    let lease_body = read_json(lease).await;
    assert_eq!(lease_body["run"]["runId"], run_id);
    assert_eq!(lease_body["run"]["status"], "leased");
    assert_eq!(lease_body["run"]["providerAuthAvailable"], true);

    let running = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/running"),
            "runner-test-token",
            json!({ "runnerId": "runner-a" }),
        ))
        .await
        .unwrap();
    assert_eq!(running.status(), StatusCode::OK);
    assert_eq!(read_json(running).await["run"]["status"], "running");

    let complete = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/complete"),
            "runner-test-token",
            json!({ "runnerId": "runner-a", "responseText": "runner skeleton complete" }),
        ))
        .await
        .unwrap();
    assert_eq!(complete.status(), StatusCode::OK);
    let completed = read_json(complete).await;
    assert_eq!(completed["run"]["status"], "completed");
    assert!(completed["run"]["responseMessageId"]
        .as_str()
        .unwrap()
        .starts_with("cloudrunmsg_"));
}

#[tokio::test]
async fn runner_canary_lease_only_claims_requested_run_id() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "runner-canary-owner", "Owner").await;
    let requester = signup(&router, "runner-canary-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;

    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let older_claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_runner_canary_older"),
        ))
        .await
        .unwrap();
    assert_eq!(older_claim.status(), StatusCode::OK);
    let older_run_id = read_json(older_claim).await["runId"]
        .as_str()
        .unwrap()
        .to_string();

    let target_claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_runner_canary_target"),
        ))
        .await
        .unwrap();
    assert_eq!(target_claim.status(), StatusCode::OK);
    let target_run_id = read_json(target_claim).await["runId"]
        .as_str()
        .unwrap()
        .to_string();

    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": "runner-canary", "canaryRunId": target_run_id }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    let leased = read_json(lease).await;
    assert_eq!(leased["run"]["runId"], target_run_id);

    let older_status: (String,) = sqlx_core::query_as::query_as(
        "SELECT status FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&older_run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(older_status.0, "queued");
}

#[tokio::test]
async fn runner_lease_reports_missing_provider_auth_and_fail_marks_run_failed() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "runner-missing-provider-owner", "Owner").await;
    let requester = signup(&router, "runner-missing-provider-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;

    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_runner_missing_provider"),
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::OK);
    let claimed = read_json(claim).await;
    let expected_run_id = claimed["runId"].as_str().unwrap().to_string();
    cancel_other_queued_runs(&pool, &expected_run_id).await;

    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": "runner-missing-provider" }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    let leased = read_json(lease).await;
    let run_id = leased["run"]["runId"].as_str().unwrap().to_string();
    assert_eq!(run_id, expected_run_id);
    assert_eq!(leased["run"]["providerAuthAvailable"], false);

    let failed = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/fail"),
            "runner-test-token",
            json!({
                "runnerId": "runner-missing-provider",
                "errorCode": "missing_provider_auth",
                "message": "owner has not enabled Cloud provider auth"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(failed.status(), StatusCode::OK);
    let failed_body = read_json(failed).await;
    assert_eq!(failed_body["run"]["status"], "failed");
    assert_eq!(failed_body["run"]["errorCode"], "missing_provider_auth");
}

#[tokio::test]
async fn runner_endpoints_reject_user_tokens_and_bad_runner_tokens() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = test_router(state);
    let account = signup(&router, "runner-auth-user", "User").await;

    let user_token_response = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            &account.token,
            json!({ "runnerId": "runner-a" }),
        ))
        .await
        .unwrap();
    assert_eq!(user_token_response.status(), StatusCode::UNAUTHORIZED);

    let bad_runner_token_response = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "wrong-runner-token",
            json!({ "runnerId": "runner-a" }),
        ))
        .await
        .unwrap();
    assert_eq!(bad_runner_token_response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn sandbox_group_sessions_reuse_shared_session_sandbox() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "sandbox-group-owner", "Owner").await;
    let requester_a = signup(&router, "sandbox-group-a", "Requester A").await;
    let requester_b = signup(&router, "sandbox-group-b", "Requester B").await;
    accept_contacts(&router, &requester_a, &owner).await;
    accept_contacts(&router, &requester_b, &owner).await;
    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let session_id = format!(
        "session:group:sandbox-shared-{}",
        uuid::Uuid::new_v4().simple()
    );
    let run_a = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester_a.token,
            claim_body_with_session(&owner, &requester_a, "msg_group_a", &session_id),
        ))
        .await
        .unwrap();
    assert_eq!(run_a.status(), StatusCode::OK);
    let run_a_id = read_json(run_a).await["runId"]
        .as_str()
        .unwrap()
        .to_string();

    let run_b = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester_b.token,
            claim_body_with_session(&owner, &requester_b, "msg_group_b", &session_id),
        ))
        .await
        .unwrap();
    assert_eq!(run_b.status(), StatusCode::OK);
    let run_b_id = read_json(run_b).await["runId"]
        .as_str()
        .unwrap()
        .to_string();

    let sandbox_a = run_sandbox_id(&pool, &run_a_id).await.unwrap();
    let sandbox_b = run_sandbox_id(&pool, &run_b_id).await.unwrap();
    assert_eq!(sandbox_a, sandbox_b);
}

#[tokio::test]
async fn sandbox_direct_sessions_are_requester_isolated() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "sandbox-direct-owner", "Owner").await;
    let requester_a = signup(&router, "sandbox-direct-a", "Requester A").await;
    let requester_b = signup(&router, "sandbox-direct-b", "Requester B").await;
    accept_contacts(&router, &requester_a, &owner).await;
    accept_contacts(&router, &requester_b, &owner).await;
    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let session_id = format!(
        "session:direct-person:sandbox-same-{}",
        uuid::Uuid::new_v4().simple()
    );
    let run_a = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester_a.token,
            claim_body_with_session(&owner, &requester_a, "msg_direct_a", &session_id),
        ))
        .await
        .unwrap();
    assert_eq!(run_a.status(), StatusCode::OK);
    let run_a_id = read_json(run_a).await["runId"]
        .as_str()
        .unwrap()
        .to_string();

    let run_b = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester_b.token,
            claim_body_with_session(&owner, &requester_b, "msg_direct_b", &session_id),
        ))
        .await
        .unwrap();
    assert_eq!(run_b.status(), StatusCode::OK);
    let run_b_id = read_json(run_b).await["runId"]
        .as_str()
        .unwrap()
        .to_string();

    let sandbox_a = run_sandbox_id(&pool, &run_a_id).await.unwrap();
    let sandbox_b = run_sandbox_id(&pool, &run_b_id).await.unwrap();
    assert_ne!(sandbox_a, sandbox_b);
}

#[tokio::test]
async fn sandbox_expired_rows_are_not_reused_and_runner_lease_includes_sandbox_id() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "sandbox-expiry-owner", "Owner").await;
    let requester = signup(&router, "sandbox-expiry-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;
    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let session_id = format!(
        "session:group:sandbox-expiry-{}",
        uuid::Uuid::new_v4().simple()
    );
    let first = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body_with_session(&owner, &requester, "msg_expiry_first", &session_id),
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first_run_id = read_json(first).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    let first_sandbox = run_sandbox_id(&pool, &first_run_id).await.unwrap();
    expire_sandbox(&pool, &first_sandbox).await;

    let second = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body_with_session(&owner, &requester, "msg_expiry_second", &session_id),
        ))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::OK);
    let second_run_id = read_json(second).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    let second_sandbox = run_sandbox_id(&pool, &second_run_id).await.unwrap();
    assert_ne!(first_sandbox, second_sandbox);
    cancel_other_queued_runs(&pool, &second_run_id).await;

    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": "runner-sandbox" }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    let lease_body = read_json(lease).await;
    assert_eq!(lease_body["run"]["runId"], second_run_id);
    assert_eq!(lease_body["run"]["sandboxId"], second_sandbox);
}

#[tokio::test]
async fn sandbox_rejected_claim_does_not_create_sandbox_for_unauthorized_requester() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "sandbox-unauth-owner", "Owner").await;
    let intruder = signup(&router, "sandbox-unauth-intruder", "Intruder").await;
    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let session_id = format!(
        "session:group:sandbox-unauth-{}",
        uuid::Uuid::new_v4().simple()
    );
    let rejected = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &intruder.token,
            claim_body_with_session(&owner, &intruder, "msg_unauth_sandbox", &session_id),
        ))
        .await
        .unwrap();

    assert_eq!(rejected.status(), StatusCode::FORBIDDEN);
    assert_eq!(count_sandboxes_for_session(&pool, &session_id).await, 0);
}

#[tokio::test]
async fn runner_explicit_artifact_export_creates_object_backed_chat_attachment() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let store = TestObjectStore::spawn().await;
    let router = test_router_with_s3(pool.clone(), &store);
    let owner = signup(&router, "artifact-owner", "Owner").await;
    let requester = signup(&router, "artifact-requester", "Requester").await;
    let stranger = signup(&router, "artifact-stranger", "Stranger").await;
    accept_contacts(&router, &requester, &owner).await;
    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let run_id = lease_claimed_run_for_export(
        &router,
        &pool,
        &owner,
        &requester,
        "msg_artifact_export",
        "runner-export",
    )
    .await;

    let unexported_count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_run_artifacts WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(unexported_count.0, 0);

    let bytes = b"# Report\nGenerated inside the Cloud sandbox.\n";
    let export = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/artifacts"),
            "runner-test-token",
            export_body("runner-export", "report.md", "report.md", bytes),
        ))
        .await
        .unwrap();
    assert_eq!(export.status(), StatusCode::CREATED);
    let body = read_json(export).await;
    let attachment_id = body["artifact"]["attachmentId"]
        .as_str()
        .unwrap()
        .to_string();
    let message_id = body["artifact"]["messageId"].as_str().unwrap().to_string();
    assert_eq!(body["artifact"]["runId"], run_id);
    assert_eq!(body["artifact"]["name"], "report.md");
    assert_eq!(body["artifact"]["sandboxPath"], "report.md");

    let linked: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_message_attachments WHERE message_id = $1 AND attachment_id = $2",
    )
    .bind(&message_id)
    .bind(&attachment_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(linked.0, 1);

    let requester_content = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/attachments/{attachment_id}/content"),
            &requester.token,
        ))
        .await
        .unwrap();
    assert_eq!(requester_content.status(), StatusCode::OK);
    let requester_bytes = to_bytes(requester_content.into_body(), 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(&requester_bytes[..], bytes);

    let stranger_content = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/attachments/{attachment_id}/content"),
            &stranger.token,
        ))
        .await
        .unwrap();
    assert_eq!(stranger_content.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn runner_artifact_export_rejects_bad_auth_paths_and_sha_mismatch() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let store = TestObjectStore::spawn().await;
    let router = test_router_with_s3(pool.clone(), &store);
    let owner = signup(&router, "artifact-invalid-owner", "Owner").await;
    let requester = signup(&router, "artifact-invalid-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;
    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let run_id = lease_claimed_run_for_export(
        &router,
        &pool,
        &owner,
        &requester,
        "msg_artifact_invalid",
        "runner-invalid",
    )
    .await;

    let user_token = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/artifacts"),
            &requester.token,
            export_body("runner-invalid", "report.md", "report.md", b"ok"),
        ))
        .await
        .unwrap();
    assert_eq!(user_token.status(), StatusCode::UNAUTHORIZED);

    for bad_path in [
        "../secret.txt",
        "/Users/owner/.ssh/id_rsa",
        "/tmp/report.md",
        "~/report.md",
    ] {
        let response = router
            .clone()
            .oneshot(post_json_with_runner_token(
                &format!("/v1/cloud/agent-runs/{run_id}/artifacts"),
                "runner-test-token",
                export_body("runner-invalid", "report.md", bad_path, b"ok"),
            ))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "path={bad_path}"
        );
    }

    let mut bad_sha = export_body("runner-invalid", "report.md", "report.md", b"ok");
    bad_sha["sha256Hex"] =
        json!("0000000000000000000000000000000000000000000000000000000000000000");
    let response = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/artifacts"),
            "runner-test-token",
            bad_sha,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn export_before_completion_uses_stable_response_message_that_completion_updates() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let store = TestObjectStore::spawn().await;
    let router = test_router_with_s3(pool.clone(), &store);
    let owner = signup(&router, "artifact-complete-owner", "Owner").await;
    let requester = signup(&router, "artifact-complete-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;
    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let run_id = lease_claimed_run_for_export(
        &router,
        &pool,
        &owner,
        &requester,
        "msg_artifact_complete",
        "runner-complete",
    )
    .await;

    let export = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/artifacts"),
            "runner-test-token",
            export_body("runner-complete", "report.md", "report.md", b"artifact"),
        ))
        .await
        .unwrap();
    assert_eq!(export.status(), StatusCode::CREATED);
    let message_id = read_json(export).await["artifact"]["messageId"]
        .as_str()
        .unwrap()
        .to_string();

    let complete = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/complete"),
            "runner-test-token",
            json!({ "runnerId": "runner-complete", "responseText": "Here is the exported report." }),
        ))
        .await
        .unwrap();
    assert_eq!(complete.status(), StatusCode::OK);
    assert_eq!(
        read_json(complete).await["run"]["responseMessageId"],
        message_id
    );

    let message: (String,) =
        sqlx_core::query_as::query_as("SELECT body FROM cloud_messages WHERE message_id = $1")
            .bind(&message_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(message.0, "Here is the exported report.");
}

#[tokio::test]
async fn failed_object_upload_does_not_create_visible_placeholder_or_artifact_rows() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let store = TestObjectStore::spawn_rejecting_puts().await;
    let router = test_router_with_s3(pool.clone(), &store);
    let owner = signup(&router, "artifact-upload-fail-owner", "Owner").await;
    let requester = signup(&router, "artifact-upload-fail-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;
    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let run_id = lease_claimed_run_for_export(
        &router,
        &pool,
        &owner,
        &requester,
        "msg_artifact_upload_fail",
        "runner-upload-fail",
    )
    .await;

    let export = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/artifacts"),
            "runner-test-token",
            export_body("runner-upload-fail", "report.md", "report.md", b"report"),
        ))
        .await
        .unwrap();
    assert_eq!(export.status(), StatusCode::BAD_GATEWAY);

    let run_response_message: (Option<String>,) = sqlx_core::query_as::query_as(
        "SELECT response_message_id FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(run_response_message.0, None);

    let artifact_rows: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_run_artifacts WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(artifact_rows.0, 0);
}
