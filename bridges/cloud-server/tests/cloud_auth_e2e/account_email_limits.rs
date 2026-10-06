//! Rate limits, send budgets, and delivery failures for account email
//! verification.

use std::sync::atomic::Ordering;

use kordi_cloud_server::auth::signup_email::SignupEmailService;

use super::account_email::{email_router, error_code, legacy_account, send, verify, Inbox, VERIFY};
use super::*;

#[tokio::test]
async fn resend_within_cooldown_is_limited() {
    let Some(pool) = try_pool().await else { return };
    let inbox = Arc::new(Inbox::default());
    let router = email_router(pool.clone(), inbox);
    let (token, _, _) = legacy_account(&router, &pool, "legacy-resend").await;
    assert_eq!(send(&router, &token).await.status(), StatusCode::OK);
    let limited = send(&router, &token).await;
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    let retry_after: u64 = limited.headers()["retry-after"]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=60).contains(&retry_after));
}

#[tokio::test]
async fn account_budget_bounds_requests_and_guesses() {
    let Some(pool) = try_pool().await else { return };
    let router = email_router(pool.clone(), Arc::new(Inbox::default()));
    let (token, _, _) = legacy_account(&router, &pool, "legacy-budget").await;
    for _ in 0..kordi_cloud_server::auth::rate_limit::EMAIL_VERIFICATION_LIMIT.limit {
        assert_eq!(
            verify(&router, &token, "email_unknown", "000000").await,
            StatusCode::BAD_REQUEST
        );
    }
    let limited = send(&router, &token).await;
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(limited.headers().contains_key("retry-after"));
}

#[tokio::test]
async fn unavailable_mail_and_missing_email_fail_closed() {
    let Some(pool) = try_pool().await else { return };
    let inbox = Arc::new(Inbox::default());
    let router = email_router(pool.clone(), inbox.clone());
    let (token, account_id, _) = legacy_account(&router, &pool, "legacy-unavailable").await;

    let unconfigured = fast_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let response = send(&unconfigured, &token).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = read_json(response).await;
    assert_eq!(body["errorCode"], "email_delivery_unavailable");
    assert_eq!(
        body["message"],
        "Email verification is temporarily unavailable. Try again later."
    );

    inbox.fail.store(true, Ordering::SeqCst);
    let response = send(&router, &token).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = read_json(response).await;
    assert_eq!(body["errorCode"], "email_delivery_unavailable");
    assert!(!body["message"].as_str().unwrap().contains("Google"));
    let (rows,): (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_account_email_codes WHERE account_id = $1",
    )
    .bind(&account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows, 0,
        "a failed first delivery leaves no challenge or charge"
    );
    inbox.fail.store(false, Ordering::SeqCst);
    assert_eq!(send(&router, &token).await.status(), StatusCode::OK);

    sqlx_core::query::query("UPDATE cloud_accounts SET primary_email = NULL WHERE account_id = $1")
        .bind(&account_id)
        .execute(&pool)
        .await
        .unwrap();
    let response = send(&router, &token).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(error_code(response).await, "email_missing");
}

fn from_address(mut request: Request<Body>, last_octet: u8) -> Request<Body> {
    request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [198, 51, 100, last_octet],
            443,
        ))));
    request
}

#[tokio::test]
async fn address_limited_and_no_op_requests_do_not_spend_the_account_budget() {
    let Some(pool) = try_pool().await else { return };
    let (token, account_id, _) = legacy_account(
        &email_router(pool.clone(), Arc::new(Inbox::default())),
        &pool,
        "budget-order",
    )
    .await;
    // One request per address, so each later address starts fresh.
    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig {
        per_ip_limit: 1,
        per_ip_window: Duration::from_secs(60),
        per_email_failure_limit: 5,
        per_email_lockout: Duration::from_secs(900),
        per_email_global_failure_limit: 50,
    });
    let state = ServerState::new(pool.clone(), EventBus::noop()).with_signup_email(
        SignupEmailService::new(
            Arc::new(Inbox::default()),
            signup_email_fixture::KEY.to_vec(),
        )
        .unwrap(),
    );
    let router = routes_with_config(Arc::new(state), PasswordHasherConfig::for_tests(), limiter);
    let guess = |octet: u8| {
        from_address(
            post_json_with_token(
                VERIFY,
                &token,
                json!({ "verificationId": "email_unknown", "verificationCode": "000000" }),
            ),
            octet,
        )
    };
    let status = |router: &axum::Router, request: Request<Body>| {
        let router = router.clone();
        async move { router.oneshot(request).await.unwrap().status() }
    };
    assert_eq!(status(&router, guess(1)).await, StatusCode::BAD_REQUEST);
    for _ in 0..20 {
        assert_eq!(
            status(&router, guess(1)).await,
            StatusCode::TOO_MANY_REQUESTS
        );
    }
    // A request with nothing to verify is not charged either.
    sqlx_core::query::query("UPDATE cloud_accounts SET primary_email = NULL WHERE account_id = $1")
        .bind(&account_id)
        .execute(&pool)
        .await
        .unwrap();
    for octet in 2..22 {
        assert_eq!(status(&router, guess(octet)).await, StatusCode::BAD_REQUEST);
    }
    sqlx_core::query::query("UPDATE cloud_accounts SET primary_email = $2 WHERE account_id = $1")
        .bind(&account_id)
        .bind(unique_email("budget-order-restored"))
        .execute(&pool)
        .await
        .unwrap();
    let budget = kordi_cloud_server::auth::rate_limit::EMAIL_VERIFICATION_LIMIT.limit as u8;
    for octet in 22..22 + budget - 1 {
        assert_eq!(status(&router, guess(octet)).await, StatusCode::BAD_REQUEST);
    }
    assert_eq!(
        status(&router, guess(22 + budget)).await,
        StatusCode::TOO_MANY_REQUESTS
    );
}
