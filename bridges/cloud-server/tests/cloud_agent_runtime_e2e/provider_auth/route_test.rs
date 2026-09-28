//! Hosted OMP route test contract against the mock OMP worker.
//!
//! Every credential below is synthetic.

use super::omp_worker::{
    mock_worker, synthetic_catalog, MockWorker, WorkerCall, EXPIRED_MODEL, OUTAGE_KEY,
    REJECTED_KEY, REJECTED_MODEL, UNSUPPORTED_MODEL,
};
use super::*;

const TEST_ROUTE_PATH: &str = "/v1/cloud/agent-provider-auth/test-route";
const CODEX_PROVIDER: &str = "openai-codex";
pub(super) const CODEX_MODEL: &str = "openai/gpt-5.6-sol";

async fn publish_codex_choice(
    router: &axum::Router,
    owner: &TestAccount,
    auth_choice: &str,
    label: &str,
    access_token: &str,
) -> String {
    let response = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots?intent=explicit",
            &owner.token,
            json!({
                "provider": CODEX_PROVIDER,
                "authChoice": auth_choice,
                "label": label,
                "payload": {
                    "apiMode": "openai-codex-oauth",
                    "accessToken": access_token,
                    "refreshToken": access_token.replacen("synthetic-", "synthetic-refresh-", 1),
                    "expiresAtMs": "4102444800000"
                }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    read_json(response).await["snapshotId"]
        .as_str()
        .unwrap()
        .to_string()
}

pub(super) async fn request_test_route(
    router: &axum::Router,
    session_token: Option<&str>,
    auth_choice: &str,
    model: &str,
) -> (StatusCode, String) {
    let mut request = Request::builder()
        .method("POST")
        .uri(TEST_ROUTE_PATH)
        .header("content-type", "application/json");
    if let Some(token) = session_token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let body = json!({
        "provider": CODEX_PROVIDER,
        "authChoice": auth_choice,
        "model": model,
        "thinking": "low"
    });
    let response = router
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}

/// Route test responses are UI metadata: they must never echo a credential,
/// a refresh token, or the snapshot that holds them.
fn assert_secret_free(text: &str, snapshot_ids: &[&str]) {
    assert!(
        !text.contains("synthetic-"),
        "route test response leaked a synthetic credential: {text}"
    );
    assert!(
        !text.contains("snapshotId"),
        "route test response exposed a snapshot field: {text}"
    );
    for snapshot_id in snapshot_ids {
        assert!(
            !text.contains(snapshot_id),
            "route test response exposed a snapshot ID: {text}"
        );
    }
}

pub(super) fn error_code(text: &str) -> Value {
    serde_json::from_str::<Value>(text).unwrap()["errorCode"].clone()
}

/// One account's view of the route test: its router, the shared worker, and
/// the synthetic credentials this test owns.
struct RouteProbe<'a> {
    router: &'a axum::Router,
    worker: &'a MockWorker,
    owner: &'a TestAccount,
    own_credentials: &'a [&'a str],
}

impl RouteProbe<'_> {
    async fn assert_uses_choice(
        &self,
        snapshot_ids: &[&str],
        auth_choice: &str,
        label: &str,
        credential: &str,
    ) {
        let before = self.worker.calls_for(self.own_credentials).len();
        let (status, text) = request_test_route(
            self.router,
            Some(&self.owner.token),
            auth_choice,
            CODEX_MODEL,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{auth_choice}: {text}");
        let body: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(body["runner"], "OMP");
        assert_eq!(body["provider"], CODEX_PROVIDER);
        assert_eq!(body["accountLabel"], label);
        assert_eq!(body["model"], CODEX_MODEL);
        assert_eq!(body["response"], "synthetic ok");
        assert_secret_free(&text, snapshot_ids);
        assert_eq!(
            self.worker.calls_for(self.own_credentials)[before..],
            [WorkerCall {
                auth_choice: auth_choice.into(),
                credential: credential.into(),
            }],
            "{auth_choice} must reach OMP exactly once with its own credential"
        );
    }
}

#[tokio::test]
async fn omp_test_route_uses_only_the_exact_saved_codex_choice() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let (worker, _worker_env) = mock_worker().await;
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "omp-route-test-owner", "Owner").await;
    let own_credentials = [
        "synthetic-work",
        "synthetic-personal",
        "synthetic-personal-rotated",
    ];
    let work =
        publish_codex_choice(&router, &owner, "profile:work", "Work", "synthetic-work").await;
    let personal = publish_codex_choice(
        &router,
        &owner,
        "profile:personal",
        "Personal",
        "synthetic-personal",
    )
    .await;
    let probe = RouteProbe {
        router: &router,
        worker,
        owner: &owner,
        own_credentials: &own_credentials,
    };
    let snapshot_ids = [work.as_str(), personal.as_str()];
    for (auth_choice, label, credential) in [
        ("profile:work", "Work", "synthetic-work"),
        ("profile:personal", "Personal", "synthetic-personal"),
    ] {
        probe
            .assert_uses_choice(&snapshot_ids, auth_choice, label, credential)
            .await;
    }

    // Replacing one choice revokes only that choice's previous snapshot.
    let rotated = publish_codex_choice(
        &router,
        &owner,
        "profile:personal",
        "Personal",
        "synthetic-personal-rotated",
    )
    .await;
    let mut snapshots: Vec<(String, String, bool)> = sqlx_core::query_as::query_as(
        "SELECT snapshot_id, auth_choice, revoked_at IS NULL \
         FROM cloud_agent_provider_auth_snapshots WHERE account_id = $1",
    )
    .bind(&owner.account_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    snapshots.sort();
    let mut expected = vec![
        (work.clone(), "profile:work".to_string(), true),
        (personal.clone(), "profile:personal".to_string(), false),
        (rotated.clone(), "profile:personal".to_string(), true),
    ];
    expected.sort();
    assert_eq!(snapshots, expected);
    let snapshot_ids = [work.as_str(), personal.as_str(), rotated.as_str()];
    for (auth_choice, label, credential) in [
        ("profile:personal", "Personal", "synthetic-personal-rotated"),
        ("profile:work", "Work", "synthetic-work"),
    ] {
        probe
            .assert_uses_choice(&snapshot_ids, auth_choice, label, credential)
            .await;
    }

    // A revoked or unknown choice fails closed even though another Codex
    // account of the same provider family remains saved.
    let revoke = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/agent-provider-auth/snapshots/{rotated}?intent=explicit"),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(revoke.status(), StatusCode::OK);
    let before = worker.calls_for(&own_credentials).len();
    for auth_choice in ["profile:personal", "profile:missing"] {
        let (status, text) =
            request_test_route(&router, Some(&owner.token), auth_choice, CODEX_MODEL).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{auth_choice}: {text}");
        assert_eq!(error_code(&text), "account_unavailable");
        assert_secret_free(&text, &snapshot_ids);
    }
    assert_eq!(
        worker.calls_for(&own_credentials).len(),
        before,
        "an unavailable choice must not reach OMP with another saved account"
    );
    probe
        .assert_uses_choice(&snapshot_ids, "profile:work", "Work", "synthetic-work")
        .await;
    worker.assert_no_violations();
}

#[tokio::test]
async fn omp_test_route_rejects_mismatched_models_and_maps_worker_failures() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let (worker, _worker_env) = mock_worker().await;
    let router = test_router(Arc::new(ServerState::new(pool, EventBus::noop())));
    let owner = signup(&router, "omp-route-failure-owner", "Owner").await;
    let credential = "synthetic-failure-probe";
    let snapshot_id =
        publish_codex_choice(&router, &owner, "profile:work", "Work", credential).await;

    let (status, text) = request_test_route(
        &router,
        Some(&owner.token),
        "profile:work",
        "anthropic/claude-sonnet-5",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{text}");
    assert_eq!(error_code(&text), "invalid_route");
    assert!(
        worker.calls_for(&[credential]).is_empty(),
        "a model outside the selected provider must not reach OMP"
    );

    for (model, expected_status, expected_code) in [
        (
            UNSUPPORTED_MODEL,
            StatusCode::UNPROCESSABLE_ENTITY,
            "unsupported_model",
        ),
        (REJECTED_MODEL, StatusCode::BAD_GATEWAY, "provider_rejected"),
        (
            EXPIRED_MODEL,
            StatusCode::UNPROCESSABLE_ENTITY,
            "account_needs_reconnect",
        ),
    ] {
        let (status, text) =
            request_test_route(&router, Some(&owner.token), "profile:work", model).await;
        assert_eq!(status, expected_status, "{model}: {text}");
        assert_eq!(error_code(&text), expected_code);
        assert_secret_free(&text, &[snapshot_id.as_str()]);
    }
    assert_eq!(
        worker.calls_for(&[credential]),
        vec![
            WorkerCall {
                auth_choice: "profile:work".into(),
                credential: credential.into(),
            };
            3
        ]
    );

    // Key checks name the worker's classification without its text.
    for (api_key, expected_status, reason) in [
        (
            REJECTED_KEY,
            StatusCode::UNPROCESSABLE_ENTITY,
            "api_key_rejected",
        ),
        (OUTAGE_KEY, StatusCode::BAD_GATEWAY, "provider_unavailable"),
    ] {
        let checked = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-provider-auth/validate-key",
                &owner.token,
                json!({ "provider": "groq", "apiKey": api_key }),
            ))
            .await
            .unwrap();
        assert_eq!(checked.status(), expected_status, "{api_key}");
        let body = read_json(checked).await;
        assert_eq!(body["errorCode"], "provider_key_not_verified");
        assert_eq!(body["reason"], reason);
    }
    worker.assert_no_violations();
}

#[tokio::test]
async fn omp_route_endpoints_keep_the_catalog_public_and_runs_authenticated() {
    let Some(pool) = try_pool().await else { return };
    let (worker, _worker_env) = mock_worker().await;
    let router = test_router(Arc::new(ServerState::new(pool, EventBus::noop())));

    let catalog = router
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/cloud/agent-provider-auth/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(catalog.status(), StatusCode::OK);
    assert_eq!(read_json(catalog).await, synthetic_catalog());

    let (status, text) = request_test_route(&router, None, "profile:work", CODEX_MODEL).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{text}");
    let validate = router
        .clone()
        .oneshot(post(
            "/v1/cloud/agent-provider-auth/validate-key",
            Body::from(json!({ "provider": "openai", "apiKey": "synthetic-key" }).to_string()),
        ))
        .await
        .unwrap();
    assert_eq!(validate.status(), StatusCode::UNAUTHORIZED);

    // The mock enforces the worker bearer the same way live-server.ts does.
    let client = reqwest::Client::new();
    for authorization in [None, Some("Bearer synthetic-wrong-worker-token")] {
        let mut request = client.post(format!("{}/run", worker.url)).json(&json!({}));
        if let Some(value) = authorization {
            request = request.header("authorization", value);
        }
        assert_eq!(request.send().await.unwrap().status().as_u16(), 401);
    }
}
