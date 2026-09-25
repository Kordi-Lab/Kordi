//! Provider logins recover from an unreachable worker during the claim, never
//! wait on an abandoned claim, and end abandoned sessions. The error codes
//! separate a backend without OMP from a briefly unavailable worker. Every
//! credential is synthetic.

use std::time::Instant;

use super::login_session::{
    cloud_login_snapshots, login_request, login_router, session_status, start_login,
};
use super::omp_worker::{lock_worker_env, mock_worker, WORKER_TOKEN_ENV, WORKER_URL_ENV};
use super::*;

#[tokio::test]
async fn a_claim_that_never_reached_the_worker_is_retried_on_the_next_poll() {
    let Some(pool) = try_pool().await else { return };
    let (worker, _worker_env) = mock_worker().await;
    let router = login_router(&pool);
    let owner = signup(&router, "login-recovery-claim-owner", "Owner").await;
    let session_id = start_login(
        &router,
        &owner.token,
        json!({ "provider": "groq", "label": "Retried key" }),
    )
    .await;
    let (status, _) = login_request(
        &router,
        &owner.token,
        "POST",
        &format!("/{session_id}/input"),
        Some(json!({ "value": "synthetic-claim-drop" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let poll = format!("/{session_id}?wait=5");
    let (status, saving) = login_request(&router, &owner.token, "GET", &poll, None).await;
    assert_eq!(status, StatusCode::OK, "{saving}");
    assert_eq!(saving["status"], "running");
    assert_eq!(saving["step"]["message"], "Saving the account.");
    assert_eq!(session_status(&pool, &session_id).await, "running");

    let (status, completed) = login_request(&router, &owner.token, "GET", &poll, None).await;
    assert_eq!(status, StatusCode::OK, "{completed}");
    assert_eq!(completed["status"], "completed");
    assert_eq!(worker.login(&session_id).unwrap().claim_attempts, 2);
    assert_eq!(
        cloud_login_snapshots(&pool, &owner.account_id).await,
        vec![(
            "groq".to_string(),
            format!("cloud-login:{session_id}"),
            Some("Retried key".to_string()),
            true
        )]
    );
}

async fn age_session(pool: &sqlx_postgres::PgPool, session_id: &str, status: &str, age: &str) {
    sqlx_core::query::query(
        "UPDATE cloud_agent_provider_login_sessions \
         SET status = $2, created_at = now() - $3::INTERVAL, updated_at = now() - $3::INTERVAL \
         WHERE session_id = $1",
    )
    .bind(session_id)
    .bind(status)
    .bind(age)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn abandoned_claims_fail_at_once_and_a_new_start_ends_abandoned_sessions() {
    let Some(pool) = try_pool().await else { return };
    let (_worker, _worker_env) = mock_worker().await;
    let router = login_router(&pool);
    let owner = signup(&router, "login-recovery-stale-owner", "Owner").await;
    let start = |label: &'static str| {
        start_login(
            &router,
            &owner.token,
            json!({ "provider": "groq", "label": label }),
        )
    };

    // A claim unfinished for minutes fails without waiting on it.
    let stale_claim = start("Stale claim").await;
    age_session(&pool, &stale_claim, "claiming", "3 minutes").await;
    let began = Instant::now();
    let (status, failed) = login_request(
        &router,
        &owner.token,
        "GET",
        &format!("/{stale_claim}"),
        None,
    )
    .await;
    assert!(began.elapsed() < Duration::from_secs(5));
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{failed}");
    assert_eq!(failed["errorCode"], "login_failed");
    assert_eq!(failed["reason"], "timeout");
    assert_eq!(session_status(&pool, &stale_claim).await, "failed");

    // Sessions nobody polls again are ended by the account's next start.
    let abandoned_login = start("Abandoned login").await;
    let abandoned_claim = start("Abandoned claim").await;
    let recent_claim = start("Recent claim").await;
    age_session(&pool, &abandoned_login, "running", "21 minutes").await;
    age_session(&pool, &abandoned_claim, "claiming", "3 minutes").await;
    age_session(&pool, &recent_claim, "claiming", "10 seconds").await;
    start("Next login").await;
    let ended: Vec<(String, String, Option<String>)> = sqlx_core::query_as::query_as(
        "SELECT session_id, status, failure_reason FROM cloud_agent_provider_login_sessions \
         WHERE session_id = ANY($1) ORDER BY created_at",
    )
    .bind(vec![
        abandoned_login.clone(),
        abandoned_claim.clone(),
        recent_claim.clone(),
    ])
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        ended,
        vec![
            (abandoned_login, "expired".to_string(), None),
            (
                abandoned_claim,
                "failed".to_string(),
                Some("timeout".to_string())
            ),
            (recent_claim, "claiming".to_string(), None),
        ]
    );
}

async fn omp_error(router: &axum::Router, token: &str, method: &str, path: &str) -> (u16, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {token}"));
    let body = if method == "POST" {
        request = request.header("content-type", "application/json");
        let body = match path.rsplit('/').next() {
            Some("start") => json!({ "provider": "groq", "label": "Keys" }),
            Some("validate-key") => json!({ "provider": "groq", "apiKey": "synthetic-key" }),
            _ => json!({
                "provider": "openai-codex",
                "authChoice": "profile:work",
                "model": "openai/gpt-5.6-sol"
            }),
        };
        Body::from(body.to_string())
    } else {
        Body::empty()
    };
    let response = router
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, read_json(response).await)
}

#[tokio::test]
async fn a_backend_without_omp_answers_differently_from_an_unreachable_worker() {
    let Some(pool) = try_pool().await else { return };
    let _worker_env = lock_worker_env().await;
    let router = login_router(&pool);
    let owner = signup(&router, "login-recovery-codes-owner", "Owner").await;
    let requests = [
        ("GET", "/v1/cloud/agent-provider-auth/catalog"),
        ("POST", "/v1/cloud/agent-provider-auth/login/start"),
        ("POST", "/v1/cloud/agent-provider-auth/validate-key"),
        ("POST", "/v1/cloud/agent-provider-auth/test-route"),
    ];

    std::env::remove_var(WORKER_URL_ENV);
    std::env::remove_var(WORKER_TOKEN_ENV);
    for (method, path) in requests {
        let (status, body) = omp_error(&router, &owner.token, method, path).await;
        assert_eq!(status, 503, "{path}: {body}");
        assert_eq!(body["errorCode"], "provider_auth_not_configured", "{path}");
    }

    // A configured worker that cannot be reached is a transient failure.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    std::env::set_var(WORKER_URL_ENV, &url);
    std::env::set_var(WORKER_TOKEN_ENV, "synthetic-unreachable-worker-token");
    for (method, path) in requests.into_iter().take(3) {
        let (status, body) = omp_error(&router, &owner.token, method, path).await;
        assert_eq!(status, 503, "{path}: {body}");
        assert_eq!(body["errorCode"], "omp_unavailable", "{path}");
    }
}
