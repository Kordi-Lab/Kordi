use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_109_preserves_existing_accounts_without_certifying_email() {
    let pool = fixture(109).await;
    execute(&pool, "UPDATE cloud_accounts SET primary_email = 'claimed@example.com', password_hash = 'existing-password-hash' WHERE account_id = 'fixture-owner'").await;
    let before: Vec<(Value,)> =
        query_as("SELECT to_jsonb(a) FROM cloud_accounts a ORDER BY account_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    apply_migrations(&pool).await.unwrap();
    latest_version(&pool).await;
    let after: Vec<(Value,)> = query_as("SELECT to_jsonb(a) - 'primary_email_verified_at' FROM cloud_accounts a ORDER BY account_id")
        .fetch_all(&pool).await.unwrap();
    assert_eq!(before, after);
    let (verified,): (i64,) = query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_accounts WHERE primary_email_verified_at IS NOT NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(verified, 0);
    let (codes,): (i64,) = query_as("SELECT COUNT(*)::BIGINT FROM cloud_signup_email_codes")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(codes, 0);
}
