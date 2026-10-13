use super::*;

fn legacy_router(pool: sqlx_postgres::PgPool, window: chrono::Duration) -> axum::Router {
    // No signup email service: the legacy path must not depend on delivery.
    let state = ServerState::new(pool, EventBus::noop())
        .with_legacy_signup_until(chrono::Utc::now() + window);
    fast_router(Arc::new(state))
}

fn legacy_body(email: &str) -> Body {
    Body::from(
        json!({
            "email": email,
            "password": "correct horse",
            "avatarSeed": "legacy_signup_e2e",
            "device": device_registration(7, "Legacy Mac", "macos"),
        })
        .to_string(),
    )
}

async fn account_row(pool: &sqlx_postgres::PgPool, email: &str) -> Option<(String, bool)> {
    sqlx_core::query_as::query_as(
        "SELECT account_id, primary_email_verified_at IS NOT NULL \
         FROM cloud_accounts WHERE primary_email = $1",
    )
    .bind(email)
    .fetch_optional(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn open_window_creates_an_unverified_account_without_a_code() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("legacy-open");
    let router = legacy_router(pool.clone(), chrono::Duration::hours(1));
    let response = router
        .clone()
        .oneshot(post("/v1/cloud/auth/signup", legacy_body(&email)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = read_json(response).await;
    assert!(body["session"]["token"].as_str().is_some());

    let (account_id, verified) = account_row(&pool, &email).await.unwrap();
    assert_eq!(body["account"]["accountId"], account_id.as_str());
    assert!(!verified, "a legacy signup never proves email ownership");
    let (metadata,): (String,) = sqlx_core::query_as::query_as(
        "SELECT metadata_json FROM cloud_audit_events \
         WHERE account_id = $1 AND event_type = 'account.created'",
    )
    .bind(&account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!(metadata["legacySignup"], true);

    let duplicate = router
        .oneshot(post("/v1/cloud/auth/signup", legacy_body(&email)))
        .await
        .unwrap();
    assert_eq!(duplicate.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn closed_window_refuses_signup_without_a_code() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("legacy-closed");
    let router = legacy_router(pool.clone(), chrono::Duration::seconds(-1));
    let response = router
        .oneshot(post("/v1/cloud/auth/signup", legacy_body(&email)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        read_json(response).await["errorCode"],
        "email_verification_required"
    );
    assert!(account_row(&pool, &email).await.is_none());
}

#[tokio::test]
async fn open_window_still_checks_a_code_that_is_sent() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("legacy-with-code");
    let state = signup_email_fixture::state(pool.clone())
        .with_legacy_signup_until(chrono::Utc::now() + chrono::Duration::hours(1));
    let router = fast_router(Arc::new(state));
    let wrong = json!({
        "email": email,
        "password": "correct horse",
        "avatarSeed": "legacy_signup_e2e",
        "verificationId": "email_missing",
        "verificationCode": "000000",
    });
    let response = router
        .clone()
        .oneshot(post("/v1/cloud/auth/signup", Body::from(wrong.to_string())))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        read_json(response).await["errorCode"],
        "invalid_verification_code"
    );
    assert!(account_row(&pool, &email).await.is_none());

    let response = router
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse").await,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let (_, verified) = account_row(&pool, &email).await.unwrap();
    assert!(verified);
}
