use super::*;

async fn tables(pool: &PgPool) -> Vec<String> {
    query_as::<_, (String,)>(
        "SELECT table_name::text FROM information_schema.tables \
         WHERE table_name LIKE 'cloud_resource_pool_%' ORDER BY table_name",
    )
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|(name,)| name)
    .collect()
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_165_adds_resource_pool_usage() {
    let pool = fixture(165).await;
    assert!(tables(&pool).await.is_empty());
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    assert_eq!(
        tables(&pool).await,
        [
            "cloud_resource_pool_reservations",
            "cloud_resource_pool_usage"
        ]
    );

    execute(
        &pool,
        "INSERT INTO cloud_resource_pool_usage(pool_id,usage_day,feature,scope_id,runs) \
         VALUES('fixture-pool','2026-01-01','*','',1); \
         INSERT INTO cloud_resource_pool_reservations(run_id,pool_id,usage_day,feature,scope_id) \
         VALUES('pip_fixture','fixture-pool','2026-01-01','system_agent','fixture-conversation')",
    )
    .await;
    let refused = sqlx_core::raw_sql::raw_sql(
        "UPDATE cloud_resource_pool_reservations SET state = 'unknown'",
    )
    .execute(&pool)
    .await;
    assert!(refused.is_err(), "reservation states are checked");
    let negative = sqlx_core::raw_sql::raw_sql("UPDATE cloud_resource_pool_usage SET runs = -1")
        .execute(&pool)
        .await;
    assert!(negative.is_err(), "counters never go below zero");

    // Running the released SQL again keeps the rows.
    let migration = EMBEDDED_MIGRATIONS
        .iter()
        .find(|m| m.version == 166)
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx_core::raw_sql::raw_sql(migration.sql)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (usage, reservations): (i64, i64) = query_as(
        "SELECT (SELECT count(*) FROM cloud_resource_pool_usage), \
                (SELECT count(*) FROM cloud_resource_pool_reservations)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((usage, reservations), (1, 1));
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_169_adds_usage_notices() {
    let pool = fixture(169).await;
    let before: Option<String> = sqlx_core::query_scalar::query_scalar(
        "SELECT to_regclass('public.cloud_usage_notices')::text",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(before.is_none());
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;

    execute(
        &pool,
        "INSERT INTO cloud_usage_notices(scope_kind,scope_id,pool_id,usage_day,notice,reached) \
         VALUES('conversation','fixture-conversation','fixture-pool','2026-01-01','paused','daily_limit'); \
         INSERT INTO cloud_usage_notices(scope_kind,scope_id,pool_id,usage_day,notice) \
         VALUES('organization','org_fixture','fixture-pool','2026-01-01','threshold_75')",
    )
    .await;
    let repeated = sqlx_core::raw_sql::raw_sql(
        "INSERT INTO cloud_usage_notices(scope_kind,scope_id,pool_id,usage_day,notice) \
         VALUES('organization','org_fixture','fixture-pool','2026-01-01','threshold_75')",
    )
    .execute(&pool)
    .await;
    assert!(repeated.is_err(), "a notice is kept once per window");
    for bad in [
        "UPDATE cloud_usage_notices SET notice = 'unknown'",
        "UPDATE cloud_usage_notices SET reached = 'unknown'",
        "UPDATE cloud_usage_notices SET scope_kind = 'unknown'",
    ] {
        let refused = sqlx_core::raw_sql::raw_sql(bad).execute(&pool).await;
        assert!(refused.is_err(), "{bad} is refused");
    }

    // Running the released SQL again keeps the rows.
    let migration = EMBEDDED_MIGRATIONS
        .iter()
        .find(|m| m.version == 170)
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx_core::raw_sql::raw_sql(migration.sql)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (count,): (i64,) = query_as("SELECT count(*) FROM cloud_usage_notices")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
}
