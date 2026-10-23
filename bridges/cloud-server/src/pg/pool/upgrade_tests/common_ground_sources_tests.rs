use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_146_adds_profile_sources() {
    let pool = fixture(146).await;
    execute(&pool, "INSERT INTO cloud_common_ground_profiles(profile_id,account_id,kind,name,position,design,icon) VALUES('cgp_a','fixture-owner','work','Work',0,'ocean','briefcase')").await;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let (design, icon, sources): (Option<String>, Option<String>, Option<Value>) =
        query_as("SELECT design, icon, sources_json FROM cloud_common_ground_profiles")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        (design.as_deref(), icon.as_deref(), sources),
        (Some("ocean"), Some("briefcase"), None),
        "existing profiles keep their design and have no saved sources"
    );
    execute(
        &pool,
        r#"UPDATE cloud_common_ground_profiles SET sources_json = '{"memory":true}'"#,
    )
    .await;
}
