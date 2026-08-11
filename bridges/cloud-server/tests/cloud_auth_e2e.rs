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
            "avatarUrl": "data:image/png;base64,iVBORw0KGgo=",
        })
        .to_string(),
    )
}

async fn signup_account(router: &axum::Router, prefix: &str) -> (String, String) {
    let response = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&unique_email(prefix), "correct horse"),
        ))
        .await
        .unwrap();
    let body = read_json(response).await;
    (
        body["session"]["token"].as_str().unwrap().to_string(),
        body["account"]["accountId"].as_str().unwrap().to_string(),
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

fn post_json_with_token(uri: &str, token: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
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

async fn read_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    if bytes.is_empty() {
        return serde_json::Value::Null;
    }
    serde_json::from_slice(&bytes).unwrap()
}

#[path = "cloud_auth_e2e/account_auth.rs"]
mod account_auth;
#[path = "cloud_auth_e2e/group_invitations.rs"]
mod group_invitations;
#[path = "cloud_auth_e2e/public_identity.rs"]
mod public_identity;
#[path = "cloud_auth_e2e/session_and_presence.rs"]
mod session_and_presence;
