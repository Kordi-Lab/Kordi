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
    // Migrations 139 and 140 add empty profile columns.
    let after: Vec<(Value,)> =
        query_as("SELECT to_jsonb(a) - ARRAY['public_handle','about','location','time_zone','website','birthday','public_handle_changed_at','ai_consent_status','ai_consent_decided_at'] FROM cloud_accounts a ORDER BY account_id")
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

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_169_adds_account_security_codes() {
    let pool = fixture(169).await;
    execute(&pool, "UPDATE cloud_accounts SET primary_email = 'owner@example.test' WHERE account_id = 'fixture-owner'").await;
    let before: Vec<(Value,)> =
        query_as("SELECT to_jsonb(a) FROM cloud_accounts a ORDER BY account_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    apply_migrations(&pool).await.unwrap();
    latest_version(&pool).await;
    // Migration 180 adds the AI consent columns.
    let after: Vec<(Value,)> =
        query_as("SELECT to_jsonb(a) - ARRAY['ai_consent_status','ai_consent_decided_at'] FROM cloud_accounts a ORDER BY account_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(before, after, "accounts are unchanged");
    for table in [
        "cloud_account_email_change_codes",
        "cloud_account_reauth_codes",
    ] {
        execute(&pool, &format!("INSERT INTO {table}(account_id,email,verification_id,code_mac,expires_at,resend_after,window_started_at,send_count,attempts_remaining) VALUES('fixture-owner','new@example.test','email_{table}','\\x00',now(),now(),now(),1,5)")).await;
        for invalid in [
            format!("INSERT INTO {table}(account_id,email,verification_id,code_mac,expires_at,resend_after,window_started_at,send_count,attempts_remaining) VALUES('missing-account','x@example.test','email_missing','\\x00',now(),now(),now(),1,5)"),
            format!("INSERT INTO {table}(account_id,email,verification_id,code_mac,expires_at,resend_after,window_started_at,send_count,attempts_remaining) VALUES('fixture-peer','x@example.test','email_{table}','\\x00',now(),now(),now(),1,5)"),
            format!("INSERT INTO {table}(account_id,email,verification_id,code_mac,expires_at,resend_after,window_started_at,send_count,attempts_remaining) VALUES('fixture-peer','x@example.test','email_count','\\x00',now(),now(),now(),6,5)"),
        ] {
            assert!(sqlx_core::raw_sql::raw_sql(&invalid).execute(&pool).await.is_err());
        }
    }
    execute(
        &pool,
        "DELETE FROM cloud_accounts WHERE account_id = 'fixture-owner'",
    )
    .await;
    for table in [
        "cloud_account_email_change_codes",
        "cloud_account_reauth_codes",
    ] {
        let (codes,): (i64,) = query_as(&format!("SELECT COUNT(*)::BIGINT FROM {table}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(codes, 0, "codes are removed with their account");
    }
}
