//! Connector tests. Pure tests always run; database tests follow the crate
//! convention and run against `$DATABASE_URL`, returning early when it is
//! unset. Every database test uses uuid-suffixed data.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use chrono::{Duration as ChronoDuration, Utc};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, PgPoolOptions};
use tower::ServiceExt;
use uuid::Uuid;

use super::broker::{self, codes};
use super::events::{self, NewConnectorEvent};
use super::models::*;
use super::oauth::{self, StateError};
use super::providers::stub::{StubConnectorProvider, STUB, STUB_ACT_TOOL, STUB_READ_TOOL};
use super::providers::{self, ConnectorSecret, ProviderRegistry, ScopeParam};
use super::store::{self, ConnectorOAuthState};
use super::ConnectorRuntime;
use crate::cloud_agent_runtime::provider_auth::{ProviderAuthCipher, ProviderAuthCipherError};
use crate::events::EventBus;
use crate::server::ServerState;

mod audience_tests;
mod broker_tests;
mod delivery_tests;
mod lifecycle_tests;
mod models_tests;
mod oauth_tests;
mod routes_tests;

// ---------------------------------------------------------------------------
// Fixtures

/// Reversible test cipher with the same layout as the provider-auth cipher:
/// a 12-byte nonce followed by the payload.
struct TestCipher;

impl ProviderAuthCipher for TestCipher {
    fn key_id(&self) -> &str {
        "test:v3"
    }

    fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, ProviderAuthCipherError> {
        let nonce: [u8; 12] = rand::random();
        let mut out = nonce.to_vec();
        out.extend(
            plaintext
                .iter()
                .enumerate()
                .map(|(i, byte)| byte ^ nonce[i % 12] ^ 0x5a),
        );
        Ok(out)
    }

    fn decrypt(&self, ciphertext: &[u8]) -> Result<Vec<u8>, ProviderAuthCipherError> {
        if ciphertext.len() <= 12 {
            return Err(ProviderAuthCipherError::InvalidCiphertext);
        }
        let (nonce, payload) = ciphertext.split_at(12);
        Ok(payload
            .iter()
            .enumerate()
            .map(|(i, byte)| byte ^ nonce[i % 12] ^ 0x5a)
            .collect())
    }
}

fn stub_runtime() -> (ConnectorRuntime, Arc<StubConnectorProvider>) {
    let stub = Arc::new(StubConnectorProvider::default());
    let mut registry = ProviderRegistry::default();
    registry.insert(stub.clone());
    (
        ConnectorRuntime::new(Some(Arc::new(TestCipher)), registry),
        stub,
    )
}

fn record(status: ConnectorStatus, act_enabled: bool) -> ConnectorRecord {
    let now = Utc::now();
    ConnectorRecord {
        connector_id: "conn_sample".into(),
        account_id: "acct_sample".into(),
        provider: "google_calendar".into(),
        status,
        read_scopes: vec!["calendar.readonly".into()],
        act_scopes: vec!["calendar.events".into()],
        act_enabled,
        created_at: now,
        updated_at: now,
        revoked_at: (status == ConnectorStatus::Revoked).then_some(now),
    }
}

fn lazy_state(runtime: ConnectorRuntime) -> Arc<ServerState> {
    let pool = PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1/unused")
        .unwrap();
    Arc::new(ServerState::new(pool, EventBus::noop()).with_connector_runtime(runtime))
}

async fn body_json(response: axum::response::Response) -> Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

fn collect_keys(value: &Value, keys: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, nested) in map {
                keys.push(key.clone());
                collect_keys(nested, keys);
            }
        }
        Value::Array(items) => items.iter().for_each(|item| collect_keys(item, keys)),
        _ => {}
    }
}

fn is_secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    ["token", "secret", "refresh", "ciphertext", "nonce"]
        .iter()
        .any(|needle| lower.contains(needle))
}

fn assert_no_secret_keys(label: &str, value: Value) {
    let mut keys = Vec::new();
    collect_keys(&value, &mut keys);
    assert!(!keys.is_empty(), "{label} serialized no keys");
    let offending = keys
        .iter()
        .filter(|key| is_secret_key(key))
        .collect::<Vec<_>>();
    assert!(
        offending.is_empty(),
        "{label} exposes secret-shaped keys: {offending:?}"
    );
}

// ---------------------------------------------------------------------------
// Database tests

async fn pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    Some(crate::pg::init_pool(&url).await.expect("init test pool"))
}

/// Creates an account with a device and returns (account_id, session token).
async fn signed_in_account(pool: &PgPool, label: &str) -> (String, String) {
    let suffix = Uuid::new_v4().simple().to_string();
    let account_id = format!("acct_conn_{label}_{suffix}");
    let device_id = format!("dev_conn_{label}_{suffix}");
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
    query(
        "INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, \
         created_at, last_seen_at) VALUES ($1, $2, 'Connector device', $3, $4, $4)",
    )
    .bind(&device_id)
    .bind(&account_id)
    .bind(format!("legacy:{suffix}"))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    let session = crate::auth::session::issue_session(pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    (account_id, session.plaintext_token)
}

fn state_from_auth_url(auth_url: &str) -> String {
    url::Url::parse(auth_url)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .to_string()
}

/// Connects the stub provider for `account_id` through the real OAuth flow.
async fn connect_stub(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    account_id: &str,
    grant: ConnectorToolGroup,
) -> String {
    let auth_url = oauth::start_grant(pool, runtime, account_id, STUB.id, grant, None)
        .await
        .unwrap();
    let outcome = oauth::complete_grant(
        pool,
        runtime,
        Some(&state_from_auth_url(&auth_url)),
        Some("code-1"),
        None,
    )
    .await;
    outcome.result.unwrap().connector_id
}

async fn audit_outcomes(pool: &PgPool, connector_id: &str) -> Vec<(String, String)> {
    query_as(
        "SELECT tool, outcome FROM cloud_connector_audit WHERE connector_id = $1 \
         ORDER BY created_at, audit_id",
    )
    .bind(connector_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

fn authed(method: &str, uri: &str, token: &str, body: Option<Value>) -> Request<Body> {
    let builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {token}"));
    match body {
        Some(body) => builder
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    }
}
