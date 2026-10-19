use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_133_adds_common_ground() {
    let pool = fixture(133).await;
    let accounts = "SELECT to_jsonb(a) FROM cloud_accounts a ORDER BY account_id";
    let before: Vec<(Value,)> = query_as(accounts).fetch_all(&pool).await.unwrap();
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let after: Vec<(Value,)> = query_as(accounts).fetch_all(&pool).await.unwrap();
    assert_eq!(before, after, "accounts are untouched");

    execute(&pool, "INSERT INTO cloud_common_ground_cards(account_id) VALUES('fixture-owner'),('fixture-peer')").await;
    execute(&pool, "INSERT INTO cloud_common_ground_rooms(room_id,code,created_by) VALUES('00000000-0000-0000-0000-000000000001','0427','fixture-owner')").await;
    execute(&pool, "INSERT INTO cloud_common_ground_room_members(room_id,account_id) VALUES('00000000-0000-0000-0000-000000000001','fixture-owner'),('00000000-0000-0000-0000-000000000001','fixture-peer')").await;
    execute(&pool, "INSERT INTO cloud_common_ground_pairings(account_a,account_b) VALUES('fixture-owner','fixture-peer')").await;
    execute(&pool, "INSERT INTO cloud_common_ground_pairing_codes(code_hash,account_id,expires_at) VALUES('hash','fixture-peer',now())").await;
    execute(&pool, "INSERT INTO cloud_common_ground_matches(viewer_account_id,other_account_id,viewer_revision,other_revision,result_json) VALUES('fixture-owner','fixture-peer',1,1,'{}')").await;
    let (sharing, revision, topics): (bool, i64, Value) = query_as("SELECT sharing_enabled,revision,topics_json FROM cloud_common_ground_cards WHERE account_id='fixture-owner'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        (sharing, revision, topics),
        (true, 0, json!({})),
        "cards share by default"
    );
    for invalid in [
        // A second open room with the same code.
        "INSERT INTO cloud_common_ground_rooms(room_id,code) VALUES('00000000-0000-0000-0000-000000000002','0427')",
        "INSERT INTO cloud_common_ground_rooms(room_id,code) VALUES('00000000-0000-0000-0000-000000000003','42')",
        "INSERT INTO cloud_common_ground_rooms(room_id,code) VALUES('00000000-0000-0000-0000-000000000004','04a7')",
        // Pairings are stored with the smaller id first, once.
        "INSERT INTO cloud_common_ground_pairings(account_a,account_b) VALUES('fixture-peer','fixture-owner')",
        "INSERT INTO cloud_common_ground_matches(viewer_account_id,other_account_id,viewer_revision,other_revision,result_json) VALUES('fixture-peer','fixture-peer',1,1,'{}')",
    ] {
        assert!(sqlx_core::raw_sql::raw_sql(invalid).execute(&pool).await.is_err(), "{invalid}");
    }
    // A closed room frees its code.
    execute(
        &pool,
        "UPDATE cloud_common_ground_rooms SET closed_at=now() WHERE code='0427'",
    )
    .await;
    execute(&pool, "INSERT INTO cloud_common_ground_rooms(room_id,code) VALUES('00000000-0000-0000-0000-000000000005','0427')").await;

    execute(
        &pool,
        "DELETE FROM cloud_accounts WHERE account_id='fixture-peer'",
    )
    .await;
    let counts: (i64, i64, i64, i64, i64) = query_as("SELECT (SELECT COUNT(*) FROM cloud_common_ground_cards),(SELECT COUNT(*) FROM cloud_common_ground_room_members),(SELECT COUNT(*) FROM cloud_common_ground_pairings),(SELECT COUNT(*) FROM cloud_common_ground_pairing_codes),(SELECT COUNT(*) FROM cloud_common_ground_matches)")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        counts,
        (1, 1, 0, 0, 0),
        "a deleted account takes its Common ground rows"
    );
    execute(
        &pool,
        "DELETE FROM cloud_accounts WHERE account_id='fixture-owner'",
    )
    .await;
    let (created_by,): (Option<String>,) = query_as("SELECT created_by FROM cloud_common_ground_rooms WHERE room_id='00000000-0000-0000-0000-000000000001'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(created_by, None, "rooms outlive the person who opened them");
}
