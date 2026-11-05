use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_167_backfills_identity_matching_email() {
    let pool = fixture(167).await;
    execute(&pool, "INSERT INTO cloud_account_identities(identity_id,account_id,provider,provider_subject,email,email_verified,created_at,updated_at) VALUES ('ident_verified','fixture-owner','google','subject-verified',' Owner@Example.test ',true,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),('ident_unverified','fixture-peer','google','subject-unverified','peer@example.test',false,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),('ident_empty','fixture-peer','github','subject-empty',NULL,false,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").await;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let rows: Vec<(String, Option<String>)> = query_as(
        "SELECT identity_id, matching_email FROM cloud_account_identities ORDER BY identity_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            ("ident_empty".into(), None),
            ("ident_unverified".into(), None),
            ("ident_verified".into(), Some("owner@example.test".into())),
        ]
    );
}
