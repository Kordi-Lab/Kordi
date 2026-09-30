//! OAuth identity linking against a real Postgres at `$DATABASE_URL`.
//! Skipped when `DATABASE_URL` is unset. Every test uses uuid-suffixed data.

use super::*;

async fn pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    Some(crate::pg::init_pool(&url).await.expect("init test pool"))
}

fn unique_email(prefix: &str) -> String {
    format!("{prefix}-{}@example.test", uuid::Uuid::new_v4().simple())
}

fn profile(subject: &str, email: Option<&str>, email_verified: bool) -> OAuthProfile {
    OAuthProfile {
        provider_subject: subject.to_string(),
        username: None,
        display_name: Some("OAuth User".to_string()),
        email: email.map(str::to_string),
        email_verified,
        avatar_url: None,
    }
}

fn unique_subject() -> String {
    format!("subject-{}", uuid::Uuid::new_v4().simple())
}

async fn insert_account(pool: &PgPool, email: &str, password: bool, verified: bool) -> String {
    let account_id = format!("acct_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, created_at, updated_at, \
          password_hash, password_algorithm, primary_email_verified_at, avatar_source, \
          avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, 'Existing', $2, $3, $3, $4, $5, $6, 'generated', 'lorelei', $1, 'fixture', \
                 1, $3)",
    )
    .bind(&account_id)
    .bind(email)
    .bind(&now)
    .bind(password.then_some("$argon2id$v=19$m=8,t=1,p=1$c2FsdA$aGFzaA"))
    .bind(password.then_some(PASSWORD_ALGORITHM_ID))
    .bind(verified.then_some(now.as_str()))
    .execute(pool)
    .await
    .unwrap();
    account_id
}

async fn login(
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

async fn accounts_with_email(pool: &PgPool, email: &str) -> i64 {
    query_as::<_, (i64,)>("SELECT count(*) FROM cloud_accounts WHERE LOWER(primary_email) = $1")
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

async fn email_verified_at(pool: &PgPool, account_id: &str) -> Option<String> {
    query_as::<_, (Option<String>,)>(
        "SELECT primary_email_verified_at FROM cloud_accounts WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_one(pool)
    .await
    .unwrap()
    .0
}

#[tokio::test]
async fn provider_email_does_not_join_an_unverified_password_account() {
    let Some(pool) = pool().await else { return };
    let email = unique_email("password-first");
    let existing = insert_account(&pool, &email, true, false).await;

    let result = login(
        &pool,
        OAuthProvider::Google,
        profile(&unique_subject(), Some(&email), true),
    )
    .await;

    match result {
        Err(OAuthLoginError::ExistingEmailAccount {
            account_id,
            password_sign_in,
        }) => {
            assert_eq!(account_id, existing);
            assert!(password_sign_in);
        }
        other => panic!("expected an existing-account refusal, got {other:?}"),
    }
    assert_eq!(identities_for(&pool, &existing).await, 0);
    assert_eq!(accounts_with_email(&pool, &email).await, 1);
    assert_eq!(email_verified_at(&pool, &existing).await, None);
}

#[tokio::test]
async fn provider_email_joins_a_verified_account() {
    let Some(pool) = pool().await else { return };
    let email = unique_email("verified-first");
    let existing = insert_account(&pool, &email, true, true).await;

    let (body, _) = login(
        &pool,
        OAuthProvider::Github,
        profile(&unique_subject(), Some(&email), true),
    )
    .await
    .expect("verified identities link");

    assert_eq!(body.account.account_id, existing);
    assert_eq!(identities_for(&pool, &existing).await, 1);
    assert_eq!(accounts_with_email(&pool, &email).await, 1);
}

#[tokio::test]
async fn unverified_provider_email_never_joins_an_existing_account() {
    let Some(pool) = pool().await else { return };
    let email = unique_email("unverified-provider");
    let existing = insert_account(&pool, &email, false, true).await;

    let result = login(
        &pool,
        OAuthProvider::Google,
        profile(&unique_subject(), Some(&email), false),
    )
    .await;

    assert!(matches!(
        result,
        Err(OAuthLoginError::ExistingEmailAccount {
            password_sign_in: false,
            ..
        })
    ));
    assert_eq!(identities_for(&pool, &existing).await, 0);
    assert_eq!(accounts_with_email(&pool, &email).await, 1);
}

#[tokio::test]
async fn new_provider_accounts_are_verified_and_link_across_providers() {
    let Some(pool) = pool().await else { return };
    let email = unique_email("provider-first");

    let (first, first_is_new) = login(
        &pool,
        OAuthProvider::Google,
        profile(&unique_subject(), Some(&email), true),
    )
    .await
    .expect("new provider account");
    assert!(first_is_new);
    let account_id = first.account.account_id;
    assert!(email_verified_at(&pool, &account_id).await.is_some());

    let (second, _) = login(
        &pool,
        OAuthProvider::Github,
        profile(&unique_subject(), Some(&email), true),
    )
    .await
    .expect("second verified provider links");
    assert_eq!(second.account.account_id, account_id);
    assert_eq!(identities_for(&pool, &account_id).await, 2);
    assert_eq!(accounts_with_email(&pool, &email).await, 1);
}

#[tokio::test]
async fn existing_provider_subject_keeps_signing_in_and_marks_matching_email() {
    let Some(pool) = pool().await else { return };
    let email = unique_email("returning");
    let subject = unique_subject();

    let (first, _) = login(
        &pool,
        OAuthProvider::Google,
        profile(&subject, Some(&email), false),
    )
    .await
    .expect("new account with unverified provider email");
    let account_id = first.account.account_id;
    assert_eq!(email_verified_at(&pool, &account_id).await, None);

    let (again, _) = login(
        &pool,
        OAuthProvider::Google,
        profile(&subject, Some(&email), false),
    )
    .await
    .expect("returning subject signs in");
    assert_eq!(again.account.account_id, account_id);
    assert_eq!(email_verified_at(&pool, &account_id).await, None);

    let (verified, _) = login(
        &pool,
        OAuthProvider::Google,
        profile(&subject, Some(&email), true),
    )
    .await
    .expect("returning subject signs in after provider verification");
    assert_eq!(verified.account.account_id, account_id);
    assert!(email_verified_at(&pool, &account_id).await.is_some());
}

#[test]
fn existing_account_messages_name_the_sign_in_method() {
    assert!(existing_email_account_message(true).contains("email and password"));
    assert!(existing_email_account_message(false).contains("method you used"));
}
