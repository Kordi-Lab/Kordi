//! Synthetic signup proofs for suites whose subject is already-authenticated behavior.
//! Verification route tests exercise delivery through a separate private inbox.

use std::sync::Arc;

use async_trait::async_trait;
use hmac::{Hmac, Mac};
use kordi_cloud_server::auth::signup_email::{SignupCodeSender, SignupEmailService};
use serde_json::{json, Value};
use sha2::Sha256;

pub const KEY: &[u8] = b"synthetic-test-signup-key-32-bytes-only";
pub const CODE: &str = "123456";

struct TestSender;
#[async_trait]
impl SignupCodeSender for TestSender {
    async fn send_code(&self, _: &str, _: &str) -> Result<(), &'static str> {
        Ok(())
    }
}

pub fn service() -> SignupEmailService {
    SignupEmailService::new(Arc::new(TestSender), KEY.to_vec()).unwrap()
}

pub async fn with_proof(mut body: Value) -> Value {
    let email = body["email"].as_str().unwrap().trim().to_ascii_lowercase();
    let id = format!("email_{}", uuid::Uuid::new_v4().simple());
    let mut mac = Hmac::<Sha256>::new_from_slice(KEY).unwrap();
    for part in [id.as_str(), email.as_str(), CODE] {
        mac.update(part.as_bytes());
        mac.update(&[0]);
    }
    let pool = sqlx_postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&std::env::var("DATABASE_URL").expect("disposable test database"))
        .await
        .unwrap();
    sqlx_core::query::query(
        "INSERT INTO cloud_signup_email_codes \
         (email, verification_id, code_mac, expires_at, resend_after, window_started_at, send_count, attempts_remaining, delivered_at) \
         VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes', NOW(), NOW(), 1, 5, NOW()) \
         ON CONFLICT (email) DO UPDATE SET verification_id = EXCLUDED.verification_id, \
         code_mac = EXCLUDED.code_mac, attempts_remaining = 5, consumed_at = NULL, delivered_at = NOW()",
    ).bind(email).bind(&id).bind(mac.finalize().into_bytes().to_vec()).execute(&pool).await.unwrap();
    pool.close().await;
    body["verificationId"] = json!(id);
    body["verificationCode"] = json!(CODE);
    body
}

pub fn state(pool: sqlx_postgres::PgPool) -> kordi_cloud_server::server::ServerState {
    kordi_cloud_server::server::ServerState::new(pool, kordi_cloud_server::events::EventBus::noop())
        .with_signup_email(service())
}
