//! A signed-in account proves it can read its primary email with an inbox code.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use async_trait::async_trait;
use kordi_cloud_server::auth::signup_email::{SignupCodeSender, SignupEmailService};

use super::*;

const SEND: &str = "/v1/cloud/auth/email/verification/code";
const VERIFY: &str = "/v1/cloud/auth/email/verification";

#[derive(Default)]
struct Inbox {
    codes: Mutex<HashMap<String, String>>,
    fail: AtomicBool,
}

#[async_trait]
impl SignupCodeSender for Inbox {
    async fn send_code(&self, email: &str, code: &str) -> Result<(), &'static str> {
        if self.fail.load(Ordering::SeqCst) {
            return Err("Synthetic delivery failure");
        }
        self.codes
            .lock()
            .unwrap()
            .insert(email.to_string(), code.to_string());
        Ok(())
    }
}

fn email_router(pool: sqlx_postgres::PgPool, inbox: Arc<Inbox>) -> axum::Router {
    let state = ServerState::new(pool, EventBus::noop()).with_signup_email(
        SignupEmailService::new(inbox, signup_email_fixture::KEY.to_vec()).unwrap(),
    );
    fast_router(Arc::new(state))
}

/// A password account whose email was never verified, as created before signup
/// required an inbox code. Returns its session token, id, and email.
async fn legacy_account(
    router: &axum::Router,
    pool: &sqlx_postgres::PgPool,
    prefix: &str,
) -> (String, String, String) {
    let email = unique_email(prefix);
    let response = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse").await,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = read_json(response).await;
    let token = body["session"]["token"].as_str().unwrap().to_string();
    let account_id = body["account"]["accountId"].as_str().unwrap().to_string();
    sqlx_core::query::query(
        "UPDATE cloud_accounts SET primary_email_verified_at = NULL WHERE account_id = $1",
    )
    .bind(&account_id)
    .execute(pool)
    .await
    .unwrap();
    (token, account_id, email)
}

async fn send(router: &axum::Router, token: &str) -> axum::response::Response {
    router
        .clone()
        .oneshot(post_json_with_token(SEND, token, json!({})))
        .await
        .unwrap()
}

async fn verify(router: &axum::Router, token: &str, id: &str, code: &str) -> StatusCode {
    let response = router
        .clone()
        .oneshot(post_json_with_token(
            VERIFY,
            token,
            json!({ "verificationId": id, "verificationCode": code }),
        ))
        .await
        .unwrap();
    let status = response.status();
    if status == StatusCode::BAD_REQUEST {
        assert_eq!(
            read_json(response).await["errorCode"],
            "invalid_verification_code"
        );
    }
    status
}

async fn me_verified(router: &axum::Router, token: &str) -> bool {
    let response = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/auth/me", token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    assert!(body["accountId"].is_string());
    assert!(body["primaryEmail"].is_string());
    assert!(body["avatar"].is_object());
    assert!(body["defaultAgent"].is_object());
    assert!(body["passwordSet"].as_bool().unwrap());
    body["primaryEmailVerified"].as_bool().unwrap()
}

async fn error_code(response: axum::response::Response) -> serde_json::Value {
    read_json(response).await["errorCode"].clone()
}

#[tokio::test]
async fn verification_routes_require_a_session() {
    let Some(pool) = try_pool().await else { return };
    let router = email_router(pool, Arc::new(Inbox::default()));
    for request in [
        post(SEND, Body::from("{}")),
        post(
            VERIFY,
            Body::from(
                json!({ "verificationId": "email_x", "verificationCode": "000000" }).to_string(),
            ),
        ),
    ] {
        assert_eq!(
            router.clone().oneshot(request).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn legacy_account_verifies_its_email_with_an_inbox_code() {
    let Some(pool) = try_pool().await else { return };
    let inbox = Arc::new(Inbox::default());
    let router = email_router(pool.clone(), inbox.clone());
    let (token, account_id, email) = legacy_account(&router, &pool, "legacy-verify").await;
    assert!(!me_verified(&router, &token).await);

    let response = send(&router, &token).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    assert_eq!(body["retryAfterSeconds"], 60);
    assert!(body["expiresAt"].is_string());
    assert!(body.get("code").is_none());
    assert!(body.get("verificationCode").is_none());
    let id = body["verificationId"].as_str().unwrap().to_string();
    let code = inbox.codes.lock().unwrap()[&email].clone();

    let wrong = if code == "000000" { "999999" } else { "000000" };
    assert_eq!(
        verify(&router, &token, &id, wrong).await,
        StatusCode::BAD_REQUEST
    );
    assert!(!me_verified(&router, &token).await);
    let (remaining,): (i32,) = sqlx_core::query_as::query_as(
        "SELECT attempts_remaining FROM cloud_account_email_codes WHERE account_id = $1",
    )
    .bind(&account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(remaining, 4, "a failed guess is committed");

    assert_eq!(
        verify(&router, &token, &id, &code).await,
        StatusCode::NO_CONTENT
    );
    assert!(me_verified(&router, &token).await);
    // This is the state OAuth email linking requires of an existing account.
    let (verified,): (bool,) = sqlx_core::query_as::query_as(
        "SELECT primary_email_verified_at IS NOT NULL FROM cloud_accounts \
         WHERE LOWER(primary_email) = $1",
    )
    .bind(&email)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(verified);

    let again = send(&router, &token).await;
    assert_eq!(again.status(), StatusCode::CONFLICT);
    assert_eq!(error_code(again).await, "email_already_verified");
    assert_eq!(
        verify(&router, &token, &id, &code).await,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn codes_for_another_account_do_not_verify() {
    let Some(pool) = try_pool().await else { return };
    let inbox = Arc::new(Inbox::default());
    let router = email_router(pool.clone(), inbox.clone());
    let (owner_token, _, owner_email) = legacy_account(&router, &pool, "code-owner").await;
    let (other_token, _, _) = legacy_account(&router, &pool, "code-other").await;
    let body = read_json(send(&router, &owner_token).await).await;
    let id = body["verificationId"].as_str().unwrap().to_string();
    let code = inbox.codes.lock().unwrap()[&owner_email].clone();
    assert_eq!(
        verify(&router, &other_token, &id, &code).await,
        StatusCode::BAD_REQUEST
    );
    assert!(!me_verified(&router, &other_token).await);
    assert_eq!(
        verify(&router, &owner_token, &id, &code).await,
        StatusCode::NO_CONTENT
    );
}

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
    assert_eq!(error_code(response).await, "email_delivery_unavailable");

    inbox.fail.store(true, Ordering::SeqCst);
    let response = send(&router, &token).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_code(response).await, "email_delivery_unavailable");
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

#[tokio::test]
async fn signup_accounts_report_a_verified_email() {
    let Some(pool) = try_pool().await else { return };
    let router = email_router(pool, Arc::new(Inbox::default()));
    let (token, _) = signup_account(&router, "signup-verified").await;
    assert!(me_verified(&router, &token).await);
    assert_eq!(send(&router, &token).await.status(), StatusCode::CONFLICT);
}
