//! Connector tests. Pure tests always run; database tests run against
//! `$DATABASE_URL`. Outside CI they return early when it is unset; in CI
//! (`CI` set) a missing `DATABASE_URL` fails them, so they cannot pass by
//! skipping. A CI job without a database opts out explicitly with
//! `KORDI_CONNECTOR_DB_TESTS=skip`; `scripts/test-cloud-migrations.sh` runs
//! them against its own database. Every database test uses uuid-suffixed
//! data.

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
use super::oauth_complete;
use super::providers::stub::{StubConnectorProvider, STUB, STUB_ACT_TOOL, STUB_READ_TOOL};
use super::providers::{self, ConnectorSecret, ProviderRegistry, ScopeParam};
use super::store::{self, ConnectorOAuthState};
use super::ConnectorRuntime;
use crate::cloud_agent_runtime::provider_auth::{ProviderAuthCipher, ProviderAuthCipherError};
use crate::events::EventBus;
use crate::server::ServerState;

mod audience_tests;
mod broker_tests;
mod completion_tests;
mod delivery_tests;
mod google_provider_tests;
mod http_stub;
mod isolation_tests;
mod lifecycle_tests;
mod models_tests;
mod oauth_tests;
mod polling_tests;
mod providers_tests;
mod refresh_tests;
mod routes_tests;
mod safety_tests;
mod service_fixture;
mod sweep_tests;
mod webhook_tests;

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
        settings: json!({}),
        provider_account_id: Some("provider-user".into()),
        last_event_at: Some(now),
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
    let skip_requested = std::env::var("KORDI_CONNECTOR_DB_TESTS").as_deref() == Ok("skip");
    let url = match std::env::var("DATABASE_URL") {
        Ok(url) if !url.trim().is_empty() => url,
        _ if skip_requested => return None,
        _ if std::env::var_os("CI").is_some() => panic!(
            "connector database tests need DATABASE_URL in CI. Run them through \
             scripts/test-cloud-migrations.sh, or set KORDI_CONNECTOR_DB_TESTS=skip \
             in a job that has no database."
        ),
        _ => return None,
    };
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

/// Runs the start and callback steps for `account_id` and returns the
/// completion code the callback parked.
async fn pending_stub_grant(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    account_id: &str,
    grant: ConnectorToolGroup,
    code: &str,
) -> String {
    let auth_url = oauth::start_grant(pool, runtime, account_id, STUB.id, grant, None)
        .await
        .unwrap();
    let outcome = oauth::complete_grant(
        pool,
        runtime,
        Some(&state_from_auth_url(&auth_url)),
        Some(code),
        None,
    )
    .await;
    let fragment = outcome.result.unwrap();
    assert_eq!(fragment.status, "pending");
    fragment.completion_code
}

/// Connects the stub provider for `account_id` through the real OAuth flow,
/// including the authenticated completion step.
async fn connect_stub(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    account_id: &str,
    grant: ConnectorToolGroup,
) -> String {
    let code = pending_stub_grant(pool, runtime, account_id, grant, "code-1").await;
    oauth_complete::finish_grant(pool, runtime, account_id, &code)
        .await
        .unwrap()
        .connector_id
}

async fn count_rows(pool: &PgPool, sql: &str, bind: &str) -> i64 {
    let (n,): (i64,) = query_as(sql).bind(bind).fetch_one(pool).await.unwrap();
    n
}

/// Fails if `value` contains any stub credential string.
fn assert_no_stub_credentials(label: &str, value: &Value) {
    let text = value.to_string();
    for needle in ["stub-access", "stub-refresh"] {
        assert!(!text.contains(needle), "{label} leaks {needle}: {text}");
    }
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
