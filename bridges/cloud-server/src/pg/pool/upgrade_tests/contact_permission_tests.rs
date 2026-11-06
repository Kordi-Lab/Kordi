use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_174_adds_contact_permissions() {
    let pool = fixture(174).await;
    let before: Option<String> = sqlx_core::query_scalar::query_scalar(
        "SELECT to_regclass('public.cloud_contact_permissions')::text",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(before.is_none());
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;

    // Existing accounts keep today's behavior: no rows, so both allowed.
    let (rows,): (i64,) = query_as("SELECT count(*) FROM cloud_contact_permissions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 0);
    execute(
        &pool,
        "INSERT INTO cloud_contact_permissions(owner_account_id,subject_account_id,card_access) \
         VALUES('fixture-owner','fixture-peer',false)",
    )
    .await;
    let (agent, card): (bool, bool) = query_as(
        "SELECT agent_access, card_access FROM cloud_contact_permissions \
         WHERE owner_account_id = 'fixture-owner'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(agent && !card, "agent access defaults to allowed");
    let self_row = sqlx_core::raw_sql::raw_sql(
        "INSERT INTO cloud_contact_permissions(owner_account_id,subject_account_id) \
         VALUES('fixture-owner','fixture-owner')",
    )
    .execute(&pool)
    .await;
    assert!(self_row.is_err(), "an account never restricts itself");

    // Running the released SQL again keeps the row; deleting an account
    // deletes its rows.
    let migration = EMBEDDED_MIGRATIONS
        .iter()
        .find(|m| m.version == 184)
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx_core::raw_sql::raw_sql(migration.sql)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    execute(
        &pool,
        "DELETE FROM cloud_accounts WHERE account_id = 'fixture-peer'",
    )
    .await;
    let (rows,): (i64,) = query_as("SELECT count(*) FROM cloud_contact_permissions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 0);
}
