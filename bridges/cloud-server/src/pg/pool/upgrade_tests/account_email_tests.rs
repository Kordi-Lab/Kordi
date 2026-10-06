use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_112_adds_account_email_codes() {
    let pool = fixture(112).await;
    execute(&pool, "UPDATE cloud_accounts SET primary_email = 'legacy@example.com', password_hash = 'existing-password-hash' WHERE account_id = 'fixture-owner'").await;
    let before: Vec<(Value,)> =
        query_as("SELECT to_jsonb(a) FROM cloud_accounts a ORDER BY account_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    apply_migrations(&pool).await.unwrap();
    latest_version(&pool).await;
    let after: Vec<(Value,)> =
        query_as("SELECT to_jsonb(a) FROM cloud_accounts a ORDER BY account_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(before, after);
    let (codes,): (i64,) = query_as("SELECT COUNT(*)::BIGINT FROM cloud_account_email_codes")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(codes, 0);
    execute(&pool, "INSERT INTO cloud_account_email_codes(account_id,email,verification_id,code_mac,expires_at,resend_after,window_started_at,send_count,attempts_remaining) VALUES('fixture-owner','legacy@example.com','email_fixture','\\x00',now(),now(),now(),1,5)").await;
    for invalid in [
        "INSERT INTO cloud_account_email_codes(account_id,email,verification_id,code_mac,expires_at,resend_after,window_started_at,send_count,attempts_remaining) VALUES('missing-account','x@example.com','email_missing','\\x00',now(),now(),now(),1,5)",
        "INSERT INTO cloud_account_email_codes(account_id,email,verification_id,code_mac,expires_at,resend_after,window_started_at,send_count,attempts_remaining) VALUES('fixture-peer','x@example.com','email_fixture','\\x00',now(),now(),now(),1,5)",
        "INSERT INTO cloud_account_email_codes(account_id,email,verification_id,code_mac,expires_at,resend_after,window_started_at,send_count,attempts_remaining) VALUES('fixture-peer','x@example.com','email_count','\\x00',now(),now(),now(),6,5)",
    ] {
        assert!(sqlx_core::raw_sql::raw_sql(invalid).execute(&pool).await.is_err());
    }
    execute(
        &pool,
        "DELETE FROM cloud_accounts WHERE account_id = 'fixture-owner'",
    )
    .await;
    let (codes,): (i64,) = query_as("SELECT COUNT(*)::BIGINT FROM cloud_account_email_codes")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(codes, 0, "codes are removed with their account");
}
