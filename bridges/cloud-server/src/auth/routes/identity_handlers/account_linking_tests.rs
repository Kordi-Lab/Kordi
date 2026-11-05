//! One Kordi account per verified email across Google, GitHub, and email
//! sign-up, against a task-owned disposable Postgres at `$DATABASE_URL`.
//! Every test uses uuid-suffixed synthetic data.

use super::*;
use axum::body::Body;
use axum::http::Request;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::util::ServiceExt;

const PASSWORD: &str = "Synthetic-password-123";

async fn pool() -> PgPool {
    crate::pg::init_pool(&std::env::var("DATABASE_URL").expect("a disposable database is required"))
        .await
        .expect("init test pool")
}

fn unique_email(prefix: &str) -> String {
    format!("{prefix}-{}@example.test", uuid::Uuid::new_v4().simple())
}

fn unique_subject() -> String {
    format!("subject-{}", uuid::Uuid::new_v4().simple())
}

fn profile(subject: &str, email: Option<&str>, email_verified: bool) -> OAuthProfile {
    OAuthProfile {
        provider_subject: subject.to_string(),
        username: None,
        display_name: Some("Synthetic tester".to_string()),
        email: email.map(str::to_string),
        email_verified,
        avatar_url: None,
        hosted_domain: None,
    }
}

async fn provider_login(
    pool: &PgPool,
    provider: OAuthProvider,
    profile: OAuthProfile,
) -> Result<(AuthResponse, bool), OAuthLoginError> {
    complete_oauth_login(
        pool,
        provider,
        profile,
        &legacy_device_registration("oauth-test-device"),
    )
    .await
}

struct CapturingSender(std::sync::Mutex<Option<(String, String)>>);

#[async_trait::async_trait]
impl crate::auth::signup_email::SignupCodeSender for CapturingSender {
    async fn send_code(&self, email: &str, code: &str) -> Result<(), &'static str> {
        *self.0.lock().unwrap() = Some((email.to_string(), code.to_string()));
        Ok(())
    }
}

struct App {
    router: Router,
    sender: Arc<CapturingSender>,
}

fn app(pool: &PgPool) -> App {
    let sender = Arc::new(CapturingSender(std::sync::Mutex::new(None)));
    let service =
        crate::auth::signup_email::SignupEmailService::new(sender.clone(), vec![7; 32]).unwrap();
    let state =
        ServerState::new(pool.clone(), crate::events::EventBus::noop()).with_signup_email(service);
    let router = routes_with_config(
        Arc::new(state),
        PasswordHasherConfig::for_tests(),
        CloudRateLimiter::memory(crate::auth::rate_limit::CloudRateLimitConfig::production()),
    );
    App { router, sender }
}

impl App {
    async fn call(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Value,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let body = if body.is_null() {
            Body::empty()
        } else {
            Body::from(body.to_string())
        };
        let response = self
            .router
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// Requests a sign-up code and returns its verification id and the code.
    async fn signup_code(&self, email: &str) -> Result<(String, String), (StatusCode, Value)> {
        let (status, body) = self
            .call(
                "POST",
                "/v1/cloud/auth/signup/code",
                None,
                json!({"email": email}),
            )
            .await;
        if status != StatusCode::OK {
            return Err((status, body));
        }
        let (_, code) = self.sender.0.lock().unwrap().take().expect("code was sent");
        Ok((body["verificationId"].as_str().unwrap().to_string(), code))
    }

    async fn signup(&self, email: &str, proof: Option<(&str, &str)>) -> (StatusCode, Value) {
        let mut body = json!({
            "email": email,
            "password": PASSWORD,
            "displayName": "Email tester",
            "avatarSeed": "account_linking_test",
        });
        if let Some((verification_id, code)) = proof {
            body["verificationId"] = json!(verification_id);
            body["verificationCode"] = json!(code);
        }
        self.call("POST", "/v1/cloud/auth/signup", None, body).await
    }

    async fn login(&self, email: &str, password: &str) -> (StatusCode, Value) {
        self.call(
            "POST",
            "/v1/cloud/auth/login",
            None,
            json!({"email": email, "password": password}),
        )
        .await
    }

    async fn me(&self, token: &str) -> StatusCode {
        self.call("GET", "/v1/cloud/auth/me", Some(token), Value::Null)
            .await
            .0
    }
}

async fn accounts_with_email(pool: &PgPool, email: &str) -> i64 {
    query_as::<_, (i64,)>(
        "SELECT count(*) FROM cloud_accounts WHERE LOWER(primary_email) = LOWER($1)",
    )
    .bind(email)
    .fetch_one(pool)
    .await
    .unwrap()
    .0
}

async fn identities_for(pool: &PgPool, account_id: &str) -> i64 {
    query_as::<_, (i64,)>("SELECT count(*) FROM cloud_account_identities WHERE account_id = $1")
        .bind(account_id)
        .fetch_one(pool)
        .await
        .unwrap()
        .0
}

async fn password_hash(pool: &PgPool, account_id: &str) -> Option<String> {
    query_as::<_, (Option<String>,)>(
        "SELECT password_hash FROM cloud_accounts WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_one(pool)
    .await
    .unwrap()
    .0
}

async fn audit_events(pool: &PgPool, account_id: &str, event_type: &str) -> i64 {
    query_as::<_, (i64,)>(
        "SELECT count(*) FROM cloud_audit_events WHERE account_id = $1 AND event_type = $2",
    )
    .bind(account_id)
    .bind(event_type)
    .fetch_one(pool)
    .await
    .unwrap()
    .0
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn google_first_then_email_signup_adds_a_password_to_the_same_account() {
    let pool = pool().await;
    let app = app(&pool);
    let email = unique_email("google-first");
    let subject = unique_subject();
    let (google, _) = provider_login(
        &pool,
        OAuthProvider::Google,
        profile(&subject, Some(&email), true),
    )
    .await
    .expect("new Google account");
    let account_id = google.account.account_id.clone();
    assert_eq!(password_hash(&pool, &account_id).await, None);

    // Passwordless accounts get no password sign-in and no enumeration.
    let (status, body) = app.login(&email, PASSWORD).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["errorCode"], "invalid_credentials");
    let (unknown_status, unknown_body) = app.login(&unique_email("nobody"), PASSWORD).await;
    assert_eq!(unknown_status, status);
    assert_eq!(unknown_body, body);

    // The emailed code proves the address, so the password joins the account.
    let mixed_case = email.to_uppercase();
    let (verification_id, code) = app.signup_code(&mixed_case).await.expect("code is sent");
    let (status, body) = app
        .signup(&mixed_case, Some((&verification_id, &code)))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["account"]["accountId"], json!(account_id));
    assert_eq!(accounts_with_email(&pool, &email).await, 1);
    assert!(password_hash(&pool, &account_id).await.is_some());
    assert_eq!(
        audit_events(&pool, &account_id, "auth.password.added").await,
        1
    );
    // The Google profile keeps its name.
    assert_eq!(body["account"]["displayName"], "Synthetic tester");

    let (status, body) = app.login(&email, PASSWORD).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["account"]["accountId"], json!(account_id));
    let (again, _) = provider_login(
        &pool,
        OAuthProvider::Google,
        profile(&subject, Some(&email), true),
    )
    .await
    .expect("Google still signs in");
    assert_eq!(again.account.account_id, account_id);

    // The session from the first Google sign-in is untouched.
    assert_eq!(app.me(&google.session.token).await, StatusCode::OK);

    // A second sign-up for the address now meets the existing password.
    assert!(matches!(
        app.signup_code(&email).await,
        Err((StatusCode::CONFLICT, ref body)) if body["errorCode"] == "email_in_use"
    ));
    let (status, body) = app.signup(&email, Some((&verification_id, &code))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["errorCode"], "email_in_use");
    assert_eq!(accounts_with_email(&pool, &email).await, 1);
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn email_first_then_google_and_github_join_the_same_account() {
    let pool = pool().await;
    let app = app(&pool);
    let email = unique_email("email-first");
    let (verification_id, code) = app.signup_code(&email).await.expect("code is sent");
    let (status, body) = app.signup(&email, Some((&verification_id, &code))).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let account_id = body["account"]["accountId"].as_str().unwrap().to_string();
    let signup_token = body["session"]["token"].as_str().unwrap().to_string();

    let (google, _) = provider_login(
        &pool,
        OAuthProvider::Google,
        profile(&unique_subject(), Some(&email.to_uppercase()), true),
    )
    .await
    .expect("verified Google email links");
    assert_eq!(google.account.account_id, account_id);
    let (github, _) = provider_login(
        &pool,
        OAuthProvider::Github,
        profile(&unique_subject(), Some(&email), true),
    )
    .await
    .expect("verified GitHub email links");
    assert_eq!(github.account.account_id, account_id);
    assert_eq!(identities_for(&pool, &account_id).await, 2);
    assert_eq!(accounts_with_email(&pool, &email).await, 1);
    assert_eq!(
        audit_events(&pool, &account_id, "auth.oauth.linked_by_email").await,
        2
    );

    let (status, body) = app.login(&email, PASSWORD).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["account"]["accountId"], json!(account_id));
    assert_eq!(app.me(&signup_token).await, StatusCode::OK);
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn github_without_a_verified_email_never_joins_an_account() {
    let pool = pool().await;
    let email = unique_email("github-unverified");
    let (google, _) = provider_login(
        &pool,
        OAuthProvider::Google,
        profile(&unique_subject(), Some(&email), true),
    )
    .await
    .expect("new Google account");

    // GitHub reports an email only when the primary one is verified, so an
    // unverified GitHub email arrives as no email at all.
    let (github, _) = provider_login(
        &pool,
        OAuthProvider::Github,
        profile(&unique_subject(), None, false),
    )
    .await
    .expect("GitHub without email signs in alone");
    assert_ne!(github.account.account_id, google.account.account_id);
    assert_eq!(github.account.primary_email, None);

    // A provider that names the email without verifying it is refused
    // without creating a second account for the address.
    let result = provider_login(
        &pool,
        OAuthProvider::Github,
        profile(&unique_subject(), Some(&email), false),
    )
    .await;
    assert!(matches!(
        result,
        Err(OAuthLoginError::ExistingEmailAccount { .. })
    ));
    assert_eq!(identities_for(&pool, &google.account.account_id).await, 1);
    assert_eq!(accounts_with_email(&pool, &email).await, 1);
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn unverified_existing_accounts_are_never_claimed_by_email() {
    let pool = pool().await;
    let app = app(&pool);
    // A provider account whose email the provider did not verify.
    let email = unique_email("unverified-owner");
    let (owner, _) = provider_login(
        &pool,
        OAuthProvider::Google,
        profile(&unique_subject(), Some(&email), false),
    )
    .await
    .expect("account with an unverified provider email");
    let account_id = owner.account.account_id;

    assert!(matches!(
        app.signup_code(&email).await,
        Err((StatusCode::CONFLICT, ref body)) if body["errorCode"] == "email_in_use"
    ));
    let (status, body) = app.signup(&email, Some(("email_unused", "123456"))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["errorCode"], "email_in_use");
    assert_eq!(password_hash(&pool, &account_id).await, None);

    // A verified provider email cannot take it over either.
    let result = provider_login(
        &pool,
        OAuthProvider::Github,
        profile(&unique_subject(), Some(&email), true),
    )
    .await;
    assert!(matches!(
        result,
        Err(OAuthLoginError::ExistingEmailAccount {
            password_sign_in: false,
            ..
        })
    ));
    assert_eq!(identities_for(&pool, &account_id).await, 1);
    assert_eq!(accounts_with_email(&pool, &email).await, 1);
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn a_wrong_code_leaves_the_provider_account_unchanged() {
    let pool = pool().await;
    let app = app(&pool);
    let email = unique_email("wrong-code");
    let (google, _) = provider_login(
        &pool,
        OAuthProvider::Google,
        profile(&unique_subject(), Some(&email), true),
    )
    .await
    .expect("new Google account");
    let account_id = google.account.account_id;

    let (verification_id, code) = app.signup_code(&email).await.expect("code is sent");
    let wrong = if code == "000000" { "111111" } else { "000000" };
    let (status, body) = app.signup(&email, Some((&verification_id, wrong))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["errorCode"], "invalid_verification_code");
    // Legacy sign-up without a code never reaches an existing account.
    let (status, _) = app.signup(&email, None).await;
    assert_ne!(status, StatusCode::OK);
    assert_eq!(password_hash(&pool, &account_id).await, None);
    assert_eq!(accounts_with_email(&pool, &email).await, 1);
    assert_eq!(app.me(&google.session.token).await, StatusCode::OK);
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn mixed_case_stored_emails_link_by_their_normalized_form() {
    let pool = pool().await;
    let email = unique_email("Mixed.Case");
    let account_id = format!("acct_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, created_at, updated_at, \
          primary_email_verified_at, avatar_source, avatar_style, avatar_seed, \
          avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, 'Existing', $2, $3, $3, $3, 'generated', 'lorelei', $1, 'fixture', 1, $3)",
    )
    .bind(&account_id)
    .bind(&email)
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();

    let (body, _) = provider_login(
        &pool,
        OAuthProvider::Google,
        profile(
            &unique_subject(),
            Some(&format!("  {}  ", email.to_lowercase())),
            true,
        ),
    )
    .await
    .expect("normalized email links");
    assert_eq!(body.account.account_id, account_id);
    assert_eq!(accounts_with_email(&pool, &email).await, 1);
}
