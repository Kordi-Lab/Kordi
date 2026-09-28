//! Mock OMP route worker shared by the provider-auth e2e tests.
//!
//! It mirrors the `/run`, `/catalog`, and `/login/*` contracts of
//! `experiments/omp-provider-routing` without calling any provider. Every
//! credential it handles is synthetic.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header::AUTHORIZATION, HeaderMap};
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::*;

#[path = "omp_login.rs"]
mod login;

pub(super) const WORKER_URL_ENV: &str = "KORDI_OMP_ROUTE_WORKER_URL";
pub(super) const WORKER_TOKEN_ENV: &str = "KORDI_OMP_ROUTE_WORKER_TOKEN";
const CODEX_TOKEN_URL_ENV: &str = "KORDI_CODEX_OAUTH_TOKEN_URL";
/// The mock answers these models with the statuses and `{error}` codes
/// `live-server.ts` uses for `unsupported_model` (422), `provider_rejected`
/// (502), and `credential_expired` (502).
pub(super) const UNSUPPORTED_MODEL: &str = "openai/gpt-5.6-unsupported";
pub(super) const REJECTED_MODEL: &str = "openai/gpt-5.6-rejected";
pub(super) const EXPIRED_MODEL: &str = "openai/gpt-5.6-expired";
/// Keys the mock `/validate-key` refuses as `api_key_rejected` (422) and
/// `provider_unavailable` (502).
pub(super) const REJECTED_KEY: &str = "synthetic-rejected-key";
pub(super) const OUTAGE_KEY: &str = "synthetic-outage-key";

/// A worker error body: `{"error": "<fixed code>"}`.
fn worker_error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct WorkerCall {
    pub(super) auth_choice: String,
    pub(super) credential: String,
}

struct MockWorkerShared {
    token: String,
    calls: Arc<Mutex<Vec<WorkerCall>>>,
    violations: Arc<Mutex<Vec<String>>>,
    logins: Mutex<HashMap<String, MockLogin>>,
    /// Refresh tokens received by the mock Codex token endpoint.
    token_calls: Mutex<Vec<String>>,
    /// Keys received by the mock `/validate-key`.
    validated_keys: Mutex<Vec<String>>,
}

/// One scripted provider login in the mock worker's state machine.
#[derive(Clone)]
pub(super) struct MockLogin {
    /// The provider the server asked the worker to sign in to.
    pub(super) provider: String,
    /// The sign-in method the server forwarded.
    pub(super) method: String,
    pub(super) status: &'static str,
    step: Value,
    auth: Value,
    error: Option<&'static str>,
    version: u64,
    /// The result the flow reaches on the next poll after input.
    outcome: Option<Result<Value, &'static str>>,
    material: Option<Value>,
    /// Every claim request, including rejected repeats.
    pub(super) claim_attempts: u32,
    claimed: bool,
    /// The next claim closes the connection without answering.
    drop_next_claim: bool,
    /// The `after` version the server forwarded on its latest poll.
    pub(super) last_after: Option<u64>,
}

pub(super) struct MockWorker {
    pub(super) url: String,
    shared: Arc<MockWorkerShared>,
}

impl MockWorker {
    /// Calls that carried one of `credentials`. Tests filter by their own
    /// synthetic credentials because the worker is shared by the process.
    pub(super) fn calls_for(&self, credentials: &[&str]) -> Vec<WorkerCall> {
        self.shared
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| credentials.contains(&call.credential.as_str()))
            .cloned()
            .collect()
    }

    pub(super) fn token_calls_for(&self, refresh_token: &str) -> usize {
        self.shared
            .token_calls
            .lock()
            .unwrap()
            .iter()
            .filter(|received| received.as_str() == refresh_token)
            .count()
    }

    /// How many times `/validate-key` received `api_key`.
    pub(super) fn validations_of(&self, api_key: &str) -> usize {
        self.shared
            .validated_keys
            .lock()
            .unwrap()
            .iter()
            .filter(|received| received.as_str() == api_key)
            .count()
    }

    pub(super) fn login(&self, session_id: &str) -> Option<MockLogin> {
        self.shared.logins.lock().unwrap().get(session_id).cloned()
    }

    pub(super) fn assert_no_violations(&self) {
        let violations = self.shared.violations.lock().unwrap();
        assert!(
            violations.is_empty(),
            "the OMP worker received material that breaks the route contract: {violations:?}"
        );
    }
}

static WORKER_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Exclusive use of the worker URL and token environment for one test.
pub(super) type WorkerEnvGuard = tokio::sync::MutexGuard<'static, ()>;

/// The route handlers read the worker URL and token from the process
/// environment on every request, and all e2e tests share one process. Every
/// test that reaches a worker holds this guard for its whole run, so a test
/// that points the server at the real Bun worker cannot redirect another
/// test's requests. No other test reads these variables.
pub(super) async fn lock_worker_env() -> WorkerEnvGuard {
    WORKER_ENV.lock().await
}

/// One mock worker serves the whole test binary from its own runtime thread.
/// The returned guard points the server at it until the test ends.
pub(super) async fn mock_worker() -> (&'static MockWorker, WorkerEnvGuard) {
    static WORKER: OnceLock<MockWorker> = OnceLock::new();
    let guard = lock_worker_env().await;
    let worker = WORKER.get_or_init(|| {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let shared = Arc::new(MockWorkerShared {
            token: format!(
                "synthetic-omp-worker-token-{}",
                uuid::Uuid::new_v4().simple()
            ),
            calls: Arc::default(),
            violations: Arc::default(),
            logins: Mutex::default(),
            token_calls: Mutex::default(),
            validated_keys: Mutex::default(),
        });
        let app = login::routes(
            axum::Router::new()
                .route("/catalog", axum::routing::get(mock_catalog))
                .route("/run", axum::routing::post(mock_run))
                .route("/validate-key", axum::routing::post(mock_validate_key))
                .route("/oauth/token", axum::routing::post(mock_codex_token)),
        )
        .with_state(shared.clone());
        std::thread::Builder::new()
            .name("mock-omp-route-worker".into())
            .spawn(move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(async move {
                        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                        axum::serve(listener, app).await.unwrap();
                    });
            })
            .unwrap();
        MockWorker { url, shared }
    });
    std::env::set_var(WORKER_URL_ENV, &worker.url);
    std::env::set_var(WORKER_TOKEN_ENV, &worker.shared.token);
    std::env::set_var(CODEX_TOKEN_URL_ENV, format!("{}/oauth/token", worker.url));
    (worker, guard)
}

pub(super) fn synthetic_catalog() -> Value {
    json!({
        "providers": [{
            "id": "openai-codex",
            "models": ["gpt-5.6-sol"],
            "defaultModel": "gpt-5.6-sol",
            "auth": {
                "kind": "oauth-code",
                "name": "ChatGPT",
                "acceptsApiKey": false,
                "instructions": null,
                "authUrl": null,
                "placeholder": null,
                "envVars": []
            }
        }]
    })
}

/// The Codex token endpoint. It answers slowly so concurrent refreshes would
/// overlap, and it rotates the refresh token like the real endpoint.
async fn mock_codex_token(State(shared): State<Arc<MockWorkerShared>>, body: Bytes) -> Response {
    let form: HashMap<String, String> = url::form_urlencoded::parse(&body).into_owned().collect();
    let refresh_token = form.get("refresh_token").cloned().unwrap_or_default();
    shared
        .token_calls
        .lock()
        .unwrap()
        .push(refresh_token.clone());
    if form.get("grant_type").map(String::as_str) != Some("refresh_token") {
        return (StatusCode::BAD_REQUEST, "unsupported_grant_type").into_response();
    }
    // The provider revoked this refresh token, as the real endpoint answers.
    if refresh_token.starts_with("synthetic-refresh-revoked") {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid_grant" })),
        )
            .into_response();
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let suffix = refresh_token
        .strip_prefix("synthetic-refresh-")
        .unwrap_or("unknown");
    Json(json!({
        "access_token": format!("synthetic-renewed-access-{suffix}"),
        "refresh_token": format!("synthetic-refresh-rotated-{suffix}"),
        "expires_in": 3600
    }))
    .into_response()
}

async fn mock_catalog() -> Json<Value> {
    Json(synthetic_catalog())
}

/// Accepts any other key, like `live-server.ts` for a provider without a probe.
async fn mock_validate_key(
    State(shared): State<Arc<MockWorkerShared>>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Response {
    if !authorized(&shared, &headers) {
        return worker_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let Some(api_key) = input["apiKey"].as_str() else {
        return worker_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    shared
        .validated_keys
        .lock()
        .unwrap()
        .push(api_key.to_string());
    match api_key {
        REJECTED_KEY => worker_error(StatusCode::UNPROCESSABLE_ENTITY, "api_key_rejected"),
        OUTAGE_KEY => worker_error(StatusCode::BAD_GATEWAY, "provider_unavailable"),
        _ => Json(json!({ "verified": true })).into_response(),
    }
}

async fn mock_run(
    State(shared): State<Arc<MockWorkerShared>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !authorized(&shared, &headers) {
        return worker_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let Ok(input) = serde_json::from_slice::<Value>(&body) else {
        return worker_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let (route, material) = (&input["route"], &input["material"]);
    if let Some(violation) = contract_violation(route, material) {
        shared.violations.lock().unwrap().push(violation);
        return worker_error(StatusCode::BAD_REQUEST, "route_mismatch");
    }
    let payload = &material["payload"];
    let credential = if payload["apiMode"] == "openai-codex-oauth" {
        payload["accessToken"].as_str()
    } else {
        payload["apiKey"]
            .as_str()
            .or_else(|| payload["accessToken"].as_str())
    };
    shared.calls.lock().unwrap().push(WorkerCall {
        auth_choice: material["authChoice"].as_str().unwrap_or_default().into(),
        credential: credential.unwrap_or_default().into(),
    });
    let default_model = route["defaultModel"].as_str().unwrap_or_default();
    match default_model {
        UNSUPPORTED_MODEL => worker_error(StatusCode::UNPROCESSABLE_ENTITY, "unsupported_model"),
        REJECTED_MODEL => worker_error(StatusCode::BAD_GATEWAY, "provider_rejected"),
        EXPIRED_MODEL => worker_error(StatusCode::BAD_GATEWAY, "credential_expired"),
        _ => Json(json!({
            "provider": material["provider"],
            "model": default_model.split_once('/').map(|(_, model)| model).unwrap_or_default(),
            "response": "synthetic ok",
        }))
        .into_response(),
    }
}

fn contract_violation(route: &Value, material: &Value) -> Option<String> {
    let route_choice = route["defaultAuthChoice"].as_str();
    let material_choice = material["authChoice"].as_str();
    if route_choice.is_none() || route_choice != material_choice {
        return Some(format!(
            "route choice {route_choice:?} differs from material choice {material_choice:?}"
        ));
    }
    refresh_capability(material).map(|field| format!("material carries {field}"))
}

/// Refresh capability stays on the server: no refresh token or expiry field
/// (clients send `expiresAtMs`) and no refresh token value may reach OMP.
fn refresh_capability(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => map.iter().find_map(|(key, nested)| {
            if key == "refreshToken" || key.starts_with("expiresAt") {
                Some(key.clone())
            } else {
                refresh_capability(nested)
            }
        }),
        Value::Array(items) => items.iter().find_map(refresh_capability),
        Value::String(text) if text.contains("synthetic-refresh") => {
            Some("a refresh token value".into())
        }
        _ => None,
    }
}

fn authorized(shared: &MockWorkerShared, headers: &HeaderMap) -> bool {
    let expected = format!("Bearer {}", shared.token);
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        == Some(expected.as_str())
}
