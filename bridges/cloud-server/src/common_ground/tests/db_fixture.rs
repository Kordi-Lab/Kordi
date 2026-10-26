//! Fixtures for the Common ground database tests. They run against
//! `$DATABASE_URL` with the same skip rule as the connector and shared
//! document tests: outside CI they return early when it is unset; in CI a
//! missing URL fails unless `KORDI_CONNECTOR_DB_TESTS=skip`.

use std::sync::Arc;

use axum::body::Body;
use axum::http::Request;
use axum::Router;
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::Value;
use sqlx_core::query::query;
use sqlx_postgres::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use crate::events::EventBus;
use crate::server::ServerState;

pub(crate) async fn pool() -> Option<PgPool> {
    let skip_requested = std::env::var("KORDI_CONNECTOR_DB_TESTS").as_deref() == Ok("skip");
    let url = match std::env::var("DATABASE_URL") {
        Ok(url) if !url.trim().is_empty() => url,
        _ if skip_requested => return None,
        _ if std::env::var_os("CI").is_some() => panic!(
            "Common ground database tests need DATABASE_URL in CI. Run them through \
             scripts/test-cloud-migrations.sh, or set KORDI_CONNECTOR_DB_TESTS=skip \
             in a job that has no database."
        ),
        _ => return None,
    };
    Some(crate::pg::init_pool(&url).await.expect("init test pool"))
}

pub(crate) async fn account(pool: &PgPool, label: &str) -> String {
    let account_id = format!("acct_cg_{label}_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, created_at, updated_at, avatar_source, \
          avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, $2, $3, $4, $4, 'generated', 'lorelei', $1, 'fixture', 1, $4)",
    )
    .bind(&account_id)
    .bind(label)
    .bind(format!("{account_id}@example.test"))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    account_id
}

/// An account with a device and a session; returns (account_id, token).
pub(crate) async fn signed_in(pool: &PgPool, label: &str) -> (String, String) {
    let account_id = account(pool, label).await;
    let device_id = format!("dev_{account_id}");
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, \
         created_at, last_seen_at) VALUES ($1, $2, 'Test device', $3, $4, $4)",
    )
    .bind(&device_id)
    .bind(&account_id)
    .bind(format!("legacy:{device_id}"))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    let session = crate::auth::session::issue_session(pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    (account_id, session.plaintext_token)
}

/// The router with the System agent configured as `service`, so card builds can
/// queue.
pub(crate) fn app(pool: &PgPool, service: Option<&str>) -> Router {
    let mut state = ServerState::new(pool.clone(), EventBus::noop());
    if let Some(service) = service {
        state = state.with_system_agent(crate::system_agent::SystemAgentService::new(
            crate::system_agent::test_config(service),
        ));
    }
    crate::server::router(Arc::new(state))
}

pub(crate) async fn send(
    app: &Router,
    method: &str,
    path: &str,
    token: &str,
    body: Option<Value>,
) -> (u16, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {token}"));
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}
