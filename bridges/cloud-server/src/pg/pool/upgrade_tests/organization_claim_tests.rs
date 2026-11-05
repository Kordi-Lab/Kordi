use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_170_adds_organization_claims() {
    let pool = fixture(170).await;
    execute(&pool, "INSERT INTO cloud_devices(device_id,account_id,device_name,device_public_key,created_at,last_seen_at) VALUES('device-fixture','fixture-owner','Fixture','fixture-key','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").await;
    execute(&pool, "INSERT INTO cloud_refresh_tokens(token_id,account_id,device_id,token_hash,created_at,expires_at) VALUES('cs_fixture','fixture-owner','device-fixture','hash-fixture','2026-01-01T00:00:00Z','2099-01-01T00:00:00Z')").await;
    execute(&pool, "INSERT INTO cloud_app_sign_ins(sign_in_id,account_id,device_id,client_id,created_at,last_refreshed_at) VALUES('asi_fixture','fixture-owner','device-fixture','fixture-app',now(),now())").await;
    let before: Value = query_as::<_, (Value,)>(
        "SELECT jsonb_build_object('tokens',(SELECT jsonb_agg(to_jsonb(t)) FROM cloud_refresh_tokens t),\
                                   'sign_ins',(SELECT jsonb_agg(to_jsonb(s)) FROM cloud_app_sign_ins s))",
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .0;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;

    // Existing sessions and sign-ins keep every value and gain an empty
    // claim, which means the personal organization.
    let (claims, after): (i64, Value) = query_as(
        "SELECT (SELECT count(*) FROM cloud_refresh_tokens WHERE organization_id IS NOT NULL) \
              + (SELECT count(*) FROM cloud_app_sign_ins WHERE organization_id IS NOT NULL), \
                jsonb_build_object('tokens',(SELECT jsonb_agg(to_jsonb(t)-'organization_id') FROM cloud_refresh_tokens t),\
                                   'sign_ins',(SELECT jsonb_agg(to_jsonb(s)-'organization_id') FROM cloud_app_sign_ins s))",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(claims, 0);
    assert_eq!(after, before);

    // Deleting a claimed organization empties the claim instead of the session.
    execute(&pool, "INSERT INTO cloud_organizations(organization_id,name,kind,created_by_account_id,created_at) VALUES('org_fixture_claim','Team','team','fixture-owner',now())").await;
    execute(
        &pool,
        "UPDATE cloud_refresh_tokens SET organization_id='org_fixture_claim'",
    )
    .await;
    execute(
        &pool,
        "UPDATE cloud_app_sign_ins SET organization_id='org_fixture_claim'",
    )
    .await;
    execute(
        &pool,
        "DELETE FROM cloud_organizations WHERE organization_id='org_fixture_claim'",
    )
    .await;
    let (tokens, claimed): (i64, i64) = query_as(
        "SELECT (SELECT count(*) FROM cloud_refresh_tokens), \
                (SELECT count(*) FROM cloud_refresh_tokens WHERE organization_id IS NOT NULL) \
              + (SELECT count(*) FROM cloud_app_sign_ins WHERE organization_id IS NOT NULL)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((tokens, claimed), (1, 0));
}
