use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use async_trait::async_trait;
use kordi_cloud_server::auth::signup_email::{SignupCodeSender, SignupEmailService};

use super::*;

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

async fn send_code(router: &axum::Router, email: &str) -> axum::response::Response {
    router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup/code",
            Body::from(json!({ "email": email }).to_string()),
        ))
        .await
        .unwrap()
}

fn registration(email: &str, id: &str, code: &str) -> Body {
    Body::from(json!({ "email": email, "password": "correct horse", "avatarSeed": "signup_email_test", "verificationId": id, "verificationCode": code }).to_string())
}

async fn finish(
    router: &axum::Router,
    email: &str,
    id: &str,
    code: &str,
) -> axum::response::Response {
    router
        .clone()
        .oneshot(post("/v1/cloud/auth/signup", registration(email, id, code)))
        .await
        .unwrap()
}

async fn challenge(router: &axum::Router, inbox: &Inbox, email: &str) -> (String, String) {
    let response = send_code(router, email).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    assert!(body.get("code").is_none());
    assert!(body.get("verificationCode").is_none());
    assert!(body.get("session").is_none());
    assert_eq!(body["retryAfterSeconds"], 60);
    (
        body["verificationId"].as_str().unwrap().to_string(),
        inbox.codes.lock().unwrap()[email].clone(),
    )
}

async fn account_count(pool: &sqlx_postgres::PgPool, email: &str) -> i64 {
    sqlx_core::query_as::query_as::<_, (i64,)>(
        "SELECT COUNT(*)::BIGINT FROM cloud_accounts WHERE primary_email = $1",
    )
    .bind(email)
    .fetch_one(pool)
    .await
    .unwrap()
    .0
}

#[tokio::test]
async fn signup_without_inbox_proof_cannot_create_account_or_session() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("no-proof");
    let router = email_router(pool.clone(), Arc::new(Inbox::default()));
    let response = router.oneshot(post("/v1/cloud/auth/signup", Body::from(json!({ "email": email, "password": "correct horse", "avatarSeed": "signup_email_test" }).to_string()))).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = read_json(response).await;
    assert_eq!(body["errorCode"], "email_verification_required");
    assert!(body.get("session").is_none());
    assert_eq!(account_count(&pool, &email).await, 0);
}

#[tokio::test]
async fn delivered_code_creates_verified_account_and_cannot_be_reused_concurrently() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("verified");
    let inbox = Arc::new(Inbox::default());
    let router = email_router(pool.clone(), inbox.clone());
    let (id, code) = challenge(&router, &inbox, &email).await;
    assert_eq!(account_count(&pool, &email).await, 0);
    let (a, b) = tokio::join!(
        finish(&router, &email, &id, &code),
        finish(&router, &email, &id, &code)
    );
    assert_eq!(
        [a.status(), b.status()]
            .iter()
            .filter(|&&s| s == StatusCode::CREATED)
            .count(),
        1
    );
    assert_eq!(account_count(&pool, &email).await, 1);
    let (verified, devices, sessions): (bool, i64, i64) = sqlx_core::query_as::query_as(
        "SELECT primary_email_verified_at IS NOT NULL, \
         (SELECT COUNT(*) FROM cloud_devices WHERE account_id = a.account_id), \
         (SELECT COUNT(*) FROM cloud_refresh_tokens WHERE account_id = a.account_id) \
         FROM cloud_accounts a WHERE primary_email = $1",
    )
    .bind(&email)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(verified);
    assert_eq!((devices, sessions), (1, 1));
    assert_ne!(
        finish(&router, &email, &id, &code).await.status(),
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn codes_are_bound_to_email_and_five_failed_guesses_exhaust_the_code() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("guess-limit");
    let other = unique_email("wrong-recipient");
    let inbox = Arc::new(Inbox::default());
    let router = email_router(pool.clone(), inbox.clone());
    let (id, code) = challenge(&router, &inbox, &email).await;
    assert_eq!(
        finish(&router, &other, &id, &code).await.status(),
        StatusCode::BAD_REQUEST
    );
    let (remaining,): (i32,) = sqlx_core::query_as::query_as(
        "SELECT attempts_remaining FROM cloud_signup_email_codes WHERE email = $1",
    )
    .bind(&email)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        remaining, 5,
        "a proof for another email cannot spend the owner's guesses"
    );
    let wrong = if code == "000000" { "999999" } else { "000000" };
    for _ in 0..5 {
        assert_eq!(
            finish(&router, &email, &id, wrong).await.status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        finish(&email_router(pool.clone(), inbox), &email, &id, &code)
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    let (remaining,): (i32,) = sqlx_core::query_as::query_as(
        "SELECT attempts_remaining FROM cloud_signup_email_codes WHERE email = $1",
    )
    .bind(&email)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(remaining, 0);
    assert_eq!(account_count(&pool, &email).await, 0);
    assert_eq!(account_count(&pool, &other).await, 0);
}

#[tokio::test]
async fn expired_codes_are_rejected() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("expired-code");
    let inbox = Arc::new(Inbox::default());
    let router = email_router(pool.clone(), inbox.clone());
    let (id, code) = challenge(&router, &inbox, &email).await;
    sqlx_core::query::query("UPDATE cloud_signup_email_codes SET expires_at = NOW() - INTERVAL '1 second' WHERE email = $1")
        .bind(&email).execute(&pool).await.unwrap();
    assert_eq!(
        finish(&router, &email, &id, &code).await.status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(account_count(&pool, &email).await, 0);
}

#[tokio::test]
async fn resend_is_limited_replaces_old_proof_and_has_hourly_budget() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("resend-code");
    let inbox = Arc::new(Inbox::default());
    let router = email_router(pool.clone(), inbox.clone());
    let (old_id, old_code) = challenge(&router, &inbox, &email).await;
    let limited = send_code(&email_router(pool.clone(), inbox.clone()), &email).await;
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(limited.headers().contains_key("retry-after"));
    for _ in 0..4 {
        sqlx_core::query::query("UPDATE cloud_signup_email_codes SET resend_after = NOW() - INTERVAL '1 second' WHERE email = $1")
            .bind(&email).execute(&pool).await.unwrap();
        challenge(&router, &inbox, &email).await;
    }
    assert_eq!(
        finish(&router, &email, &old_id, &old_code).await.status(),
        StatusCode::BAD_REQUEST
    );
    sqlx_core::query::query("UPDATE cloud_signup_email_codes SET resend_after = NOW() - INTERVAL '1 second' WHERE email = $1")
        .bind(&email).execute(&pool).await.unwrap();
    assert_eq!(
        send_code(&router, &email).await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    sqlx_core::query::query("UPDATE cloud_signup_email_codes SET window_started_at = NOW() - INTERVAL '2 hours' WHERE email = $1")
        .bind(&email).execute(&pool).await.unwrap();
    let (id, code) = challenge(&router, &inbox, &email).await;
    assert_eq!(
        finish(&router, &email, &id, &code).await.status(),
        StatusCode::CREATED
    );
}

async fn send_budget(
    pool: &sqlx_postgres::PgPool,
    email: &str,
) -> (
    i32,
    chrono::DateTime<chrono::Utc>,
    chrono::DateTime<chrono::Utc>,
) {
    sqlx_core::query_as::query_as(
        "SELECT send_count, resend_after, window_started_at FROM cloud_signup_email_codes WHERE email = $1",
    )
    .bind(email)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn allow_resend(pool: &sqlx_postgres::PgPool, email: &str) {
    sqlx_core::query::query("UPDATE cloud_signup_email_codes SET resend_after = NOW() - INTERVAL '1 second' WHERE email = $1")
        .bind(email).execute(pool).await.unwrap();
}

#[tokio::test]
async fn missing_mail_configuration_and_failed_delivery_fail_closed() {
    let Some(pool) = try_pool().await else { return };
    let unavailable = fast_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let email = unique_email("no-mailer");
    assert_eq!(
        send_code(&unavailable, &email).await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let inbox = Arc::new(Inbox {
        fail: AtomicBool::new(true),
        ..Inbox::default()
    });
    let router = email_router(pool.clone(), inbox.clone());
    assert_eq!(
        send_code(&router, &email).await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let (rows,): (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_signup_email_codes WHERE email = $1",
    )
    .bind(&email)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows, 0,
        "a first failed delivery leaves no challenge behind"
    );
    assert_eq!(account_count(&pool, &email).await, 0);

    // The failure did not start a cooldown or spend a send.
    inbox.fail.store(false, Ordering::SeqCst);
    challenge(&router, &inbox, &email).await;
    let (send_count, resend_after, window_started_at) = send_budget(&pool, &email).await;
    assert_eq!(send_count, 1);

    // A failed resend restores the budget and leaves an unusable challenge.
    allow_resend(&pool, &email).await;
    let before = send_budget(&pool, &email).await;
    assert!(before.1 < resend_after);
    assert_eq!(before.2, window_started_at);
    inbox.fail.store(true, Ordering::SeqCst);
    assert_eq!(
        send_code(&router, &email).await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(send_budget(&pool, &email).await, before);
    let (failed_id, attempts, delivered, consumed): (String, i32, bool, bool) =
        sqlx_core::query_as::query_as(
            "SELECT verification_id, attempts_remaining, delivered_at IS NOT NULL, consumed_at IS NOT NULL \
             FROM cloud_signup_email_codes WHERE email = $1",
        )
        .bind(&email)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(attempts, 0);
    assert!(!delivered);
    assert!(!consumed);
    for guess in ["000000", "123456", "999999"] {
        assert_eq!(
            finish(&router, &email, &failed_id, guess).await.status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(account_count(&pool, &email).await, 0);
}

#[tokio::test]
async fn failed_deliveries_do_not_spend_the_hourly_send_budget() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("flapping-mailer");
    let inbox = Arc::new(Inbox {
        fail: AtomicBool::new(true),
        ..Inbox::default()
    });
    let router = email_router(pool.clone(), inbox.clone());
    for _ in 0..5 {
        assert_eq!(
            send_code(&router, &email).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
    inbox.fail.store(false, Ordering::SeqCst);
    challenge(&router, &inbox, &email).await;
    assert_eq!(send_budget(&pool, &email).await.0, 1);

    inbox.fail.store(true, Ordering::SeqCst);
    for _ in 0..5 {
        allow_resend(&pool, &email).await;
        assert_eq!(
            send_code(&router, &email).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
    assert_eq!(send_budget(&pool, &email).await.0, 1);

    inbox.fail.store(false, Ordering::SeqCst);
    let mut latest = None;
    for sent in 2..=5 {
        allow_resend(&pool, &email).await;
        latest = Some(challenge(&router, &inbox, &email).await);
        assert_eq!(send_budget(&pool, &email).await.0, sent);
    }
    allow_resend(&pool, &email).await;
    assert_eq!(
        send_code(&router, &email).await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    let (id, code) = latest.unwrap();
    assert_eq!(
        finish(&router, &email, &id, &code).await.status(),
        StatusCode::CREATED
    );
}
