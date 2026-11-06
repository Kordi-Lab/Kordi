//! Account security routes against a task-owned disposable PostgreSQL
//! database at `$DATABASE_URL`. Run with `--ignored`. Every account, email,
//! and secret is synthetic and generated per test.

use super::*;
use crate::auth::app_sign_in::tokens::start_sign_in;
use crate::auth::rate_limit::CloudRateLimitConfig;
use crate::auth::routes::web_session_handlers::{
    web_csrf_token, WEB_CSRF_HEADER, WEB_SESSION_COOKIE,
};
use crate::auth::session::issue_session;
use axum::body::Body;
use axum::http::Request as HttpRequest;
use serde_json::{json, Value};
use tower::ServiceExt;

mod delete_account;
mod email_change;
mod password;
mod providers;
mod sessions;

pub(super) const BASE: &str = "/v1/cloud/account/security";

/// A password that satisfies the password rule, different on every call.
pub(super) fn strong_password() -> String {
    format!("Pw{}9", uuid::Uuid::new_v4().simple())
}

pub(super) fn unique_email(prefix: &str) -> String {
    format!("{prefix}-{}@example.test", uuid::Uuid::new_v4().simple())
}

pub(super) struct CapturingSender(std::sync::Mutex<Vec<(String, String)>>);

#[async_trait::async_trait]
impl crate::auth::signup_email::SignupCodeSender for CapturingSender {
    async fn send_code(&self, email: &str, code: &str) -> Result<(), &'static str> {
        self.0
            .lock()
            .unwrap()
            .push((email.to_string(), code.to_string()));
        Ok(())
    }
}

pub(super) struct Harness {
    pub app: Router,
    pub pool: PgPool,
    pub sender: Arc<CapturingSender>,
}

/// How a request authenticates.
#[derive(Clone, Copy)]
pub(super) enum Auth<'a> {
    /// The web page: cookie, exact `Origin`, and CSRF header.
    Web(&'a str),
    /// Cookie and `Origin` without the CSRF header.
    WebWithoutCsrf(&'a str),
    /// Cookie and CSRF header from another origin.
    WebFromOtherOrigin(&'a str),
    Bearer(&'a str),
    None,
}

pub(super) struct Account {
    pub account_id: String,
    pub email: String,
    pub device_id: String,
    pub token: String,
    pub token_id: String,
}

pub(super) async fn harness() -> Harness {
    let url = std::env::var("DATABASE_URL").expect("a disposable database is required");
    let pool = crate::pg::init_pool(&url).await.unwrap();
    let sender = Arc::new(CapturingSender(std::sync::Mutex::new(Vec::new())));
    let service =
        crate::auth::signup_email::SignupEmailService::new(sender.clone(), vec![7; 32]).unwrap();
    let state = Arc::new(
        ServerState::new(pool.clone(), crate::events::EventBus::noop()).with_signup_email(service),
    );
    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig {
        per_ip_limit: 10_000,
        ..CloudRateLimitConfig::production()
    });
    let app =
        crate::auth::routes::routes_with_config(state, PasswordHasherConfig::for_tests(), limiter);
    Harness { app, pool, sender }
}

impl Harness {
    pub(super) async fn send(
        &self,
        method: &str,
        uri: &str,
        auth: Auth<'_>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = HttpRequest::builder().method(method).uri(uri);
        let origin = crate::distribution::public_origin();
        let headers: Vec<(String, String)> = match auth {
            Auth::Web(token) => vec![
                ("Cookie".into(), format!("{WEB_SESSION_COOKIE}={token}")),
                ("Origin".into(), origin),
                (WEB_CSRF_HEADER.into(), web_csrf_token(token)),
            ],
            Auth::WebWithoutCsrf(token) => vec![
                ("Cookie".into(), format!("{WEB_SESSION_COOKIE}={token}")),
                ("Origin".into(), origin),
            ],
            Auth::WebFromOtherOrigin(token) => vec![
                ("Cookie".into(), format!("{WEB_SESSION_COOKIE}={token}")),
                ("Origin".into(), "https://elsewhere.example.test".into()),
                (WEB_CSRF_HEADER.into(), web_csrf_token(token)),
            ],
            Auth::Bearer(token) => vec![("Authorization".into(), format!("Bearer {token}"))],
            Auth::None => Vec::new(),
        };
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let body = match body {
            Some(body) => {
                request = request.header("Content-Type", "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = self
            .app
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    pub(super) async fn overview(&self, auth: Auth<'_>) -> Value {
        let (status, body) = self.send("GET", BASE, auth, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    pub(super) async fn post(
        &self,
        path: &str,
        auth: Auth<'_>,
        body: Value,
    ) -> (StatusCode, Value) {
        self.send("POST", &format!("{BASE}{path}"), auth, Some(body))
            .await
    }

    pub(super) async fn me_status(&self, token: &str) -> StatusCode {
        self.send("GET", "/v1/cloud/auth/me", Auth::Bearer(token), None)
            .await
            .0
    }

    /// The codes sent since the last call, with their recipients.
    pub(super) fn sent_codes(&self) -> Vec<(String, String)> {
        std::mem::take(&mut *self.sender.0.lock().unwrap())
    }

    /// A synthetic account signed in on the web from a confirmed browser.
    pub(super) async fn account(&self, password: Option<&str>, verified: bool) -> Account {
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let account_id = format!("acct_security_{suffix}");
        let email = unique_email("security");
        let now = Utc::now().to_rfc3339();
        let hash = password.map(|password| {
            crate::auth::password::hash_password(password, PasswordHasherConfig::for_tests())
                .unwrap()
        });
        query(
            "INSERT INTO cloud_accounts \
             (account_id, display_name, primary_email, primary_email_verified_at, password_hash, \
              password_algorithm, created_at, updated_at, avatar_source, avatar_style, \
              avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
             VALUES ($1, 'Security tester', $2, $3, $4, $5, $6, $6, 'generated', 'lorelei', $1, \
                     'fixture', 1, $6)",
        )
        .bind(&account_id)
        .bind(&email)
        .bind(verified.then(|| now.clone()))
        .bind(&hash)
        .bind(hash.as_ref().map(|_| PASSWORD_ALGORITHM_ID))
        .bind(&now)
        .execute(&self.pool)
        .await
        .unwrap();
        let device_id = self
            .device(&account_id, "Web browser", None, "confirmed")
            .await;
        let (token, token_id) = self.session(&account_id, &device_id).await;
        Account {
            account_id,
            email,
            device_id,
            token,
            token_id,
        }
    }

    /// A device of the account. Without a platform it looks like a browser.
    pub(super) async fn device(
        &self,
        account_id: &str,
        name: &str,
        platform: Option<&str>,
        authorization_state: &str,
    ) -> String {
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let device_id = format!("dev_security_{suffix}");
        let now = Utc::now().to_rfc3339();
        let key_algorithm = if platform.is_some() { "p256" } else { "legacy" };
        query(
            "INSERT INTO cloud_devices \
             (device_id, account_id, device_name, device_public_key, device_key_algorithm, \
              device_platform, authorization_state, review_started_at, confirmed_at, \
              created_at, last_seen_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8, $8)",
        )
        .bind(&device_id)
        .bind(account_id)
        .bind(name)
        .bind(format!("{key_algorithm}:{suffix}"))
        .bind(key_algorithm)
        .bind(platform)
        .bind(authorization_state)
        .bind(&now)
        .bind((authorization_state == "confirmed").then(|| now.clone()))
        .execute(&self.pool)
        .await
        .unwrap();
        device_id
    }

    /// A direct session on a device: (token, token id).
    pub(super) async fn session(&self, account_id: &str, device_id: &str) -> (String, String) {
        let issued = issue_session(&self.pool, account_id, device_id, 30)
            .await
            .unwrap();
        (issued.plaintext_token, issued.token_id)
    }

    /// An app sign-in on a device: (sign-in id, access token).
    pub(super) async fn app_sign_in(&self, account_id: &str, device_id: &str) -> (String, String) {
        let mut tx = self.pool.begin().await.unwrap();
        let issued = start_sign_in(&mut tx, account_id, device_id, "kordi-desktop")
            .await
            .unwrap();
        tx.commit().await.unwrap();
        (issued.sign_in_id, issued.access_token)
    }

    /// Moves a session's sign-in back in time.
    pub(super) async fn age_session(&self, token_id: &str, minutes: i64) {
        let at = (Utc::now() - ChronoDuration::minutes(minutes)).to_rfc3339();
        query("UPDATE cloud_refresh_tokens SET created_at = $2 WHERE token_id = $1")
            .bind(token_id)
            .bind(at)
            .execute(&self.pool)
            .await
            .unwrap();
    }

    pub(super) async fn audit_count(&self, account_id: &str, event_type: &str) -> i64 {
        let (count,): (i64,) = query_as(
            "SELECT COUNT(*) FROM cloud_audit_events WHERE account_id = $1 AND event_type = $2",
        )
        .bind(account_id)
        .bind(event_type)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        count
    }

    pub(super) async fn link(&self, account_id: &str, provider: &str, email: &str) {
        let now = Utc::now().to_rfc3339();
        query(
            "INSERT INTO cloud_account_identities \
             (identity_id, account_id, provider, provider_subject, email, email_verified, \
              created_at, updated_at) \
             VALUES ($1, $2, $3, $4, $5, TRUE, $6, $6)",
        )
        .bind(format!("ident_{}", uuid::Uuid::new_v4().simple()))
        .bind(account_id)
        .bind(provider)
        .bind(format!("subject-{}", uuid::Uuid::new_v4().simple()))
        .bind(email)
        .bind(&now)
        .execute(&self.pool)
        .await
        .unwrap();
    }
}

pub(super) fn error_code(body: &Value) -> &str {
    body["errorCode"].as_str().unwrap_or_default()
}
