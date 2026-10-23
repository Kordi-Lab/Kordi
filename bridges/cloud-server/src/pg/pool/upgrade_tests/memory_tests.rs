use super::*;

/// Memory id, category, declaration type, confidence and profile id.
type Backfill = (String, String, String, Option<String>, Option<String>);

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_148_adds_memory_categories() {
    let pool = fixture(148).await;
    execute(
        &pool,
        "INSERT INTO cloud_account_memories \
           (memory_id, owner_account_id, scope, scope_id, scope_label, source, text, created_at, updated_at) \
         VALUES \
           ('mem_manual', 'fixture-owner', 'global', 'account', NULL, 'manual', \
            'Answer in British English', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'), \
           ('mem_correction', 'fixture-owner', 'conversation', 'session-1', 'Launch', \
            'user_correction', 'Prefer short replies', '2026-01-03T00:00:00Z', '2026-01-04T00:00:00Z'), \
           ('mem_outcome', 'fixture-owner', 'project', 'project-1', NULL, 'outcome', \
            'Run the smoke test first', '2026-01-05T00:00:00Z', '2026-01-06T00:00:00Z')",
    )
    .await;
    let rows = "SELECT memory_id, to_jsonb(m) - ARRAY['category','declaration_type','confidence','profile_id'] \
        FROM cloud_account_memories m ORDER BY memory_id";
    let before: Vec<(String, Value)> = query_as(rows).fetch_all(&pool).await.unwrap();
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let after: Vec<(String, Value)> = query_as(rows).fetch_all(&pool).await.unwrap();
    assert_eq!(before, after, "text, scope and timestamps are untouched");

    let backfill: Vec<Backfill> = query_as(
        "SELECT memory_id, category, declaration_type, confidence, profile_id \
         FROM cloud_account_memories ORDER BY memory_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let expected = |id: &str, category: &str, declaration: &str, confidence: Option<&str>| {
        (
            id.to_string(),
            category.to_string(),
            declaration.to_string(),
            confidence.map(str::to_string),
            None,
        )
    };
    assert_eq!(
        backfill,
        vec![
            expected(
                "mem_correction",
                "general_preferences",
                "model-inferred",
                Some("medium")
            ),
            expected("mem_manual", "general_preferences", "user-declared", None),
            expected(
                "mem_outcome",
                "hcp-custom:task_lessons",
                "model-inferred",
                Some("medium")
            ),
        ]
    );

    for invalid in [
        "UPDATE cloud_account_memories SET category = 'diary' WHERE memory_id = 'mem_manual'",
        "UPDATE cloud_account_memories SET declaration_type = 'guessed' WHERE memory_id = 'mem_manual'",
        "UPDATE cloud_account_memories SET confidence = 'certain' WHERE memory_id = 'mem_manual'",
        "UPDATE cloud_account_memories SET profile_id = 'cgp_missing' WHERE memory_id = 'mem_manual'",
    ] {
        assert!(
            sqlx_core::raw_sql::raw_sql(invalid)
                .execute(&pool)
                .await
                .is_err(),
            "{invalid}"
        );
    }

    // Deleting a profile keeps its memories and clears their profile.
    execute(
        &pool,
        "INSERT INTO cloud_common_ground_profiles (profile_id, account_id, kind, name, position) \
         VALUES ('cgp_fixture_health', 'fixture-owner', 'health', 'Health', 7); \
         UPDATE cloud_account_memories SET profile_id = 'cgp_fixture_health' WHERE memory_id = 'mem_manual'; \
         DELETE FROM cloud_common_ground_profiles WHERE profile_id = 'cgp_fixture_health'",
    )
    .await;
    let (profile,): (Option<String>,) =
        query_as("SELECT profile_id FROM cloud_account_memories WHERE memory_id = 'mem_manual'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(profile, None);
}
