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
async fn upgrade_from_168_adds_pool_worker_runs() {
    // Versions 167 and 168 belong to other changes; a fixture at 168 holds
    // whichever of them exist on this branch.
    let pool = fixture(168).await;
    let exists = |pool: PgPool| async move {
        query_as::<_, (Option<String>,)>(
            "SELECT to_regclass('public.cloud_pool_worker_runs')::text",
        )
        .fetch_one(&pool)
        .await
        .unwrap()
        .0
        .is_some()
    };
    assert!(!exists(pool.clone()).await);
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    assert!(exists(pool.clone()).await);

    execute(
        &pool,
        // The fixture already holds the account `fixture-owner`.
        "INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at) \
         VALUES('pip_fixture','pip_fixture','pip_fixture','fixture-session','fixture-owner','fixture-owner','queued','{}','2026-01-01','2026-01-01'); \
         INSERT INTO cloud_pool_worker_runs(run_id,pool_id,feature) VALUES('pip_fixture','fixture-pool','system_agent')",
    )
    .await;
    let refused =
        sqlx_core::raw_sql::raw_sql("UPDATE cloud_pool_worker_runs SET feature = 'digest'")
            .execute(&pool)
            .await;
    assert!(refused.is_err(), "features are checked");

    // Running the released SQL again keeps the row; deleting the run removes
    // its tag.
    let migration = EMBEDDED_MIGRATIONS
        .iter()
        .find(|m| m.version == 169)
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx_core::raw_sql::raw_sql(migration.sql)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let count = |pool: PgPool| async move {
        query_as::<_, (i64,)>("SELECT count(*) FROM cloud_pool_worker_runs")
            .fetch_one(&pool)
            .await
            .unwrap()
            .0
    };
    assert_eq!(count(pool.clone()).await, 1);
    execute(
        &pool,
        "DELETE FROM cloud_agent_fallback_runs WHERE run_id = 'pip_fixture'",
    )
    .await;
    assert_eq!(count(pool.clone()).await, 0);
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_173_adds_usage_pauses() {
    let pool = fixture(173).await;
    let before: Option<String> = sqlx_core::query_scalar::query_scalar(
        "SELECT to_regclass('public.cloud_usage_pauses')::text",
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
        "INSERT INTO cloud_usage_pauses(pool_id,usage_day,conversation_id,organization_id,limit_id,reached) \
         VALUES('fixture-pool','2026-01-01','fixture-conversation','org_fixture','pool.runs','daily_limit')",
    )
    .await;
    let repeated = sqlx_core::raw_sql::raw_sql(
        "INSERT INTO cloud_usage_pauses(pool_id,usage_day,conversation_id,limit_id,reached) \
         VALUES('fixture-pool','2026-01-01','fixture-conversation','pool.stopped','stopped')",
    )
    .execute(&pool)
    .await;
    assert!(repeated.is_err(), "a pause is kept once per window");
    for bad in [
        "UPDATE cloud_usage_pauses SET limit_id = 'unknown'",
        "UPDATE cloud_usage_pauses SET reached = 'none'",
    ] {
        let refused = sqlx_core::raw_sql::raw_sql(bad).execute(&pool).await;
        assert!(refused.is_err(), "{bad} is refused");
    }

    // Running the released SQL again keeps the rows.
    let migration = EMBEDDED_MIGRATIONS
        .iter()
        .find(|m| m.version == 174)
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx_core::raw_sql::raw_sql(migration.sql)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (count,): (i64,) = query_as("SELECT count(*) FROM cloud_usage_pauses")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}
