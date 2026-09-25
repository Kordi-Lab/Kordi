//! Server-owned provider login sessions against the mock OMP worker's login
//! state machine. Every credential below is synthetic.

use super::omp_worker::{mock_worker, WorkerCall};
use super::route_test::{error_code, request_test_route, CODEX_MODEL};
use super::*;

const LOGIN_PATH: &str = "/v1/cloud/agent-provider-auth/login";

/// Sends one login request. No login response may carry a credential, not
/// even inside a forwarded step or an error.
pub(super) async fn login_request(
    router: &axum::Router,
    token: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(format!("{LOGIN_PATH}{path}"))
        .header("authorization", format!("Bearer {token}"));
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = router
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(
        !text.contains("synthetic-"),
        "login response leaked a synthetic credential: {text}"
    );
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

/// The client sees the saved account, never the credential behind it.
pub(super) fn assert_no_material(body: &Value) {
    let text = body.to_string();
    for field in [
        "material",
        "accessToken",
        "refreshToken",
        "apiKey",
        "expiresAtMs",
    ] {
        assert!(
            !text.contains(field),
            "login response exposed {field}: {text}"
        );
    }
}

const SIGN_IN_URL: &str = "https://auth.example.test/oauth/authorize?client_id=kordi-e2e";

/// Starts a login and returns its session ID.
pub(super) async fn start_login(router: &axum::Router, token: &str, body: Value) -> String {
    let (status, started) = login_request(router, token, "POST", "/start", Some(body)).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{started}");
    started["sessionId"].as_str().unwrap().to_string()
}

/// Cloud-login snapshots of one account as (provider, authChoice, label, active).
pub(super) async fn cloud_login_snapshots(
    pool: &sqlx_postgres::PgPool,
    account_id: &str,
) -> Vec<(String, String, Option<String>, bool)> {
    sqlx_core::query_as::query_as(
        "SELECT provider, auth_choice, label, revoked_at IS NULL \
         FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND auth_choice LIKE 'cloud-login:%' ORDER BY created_at",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

pub(super) async fn session_status(pool: &sqlx_postgres::PgPool, session_id: &str) -> String {
    let row: (String,) = sqlx_core::query_as::query_as(
        "SELECT status FROM cloud_agent_provider_login_sessions WHERE session_id = $1",
    )
    .bind(session_id)
    .fetch_one(pool)
    .await
    .unwrap();
    row.0
}

pub(super) fn login_router(pool: &sqlx_postgres::PgPool) -> axum::Router {
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())))
}

#[tokio::test]
async fn provider_login_saves_one_codex_account_that_the_route_test_can_use() {
    let Some(pool) = try_pool().await else { return };
    let (worker, _worker_env) = mock_worker().await;
    let router = login_router(&pool);
    let owner = signup(&router, "provider-login-owner", "Owner").await;
    let intruder = signup(&router, "provider-login-intruder", "Intruder").await;

    let (status, started) = login_request(
        &router,
        &owner.token,
        "POST",
        "/start",
        Some(json!({ "provider": "openai-codex", "label": "Work laptop" })),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{started}");
    assert_eq!(started["status"], "running");
    assert_eq!(started["step"]["type"], "open-url");
    assert_eq!(started["auth"]["url"], SIGN_IN_URL);
    let session_id = started["sessionId"].as_str().unwrap().to_string();
    let version = started["version"].as_u64().unwrap();
    assert_eq!(worker.login(&session_id).unwrap().provider, "openai-codex");
    for (method, suffix, body) in [
        ("GET", "?wait=1", None),
        (
            "POST",
            "/input",
            Some(json!({ "value": "synthetic-redirect" })),
        ),
        ("POST", "/cancel", None),
    ] {
        let path = format!("/{session_id}{suffix}");
        let (status, body) = login_request(&router, &intruder.token, method, &path, body).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}: {body}");
        assert_eq!(body["errorCode"], "login_not_found");
    }

    let (status, waiting) = login_request(
        &router,
        &owner.token,
        "GET",
        &format!("/{session_id}?wait=1&after={version}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{waiting}");
    assert_eq!(worker.login(&session_id).unwrap().last_after, Some(version));
    assert_eq!(waiting["status"], "awaiting-input");
    assert_eq!(
        waiting["step"],
        json!({ "type": "paste-code", "instructions": "Paste the redirect URL." })
    );
    // The sign-in link stays available after later steps.
    assert_eq!(waiting["auth"], started["auth"]);
    let (status, checking) = login_request(
        &router,
        &owner.token,
        "POST",
        &format!("/{session_id}/input"),
        Some(json!({ "value": "synthetic-redirect" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{checking}");
    assert_eq!(checking["status"], "running");
    assert_eq!(checking["auth"]["url"], SIGN_IN_URL);

    // Two polls race to observe completion; only one claims, and both return
    // the same saved account.
    let poll_path = format!("/{session_id}?wait=25");
    let poll = || login_request(&router, &owner.token, "GET", &poll_path, None);
    let ((first_status, completed), (second_status, raced)) = tokio::join!(poll(), poll());
    assert_eq!(first_status, StatusCode::OK, "{completed}");
    assert_eq!(second_status, StatusCode::OK, "{raced}");
    assert_eq!(raced, completed);
    assert_no_material(&completed);
    let auth_choice = format!("cloud-login:{session_id}");
    assert_eq!(completed["status"], "completed");
    assert_eq!(completed["snapshot"]["provider"], "openai-codex");
    assert_eq!(completed["snapshot"]["authChoice"], auth_choice.as_str());
    assert_eq!(completed["snapshot"]["label"], "Work laptop");

    // Polling after completion answers from the stored session.
    for _ in 0..2 {
        let (status, polled) = login_request(
            &router,
            &owner.token,
            "GET",
            &format!("/{session_id}?wait=25"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{polled}");
        assert_eq!(polled["snapshot"], completed["snapshot"]);
    }
    assert_eq!(worker.login(&session_id).unwrap().claim_attempts, 1);
    assert_eq!(session_status(&pool, &session_id).await, "completed");
    assert_eq!(
        cloud_login_snapshots(&pool, &owner.account_id).await,
        vec![(
            "openai-codex".to_string(),
            auth_choice.clone(),
            Some("Work laptop".to_string()),
            true
        )]
    );

    let listed = router
        .clone()
        .oneshot(get_with_token(
            "/v1/cloud/agent-provider-auth/snapshots",
            &owner.token,
        ))
        .await
        .unwrap();
    let listed = read_json(listed).await;
    assert!(listed["snapshots"]
        .as_array()
        .unwrap()
        .iter()
        .any(
            |snapshot| snapshot["snapshotId"] == completed["snapshot"]["snapshotId"]
                && snapshot["authChoice"] == auth_choice.as_str()
                && snapshot["label"] == "Work laptop"
        ));

    let (status, text) =
        request_test_route(&router, Some(&owner.token), &auth_choice, CODEX_MODEL).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert!(!text.contains("synthetic-"), "{text}");
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap()["accountLabel"],
        "Work laptop"
    );
    assert_eq!(
        worker.calls_for(&["synthetic-access"]),
        vec![WorkerCall {
            auth_choice,
            credential: "synthetic-access".into(),
        }]
    );
    worker.assert_no_violations();
}

#[tokio::test]
async fn provider_login_saves_api_keys_and_nothing_for_cancelled_failed_or_expired_logins() {
    let Some(pool) = try_pool().await else { return };
    let (worker, _worker_env) = mock_worker().await;
    let router = login_router(&pool);
    let owner = signup(&router, "provider-login-keys-owner", "Owner").await;
    let request = |method: &'static str, path: String, body: Option<Value>| {
        let router = router.clone();
        let token = owner.token.clone();
        async move { login_request(&router, &token, method, &path, body).await }
    };

    let groq_id = start_login(
        &router,
        &owner.token,
        json!({ "provider": "groq", "label": "Groq key" }),
    )
    .await;
    let (status, checking) = request(
        "POST",
        format!("/{groq_id}/input"),
        Some(json!({ "value": "synthetic-groq" })),
    )
    .await;
    assert_eq!(
        (status, &checking["status"]),
        (StatusCode::OK, &json!("running"))
    );
    let (status, completed) = request("GET", format!("/{groq_id}?wait=25"), None).await;
    assert_eq!(status, StatusCode::OK, "{completed}");
    assert_no_material(&completed);
    assert_eq!(completed["snapshot"]["provider"], "groq");
    assert_eq!(
        completed["snapshot"]["authChoice"],
        format!("cloud-login:{groq_id}").as_str()
    );
    let encrypted: (Vec<u8>,) = sqlx_core::query_as::query_as(
        "SELECT encrypted_payload FROM cloud_agent_provider_auth_snapshots WHERE snapshot_id = $1",
    )
    .bind(completed["snapshot"]["snapshotId"].as_str().unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!String::from_utf8_lossy(&encrypted.0).contains("synthetic-groq"));

    // Device mode starts the worker's Codex device login; cancelling it saves nothing.
    let device_id = start_login(
        &router,
        &owner.token,
        json!({ "provider": "openai-codex", "label": "Phone", "mode": "device" }),
    )
    .await;
    assert_eq!(
        worker.login(&device_id).unwrap().provider,
        "openai-codex-device"
    );
    let (status, cancelled) = request("POST", format!("/{device_id}/cancel"), None).await;
    assert_eq!(status, StatusCode::OK, "{cancelled}");
    assert_eq!(cancelled["status"], "cancelled");
    let (status, polled) = request("GET", format!("/{device_id}"), None).await;
    assert_eq!(
        (status, &polled["status"]),
        (StatusCode::OK, &json!("cancelled"))
    );
    let (status, late_input) = request(
        "POST",
        format!("/{device_id}/input"),
        Some(json!({ "value": "synthetic-redirect" })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{late_input}");
    let device = worker.login(&device_id).unwrap();
    assert_eq!((device.status, device.claim_attempts), ("cancelled", 0));
    assert_eq!(session_status(&pool, &device_id).await, "cancelled");

    // A failed login reports the worker's classification and saves nothing.
    let failed_id = start_login(
        &router,
        &owner.token,
        json!({ "provider": "groq", "label": "Bad key" }),
    )
    .await;
    let (status, _) = request(
        "POST",
        format!("/{failed_id}/input"),
        Some(json!({ "value": "synthetic-bad-key" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    for _ in 0..2 {
        let (status, failed) = request("GET", format!("/{failed_id}"), None).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{failed}");
        assert_eq!(failed["errorCode"], "login_failed");
        assert_eq!(failed["reason"], "invalid_input");
    }
    assert_eq!(worker.login(&failed_id).unwrap().claim_attempts, 0);
    assert_eq!(session_status(&pool, &failed_id).await, "failed");

    // Sessions older than 20 minutes expire and are cancelled at the worker.
    let late_id = start_login(
        &router,
        &owner.token,
        json!({ "provider": "groq", "label": "Late" }),
    )
    .await;
    sqlx_core::query::query(
        "UPDATE cloud_agent_provider_login_sessions \
         SET created_at = now() - interval '21 minutes' WHERE session_id = $1",
    )
    .bind(&late_id)
    .execute(&pool)
    .await
    .unwrap();
    for (method, path, body) in [
        ("GET", format!("/{late_id}"), None),
        (
            "POST",
            format!("/{late_id}/input"),
            Some(json!({ "value": "synthetic-groq-late" })),
        ),
    ] {
        let (status, expired) = request(method, path, body).await;
        assert_eq!(status, StatusCode::GONE, "{expired}");
        assert_eq!(expired["errorCode"], "login_expired");
    }
    assert_eq!(worker.login(&late_id).unwrap().status, "cancelled");

    assert_eq!(
        cloud_login_snapshots(&pool, &owner.account_id).await,
        vec![(
            "groq".to_string(),
            format!("cloud-login:{groq_id}"),
            Some("Groq key".to_string()),
            true
        )]
    );
}

#[tokio::test]
async fn provider_login_starts_are_validated_authenticated_and_rate_limited() {
    let Some(pool) = try_pool().await else { return };
    let _worker_env = mock_worker().await;
    let router = login_router(&pool);
    let owner = signup(&router, "provider-login-limit-owner", "Owner").await;
    let other = signup(&router, "provider-login-limit-other", "Other").await;

    // Invalid starts are rejected before they spend the account's budget.
    for body in [
        json!({ "provider": "Groq", "label": "Keys" }),
        json!({ "provider": "groq" }),
        json!({ "provider": "groq", "label": "Line\nbreak" }),
        json!({ "provider": "groq", "label": "Keys", "mode": "device" }),
    ] {
        let (status, rejected) =
            login_request(&router, &owner.token, "POST", "/start", Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{rejected}");
        assert_eq!(rejected["errorCode"], "invalid_login_input");
    }
    let unauthenticated = router
        .clone()
        .oneshot(post(
            &format!("{LOGIN_PATH}/start"),
            Body::from(json!({ "provider": "groq", "label": "Keys" }).to_string()),
        ))
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

    for index in 0..5 {
        start_login(
            &router,
            &owner.token,
            json!({ "provider": "groq", "label": format!("Key {index}") }),
        )
        .await;
    }
    let limited = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("{LOGIN_PATH}/start"),
            &owner.token,
            json!({ "provider": "groq", "label": "Key 6" }),
        ))
        .await
        .unwrap();
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(limited.headers().contains_key("retry-after"));
    assert_eq!(
        error_code(&read_json(limited).await.to_string()),
        "rate_limited"
    );

    // The limit is per account; worker refusals map to fixed client errors.
    for (provider, status, code, reason) in [
        (
            "unknown-provider",
            StatusCode::UNPROCESSABLE_ENTITY,
            "login_unsupported",
            json!("unknown_provider"),
        ),
        (
            "busy-provider",
            StatusCode::SERVICE_UNAVAILABLE,
            "omp_busy",
            Value::Null,
        ),
    ] {
        let (actual, body) = login_request(
            &router,
            &other.token,
            "POST",
            "/start",
            Some(json!({ "provider": provider, "label": "Other key" })),
        )
        .await;
        assert_eq!(actual, status, "{body}");
        assert_eq!(body["errorCode"], code);
        assert_eq!(body["reason"], reason);
    }
    start_login(
        &router,
        &other.token,
        json!({ "provider": "groq", "label": "Other key" }),
    )
    .await;
}
