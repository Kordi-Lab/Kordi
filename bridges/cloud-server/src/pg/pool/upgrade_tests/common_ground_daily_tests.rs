use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_146_renames_daily_profiles() {
    let pool = fixture(146).await;
    execute(&pool, "INSERT INTO cloud_common_ground_profiles(profile_id,account_id,kind,name,position) VALUES('cgp_a','fixture-owner','work','Work',0),('cgp_b','fixture-owner','daily','Daily tasks',1),('cgp_c','fixture-peer','daily','Weekends',0),('cgp_d','fixture-peer','custom','Daily tasks',1)").await;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let names: Vec<(String, String)> =
        query_as("SELECT profile_id, name FROM cloud_common_ground_profiles ORDER BY profile_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    let names: Vec<(&str, &str)> = names
        .iter()
        .map(|(id, name)| (id.as_str(), name.as_str()))
        .collect();
    assert_eq!(
        names,
        [
            ("cgp_a", "Work"),
            ("cgp_b", "Daily"),
            ("cgp_c", "Weekends"),
            ("cgp_d", "Daily tasks"),
        ],
        "only untouched daily default names are renamed"
    );
}
