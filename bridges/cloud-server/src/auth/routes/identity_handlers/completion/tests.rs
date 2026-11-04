use super::*;
use crate::auth::admission::{AdmissionError, AdmissionMode, AdmissionPolicy};
use axum::{body::Body, http::Request};
use tower::ServiceExt;

async fn pool() -> PgPool {
    crate::pg::init_pool(&std::env::var("DATABASE_URL").expect("a disposable database is required"))
        .await
        .unwrap()
}
fn profile(email: &str, verified: bool) -> OAuthProfile {
    OAuthProfile {
        provider_subject: uuid::Uuid::new_v4().to_string(),
        username: None,
        display_name: Some("Synthetic tester".into()),
        email: Some(email.into()),
        email_verified: verified,
        avatar_url: None,
    }
}
fn research() -> AdmissionPolicy {
    AdmissionPolicy::synthetic(
        AdmissionMode::VerifiedDomain,
        vec!["stanford.edu".into()],
        Default::default(),
    )
}
#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn verified_waitlist_never_creates_an_account_or_session() {
    let pool = pool().await;
    let email = format!("test-{}@example.test", uuid::Uuid::new_v4().simple());
    let result = complete_oauth_login_with_policy(
        &pool,
        OAuthProvider::Google,
        profile(&email, true),
        &legacy_device_registration("synthetic"),
        &research(),
    )
    .await;
    assert!(matches!(
        result,
        Err(OAuthLoginError::Admission(AdmissionError::Waitlisted))
    ));
    let entries: (i64,) = query_as("SELECT COUNT(*) FROM cloud_access_waitlist WHERE email = $1")
        .bind(&email)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(entries.0, 1);
    let accounts: (i64,) = query_as("SELECT COUNT(*) FROM cloud_accounts WHERE primary_email = $1")
        .bind(&email)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(accounts.0, 0);
    let unverified = format!("test-{}@example.test", uuid::Uuid::new_v4().simple());
    let result = complete_oauth_login_with_policy(
        &pool,
        OAuthProvider::Github,
        profile(&unverified, false),
        &legacy_device_registration("synthetic"),
        &research(),
    )
    .await;
    assert!(matches!(
        result,
        Err(OAuthLoginError::Admission(
            AdmissionError::VerificationRequired
        ))
    ));
    let entries: (i64,) = query_as("SELECT COUNT(*) FROM cloud_access_waitlist WHERE email = $1")
        .bind(&unverified)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(entries.0, 0);
}
#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn approved_tester_can_sign_in_but_an_old_token_cannot_bypass_revocation() {
    let pool = pool().await;
    let email = format!("tester-{}@example.test", uuid::Uuid::new_v4().simple());
    let policy = AdmissionPolicy::synthetic(
        AdmissionMode::ApprovedTesters,
        vec![],
        [email.clone()].into_iter().collect(),
    );
    let (body, _) = complete_oauth_login_with_policy(
        &pool,
        OAuthProvider::Google,
        profile(&email, true),
        &legacy_device_registration("synthetic"),
        &policy,
    )
    .await
    .unwrap();
    assert!(policy
        .authorize_account(&pool, &body.account.account_id)
        .await
        .is_ok());
    let revoked =
        AdmissionPolicy::synthetic(AdmissionMode::ApprovedTesters, vec![], Default::default());
    let state =
        Arc::new(ServerState::new(pool, crate::events::EventBus::noop()).with_admission(revoked));
    let app = Router::new()
        .route("/protected", get(|| async { "protected" }))
        .route_layer(axum::middleware::from_fn_with_state(
            state,
            crate::auth::routes::cloud_session_middleware,
        ));
    let response = app
        .oneshot(
            Request::builder()
                .uri("/protected")
                .header("Authorization", format!("Bearer {}", body.session.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}
#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn verified_stanford_enters_research_but_not_staging_without_approval() {
    let pool = pool().await;
    let email = format!("tester-{}@stanford.edu", uuid::Uuid::new_v4().simple());
    let (body, _) = complete_oauth_login_with_policy(
        &pool,
        OAuthProvider::Google,
        profile(&email, true),
        &legacy_device_registration("synthetic"),
        &research(),
    )
    .await
    .unwrap();
    assert!(research()
        .authorize_account(&pool, &body.account.account_id)
        .await
        .is_ok());
    let staging =
        AdmissionPolicy::synthetic(AdmissionMode::ApprovedTesters, vec![], Default::default());
    assert_eq!(
        staging
            .authorize_account(&pool, &body.account.account_id)
            .await,
        Err(AdmissionError::TesterApprovalRequired)
    );
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn restricted_password_routes_reject_legacy_signup_and_recheck_approval() {
    let pool = pool().await;
    let email = format!("password-{}@example.test", uuid::Uuid::new_v4().simple());
    let approved = AdmissionPolicy::synthetic(
        AdmissionMode::ApprovedTesters,
        vec![],
        [email.clone()].into_iter().collect(),
    );
    let (account, _) = complete_oauth_login_with_policy(
        &pool,
        OAuthProvider::Google,
        profile(&email, true),
        &legacy_device_registration("synthetic"),
        &approved,
    )
    .await
    .unwrap();
    let password = "Synthetic-password-123";
    let hash = hash_password(password, PasswordHasherConfig::for_tests()).unwrap();
    query("UPDATE cloud_accounts SET password_hash = $1, password_algorithm = $2 WHERE account_id = $3")
        .bind(hash).bind(PASSWORD_ALGORITHM_ID).bind(&account.account.account_id).execute(&pool).await.unwrap();
    let denied =
        AdmissionPolicy::synthetic(AdmissionMode::ApprovedTesters, vec![], Default::default());
    let state = Arc::new(
        ServerState::new(pool.clone(), crate::events::EventBus::noop())
            .with_admission(denied)
            .with_legacy_signup_until(Utc::now() + ChronoDuration::days(1)),
    );
    let app = crate::auth::routes::routes(state);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/cloud/auth/login")
                .header("Content-Type", "application/json")
                .body(Body::from(
                    serde_json::json!({"email":email,"password":password}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let new_email = format!("signup-{}@example.test", uuid::Uuid::new_v4().simple());
    let response = app.oneshot(Request::builder().method("POST").uri("/v1/cloud/auth/signup").header("Content-Type","application/json")
        .body(Body::from(serde_json::json!({"email":new_email,"password":password,"avatarSeed":"synthetic"}).to_string())).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let count: (i64,) = query_as("SELECT COUNT(*) FROM cloud_accounts WHERE primary_email = $1")
        .bind(&new_email)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count.0, 0);
}
