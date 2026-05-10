//! End-to-end integration tests against a real Postgres at `$DATABASE_URL`.
//!
//! Skipped (not failed) when `DATABASE_URL` is not set, so `cargo test` on
//! a developer laptop without the cluster port-forward still runs green.
//! In CI / local dev with the cluster, run:
//!
//!   kubectl -n kordi-cloud port-forward svc/postgres 5432:5432 &
//!   PG_PASS=$(kubectl -n kordi-cloud get secret postgres-credentials \
//!     -o jsonpath='{.data.password}' | base64 -d)
//!   DATABASE_URL="postgresql://kordi:$PG_PASS@127.0.0.1:5432/kordi_cloud" \
//!     cargo test -p kordi-cloud-server --test cloud_auth_e2e
//!
//! Each test uses uuid-suffixed emails / account ids so they don't collide
//! with each other or with existing data when run against a shared DB.

use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use kordi_cloud_server::auth::password::PasswordHasherConfig;
use kordi_cloud_server::auth::rate_limit::{CloudRateLimitConfig, CloudRateLimiter};
use kordi_cloud_server::auth::routes::routes_with_config;
use kordi_cloud_server::events::EventBus;
use kordi_cloud_server::pg::init_pool;
use kordi_cloud_server::server::ServerState;
use serde_json::json;
use tower::util::ServiceExt;

async fn try_pool() -> Option<sqlx_postgres::PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    match init_pool(&url).await {
        Ok(pool) => Some(pool),
        Err(err) => {
            eprintln!("[cloud_auth_e2e] init_pool failed, skipping: {err}");
            None
        }
    }
}

fn fast_router(state: Arc<ServerState>) -> axum::Router {
    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig {
        per_ip_limit: 10_000,
        per_ip_window: Duration::from_secs(60),
        per_email_failure_limit: 5,
        per_email_lockout: Duration::from_secs(900),
    });
    routes_with_config(state, PasswordHasherConfig::for_tests(), limiter)
}

fn unique_email(prefix: &str) -> String {
    format!("{prefix}-{}@e2e.local", uuid::Uuid::new_v4().simple())
}

fn signup_body(email: &str, password: &str) -> Body {
    Body::from(
        json!({
            "email": email,
            "password": password,
            "displayName": "E2E",
            "avatarSeed": "cloud-signup:e2e",
        })
        .to_string(),
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

fn get_with_token(uri: &str, token: &str) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
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

async fn read_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    if bytes.is_empty() {
        return serde_json::Value::Null;
    }
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn pool_init_runs_migrations() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping");
        return;
    };
    // After init_pool the migrations have run; a SELECT against
    // cloud_schema_versions should return at least the v1 row.
    let count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_schema_versions WHERE version >= 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(count.0 >= 1, "expected at least migration v1 to be applied");
}

#[tokio::test]
async fn signup_happy_path_returns_session_and_persists_account() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("signup-happy");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let response = router
        .clone()
        .oneshot(post("/v1/cloud/auth/signup", signup_body(&email, "correct horse")))
        .await
        .unwrap();
    let status = response.status();
    let body = read_json(response).await;
    assert_eq!(status, StatusCode::CREATED, "got body {body}");
    assert!(body["session"]["token"]
        .as_str()
        .unwrap()
        .starts_with("kordi_cs_"));
    assert_eq!(body["account"]["primaryEmail"], email);
    assert_eq!(body["account"]["passwordSet"], true);

    // Verify the row landed in Postgres.
    let row: (String, String) = sqlx_core::query_as::query_as(
        "SELECT account_id, primary_email FROM cloud_accounts WHERE LOWER(primary_email) = $1",
    )
    .bind(&email)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(row.0.starts_with("acct_"));
    assert_eq!(row.1, email);
}

#[tokio::test]
async fn signup_duplicate_email_returns_409() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("dupe-email");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);

    let _ = router
        .clone()
        .oneshot(post("/v1/cloud/auth/signup", signup_body(&email, "correct horse")))
        .await
        .unwrap();
    let second = router
        .oneshot(post("/v1/cloud/auth/signup", signup_body(&email, "another password")))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::CONFLICT);
    let body = read_json(second).await;
    assert_eq!(body["errorCode"], "email_in_use");
}

#[tokio::test]
async fn login_with_correct_password_returns_session_and_me_works() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("login");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);

    // signup
    let _ = router
        .clone()
        .oneshot(post("/v1/cloud/auth/signup", signup_body(&email, "correct horse")))
        .await
        .unwrap();

    // login
    let login_resp = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/login",
            Body::from(json!({"email": &email, "password": "correct horse"}).to_string()),
        ))
        .await
        .unwrap();
    assert_eq!(login_resp.status(), StatusCode::OK);
    let login_body = read_json(login_resp).await;
    let token = login_body["session"]["token"].as_str().unwrap().to_string();

    // /me
    let me_resp = router
        .oneshot(get_with_token("/v1/cloud/auth/me", &token))
        .await
        .unwrap();
    assert_eq!(me_resp.status(), StatusCode::OK);
    let me_body = read_json(me_resp).await;
    assert_eq!(me_body["primaryEmail"], email);
}

#[tokio::test]
async fn login_with_wrong_password_returns_401() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("wrong-pass");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);

    let _ = router
        .clone()
        .oneshot(post("/v1/cloud/auth/signup", signup_body(&email, "correct horse")))
        .await
        .unwrap();

    let bad = router
        .oneshot(post(
            "/v1/cloud/auth/login",
            Body::from(json!({"email": &email, "password": "WRONG"}).to_string()),
        ))
        .await
        .unwrap();
    assert_eq!(bad.status(), StatusCode::UNAUTHORIZED);
    let body = read_json(bad).await;
    assert_eq!(body["errorCode"], "invalid_credentials");
}

#[tokio::test]
async fn logout_invalidates_session_token() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("logout");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);

    let signup_resp = router
        .clone()
        .oneshot(post("/v1/cloud/auth/signup", signup_body(&email, "correct horse")))
        .await
        .unwrap();
    let token = read_json(signup_resp).await["session"]["token"]
        .as_str()
        .unwrap()
        .to_string();

    let logout_resp = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/auth/logout", &token))
        .await
        .unwrap();
    assert_eq!(logout_resp.status(), StatusCode::NO_CONTENT);

    let me_after = router
        .oneshot(get_with_token("/v1/cloud/auth/me", &token))
        .await
        .unwrap();
    assert_eq!(me_after.status(), StatusCode::UNAUTHORIZED);
}
