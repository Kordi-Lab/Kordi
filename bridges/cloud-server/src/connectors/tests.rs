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

// ---------------------------------------------------------------------------
// 1. Response shape

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

#[test]
fn no_connector_response_type_has_a_secret_shaped_key() {
    assert!(is_secret_key("accessToken") && is_secret_key("refresh_ciphertext"));
    let summary = ConnectorSummary::from_record(
        record(ConnectorStatus::Revoked, true),
        vec!["cloud-agent:acct_sample".into()],
    );
    let audit = ConnectorAuditEntry {
        audit_id: "cnaud_1".into(),
        connector_id: "conn_sample".into(),
        run_id: Some("run_1".into()),
        agent_id: Some("agent_1".into()),
        tool: "calendar.list_events".into(),
        tool_group: ConnectorToolGroup::Read,
        outcome: "completed".into(),
        summary: "Completed.".into(),
        created_at: Utc::now().to_rfc3339(),
    };
    let samples: Vec<(&str, Value)> = vec![
        ("ConnectorSummary", serde_json::to_value(&summary).unwrap()),
        (
            "ConnectorListResponse",
            serde_json::to_value(ConnectorListResponse {
                connectors: vec![summary.clone()],
            })
            .unwrap(),
        ),
        (
            "ConnectorResponse",
            serde_json::to_value(ConnectorResponse {
                connector: summary.clone(),
            })
            .unwrap(),
        ),
        (
            "OAuthStartResponse",
            serde_json::to_value(OAuthStartResponse {
                auth_url: "https://example.test/authorize".into(),
            })
            .unwrap(),
        ),
        (
            "OAuthCompletedFragment",
            serde_json::to_value(OAuthCompletedFragment {
                connector_id: "conn_sample".into(),
                provider: "github".into(),
                grant: ConnectorToolGroup::Act,
                status: ConnectorStatus::Connected,
            })
            .unwrap(),
        ),
        ("ConnectorAuditEntry", serde_json::to_value(&audit).unwrap()),
        (
            "ConnectorAuditResponse",
            serde_json::to_value(ConnectorAuditResponse {
                entries: vec![audit],
                next_before: Some(Utc::now().to_rfc3339()),
            })
            .unwrap(),
        ),
        (
            "DisconnectResponse",
            serde_json::to_value(DisconnectResponse { deleted_events: 3 }).unwrap(),
        ),
        (
            "BrokerCallResponse(ok)",
            serde_json::to_value(BrokerCallResponse::success(json!({ "items": [] }))).unwrap(),
        ),
        (
            "BrokerCallResponse(error)",
            serde_json::to_value(BrokerCallResponse::failure("denied", "Denied.")).unwrap(),
        ),
    ];
    for (label, value) in samples {
        assert_no_secret_keys(label, value);
    }
}

/// `ConnectorSummary` is built only from `ConnectorRecord`, which is loaded
/// with `CONNECTOR_COLUMNS`. `ConnectorSummary::from_record` destructures the
/// record exhaustively, so adding a field fails to compile until reviewed;
/// this test pins the column list to `cloud_connectors` columns.
#[test]
fn connector_summary_is_built_from_cloud_connectors_columns_only() {
    let columns = CONNECTOR_COLUMNS
        .split(',')
        .map(str::trim)
        .collect::<Vec<_>>();
    assert_eq!(
        columns,
        [
            "connector_id",
            "account_id",
            "provider",
            "status",
            "read_scopes",
            "act_scopes",
            "act_enabled",
            "created_at",
            "updated_at",
            "revoked_at"
        ]
    );
    assert!(columns.iter().all(|column| !is_secret_key(column)));
    let migration = include_str!("../../migrations/0114_cloud_connectors.sql");
    let table = migration
        .split("CREATE TABLE cloud_connectors (")
        .nth(1)
        .and_then(|rest| rest.split(");").next())
        .unwrap();
    for column in columns {
        assert!(
            table.contains(&format!("    {column} ")),
            "{column} is not a cloud_connectors column"
        );
    }
}

#[test]
fn connector_secret_debug_redacts_tokens() {
    let secret = ConnectorSecret {
        access_token: "plain-access".into(),
        refresh_token: Some("plain-refresh".into()),
        expires_at: None,
    };
    let rendered = format!("{secret:?}");
    assert!(!rendered.contains("plain-access") && !rendered.contains("plain-refresh"));
}

// ---------------------------------------------------------------------------
// 2. allowed_tool_groups

#[test]
fn allowed_tool_groups_covers_every_combination() {
    use ConnectorStatus::*;
    use ConnectorToolGroup::*;
    use RunTrigger::*;
    let cases = [
        (Connected, false, PersonStarted, vec![Read]),
        (Connected, false, Background, vec![Read]),
        (Connected, true, PersonStarted, vec![Read, Act]),
        (Connected, true, Background, vec![Read]),
        (NeedsReauth, false, PersonStarted, vec![]),
        (NeedsReauth, false, Background, vec![]),
        (NeedsReauth, true, PersonStarted, vec![]),
        (NeedsReauth, true, Background, vec![]),
        (Revoked, false, PersonStarted, vec![]),
        (Revoked, false, Background, vec![]),
        (Revoked, true, PersonStarted, vec![]),
        (Revoked, true, Background, vec![]),
    ];
    for (status, act_enabled, trigger, expected) in cases {
        assert_eq!(
            allowed_tool_groups(&record(status, act_enabled), trigger),
            expected,
            "{status:?} act_enabled={act_enabled} {trigger:?}"
        );
    }
}

#[test]
fn background_runs_never_receive_act_tool_descriptors() {
    let stub = StubConnectorProvider::default();
    let connector = record(ConnectorStatus::Connected, true);
    let names = |trigger| {
        broker::tools_for_trigger(&connector, &stub, trigger)
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>()
    };
    assert_eq!(names(RunTrigger::Background), [STUB_READ_TOOL]);
    assert_eq!(
        names(RunTrigger::PersonStarted),
        [STUB_READ_TOOL, STUB_ACT_TOOL]
    );
}

// ---------------------------------------------------------------------------
// Providers, sealing, OAuth helpers

#[test]
fn provider_catalog_has_read_and_act_scopes_for_every_provider() {
    let ids = providers::PROVIDER_SPECS
        .iter()
        .map(|spec| spec.id)
        .collect::<Vec<_>>();
    assert_eq!(ids, ["google_calendar", "gmail", "github", "slack"]);
    for spec in providers::PROVIDER_SPECS {
        assert!(!spec.read_scopes.is_empty() && !spec.act_scopes.is_empty());
        assert!(spec
            .read_scopes
            .iter()
            .all(|scope| !spec.act_scopes.contains(scope)));
        assert!(providers::client_id_env(spec).starts_with("KORDI_CONNECTOR_"));
        assert!(!providers::client_id_env(spec).contains("OAUTH"));
    }
    assert!(providers::provider_spec("outlook").is_none());
    assert!(providers::NOT_YET_AVAILABLE_PROVIDERS.contains(&"outlook"));
}

#[test]
fn oauth_client_requires_both_halves() {
    assert!(providers::oauth_client_from_values("id", " ", "https://kordi.ai").is_none());
    assert!(providers::oauth_client_from_values("", "secret", "https://kordi.ai").is_none());
    let client = providers::oauth_client_from_values("id", "secret", "https://kordi.ai/").unwrap();
    assert_eq!(
        client.redirect_uri,
        "https://kordi.ai/v1/cloud/connectors/oauth/callback"
    );
    assert!(!format!("{client:?}").contains("secret\""));
}

#[test]
fn auth_url_carries_grant_scopes_state_and_pkce() {
    let client = providers::oauth_client_from_values("cid", "csecret", "https://kordi.ai").unwrap();
    let url = url::Url::parse(&oauth::build_auth_url(
        &providers::GMAIL,
        &client,
        ConnectorToolGroup::Act,
        "state_1",
        "verifier",
    ))
    .unwrap();
    let pairs = url
        .query_pairs()
        .into_owned()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(pairs["state"], "state_1");
    assert_eq!(pairs["code_challenge_method"], "S256");
    assert_eq!(pairs["access_type"], "offline");
    let scopes = pairs["scope"].split(' ').collect::<Vec<_>>();
    assert!(scopes.contains(&"https://www.googleapis.com/auth/gmail.readonly"));
    assert!(scopes.contains(&"https://www.googleapis.com/auth/gmail.send"));
    assert!(!url.as_str().contains("csecret"));

    let read_only = oauth::build_auth_url(
        &providers::SLACK,
        &client,
        ConnectorToolGroup::Read,
        "state_2",
        "verifier",
    );
    let slack = url::Url::parse(&read_only).unwrap();
    let user_scope = slack
        .query_pairs()
        .find(|(key, _)| key == "user_scope")
        .unwrap()
        .1
        .to_string();
    assert_eq!(providers::SLACK.scope_param, ScopeParam::SlackUserScope);
    assert!(user_scope.contains("channels:history") && !user_scope.contains("chat:write"));
    assert!(!read_only.contains("code_challenge"));
}

#[test]
fn granted_scopes_are_split_into_read_and_act() {
    let (read, act) =
        oauth::classify_granted_scopes(&providers::GITHUB, ConnectorToolGroup::Act, None);
    assert_eq!(read, ["read:user", "notifications"]);
    assert_eq!(act, ["repo"]);
    let granted = vec!["read:user".to_string()];
    let (read, act) =
        oauth::classify_granted_scopes(&providers::GITHUB, ConnectorToolGroup::Act, Some(&granted));
    assert_eq!(read, ["read:user"]);
    assert!(act.is_empty(), "act scopes the person unchecked stay off");
    let (_, act) =
        oauth::classify_granted_scopes(&providers::GITHUB, ConnectorToolGroup::Read, None);
    assert!(act.is_empty());
}

#[test]
fn token_responses_normalize_across_providers() {
    let now = Utc::now();
    let google = providers::token_grant_from_json(
        &json!({"access_token":"a","refresh_token":"r","expires_in":3600,"scope":"x y"}),
        None,
        now,
    )
    .unwrap();
    assert_eq!(google.secret.refresh_token.as_deref(), Some("r"));
    assert_eq!(
        google.secret.expires_at,
        Some(now + ChronoDuration::seconds(3600))
    );
    assert_eq!(google.granted_scopes.unwrap(), ["x", "y"]);

    let slack = providers::token_grant_from_json(
        &json!({"ok":true,"authed_user":{"access_token":"u","scope":"a,b"}}),
        Some("kept"),
        now,
    )
    .unwrap();
    assert_eq!(slack.secret.access_token, "u");
    assert_eq!(slack.secret.refresh_token.as_deref(), Some("kept"));
    assert_eq!(slack.granted_scopes.unwrap(), ["a", "b"]);

    assert!(
        providers::token_grant_from_json(&json!({"ok":false,"error":"bad"}), None, now).is_err()
    );
    assert!(providers::token_grant_from_json(&json!({}), None, now).is_err());
}

#[test]
fn sealed_secrets_split_nonce_and_round_trip() {
    let secret = ConnectorSecret {
        access_token: "access-value".into(),
        refresh_token: Some("refresh-value".into()),
        expires_at: Some(Utc::now()),
    };
    let sealed = broker::seal_secret(&TestCipher, &secret).unwrap();
    assert_eq!(sealed.nonce.len(), 12);
    assert_eq!(sealed.key_version, 3);
    assert!(!String::from_utf8_lossy(&sealed.ciphertext).contains("access-value"));
    assert_eq!(broker::open_secret(&TestCipher, &sealed).unwrap(), secret);
    assert_eq!(broker::key_version_from_id("env:v1"), 1);
    assert_eq!(broker::key_version_from_id("local-debug:v12"), 12);
    assert_eq!(broker::key_version_from_id("custom"), 1);
}

// ---------------------------------------------------------------------------
// 6. OAuth state helper

fn sample_state(expires_in_minutes: i64) -> ConnectorOAuthState {
    ConnectorOAuthState {
        state_id: "connector_state_x".into(),
        account_id: "acct_owner".into(),
        provider: "github".into(),
        grant: ConnectorToolGroup::Read,
        redirect_after: None,
        code_verifier: "verifier".into(),
        expires_at: Utc::now() + ChronoDuration::minutes(expires_in_minutes),
    }
}

#[test]
fn consumed_state_is_checked_for_use_and_expiry() {
    let now = Utc::now();
    let live = oauth::check_consumed_state(Some(sample_state(10)), now).unwrap();
    assert_eq!(live.account_id, "acct_owner");
    assert_eq!(
        oauth::check_consumed_state(None, now),
        Err(StateError::UnknownOrUsed)
    );
    assert_eq!(
        oauth::check_consumed_state(Some(sample_state(-1)), now),
        Err(StateError::Expired)
    );
}

#[test]
fn callback_redirects_carry_the_result_in_the_fragment() {
    let ok = oauth::CallbackOutcome {
        redirect_after: Some("kordi-beta://oauth/callback".into()),
        result: Ok(OAuthCompletedFragment {
            connector_id: "conn_1".into(),
            provider: "github".into(),
            grant: ConnectorToolGroup::Read,
            status: ConnectorStatus::Connected,
        }),
    };
    let url = oauth::callback_redirect_url("kordi-beta://oauth/callback", &ok);
    assert!(url.starts_with("kordi-beta://oauth/callback#kordi_connector="));
    let failed = oauth::CallbackOutcome {
        redirect_after: None,
        result: Err(oauth::CallbackError {
            code: "provider_denied",
            message: "Access was not granted.".into(),
        }),
    };
    let url = oauth::callback_redirect_url("http://127.0.0.1:1420/x#a=1", &failed);
    assert!(url.ends_with(
        "#a=1&kordi_connector_error=Access%20was%20not%20granted.&kordi_connector_error_code=provider_denied"
    ));
}

#[test]
fn event_retention_defaults_to_thirty_days() {
    assert_eq!(events::retention_days_from(None), 30);
    assert_eq!(events::retention_days_from(Some("7")), 7);
    assert_eq!(events::retention_days_from(Some("0")), 30);
    assert_eq!(events::retention_days_from(Some("9999")), 30);
    assert_eq!(events::retention_days_from(Some("x")), 30);
}

// ---------------------------------------------------------------------------
// 5. Capabilities and route wiring (no database needed)

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

#[tokio::test]
async fn capabilities_report_connectors_version() {
    let app = crate::server::router(lazy_state(stub_runtime().0));
    let response = app
        .oneshot(
            Request::get("/v1/cloud/auth/capabilities")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert_eq!(body["connectorsVersion"], 1);
    assert_eq!(body["password"], true);
    assert!(body["oauthProviders"].is_array());
}

#[tokio::test]
async fn connector_routes_require_a_session_or_the_runner_token() {
    let app = crate::server::router(lazy_state(stub_runtime().0));
    let list = app
        .clone()
        .oneshot(
            Request::get("/v1/cloud/connectors")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(list.status(), StatusCode::UNAUTHORIZED);
    let broker = app
        .clone()
        .oneshot(
            Request::post(super::routes::BROKER_CALL_PATH)
                .header("content-type", "application/json")
                .header("authorization", "Bearer not-the-runner-token")
                .body(Body::from(
                    json!({"leaseId":"l","accountId":"a","agentId":"g","trigger":"background",
                           "connectorId":"c","tool":"t","args":{}})
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(broker.status(), StatusCode::UNAUTHORIZED);
    let callback = app
        .oneshot(
            Request::get("/v1/cloud/connectors/oauth/callback")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(callback.status(), StatusCode::BAD_REQUEST);
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

fn call(
    account_id: &str,
    connector_id: &str,
    trigger: RunTrigger,
    tool: &str,
) -> BrokerCallRequest {
    BrokerCallRequest {
        lease_id: format!("run_{}", Uuid::new_v4().simple()),
        account_id: account_id.to_string(),
        agent_id: store::default_agent_id(account_id),
        trigger,
        connector_id: connector_id.to_string(),
        tool: tool.to_string(),
        args: json!({ "q": "today" }),
    }
}

#[tokio::test]
async fn oauth_state_is_one_use_and_bound_to_the_account() {
    let Some(pool) = pool().await else { return };
    let (runtime, stub) = stub_runtime();
    let (owner, _) = signed_in_account(&pool, "state_owner").await;
    let auth_url = oauth::start_grant(
        &pool,
        &runtime,
        &owner,
        STUB.id,
        ConnectorToolGroup::Read,
        None,
    )
    .await
    .unwrap();
    let state_id = state_from_auth_url(&auth_url);
    let first = oauth::complete_grant(&pool, &runtime, Some(&state_id), Some("c1"), None).await;
    let connector_id = first.result.unwrap().connector_id;
    let stored = store::load_account_connector(&pool, &owner, &connector_id)
        .await
        .unwrap()
        .expect("the grant lands on the account that started it");
    assert_eq!(stored.read_scopes, ["stub.read"]);
    assert!(stored.act_scopes.is_empty() && !stored.act_enabled);

    let replay = oauth::complete_grant(&pool, &runtime, Some(&state_id), Some("c2"), None).await;
    assert_eq!(replay.result.unwrap_err().code, "invalid_oauth_state");
    assert_eq!(
        stub.calls(),
        ["exchange:c1"],
        "a replayed state never exchanges"
    );

    let outlook = oauth::start_grant(
        &pool,
        &runtime,
        &owner,
        "outlook",
        ConnectorToolGroup::Read,
        None,
    )
    .await;
    assert!(matches!(outlook, Err(oauth::StartError::NotYetAvailable)));
    let unknown = oauth::start_grant(
        &pool,
        &runtime,
        &owner,
        "myspace",
        ConnectorToolGroup::Read,
        None,
    )
    .await;
    assert!(matches!(unknown, Err(oauth::StartError::UnknownProvider)));
}

#[tokio::test]
async fn broker_enforces_grants_triggers_and_ownership() {
    let Some(pool) = pool().await else { return };
    let (runtime, stub) = stub_runtime();
    let (owner, _) = signed_in_account(&pool, "broker_owner").await;
    let (stranger, _) = signed_in_account(&pool, "broker_stranger").await;
    let connector_id = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;

    // Agent without a grant: denied and audited.
    let denied = broker::call_connector_tool(
        &pool,
        &runtime,
        &call(
            &owner,
            &connector_id,
            RunTrigger::PersonStarted,
            STUB_READ_TOOL,
        ),
    )
    .await;
    assert_eq!(denied.error_code(), Some(codes::AGENT_NOT_GRANTED));

    store::replace_agent_grants(&pool, &connector_id, &[store::default_agent_id(&owner)])
        .await
        .unwrap();

    // Act tool while act is off: denied even for a person-started run.
    let act_off = broker::call_connector_tool(
        &pool,
        &runtime,
        &call(
            &owner,
            &connector_id,
            RunTrigger::PersonStarted,
            STUB_ACT_TOOL,
        ),
    )
    .await;
    assert_eq!(act_off.error_code(), Some(codes::ACT_DISABLED));

    // Second OAuth grant for act turns act on and extends scopes.
    assert_eq!(
        connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Act).await,
        connector_id
    );
    let upgraded = store::load_account_connector(&pool, &owner, &connector_id)
        .await
        .unwrap()
        .unwrap();
    assert!(upgraded.act_enabled);
    assert_eq!(upgraded.act_scopes, ["stub.act"]);

    // Background run asking for an act tool: blocked and audited.
    let blocked = broker::call_connector_tool(
        &pool,
        &runtime,
        &call(&owner, &connector_id, RunTrigger::Background, STUB_ACT_TOOL),
    )
    .await;
    assert!(!blocked.ok);
    assert_eq!(blocked.error_code(), Some(codes::BLOCKED_BACKGROUND));
    assert!(!stub.calls().iter().any(|call| call.starts_with("execute:")));

    // Background read is fine.
    let read = broker::call_connector_tool(
        &pool,
        &runtime,
        &call(
            &owner,
            &connector_id,
            RunTrigger::Background,
            STUB_READ_TOOL,
        ),
    )
    .await;
    assert!(read.ok, "{read:?}");

    // Person-started act with act on: executes through the stub.
    let acted = broker::call_connector_tool(
        &pool,
        &runtime,
        &call(
            &owner,
            &connector_id,
            RunTrigger::PersonStarted,
            STUB_ACT_TOOL,
        ),
    )
    .await;
    assert!(acted.ok, "{acted:?}");
    assert_eq!(acted.result.as_ref().unwrap()["tool"], STUB_ACT_TOOL);
    assert!(stub
        .calls()
        .contains(&format!("execute:{STUB_ACT_TOOL}:stub-access-code-1")));
    let serialized = serde_json::to_string(&acted).unwrap();
    assert!(!serialized.contains("stub-access") && !serialized.contains("stub-refresh"));

    // Expired credential: refreshed through the provider before executing.
    let sealed = broker::seal_secret(
        &TestCipher,
        &ConnectorSecret {
            access_token: "expired-access".into(),
            refresh_token: Some("stub-refresh".into()),
            expires_at: Some(Utc::now() - ChronoDuration::minutes(5)),
        },
    )
    .unwrap();
    store::write_secret(&pool, &connector_id, &sealed)
        .await
        .unwrap();
    let refreshed = broker::call_connector_tool(
        &pool,
        &runtime,
        &call(
            &owner,
            &connector_id,
            RunTrigger::Background,
            STUB_READ_TOOL,
        ),
    )
    .await;
    assert!(refreshed.ok, "{refreshed:?}");
    assert!(stub.calls().contains(&format!(
        "execute:{STUB_READ_TOOL}:expired-access-refreshed"
    )));

    // Another account naming this connector: not found, no audit row.
    let before = audit_outcomes(&pool, &connector_id).await.len();
    let mut foreign = call(
        &stranger,
        &connector_id,
        RunTrigger::PersonStarted,
        STUB_READ_TOOL,
    );
    foreign.agent_id = store::default_agent_id(&stranger);
    let foreign = broker::call_connector_tool(&pool, &runtime, &foreign).await;
    assert_eq!(foreign.error_code(), Some(codes::NOT_FOUND));
    // The owner's agent id under the wrong account is not found either.
    let mut mixed = call(
        &owner,
        &connector_id,
        RunTrigger::PersonStarted,
        STUB_READ_TOOL,
    );
    mixed.agent_id = store::default_agent_id(&stranger);
    assert_eq!(
        broker::call_connector_tool(&pool, &runtime, &mixed)
            .await
            .error_code(),
        Some(codes::NOT_FOUND)
    );
    assert_eq!(audit_outcomes(&pool, &connector_id).await.len(), before);

    let outcomes = audit_outcomes(&pool, &connector_id).await;
    let outcome_names = outcomes
        .iter()
        .map(|(_, outcome)| outcome.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        outcome_names,
        [
            "completed",          // oauth.grant read
            "denied",             // no agent grant
            "denied",             // act off
            "completed",          // oauth.grant act
            "blocked_background", // act from background
            "completed",          // background read
            "completed",          // person-started act
            "completed",          // read after refresh
        ]
    );
    assert_eq!(outcomes[4].0, STUB_ACT_TOOL);
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

#[tokio::test]
async fn disconnect_deletes_secret_and_events_and_queues_removal() {
    let Some(pool) = pool().await else { return };
    let (runtime, stub) = stub_runtime();
    let (owner, token) = signed_in_account(&pool, "disconnect").await;
    let (other, other_token) = signed_in_account(&pool, "disconnect_other").await;
    let connector_id = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    for external in ["evt-1", "evt-2"] {
        events::record_event(
            &pool,
            NewConnectorEvent {
                connector_id: &connector_id,
                provider: STUB.id,
                kind: "item.created",
                external_id: Some(external),
                occurred_at: Utc::now(),
                payload: &json!({ "title": "Standup" }),
            },
        )
        .await
        .unwrap();
    }
    let app = super::routes::routes(Arc::new(
        ServerState::new(pool.clone(), EventBus::noop()).with_connector_runtime(runtime),
    ));

    // List shows the connector without any secret-shaped key.
    let list = app
        .clone()
        .oneshot(authed("GET", "/v1/cloud/connectors", &token, None))
        .await
        .unwrap();
    assert_eq!(list.status(), StatusCode::OK);
    let list = body_json(list).await;
    assert_eq!(list["connectors"][0]["connectorId"], connector_id);
    assert_no_secret_keys("GET /v1/cloud/connectors", list);

    // Act cannot be turned on without act scopes.
    let act = app
        .clone()
        .oneshot(authed(
            "POST",
            &format!("/v1/cloud/connectors/{connector_id}/act"),
            &token,
            Some(json!({ "enabled": true })),
        ))
        .await
        .unwrap();
    assert_eq!(act.status(), StatusCode::CONFLICT);

    // Agent grants accept only the account's agents.
    let foreign_agent = app
        .clone()
        .oneshot(authed(
            "PUT",
            &format!("/v1/cloud/connectors/{connector_id}/agents"),
            &token,
            Some(json!({ "agentIds": [store::default_agent_id(&other)] })),
        ))
        .await
        .unwrap();
    assert_eq!(foreign_agent.status(), StatusCode::BAD_REQUEST);
    let own_agent = app
        .clone()
        .oneshot(authed(
            "PUT",
            &format!("/v1/cloud/connectors/{connector_id}/agents"),
            &token,
            Some(json!({ "agentIds": [store::default_agent_id(&owner)] })),
        ))
        .await
        .unwrap();
    assert_eq!(own_agent.status(), StatusCode::OK);
    assert_eq!(
        body_json(own_agent).await["connector"]["agentIds"][0],
        store::default_agent_id(&owner)
    );

    // Another account cannot see or delete it.
    let stranger_delete = app
        .clone()
        .oneshot(authed(
            "DELETE",
            &format!("/v1/cloud/connectors/{connector_id}"),
            &other_token,
            None,
        ))
        .await
        .unwrap();
    assert_eq!(stranger_delete.status(), StatusCode::NOT_FOUND);

    let deleted = app
        .clone()
        .oneshot(authed(
            "DELETE",
            &format!("/v1/cloud/connectors/{connector_id}"),
            &token,
            None,
        ))
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::OK);
    assert_eq!(body_json(deleted).await, json!({ "deletedEvents": 2 }));
    assert!(
        stub.calls().contains(&"revoke".to_string()),
        "provider revoke is attempted; its failure is not fatal"
    );

    let count = |sql: &'static str| {
        let pool = pool.clone();
        let connector_id = connector_id.clone();
        async move {
            let (n,): (i64,) = query_as(sql)
                .bind(&connector_id)
                .fetch_one(&pool)
                .await
                .unwrap();
            n
        }
    };
    assert_eq!(
        count("SELECT COUNT(*) FROM cloud_connector_secrets WHERE connector_id = $1").await,
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM cloud_connector_events WHERE connector_id = $1").await,
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM cloud_connector_agent_grants WHERE connector_id = $1").await,
        0
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM cloud_connector_removal_requests \
             WHERE connector_id = $1 AND processed_at IS NULL"
        )
        .await,
        1
    );
    let (status, revoked_at_set): (String, bool) = query_as(
        "SELECT status, revoked_at IS NOT NULL FROM cloud_connectors WHERE connector_id = $1",
    )
    .bind(&connector_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((status.as_str(), revoked_at_set), ("revoked", true));
    let outcomes = audit_outcomes(&pool, &connector_id).await;
    assert_eq!(
        outcomes.last().unwrap(),
        &("connector.disconnect".to_string(), "completed".to_string())
    );

    // The audit log stays readable, newest first, and paginates.
    let audit = app
        .clone()
        .oneshot(authed(
            "GET",
            &format!("/v1/cloud/connectors/{connector_id}/audit?limit=1"),
            &token,
            None,
        ))
        .await
        .unwrap();
    assert_eq!(audit.status(), StatusCode::OK);
    let audit = body_json(audit).await;
    assert_eq!(audit["entries"][0]["tool"], "connector.disconnect");
    assert!(audit["nextBefore"].is_string());
    assert_no_secret_keys("GET audit", audit);

    // A revoked connector no longer lists, and a reconnect makes a new row.
    let list = body_json(
        app.clone()
            .oneshot(authed("GET", "/v1/cloud/connectors", &token, None))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(list["connectors"], json!([]));
    let (runtime, _) = stub_runtime();
    let reconnected = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    assert_ne!(reconnected, connector_id);
}

#[tokio::test]
async fn retention_sweep_removes_only_expired_events() {
    let Some(pool) = pool().await else { return };
    let (runtime, _) = stub_runtime();
    let (owner, _) = signed_in_account(&pool, "retention").await;
    let connector_id = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    let kept = events::record_event(
        &pool,
        NewConnectorEvent {
            connector_id: &connector_id,
            provider: STUB.id,
            kind: "item.created",
            external_id: None,
            occurred_at: Utc::now(),
            payload: &json!({}),
        },
    )
    .await
    .unwrap();
    let expired = events::record_event(
        &pool,
        NewConnectorEvent {
            connector_id: &connector_id,
            provider: STUB.id,
            kind: "item.created",
            external_id: None,
            occurred_at: Utc::now(),
            payload: &json!({}),
        },
    )
    .await
    .unwrap();
    query("UPDATE cloud_connector_events SET expires_at = now() - interval '1 day' WHERE event_id = $1")
        .bind(&expired)
        .execute(&pool)
        .await
        .unwrap();
    events::sweep_expired_events(&pool, Utc::now())
        .await
        .unwrap();
    let remaining: Vec<(String,)> =
        query_as("SELECT event_id FROM cloud_connector_events WHERE connector_id = $1")
            .bind(&connector_id)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(remaining, [(kept,)]);
}
