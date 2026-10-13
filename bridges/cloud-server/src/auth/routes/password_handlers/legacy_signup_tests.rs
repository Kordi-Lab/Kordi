//! Signup gate decisions that are made before the database is touched, so
//! they run against a pool that never connects.

use super::*;
use axum::body::Body;
use axum::http::Request;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::util::ServiceExt;

fn router(legacy_signup_until: Option<DateTime<Utc>>) -> Router {
    let pool = sqlx_postgres::PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(200))
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    let mut state = ServerState::new(pool, crate::events::EventBus::noop());
    if let Some(deadline) = legacy_signup_until {
        state = state.with_legacy_signup_until(deadline);
    }
    routes_with_config(
        Arc::new(state),
        PasswordHasherConfig::for_tests(),
        CloudRateLimiter::memory(crate::auth::rate_limit::CloudRateLimitConfig::production()),
    )
}

async fn signup(router: Router, extra: Value) -> (StatusCode, Value) {
    let mut body = json!({
        "email": "legacy-signup@example.test",
        "password": "correct horse",
        "avatarSeed": "legacy_signup_test",
    });
    body.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let response = router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/cloud/auth/signup")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn open_window() -> Option<DateTime<Utc>> {
    Some(Utc::now() + ChronoDuration::hours(1))
}

#[tokio::test]
async fn signup_without_a_code_is_refused_when_no_window_is_configured() {
    let (status, body) = signup(router(None), json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["errorCode"], "email_verification_required");
}

#[tokio::test]
async fn signup_without_a_code_is_refused_after_the_window_closes() {
    let closed = Some(Utc::now() - ChronoDuration::seconds(1));
    let (status, body) = signup(router(closed), json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["errorCode"], "email_verification_required");
}

#[tokio::test]
async fn open_window_does_not_accept_a_partial_code() {
    for extra in [
        json!({ "verificationId": "email_partial" }),
        json!({ "verificationCode": "123456" }),
    ] {
        let (status, body) = signup(router(open_window()), extra).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["errorCode"], "email_verification_required");
    }
}

#[tokio::test]
async fn open_window_still_verifies_a_request_that_sends_a_code() {
    // No email service is configured, so a request with a code cannot be verified.
    let (status, body) = signup(
        router(open_window()),
        json!({ "verificationId": "email_sent", "verificationCode": "123456" }),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["errorCode"], "email_delivery_unavailable");
}

#[tokio::test]
async fn open_window_passes_the_code_gate_without_an_email_service() {
    // The request reaches the first account query, which fails only because
    // this pool never connects. Neither verification refusal is returned.
    let (status, body) = signup(router(open_window()), json!({})).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body["errorCode"], "server_error");
}

#[tokio::test]
async fn open_window_keeps_the_per_address_rate_limit() {
    let limiter = CloudRateLimiter::memory(crate::auth::rate_limit::CloudRateLimitConfig {
        per_ip_limit: 1,
        ..crate::auth::rate_limit::CloudRateLimitConfig::production()
    });
    let pool = sqlx_postgres::PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(200))
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    let state = ServerState::new(pool, crate::events::EventBus::noop())
        .with_legacy_signup_until(open_window().unwrap());
    let router = routes_with_config(Arc::new(state), PasswordHasherConfig::for_tests(), limiter);
    let (first, _) = signup(router.clone(), json!({})).await;
    assert_eq!(first, StatusCode::INTERNAL_SERVER_ERROR);
    let (second, _) = signup(router, json!({})).await;
    assert_eq!(second, StatusCode::TOO_MANY_REQUESTS);
}
