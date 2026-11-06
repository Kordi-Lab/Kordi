//! Sign in with Apple completion and token revocation against a real
//! Postgres at `$DATABASE_URL`, with Apple replaced by a fake. Skipped when
//! `DATABASE_URL` is unset. Every test uses uuid-suffixed data.

use serde_json::json;

use super::*;
use crate::auth::oauth::apple::test_support::*;
use crate::auth::oauth::apple::tokens::revoke_tokens;
use crate::auth::oauth::apple::AppleApiError;
use crate::cloud_agent_runtime::provider_auth::ProviderAuthCipherError;

const VERIFIER: &str = "state-verifier";
const REDIRECT: &str = "https://kordi.example.test/v1/cloud/auth/oauth/apple/callback";

/// Reversible and visibly not plaintext; enough to prove the stored bytes
/// go through the cipher.
struct TestCipher;

impl ProviderAuthCipher for TestCipher {
    fn key_id(&self) -> &str {
        "test:v1"
    }

    fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, ProviderAuthCipherError> {
        let mut sealed = b"sealed:".to_vec();
        sealed.extend(plaintext.iter().rev().map(|byte| byte ^ 0x5a));
        Ok(sealed)
    }

    fn decrypt(&self, ciphertext: &[u8]) -> Result<Vec<u8>, ProviderAuthCipherError> {
        let body = ciphertext
            .strip_prefix(b"sealed:")
            .ok_or(ProviderAuthCipherError::InvalidCiphertext)?;
        Ok(body.iter().rev().map(|byte| byte ^ 0x5a).collect())
    }
}

async fn pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    Some(crate::pg::init_pool(&url).await.expect("init test pool"))
}

fn unique(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

fn fake_apple(subject: &str, email: &str, refresh: &str) -> FakeApple {
    let signer = FakeAppleSigner::new();
    let claims = json!({"email": email, "is_private_email": email.contains("privaterelay")});
    let nonce = crate::auth::oauth::apple::web_nonce(VERIFIER);
    let token = signer.token(SERVICES_ID, subject, &nonce, claims);
    FakeApple::new(signer.keys(), Some(token), Some(refresh))
}

/// The `GET` callback's Apple steps after the state checks: profile,
/// completion, token storage.
async fn sign_in(
    pool: &PgPool,
    cipher: Option<&dyn ProviderAuthCipher>,
    apple: &FakeApple,
    form_user: Option<&str>,
) -> Result<OAuthSignIn, OAuthLoginError> {
    let (profile, tokens) = apple_profile(
        apple,
        &config(),
        REDIRECT,
        "apple-code",
        Some(VERIFIER),
        form_user,
        NOW,
    )
    .await
    .expect("verified Apple profile");
    let done = complete_oauth_sign_in(
        pool,
        OAuthProvider::Apple,
        profile,
        &legacy_device_registration("oauth-apple-test"),
        &Default::default(),
    )
    .await?;
    store_tokens(pool, cipher, &done.body.account.account_id, tokens).await;
    Ok(done)
}

async fn stored_tokens(pool: &PgPool, account_id: &str) -> Vec<(String, Vec<u8>, String)> {
    query_as(
        "SELECT client_id, refresh_token_ciphertext, cipher_key_id \
         FROM cloud_apple_tokens WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn display_name(pool: &PgPool, account_id: &str) -> Option<String> {
    query_as::<_, (Option<String>,)>(
        "SELECT display_name FROM cloud_accounts WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_one(pool)
    .await
    .unwrap()
    .0
}

async fn insert_account(pool: &PgPool, email: &str) -> String {
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
    .bind(email)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    account_id
}

#[tokio::test]
async fn an_apple_sign_in_creates_the_account_and_keeps_a_sealed_refresh_token() {
    let Some(pool) = pool().await else { return };
    let subject = unique("apple-subject");
    let email = format!("{}@example.test", unique("apple"));
    let user = r#"{"name":{"firstName":"Ada","lastName":"Lovelace"}}"#;

    let apple = fake_apple(&subject, &email, "refresh-first");
    let done = sign_in(&pool, Some(&TestCipher), &apple, Some(user))
        .await
        .unwrap();
    let account_id = done.body.account.account_id.clone();
    assert!(!done.body.session.token.is_empty());
    assert!(done.evidence_verified);
    assert_eq!(
        display_name(&pool, &account_id).await.as_deref(),
        Some("Ada Lovelace")
    );
    let (provider,): (String,) =
        query_as("SELECT provider FROM cloud_account_identities WHERE provider_subject = $1")
            .bind(&subject)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(provider, "apple");
    let tokens = stored_tokens(&pool, &account_id).await;
    assert_eq!(tokens.len(), 1);
    assert_eq!(tokens[0].0, SERVICES_ID);
    assert_eq!(tokens[0].2, "test:v1");
    assert!(!String::from_utf8_lossy(&tokens[0].1).contains("refresh-first"));

    // Apple sends no name the second time; the account keeps it, and the
    // new refresh token replaces the old one.
    let apple = fake_apple(&subject, &email, "refresh-second");
    let second = sign_in(&pool, Some(&TestCipher), &apple, None)
        .await
        .unwrap();
    assert_eq!(second.body.account.account_id, account_id);
    assert_eq!(
        display_name(&pool, &account_id).await.as_deref(),
        Some("Ada Lovelace")
    );
    let tokens = stored_tokens(&pool, &account_id).await;
    assert_eq!(tokens.len(), 1);
    assert_eq!(TestCipher.decrypt(&tokens[0].1).unwrap(), b"refresh-second");
}

#[tokio::test]
async fn without_the_cipher_no_token_is_stored() {
    let Some(pool) = pool().await else { return };
    let email = format!("{}@example.test", unique("apple"));
    let apple = fake_apple(&unique("apple-subject"), &email, "refresh");
    let done = sign_in(&pool, None, &apple, None).await.unwrap();
    assert!(stored_tokens(&pool, &done.body.account.account_id)
        .await
        .is_empty());
}

#[tokio::test]
async fn a_verified_apple_email_joins_the_verified_account_but_a_relay_never_does() {
    let Some(pool) = pool().await else { return };
    let email = format!("{}@example.test", unique("apple-join"));
    let existing = insert_account(&pool, &email).await;
    let apple = fake_apple(&unique("apple-subject"), &email, "refresh");
    let done = sign_in(&pool, Some(&TestCipher), &apple, None)
        .await
        .unwrap();
    assert_eq!(done.body.account.account_id, existing);

    let relay = format!("{}@privaterelay.appleid.com", unique("relay"));
    let holder = insert_account(&pool, &relay).await;
    let apple = fake_apple(&unique("apple-subject"), &relay, "refresh");
    match sign_in(&pool, Some(&TestCipher), &apple, None).await {
        Err(OAuthLoginError::ExistingEmailAccount { account_id, .. }) => {
            assert_eq!(account_id, holder)
        }
        other => panic!("expected a refusal, got {:?}", other.err()),
    }

    // A fresh relay address signs up like any verified email.
    let fresh_relay = format!("{}@privaterelay.appleid.com", unique("relay"));
    let apple = fake_apple(&unique("apple-subject"), &fresh_relay, "refresh");
    let done = sign_in(&pool, Some(&TestCipher), &apple, None)
        .await
        .unwrap();
    let (verified,): (bool,) = query_as(
        "SELECT primary_email_verified_at IS NOT NULL FROM cloud_accounts WHERE account_id = $1",
    )
    .bind(&done.body.account.account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(verified);
}

#[tokio::test]
async fn a_state_without_its_verifier_or_nonce_signs_nobody_in() {
    let apple = fake_apple("apple-subject", "person@example.test", "refresh");
    let missing = apple_profile(&apple, &config(), REDIRECT, "code", None, None, NOW).await;
    assert!(missing.is_err());
    // Another state's verifier gives another nonce.
    let other = apple_profile(
        &apple,
        &config(),
        REDIRECT,
        "code",
        Some("another-verifier"),
        None,
        NOW,
    )
    .await;
    assert_eq!(
        other.err().as_deref(),
        Some("Could not finish Apple sign-in.")
    );
}

#[tokio::test]
async fn revocation_sends_each_token_to_apple_and_keeps_the_ones_that_fail() {
    let Some(pool) = pool().await else { return };
    let email = format!("{}@example.test", unique("apple-revoke"));
    let apple = fake_apple(&unique("apple-subject"), &email, "refresh-to-revoke");
    let account_id = sign_in(&pool, Some(&TestCipher), &apple, None)
        .await
        .unwrap()
        .body
        .account
        .account_id;
    let config = config();

    // Apple is down: nothing is lost.
    *apple.revoke_result.lock().unwrap() = Err(AppleApiError::Unavailable);
    let outcome = revoke_tokens(
        &pool,
        Some(&TestCipher),
        Some(&config),
        &apple,
        &account_id,
        NOW,
    )
    .await;
    assert_eq!((outcome.revoked, outcome.failed), (0, 1));
    assert_eq!(stored_tokens(&pool, &account_id).await.len(), 1);

    // Without the configuration or the cipher nothing can be sent.
    let outcome = revoke_tokens(&pool, None, Some(&config), &apple, &account_id, NOW).await;
    assert_eq!((outcome.revoked, outcome.failed), (0, 1));
    let outcome = revoke_tokens(&pool, Some(&TestCipher), None, &apple, &account_id, NOW).await;
    assert_eq!((outcome.revoked, outcome.failed), (0, 1));

    *apple.revoke_result.lock().unwrap() = Ok(());
    let outcome = revoke_tokens(
        &pool,
        Some(&TestCipher),
        Some(&config),
        &apple,
        &account_id,
        NOW,
    )
    .await;
    assert_eq!((outcome.revoked, outcome.failed), (1, 0));
    assert!(stored_tokens(&pool, &account_id).await.is_empty());
    let form = apple.revoked.lock().unwrap().last().unwrap().clone();
    assert_eq!(field(&form, "token"), Some("refresh-to-revoke"));
    assert_eq!(field(&form, "token_type_hint"), Some("refresh_token"));
    assert_eq!(field(&form, "client_id"), Some(SERVICES_ID));
    assert!(field(&form, "client_secret").is_some());
}
