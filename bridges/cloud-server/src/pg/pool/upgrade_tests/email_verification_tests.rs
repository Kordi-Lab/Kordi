use super::*;

async fn add_account(pool: &PgPool, account_id: &str, email: Option<&str>, password: bool) {
    query(
        "INSERT INTO cloud_accounts(account_id,display_name,primary_email,password_hash,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at) \
         VALUES($1,$1,$2,$3,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','generated','lorelei',$1,'fixture',1,'2026-01-01T00:00:00Z')",
    )
    .bind(account_id)
    .bind(email)
    .bind(password.then_some("fixture-password-hash"))
    .execute(pool)
    .await
    .unwrap();
}

async fn add_identity(
    pool: &PgPool,
    account_id: &str,
    provider: &str,
    email: Option<&str>,
    verified: bool,
    created_at: &str,
) {
    query(
        "INSERT INTO cloud_account_identities(identity_id,account_id,provider,provider_subject,email,email_verified,created_at,updated_at) \
         VALUES($1,$2,$3,$1,$4,$5,$6,$6)",
    )
    .bind(format!("{account_id}-{provider}"))
    .bind(account_id)
    .bind(provider)
    .bind(email)
    .bind(verified)
    .bind(created_at)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_107_marks_only_provider_verified_primary_emails() {
    // 107 is the last version before account email verification (108).
    let pool = fixture(107).await;
    add_account(&pool, "linked-verified", Some("Linked@Example.test"), true).await;
    add_identity(
        &pool,
        "linked-verified",
        "github",
        Some("linked@example.test"),
        true,
        "2026-03-01T00:00:00Z",
    )
    .await;
    add_identity(
        &pool,
        "linked-verified",
        "google",
        Some("linked@example.test"),
        true,
        "2026-02-01T00:00:00Z",
    )
    .await;
    add_account(
        &pool,
        "provider-unverified",
        Some("unverified@example.test"),
        false,
    )
    .await;
    add_identity(
        &pool,
        "provider-unverified",
        "google",
        Some("unverified@example.test"),
        false,
        "2026-02-01T00:00:00Z",
    )
    .await;
    add_account(&pool, "password-only", Some("password@example.test"), true).await;
    add_account(
        &pool,
        "different-email",
        Some("primary@example.test"),
        false,
    )
    .await;
    add_identity(
        &pool,
        "different-email",
        "github",
        Some("other@example.test"),
        true,
        "2026-02-01T00:00:00Z",
    )
    .await;
    add_account(&pool, "no-email", None, false).await;
    add_identity(
        &pool,
        "no-email",
        "github",
        Some("orphan@example.test"),
        true,
        "2026-02-01T00:00:00Z",
    )
    .await;

    let (first, second) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    first.unwrap();
    second.unwrap();
    latest_version(&pool).await;

    let verified: Vec<(String, Option<String>)> = query_as(
        "SELECT account_id, primary_email_verified_at FROM cloud_accounts ORDER BY account_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        verified,
        vec![
            ("different-email".to_string(), None),
            ("fixture-owner".to_string(), None),
            ("fixture-peer".to_string(), None),
            (
                "linked-verified".to_string(),
                Some("2026-02-01T00:00:00Z".to_string())
            ),
            ("no-email".to_string(), None),
            ("password-only".to_string(), None),
            ("provider-unverified".to_string(), None),
        ]
    );
    let (emails,): (i64,) =
        query_as("SELECT count(*) FROM cloud_accounts WHERE primary_email IS NOT NULL")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(emails, 4, "the backfill never rewrites primary emails");

    let (ticket_sessions,): (i64,) =
        query_as("SELECT count(session_token_id) FROM cloud_chat_realtime_tickets")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(ticket_sessions, 0);
}
