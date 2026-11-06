use super::*;

async fn account(pool: &PgPool, id: &str) {
    execute(
        pool,
        &format!(
            "INSERT INTO cloud_accounts(account_id,display_name,created_at,updated_at,\
             avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,\
             avatar_updated_at) VALUES('{id}','{id}','2026-01-01T00:00:00Z',\
             '2026-01-01T00:00:00Z','generated','lorelei','{id}','fixture',1,\
             '2026-01-01T00:00:00Z')"
        ),
    )
    .await;
}

async fn rerun(pool: &PgPool, version: i64) {
    let migration = EMBEDDED_MIGRATIONS
        .iter()
        .find(|m| m.version == version)
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx_core::raw_sql::raw_sql(migration.sql)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_180_adds_blocks_and_reports() {
    // Versions below 181 that belong to other changes may be missing here; a
    // fixture at 180 holds whichever of them exist on this branch.
    let pool = fixture(180).await;
    for id in ["fixture-blocker", "fixture-blocked", "fixture-reporter"] {
        account(&pool, id).await;
    }
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;

    execute(
        &pool,
        "INSERT INTO cloud_account_blocks(blocker_account_id,blocked_account_id) \
         VALUES('fixture-blocker','fixture-blocked'); \
         INSERT INTO cloud_abuse_reports(report_id,reporter_account_id,client_report_id,\
           request_fingerprint,reported_account_id,reported_display_name,target_kind,reason,\
           evidence) VALUES('rpt_fixture','fixture-reporter',gen_random_uuid(),'f',\
           'fixture-blocked','Blocked','account','spam','{}'::jsonb)",
    )
    .await;
    let (either,): (bool,) =
        query_as("SELECT cloud_accounts_blocked_either_way('fixture-blocked','fixture-blocker')")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(either, "blocks read in both directions");
    let self_block = sqlx_core::raw_sql::raw_sql(
        "INSERT INTO cloud_account_blocks(blocker_account_id,blocked_account_id) \
         VALUES('fixture-blocker','fixture-blocker')",
    )
    .execute(&pool)
    .await;
    assert!(self_block.is_err(), "nobody blocks themselves");
    let unknown_reason =
        sqlx_core::raw_sql::raw_sql("UPDATE cloud_abuse_reports SET reason = 'rude'")
            .execute(&pool)
            .await;
    assert!(unknown_reason.is_err(), "reasons are a closed list");

    // Re-running the released SQL keeps every row.
    rerun(&pool, 181).await;
    rerun(&pool, 182).await;
    let (blocks, reports, notices): (i64, i64, String) = query_as(
        "SELECT (SELECT count(*) FROM cloud_account_blocks), \
                (SELECT count(*) FROM cloud_abuse_reports), \
                (SELECT notification_status FROM cloud_abuse_reports)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((blocks, reports, notices.as_str()), (1, 1, "pending"));

    // Deleting an account drops its blocks but keeps reports by or about it.
    execute(
        &pool,
        "DELETE FROM cloud_accounts WHERE account_id IN ('fixture-blocked','fixture-reporter')",
    )
    .await;
    let (blocks, reporter, reported, name): (i64, Option<String>, Option<String>, Option<String>) =
        query_as(
            "SELECT (SELECT count(*) FROM cloud_account_blocks), reporter_account_id, \
                    reported_account_id, reported_display_name \
             FROM cloud_abuse_reports WHERE report_id = 'rpt_fixture'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(blocks, 0);
    assert_eq!((reporter, reported), (None, None));
    assert_eq!(name.as_deref(), Some("Blocked"));
}
