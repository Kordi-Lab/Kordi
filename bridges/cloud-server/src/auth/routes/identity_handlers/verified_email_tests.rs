//! Provider emails link accounts only when verified, and a linked identity
//! never moves when its provider email changes (issue 2294). Runs against a
//! task-owned disposable Postgres at `$DATABASE_URL` with uuid-suffixed
//! synthetic data. Email sign-up followed by Google sign-in with the same
//! verified address is covered in `account_linking_tests`.

use super::*;
use crate::auth::identity_email::{EMAIL_CHANGED_EVENT, EMAIL_REVERIFIED_EVENT};

async fn pool() -> PgPool {
    crate::pg::init_pool(&std::env::var("DATABASE_URL").expect("a disposable database is required"))
        .await
        .expect("init test pool")
}

fn unique_email(prefix: &str) -> String {
    format!("{prefix}-{}@example.test", uuid::Uuid::new_v4().simple())
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

async fn sign_in(
    pool: &PgPool,
    provider: OAuthProvider,
    profile: OAuthProfile,
) -> Result<OAuthSignIn, OAuthLoginError> {
    complete_oauth_sign_in(
        pool,
        provider,
        profile,
        &legacy_device_registration("oauth-test-device"),
        &Default::default(),
    )
    .await
}

async fn count(pool: &PgPool, sql: &str, binds: &[&str]) -> i64 {
    let mut query = query_as::<_, (i64,)>(sql);
    for bind in binds {
        query = query.bind(*bind);
    }
    query.fetch_one(pool).await.unwrap().0
}

async fn identity(pool: &PgPool, provider: &str, subject: &str) -> (String, Option<String>) {
    query_as(
        "SELECT account_id, matching_email FROM cloud_account_identities \
         WHERE provider = $1 AND provider_subject = $2",
    )
    .bind(provider)
    .bind(subject)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn an_unverified_google_email_never_links_an_account() {
    let pool = pool().await;
    let email = unique_email("google-unverified");
    let github = format!("gh-{}", uuid::Uuid::new_v4().simple());
    let owner = sign_in(
        &pool,
        OAuthProvider::Github,
        profile(&github, Some(&email), true),
    )
    .await
    .expect("verified GitHub account");
    let owner_id = owner.body.account.account_id;

    let google = format!("google-{}", uuid::Uuid::new_v4().simple());
    let result = sign_in(
        &pool,
        OAuthProvider::Google,
        profile(&google, Some(&email), false),
    )
    .await;
    assert!(matches!(
        result,
        Err(OAuthLoginError::ExistingEmailAccount { .. })
    ));
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM cloud_account_identities WHERE provider_subject = $1",
            &[&google]
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM cloud_account_identities WHERE account_id = $1",
            &[&owner_id]
        )
        .await,
        1
    );
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn a_github_primary_email_change_keeps_the_link_and_needs_reverification() {
    let pool = pool().await;
    let first = unique_email("github-first");
    let second = unique_email("github-second");
    // Someone else's account already owns and verified the new address.
    let other_subject = format!("google-{}", uuid::Uuid::new_v4().simple());
    let other = sign_in(
        &pool,
        OAuthProvider::Google,
        profile(&other_subject, Some(&second), true),
    )
    .await
    .expect("other account");
    let other_id = other.body.account.account_id;

    let subject = format!("gh-{}", uuid::Uuid::new_v4().simple());
    let linked = sign_in(
        &pool,
        OAuthProvider::Github,
        profile(&subject, Some(&first), true),
    )
    .await
    .expect("GitHub account");
    let account_id = linked.body.account.account_id.clone();
    assert!(linked.evidence_verified);

    // The GitHub primary email changes to the other account's address.
    let changed = sign_in(
        &pool,
        OAuthProvider::Github,
        profile(&subject, Some(&second), true),
    )
    .await
    .expect("changed email still signs in");
    assert_eq!(changed.body.account.account_id, account_id);
    assert!(
        !changed.evidence_verified,
        "the new email is not evidence yet"
    );
    assert_eq!(
        identity(&pool, "github", &subject).await,
        (account_id.clone(), Some(first.clone()))
    );
    assert_eq!(
        changed.body.account.primary_email.as_deref(),
        Some(first.as_str())
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM cloud_audit_events WHERE account_id = $1 AND event_type = $2",
            &[&account_id, EMAIL_CHANGED_EVENT]
        )
        .await,
        1
    );
    // The other account is untouched.
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM cloud_account_identities WHERE account_id = $1",
            &[&other_id]
        )
        .await,
        1
    );

    // A Kordi email code for the new address re-verifies it.
    let mut tx = pool.begin().await.unwrap();
    crate::auth::identity_email::reverify_identity_emails(&mut tx, &account_id, &second)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        identity(&pool, "github", &subject).await,
        (account_id.clone(), Some(second.clone()))
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM cloud_audit_events WHERE account_id = $1 AND event_type = $2",
            &[&account_id, EMAIL_REVERIFIED_EVENT]
        )
        .await,
        1
    );
    let again = sign_in(
        &pool,
        OAuthProvider::Github,
        profile(&subject, Some(&second), true),
    )
    .await
    .expect("re-verified email signs in");
    assert!(again.evidence_verified);
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn already_linked_identities_on_unverified_accounts_keep_signing_in() {
    let pool = pool().await;
    let email = unique_email("legacy-unverified");
    let account_id = format!("acct_{}", uuid::Uuid::new_v4().simple());
    let google = format!("google-{}", uuid::Uuid::new_v4().simple());
    let github = format!("gh-{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    // An account migrated without a verified primary email, with identities
    // linked before matching emails existed.
    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, created_at, updated_at, \
          primary_email_verified_at, avatar_source, avatar_style, avatar_seed, \
          avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, 'Legacy', $2, $3, $3, NULL, 'generated', 'lorelei', $1, 'fixture', 1, $3)",
    )
    .bind(&account_id)
    .bind(&email)
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();
    for (identity_id, provider, subject, identity_email, verified) in [
        (
            "google",
            "google",
            google.as_str(),
            Some(email.as_str()),
            false,
        ),
        ("github", "github", github.as_str(), None, false),
    ] {
        query(
            "INSERT INTO cloud_account_identities \
             (identity_id, account_id, provider, provider_subject, email, email_verified, \
              created_at, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7)",
        )
        .bind(format!(
            "ident_{identity_id}_{}",
            uuid::Uuid::new_v4().simple()
        ))
        .bind(&account_id)
        .bind(provider)
        .bind(subject)
        .bind(identity_email)
        .bind(verified)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
    }

    // The provider still does not verify the email: same account.
    let unverified = sign_in(
        &pool,
        OAuthProvider::Google,
        profile(&google, Some(&email), false),
    )
    .await
    .expect("linked Google identity signs in");
    assert_eq!(unverified.body.account.account_id, account_id);
    // The provider verifies it now: same account, and the email is proven.
    let verified = sign_in(
        &pool,
        OAuthProvider::Google,
        profile(&google, Some(&email), true),
    )
    .await
    .expect("linked Google identity signs in");
    assert_eq!(verified.body.account.account_id, account_id);
    assert!(verified.evidence_verified);
    // A changed provider email still reaches the same account.
    let other = unique_email("legacy-changed");
    let changed = sign_in(
        &pool,
        OAuthProvider::Google,
        profile(&google, Some(&other), true),
    )
    .await
    .expect("linked Google identity signs in");
    assert_eq!(changed.body.account.account_id, account_id);
    // A linked GitHub identity without an email signs in too.
    let github_sign_in = sign_in(&pool, OAuthProvider::Github, profile(&github, None, false))
        .await
        .expect("linked GitHub identity signs in");
    assert_eq!(github_sign_in.body.account.account_id, account_id);
}
