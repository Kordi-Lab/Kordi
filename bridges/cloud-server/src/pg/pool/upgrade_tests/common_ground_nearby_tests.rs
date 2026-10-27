use super::*;

async fn fails(pool: &PgPool, sql: &str) -> bool {
    sqlx_core::raw_sql::raw_sql(sql)
        .execute(pool)
        .await
        .is_err()
}

async fn count(pool: &PgPool, table: &str) -> i64 {
    let (count,): (i64,) = query_as(&format!("SELECT count(*) FROM {table}"))
        .fetch_one(pool)
        .await
        .unwrap();
    count
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_155_adds_common_ground_nearby() {
    let pool = fixture(155).await;
    execute(&pool, "INSERT INTO cloud_common_ground_profiles(profile_id,account_id,kind,name,position) VALUES('cgp_owner','fixture-owner','work','Work',0),('cgp_peer','fixture-peer','work','Work',0)").await;
    execute(&pool, "INSERT INTO cloud_devices(device_id,account_id,device_name,device_public_key,created_at,last_seen_at) VALUES('dev_owner','fixture-owner','Phone','legacy:dev_owner','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").await;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;

    execute(&pool, "INSERT INTO cloud_common_ground_nearby(account_id,profile_id) VALUES('fixture-owner','cgp_owner'),('fixture-peer','cgp_peer')").await;
    type Defaults = (bool, Value, i32, i32, bool, bool, i32, i32, Option<String>);
    let row: Defaults = query_as("SELECT enabled, open_to_json, range_m, min_score, alert_requests, alert_matches, alert_match_min_score, alert_max_per_day, dirty_at::text FROM cloud_common_ground_nearby WHERE account_id = 'fixture-owner'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row,
        (false, json!([]), 2000, 0, true, true, 85, 3, None),
        "nearby starts off with the documented defaults"
    );
    execute(&pool, "INSERT INTO cloud_common_ground_nearby_locations(device_id,account_id,latitude,longitude,accuracy_m,captured_at,fresh_until) VALUES('dev_owner','fixture-owner',31.23,121.474,20,now(),now() + interval '30 minutes')").await;
    assert!(
        fails(&pool, "INSERT INTO cloud_common_ground_nearby_locations(device_id,account_id,latitude,longitude,accuracy_m,captured_at,fresh_until) VALUES('dev_owner','fixture-owner',0,0,20,now(),now())").await,
        "one location per device"
    );
    assert!(
        fails(
            &pool,
            "UPDATE cloud_common_ground_nearby_locations SET latitude = 91"
        )
        .await
    );
    execute(&pool, "INSERT INTO cloud_common_ground_nearby_needs(need_id,account_id,text,range_m) VALUES('cgn_a','fixture-owner','Someone founding a startup',1000)").await;
    assert!(
        fails(&pool, "INSERT INTO cloud_common_ground_nearby_needs(need_id,account_id,text,range_m) VALUES('cgn_b','fixture-owner','',1000)").await,
        "a request has text"
    );
    let (revision,): (i64,) =
        query_as("SELECT revision FROM cloud_common_ground_nearby_needs WHERE need_id = 'cgn_a'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(revision, 1);
    execute(&pool, "INSERT INTO cloud_common_ground_nearby_verdicts(need_id,other_profile_id,need_revision,other_revision,met) VALUES('cgn_a','cgp_peer',1,0,true)").await;
    execute(&pool, "INSERT INTO cloud_common_ground_nearby_need_runs(run_id,need_id,need_revision,account_id) VALUES('cg_need_a','cgn_a',1,'fixture-owner')").await;
    let alert = |id: &str| {
        format!("INSERT INTO cloud_common_ground_nearby_alerts(alert_id,recipient_account_id,other_account_id,other_profile_id,kind,need_id,need_revision,distance_max_m) VALUES('{id}','fixture-owner','fixture-peer','cgp_peer','need','cgn_a',1,500)")
    };
    execute(&pool, &alert("cgna_a")).await;
    assert!(
        fails(&pool, &alert("cgna_b")).await,
        "one request alert per person and revision"
    );
    execute(&pool, "UPDATE cloud_common_ground_nearby_alerts SET status = 'invalidated' WHERE alert_id = 'cgna_a'").await;
    execute(&pool, &alert("cgna_b")).await;
    assert!(
        fails(
            &pool,
            "UPDATE cloud_common_ground_nearby_alerts SET status = 'sent'"
        )
        .await
    );
    assert!(
        fails(&pool, "INSERT INTO cloud_common_ground_nearby_alerts(alert_id,recipient_account_id,other_account_id,other_profile_id,kind,distance_max_m) VALUES('cgna_c','fixture-owner','fixture-peer','cgp_peer','need',500)").await,
        "a request alert names its request"
    );
    execute(&pool, "INSERT INTO cloud_common_ground_nearby_alerts(alert_id,recipient_account_id,other_account_id,other_profile_id,kind,score,distance_max_m) VALUES('cgna_m','fixture-owner','fixture-peer','cgp_peer','match',90,500)").await;

    // Deleting the shared profile keeps the setting without a profile.
    execute(
        &pool,
        "DELETE FROM cloud_common_ground_profiles WHERE profile_id = 'cgp_owner'",
    )
    .await;
    let (profile,): (Option<String>,) = query_as(
        "SELECT profile_id FROM cloud_common_ground_nearby WHERE account_id = 'fixture-owner'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(profile, None);
    execute(
        &pool,
        "DELETE FROM cloud_devices WHERE device_id = 'dev_owner'",
    )
    .await;
    assert_eq!(
        count(&pool, "cloud_common_ground_nearby_locations").await,
        0
    );
    execute(
        &pool,
        "DELETE FROM cloud_common_ground_nearby_needs WHERE need_id = 'cgn_a'",
    )
    .await;
    for table in [
        "cloud_common_ground_nearby_verdicts",
        "cloud_common_ground_nearby_need_runs",
    ] {
        assert_eq!(count(&pool, table).await, 0, "{table}");
    }
    assert_eq!(count(&pool, "cloud_common_ground_nearby_alerts").await, 1);
    execute(
        &pool,
        "DELETE FROM cloud_accounts WHERE account_id = 'fixture-peer'",
    )
    .await;
    assert_eq!(count(&pool, "cloud_common_ground_nearby_alerts").await, 0);
    assert_eq!(count(&pool, "cloud_common_ground_nearby").await, 1);
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_158_preserves_activities_on_the_shared_card() {
    let pool = fixture(158).await;
    execute(&pool, "INSERT INTO cloud_common_ground_profiles(profile_id,account_id,kind,name,position) VALUES('activities_work','fixture-owner','work','Work',0),('activities_health','fixture-owner','health','Health',1)").await;
    execute(&pool, "INSERT INTO cloud_common_ground_nearby(account_id,profile_id,open_to_json) VALUES('fixture-owner','activities_work','[\"Hiring\"]')").await;
    apply_migrations(&pool).await.unwrap();
    latest_version(&pool).await;
    let (choices,): (Value,) = query_as("SELECT open_to_json FROM cloud_common_ground_nearby_profile_preferences WHERE profile_id = 'activities_work'").fetch_one(&pool).await.unwrap();
    assert_eq!(choices, json!(["Hiring"]));
    assert_eq!(
        count(&pool, "cloud_common_ground_nearby_profile_preferences").await,
        1,
        "Unselected cards do not inherit activity choices"
    );
    execute(
        &pool,
        "DELETE FROM cloud_common_ground_profiles WHERE profile_id = 'activities_work'",
    )
    .await;
    assert_eq!(
        count(&pool, "cloud_common_ground_nearby_profile_preferences").await,
        0
    );
}
