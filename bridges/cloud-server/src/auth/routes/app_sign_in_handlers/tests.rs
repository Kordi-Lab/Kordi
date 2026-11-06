//! Browser sign-in endpoints against a disposable PostgreSQL database at
//! `$DATABASE_URL`. Run with `--ignored`; see scripts/test-cloud-migrations.sh.

use super::*;
use crate::auth::rate_limit::CloudRateLimitConfig;
use axum::body::Body;
use axum::http::Request as HttpRequest;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tower::ServiceExt;

mod hardening;
mod prompt;
mod refresh_grace;
mod rejections;
mod web_app;
mod web_app_chat;
mod web_authorize;
mod web_oauth_binding;
mod web_session;

pub(super) const DESKTOP: &str = "kordi-desktop";
pub(super) const IOS: &str = "kordi-ios";
pub(super) const LOOPBACK: &str = "http://127.0.0.1:53682/auth/callback";

pub(super) struct Harness {
    pub app: Router,
    pub pool: PgPool,
}

pub(super) struct WebAccount {
    pub account_id: String,
    pub web_token: String,
}

pub(super) struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub(super) fn pkce() -> Pkce {
    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    Pkce {
        verifier,
        challenge,
    }
}

pub(super) async fn harness() -> Harness {
    harness_with_limit(10_000).await
}

pub(super) async fn harness_with_limit(per_ip_limit: u32) -> Harness {
    let url = std::env::var("DATABASE_URL").expect("a disposable database is required");
    let pool = crate::pg::init_pool(&url).await.unwrap();
    let state = Arc::new(ServerState::new(
        pool.clone(),
        crate::events::EventBus::noop(),
    ));
    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig {
        per_ip_limit,
        ..CloudRateLimitConfig::production()
    });
    let app =
        crate::auth::routes::routes_with_config(state, PasswordHasherConfig::for_tests(), limiter);
    Harness { app, pool }
}

impl Harness {
    pub(super) async fn send(
        &self,
        method: &str,
        uri: &str,
        bearer: Option<&str>,
        body: Option<(&str, String)>,
    ) -> (StatusCode, Value, HeaderMap) {
        let headers = bearer
            .map(|token| vec![("Authorization".to_string(), format!("Bearer {token}"))])
            .unwrap_or_default();
        self.send_with(method, uri, headers, body).await
    }

    pub(super) async fn send_with(
        &self,
        method: &str,
        uri: &str,
        headers: Vec<(String, String)>,
        body: Option<(&str, String)>,
    ) -> (StatusCode, Value, HeaderMap) {
        let mut request = HttpRequest::builder().method(method).uri(uri);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let body = match body {
            Some((content_type, body)) => {
                request = request.header("Content-Type", content_type);
                Body::from(body)
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
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value, headers)
    }

    pub(super) async fn json(
        &self,
        method: &str,
        uri: &str,
        bearer: Option<&str>,
        body: Value,
    ) -> (StatusCode, Value) {
        let (status, value, _) = self
            .send(
                method,
                uri,
                bearer,
                Some(("application/json", body.to_string())),
            )
            .await;
        (status, value)
    }

    /// A JSON request from the web sign-in page: session cookie, exact
    /// public `Origin`, and the CSRF header.
    pub(super) async fn web(&self, uri: &str, web_token: &str, body: Value) -> (StatusCode, Value) {
        let (status, value, _) = self
            .send_with(
                "POST",
                uri,
                web_headers(web_token),
                Some(("application/json", body.to_string())),
            )
            .await;
        (status, value)
    }

    pub(super) async fn form(&self, uri: &str, pairs: &[(&str, &str)]) -> (StatusCode, Value) {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(pairs)
            .finish();
        let (status, value, headers) = self
            .send(
                "POST",
                uri,
                None,
                Some(("application/x-www-form-urlencoded", body)),
            )
            .await;
        if status == StatusCode::OK {
            assert_eq!(headers.get("cache-control").unwrap(), "no-store");
        }
        (status, value)
    }

    /// A synthetic account signed in on the web, as the sign-in page would be.
    pub(super) async fn web_account(&self) -> WebAccount {
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let account_id = format!("acct_app_sign_in_{suffix}");
        let device_id = format!("dev_web_{suffix}");
        let now = Utc::now().to_rfc3339();
        query(
            "INSERT INTO cloud_accounts \
             (account_id, display_name, primary_email, created_at, updated_at, avatar_source, \
              avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
             VALUES ($1, 'Browser tester', $2, $3, $3, 'generated', 'lorelei', $1, 'fixture', 1, $3)",
        )
        .bind(&account_id)
        .bind(format!("{account_id}@example.test"))
        .bind(&now)
        .execute(&self.pool)
        .await
        .unwrap();
        query(
            "INSERT INTO cloud_devices \
             (device_id, account_id, device_name, device_public_key, created_at, last_seen_at) \
             VALUES ($1, $2, 'Web browser', $3, $4, $4)",
        )
        .bind(&device_id)
        .bind(&account_id)
        .bind(format!("legacy:{suffix}"))
        .bind(&now)
        .execute(&self.pool)
        .await
        .unwrap();
        let session = issue_session(&self.pool, &account_id, &device_id, 30)
            .await
            .unwrap();
        WebAccount {
            account_id,
            web_token: session.plaintext_token,
        }
    }

    /// Ask for a code as the sign-in page would and return it.
    pub(super) async fn code(
        &self,
        web_token: &str,
        client_id: &str,
        redirect_uri: &str,
        pkce: &Pkce,
    ) -> String {
        let (status, body) = self
            .web(
                "/v1/cloud/auth/app/authorize",
                web_token,
                authorize_body(client_id, redirect_uri, &pkce.challenge),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let redirect = url::Url::parse(body["redirectUrl"].as_str().unwrap()).unwrap();
        let pairs: std::collections::HashMap<_, _> = redirect.query_pairs().into_owned().collect();
        assert_eq!(pairs["state"], "state-1");
        assert!(body["redirectUrl"]
            .as_str()
            .unwrap()
            .starts_with(&format!("{redirect_uri}?code=")));
        pairs["code"].clone()
    }

    pub(super) async fn exchange(
        &self,
        client_id: &str,
        code: &str,
        redirect_uri: &str,
        verifier: &str,
    ) -> (StatusCode, Value) {
        self.form(
            "/v1/cloud/auth/app/token",
            &[
                ("grant_type", "authorization_code"),
                ("client_id", client_id),
                ("code", code),
                ("redirect_uri", redirect_uri),
                ("code_verifier", verifier),
            ],
        )
        .await
    }

    pub(super) async fn refresh(
        &self,
        client_id: &str,
        refresh_token: &str,
    ) -> (StatusCode, Value) {
        self.form(
            "/v1/cloud/auth/app/token",
            &[
                ("grant_type", "refresh_token"),
                ("client_id", client_id),
                ("refresh_token", refresh_token),
            ],
        )
        .await
    }

    pub(super) async fn me_status(&self, access_token: &str) -> StatusCode {
        self.send("GET", "/v1/cloud/auth/me", Some(access_token), None)
            .await
            .0
    }

    /// Sign in from scratch and return the token response.
    pub(super) async fn signed_in(
        &self,
        account: &WebAccount,
        client_id: &str,
        redirect_uri: &str,
    ) -> Value {
        let pkce = pkce();
        let code = self
            .code(&account.web_token, client_id, redirect_uri, &pkce)
            .await;
        let (status, body) = self
            .exchange(client_id, &code, redirect_uri, &pkce.verifier)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }
}

pub(super) fn web_headers(web_token: &str) -> Vec<(String, String)> {
    use crate::auth::routes::web_session_handlers::{
        web_csrf_token, WEB_CSRF_HEADER, WEB_SESSION_COOKIE,
    };
    vec![
        (
            "Cookie".to_string(),
            format!("{WEB_SESSION_COOKIE}={web_token}"),
        ),
        ("Origin".to_string(), crate::distribution::public_origin()),
        (WEB_CSRF_HEADER.to_string(), web_csrf_token(web_token)),
    ]
}

/// The page's request after the user approved the app.
pub(super) fn authorize_body(client_id: &str, redirect_uri: &str, challenge: &str) -> Value {
    serde_json::json!({
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": "state-1",
        "approved": true,
    })
}

pub(super) fn token(body: &Value, field: &str) -> String {
    body[field].as_str().unwrap().to_string()
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn code_exchange_refresh_and_sign_out_happy_path() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let pkce = pkce();

    // The app opens the authorization URL; the server forwards to the page.
    let start = format!(
        "/v1/cloud/auth/app/authorize?response_type=code&client_id={DESKTOP}\
         &redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2Fauth%2Fcallback\
         &code_challenge={}&code_challenge_method=S256&state=state-1",
        pkce.challenge
    );
    let (status, _, headers) = harness.send("GET", &start, None, None).await;
    assert!(status.is_redirection());
    let location = headers.get("location").unwrap().to_str().unwrap();
    assert!(location.starts_with(&app_sign_in_page_url()), "{location}");
    assert!(location.contains(&pkce.challenge));
    assert!(!location.contains("code="));

    let code = harness
        .code(&account.web_token, DESKTOP, LOOPBACK, &pkce)
        .await;
    let (status, first) = harness
        .exchange(DESKTOP, &code, LOOPBACK, &pkce.verifier)
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["token_type"], "Bearer");
    assert_eq!(first["account"]["accountId"], account.account_id);
    assert!(first["expires_in"].as_i64().unwrap() <= 3600);
    let access = token(&first, "access_token");
    assert!(access.starts_with(SESSION_TOKEN_PREFIX));
    assert!(token(&first, "refresh_token").starts_with("kordi_rt_"));

    // The access token works with the existing middleware and its expiry
    // does not slide forward on use.
    let expiry_before: (String,) =
        query_as("SELECT expires_at FROM cloud_refresh_tokens WHERE token_hash = $1")
            .bind(crate::auth::session::hash_session_token(&access))
            .fetch_one(&harness.pool)
            .await
            .unwrap();
    assert_eq!(harness.me_status(&access).await, StatusCode::OK);
    let expiry_after: (String,) =
        query_as("SELECT expires_at FROM cloud_refresh_tokens WHERE token_hash = $1")
            .bind(crate::auth::session::hash_session_token(&access))
            .fetch_one(&harness.pool)
            .await
            .unwrap();
    assert_eq!(expiry_before, expiry_after);

    // Refresh rotates the refresh token; JSON bodies work too.
    let (status, second) = harness
        .json(
            "POST",
            "/v1/cloud/auth/app/token",
            None,
            serde_json::json!({
                "grant_type": "refresh_token",
                "client_id": DESKTOP,
                "refresh_token": token(&first, "refresh_token"),
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_eq!(second["sign_in_id"], first["sign_in_id"]);
    assert_ne!(second["refresh_token"], first["refresh_token"]);
    assert!(second.get("account").is_none());
    let access = token(&second, "access_token");
    assert_eq!(harness.me_status(&access).await, StatusCode::OK);

    // The account sees one signed-in app, marked current.
    let (status, list, _) = harness
        .send("GET", "/v1/cloud/auth/app/sign-ins", Some(&access), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    let sign_ins = list["signIns"].as_array().unwrap();
    assert_eq!(sign_ins.len(), 1);
    assert_eq!(sign_ins[0]["signInId"], first["sign_in_id"]);
    assert_eq!(sign_ins[0]["appName"], "Kordi for Mac");
    assert_eq!(sign_ins[0]["current"], true);

    // Sign-out revokes the whole sign-in.
    let (status, _) = harness
        .form(
            "/v1/cloud/auth/app/revoke",
            &[
                ("client_id", DESKTOP),
                ("token", &token(&second, "refresh_token")),
            ],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(harness.me_status(&access).await, StatusCode::UNAUTHORIZED);
    let (status, body) = harness
        .refresh(DESKTOP, &token(&second, "refresh_token"))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_grant");
    // The web session that authorized the app is untouched.
    assert_eq!(harness.me_status(&account.web_token).await, StatusCode::OK);
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn device_details_register_a_named_device() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let pkce = pkce();
    let code = harness
        .code(&account.web_token, DESKTOP, LOOPBACK, &pkce)
        .await;
    let public_key = {
        let secret = p256::SecretKey::from_slice(&[9_u8; 32]).unwrap();
        URL_SAFE_NO_PAD.encode(secret.public_key().to_sec1_bytes())
    };
    let (status, body) = harness
        .form(
            "/v1/cloud/auth/app/token",
            &[
                ("grant_type", "authorization_code"),
                ("client_id", DESKTOP),
                ("code", &code),
                ("redirect_uri", LOOPBACK),
                ("code_verifier", &pkce.verifier),
                ("device_public_key", &public_key),
                ("device_key_algorithm", "p256"),
                ("device_name", "Synthetic Mac"),
                ("device_platform", "macos"),
            ],
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let device: (Option<String>, Option<String>, String) = query_as(
        "SELECT device_name, device_platform, authorization_state FROM cloud_devices \
         WHERE device_id = $1",
    )
    .bind(token(&body, "device_id"))
    .fetch_one(&harness.pool)
    .await
    .unwrap();
    assert_eq!(device.0.as_deref(), Some("Synthetic Mac"));
    assert_eq!(device.1.as_deref(), Some("macos"));
    assert_eq!(device.2, "pending_review");
}
