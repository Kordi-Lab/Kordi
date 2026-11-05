use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_166_adds_device_code_sign_in() {
    let pool = fixture(166).await;
    execute(
        &pool,
        "INSERT INTO cloud_accounts(account_id,display_name,created_at,updated_at,avatar_source,\
         avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at) \
         VALUES('acct_device_fixture','Fixture','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',\
         'generated','lorelei','acct_device_fixture','fixture',1,'2026-01-01T00:00:00Z')",
    )
    .await;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;

    // Existing organizations keep the default policy.
    let (personal, setting): (i64, Option<bool>) = query_as(
        "SELECT count(*), bool_or(device_code_sign_in) FROM cloud_organizations \
         WHERE personal_account_id = 'acct_device_fixture'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((personal, setting), (1, None));

    execute(
        &pool,
        "INSERT INTO cloud_device_authorizations \
         (device_code_hash,user_code_hash,client_id,created_at,expires_at) \
         VALUES('device-hash','user-hash','kordi-desktop',now(),now() + interval '15 minutes')",
    )
    .await;
    let duplicate = sqlx_core::raw_sql::raw_sql(
        "INSERT INTO cloud_device_authorizations \
         (device_code_hash,user_code_hash,client_id,created_at,expires_at) \
         VALUES('other-hash','user-hash','kordi-desktop',now(),now())",
    )
    .execute(&pool)
    .await;
    assert!(duplicate.is_err(), "user codes are unique");
    let undecided =
        sqlx_core::raw_sql::raw_sql("UPDATE cloud_device_authorizations SET status = 'approved'")
            .execute(&pool)
            .await;
    assert!(undecided.is_err(), "a decision records its time");

    // Running the released SQL again keeps the rows.
    let migration = EMBEDDED_MIGRATIONS
        .iter()
        .find(|m| m.version == 172)
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx_core::raw_sql::raw_sql(migration.sql)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (rows,): (i64,) = query_as("SELECT count(*) FROM cloud_device_authorizations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 1);
}
