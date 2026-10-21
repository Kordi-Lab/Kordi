use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_138_adds_account_handles() {
    let pool = fixture(138).await;
    let before: Vec<(String, i64)> = query_as(
        "SELECT account_id, public_account_number FROM cloud_accounts ORDER BY account_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(!before.is_empty());
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;

    let after: Vec<(String, i64, Option<String>)> = query_as(
        "SELECT account_id, public_account_number, public_handle FROM cloud_accounts ORDER BY account_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        after
            .iter()
            .map(|(id, number, _)| (id.clone(), *number))
            .collect::<Vec<_>>(),
        before,
        "account numbers are untouched"
    );
    assert!(
        after.iter().all(|(_, _, handle)| handle.is_none()),
        "existing accounts keep showing their number"
    );

    execute(
        &pool,
        "UPDATE cloud_accounts SET public_handle = 'FixtureOwner' WHERE account_id = 'fixture-owner'",
    )
    .await;
    for invalid in [
        // Case-insensitive uniqueness.
        "UPDATE cloud_accounts SET public_handle = 'fixtureowner' WHERE account_id = 'fixture-peer'",
        // A handle must contain a letter.
        "UPDATE cloud_accounts SET public_handle = '123456789' WHERE account_id = 'fixture-peer'",
        "UPDATE cloud_accounts SET public_handle = 'ab' WHERE account_id = 'fixture-peer'",
        "UPDATE cloud_accounts SET public_handle = 'with_underscore' WHERE account_id = 'fixture-peer'",
    ] {
        assert!(
            sqlx_core::raw_sql::raw_sql(invalid)
                .execute(&pool)
                .await
                .is_err(),
            "{invalid}"
        );
    }
    execute(
        &pool,
        "UPDATE cloud_accounts SET public_handle = NULL WHERE account_id = 'fixture-owner'",
    )
    .await;
    execute(
        &pool,
        "UPDATE cloud_accounts SET public_handle = 'fixtureowner' WHERE account_id = 'fixture-peer'",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_139_adds_profile_fields() {
    let pool = fixture(139).await;
    execute(
        &pool,
        "UPDATE cloud_accounts SET public_handle = 'FixtureOwner' WHERE account_id = 'fixture-owner'",
    )
    .await;
    // A parallel change may already have added `about`.
    execute(
        &pool,
        "ALTER TABLE cloud_accounts ADD COLUMN about TEXT NULL; \
         UPDATE cloud_accounts SET about = 'kept' WHERE account_id = 'fixture-owner'",
    )
    .await;
    let accounts = "SELECT to_jsonb(a) - ARRAY['location','time_zone','website','birthday','public_handle_changed_at'] \
        FROM cloud_accounts a ORDER BY account_id";
    let before: Vec<(Value,)> = query_as(accounts).fetch_all(&pool).await.unwrap();
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let after: Vec<(Value,)> = query_as(accounts).fetch_all(&pool).await.unwrap();
    assert_eq!(before, after, "existing account data is untouched");

    let abouts: Vec<(Option<String>,)> =
        query_as("SELECT about FROM cloud_accounts ORDER BY account_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(abouts, vec![(Some("kept".to_string()),), (None,)]);
    let (filled,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_accounts WHERE location IS NOT NULL OR time_zone IS NOT NULL \
            OR website IS NOT NULL OR birthday IS NOT NULL OR public_handle_changed_at IS NOT NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(filled, 0, "new fields start empty");
    execute(
        &pool,
        "UPDATE cloud_accounts SET birthday = '1990-02-28', time_zone = 'Asia/Riyadh', \
            public_handle_changed_at = now() WHERE account_id = 'fixture-owner'",
    )
    .await;
}
