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
use base64::Engine as _;
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

fn encode_test_cloud_group_envelope(envelope: Value) -> String {
    format!(
        "kordi-cloud-group:{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(envelope.to_string())
    )
}

fn decode_test_cloud_group_envelope(body: &str) -> Value {
    let encoded = body
        .trim()
        .strip_prefix("kordi-cloud-group:")
        .expect("cloud group envelope prefix");
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .expect("valid cloud group envelope base64");
    serde_json::from_slice(&bytes).expect("valid cloud group envelope json")
}

async fn insert_leased_scheduled_run(
    pool: &sqlx_postgres::PgPool,
    owner: &TestAccount,
    requester: &TestAccount,
    session_id: &str,
    runner_id: &str,
) -> String {
    let run_id = format!("run_{}", uuid::Uuid::new_v4().simple());
    let request_message_id = format!("scheduled_run_{}", uuid::Uuid::new_v4().simple());
    let now = chrono::Utc::now().to_rfc3339();
    sqlx_core::query::query(
        "INSERT INTO cloud_agent_fallback_runs \
         (run_id, idempotency_key, request_message_id, session_id, owner_account_id, requester_account_id, status, prompt, claimed_by, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, 'leased', 'Reminder due', $7, $8, $8)",
    )
    .bind(&run_id)
    .bind(format!("scheduled:{}:{}", session_id, request_message_id))
    .bind(&request_message_id)
    .bind(session_id)
    .bind(&owner.account_id)
    .bind(&requester.account_id)
    .bind(runner_id)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    run_id
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

#[path = "cloud_agent_runtime_e2e/artifacts.rs"]
mod artifacts;
#[path = "cloud_agent_runtime_e2e/claims.rs"]
mod claims;
#[path = "cloud_agent_runtime_e2e/provider_auth.rs"]
mod provider_auth;
#[path = "cloud_agent_runtime_e2e/runner.rs"]
mod runner;
#[path = "cloud_agent_runtime_e2e/sandboxes.rs"]
mod sandboxes;
#[path = "cloud_agent_runtime_e2e/scheduled_runs.rs"]
mod scheduled_runs;
