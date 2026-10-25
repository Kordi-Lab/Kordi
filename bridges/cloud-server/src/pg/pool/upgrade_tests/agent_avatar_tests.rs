use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_148_accepts_bird_avatar_style() {
    let pool = fixture(148).await;
    execute(&pool, "INSERT INTO cloud_agent_definitions(agent_id,owner_account_id,name,role,system_prompt,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at) VALUES('agent_thumbs','fixture-owner','Thumbs','research','test','test','test','generated','thumbs','agent_thumbs','fixture',1,'test')").await;
    let bird_before = query("INSERT INTO cloud_avatar_render_keys(renderer_version,style,seed) VALUES('fixture','kordi-birds','bird-owl-ink-paper')")
        .execute(&pool)
        .await;
    assert!(bird_before.is_err(), "148 still rejects the bird style");

    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;

    execute(&pool, "INSERT INTO cloud_avatar_render_keys(renderer_version,style,seed) VALUES('fixture','kordi-birds','bird-owl-ink-paper'),('fixture','thumbs','agent_thumbs'),('fixture','lorelei','fixture-owner')").await;
    execute(&pool, "INSERT INTO cloud_agent_definitions(agent_id,owner_account_id,name,role,system_prompt,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at) VALUES('agent_bird','fixture-owner','Bird','research','test','test','test','generated','kordi-birds','bird-osprey-color-sky','fixture',1,'test')").await;
    execute(&pool, "UPDATE cloud_default_agent_profiles SET avatar_style='kordi-birds' WHERE owner_account_id='fixture-owner'").await;

    let styles: Vec<(String, String)> =
        query_as("SELECT agent_id, avatar_style FROM cloud_agent_definitions ORDER BY agent_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        styles,
        [
            ("agent_bird".to_string(), "kordi-birds".to_string()),
            ("agent_thumbs".to_string(), "thumbs".to_string()),
        ],
        "existing thumbs agents are untouched"
    );
    let (profile_style,): (String,) = query_as(
        "SELECT avatar_style FROM cloud_default_agent_profiles WHERE owner_account_id='fixture-owner'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(profile_style, "kordi-birds");

    for sql in [
        "INSERT INTO cloud_avatar_render_keys(renderer_version,style,seed) VALUES('fixture','other','seed')",
        "UPDATE cloud_agent_definitions SET avatar_style='other' WHERE agent_id='agent_bird'",
        "UPDATE cloud_default_agent_profiles SET avatar_style='other' WHERE owner_account_id='fixture-owner'",
        "UPDATE cloud_accounts SET avatar_style='kordi-birds' WHERE account_id='fixture-owner'",
    ] {
        assert!(query(sql).execute(&pool).await.is_err(), "{sql}");
    }
}
