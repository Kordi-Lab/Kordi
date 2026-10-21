use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_139_adds_account_about() {
    let pool = fixture(139).await;
    let accounts = "SELECT to_jsonb(a) FROM cloud_accounts a ORDER BY account_id";
    let before: Vec<(Value,)> = query_as(accounts).fetch_all(&pool).await.unwrap();
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let after: Vec<(Value,)> =
        query_as("SELECT to_jsonb(a) - 'about' FROM cloud_accounts a ORDER BY account_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(before, after, "existing account fields are untouched");
    let abouts: Vec<(Option<String>,)> =
        query_as("SELECT about FROM cloud_accounts ORDER BY account_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        abouts,
        vec![(None,), (None,)],
        "existing accounts start without an about line"
    );
    execute(
        &pool,
        "UPDATE cloud_accounts SET about = 'Robotics PhD.' WHERE account_id = 'fixture-owner'",
    )
    .await;
    let (about,): (Option<String>,) =
        query_as("SELECT about FROM cloud_accounts WHERE account_id = 'fixture-owner'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(about.as_deref(), Some("Robotics PhD."));
}
