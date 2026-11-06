use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_184_adds_apple_token_revocations() {
    let pool = fixture(184).await;
    let before: Option<String> = sqlx_core::query_scalar::query_scalar(
        "SELECT to_regclass('public.cloud_apple_token_revocations')::text",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(before.is_none());
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;

    // A queued token belongs to no account, and is due at once.
    execute(
        &pool,
        "INSERT INTO cloud_apple_token_revocations\
         (token_id,client_id,refresh_token_ciphertext,cipher_key_id) \
         VALUES('fixture-token','fixture.client','\\x00','fixture-key')",
    )
    .await;
    let (attempts, due): (i32, bool) = query_as(
        "SELECT attempts, next_attempt_at <= now() FROM cloud_apple_token_revocations \
         WHERE token_id = 'fixture-token'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((attempts, due), (0, true));

    // Running the released SQL again keeps the queue.
    let migration = EMBEDDED_MIGRATIONS
        .iter()
        .find(|m| m.version == 185)
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx_core::raw_sql::raw_sql(migration.sql)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (rows,): (i64,) = query_as("SELECT count(*) FROM cloud_apple_token_revocations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 1);
}
