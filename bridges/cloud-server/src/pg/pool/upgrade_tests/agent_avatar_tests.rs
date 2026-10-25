use super::*;
use crate::avatars::AVATAR_RENDERER_VERSION;

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

    execute(&pool, "INSERT INTO cloud_avatar_render_keys(renderer_version,style,seed) VALUES('fixture','kordi-birds','bird-owl-ink-paper'),('fixture','thumbs','agent_thumbs_cached'),('fixture','lorelei','fixture-owner')").await;
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
            ("agent_thumbs".to_string(), "kordi-birds".to_string()),
        ],
        "149 leaves thumbs agents alone; 155 then moves generated ones to birds"
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

const MIGRATION_155: &str =
    include_str!("../../../../migrations/0155_agent_default_bird_avatars.sql");

/// Every agent avatar row and the render-key allowlist, to compare snapshots.
async fn agent_avatar_rows(pool: &PgPool) -> Vec<Value> {
    query_as::<_, (Value,)>(
        "SELECT jsonb_build_object('table','definition','id',agent_id,'url',avatar_url,'source',avatar_source,'style',avatar_style,'seed',avatar_seed,'renderer',avatar_renderer_version,'version',avatar_version,'updated',avatar_updated_at) FROM cloud_agent_definitions
         UNION ALL SELECT jsonb_build_object('table','profile','id',owner_account_id,'url',avatar_url,'source',avatar_source,'style',avatar_style,'seed',avatar_seed,'renderer',avatar_renderer_version,'version',avatar_version,'updated',avatar_updated_at) FROM cloud_default_agent_profiles
         UNION ALL SELECT jsonb_build_object('table','human','id',account_id,'url',avatar_url,'source',avatar_source,'style',avatar_style,'seed',avatar_seed,'version',avatar_version,'updated',avatar_updated_at) FROM cloud_accounts
         UNION ALL SELECT jsonb_build_object('table','render_key','renderer',renderer_version,'style',style,'seed',seed) FROM cloud_avatar_render_keys
         ORDER BY 1",
    )
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|(row,)| row)
    .collect()
}

fn row<'a>(rows: &'a [Value], table: &str, id: &str) -> &'a Value {
    rows.iter()
        .find(|row| row["table"] == table && row["id"] == id)
        .unwrap_or_else(|| panic!("{table} {id} is missing"))
}

async fn avatar_status(pool: &PgPool, style: &str, seed: &str) -> u16 {
    use tower::ServiceExt;
    let app = crate::avatars::routes(std::sync::Arc::new(crate::server::ServerState::new(
        pool.clone(),
        crate::events::EventBus::noop(),
    )));
    let uri = format!("/v1/avatars/{AVATAR_RENDERER_VERSION}/{style}/{seed}.png");
    let request = axum::http::Request::get(uri)
        .body(axum::body::Body::empty())
        .unwrap();
    app.oneshot(request).await.unwrap().status().as_u16()
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_154_moves_generated_thumbs_agents_to_birds() {
    let pool = fixture(154).await;
    // At 154, the account trigger gave fixture-owner and fixture-peer
    // generated thumbs default agents seeded `default-agent-<account>`.
    let upload = "kordi-avatar://uploaded/ava_0123456789abcdef0123456789abcdef";
    let insert = |id: &str, source: &str, style: &str, seed: &str, version: i64| {
        format!("INSERT INTO cloud_agent_definitions(agent_id,owner_account_id,name,role,system_prompt,created_at,updated_at,avatar_url,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at) VALUES('{id}','fixture-owner','{id}','research','test','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','{upload}','{source}','{style}','{seed}','{AVATAR_RENDERER_VERSION}',{version},'2026-01-01T00:00:00Z')")
    };
    for sql in [
        insert(
            "agent_generated",
            "generated",
            "thumbs",
            "3f9a1c2e4b5d6f70",
            3,
        ),
        insert("agent_uploaded", "uploaded", "thumbs", "agent_uploaded", 2),
        insert(
            "agent_picked",
            "generated",
            "kordi-birds",
            "bird-owl-ink-paper",
            4,
        ),
    ] {
        execute(&pool, &sql).await;
    }
    execute(&pool, &format!("UPDATE cloud_default_agent_profiles SET avatar_source='uploaded', avatar_url='{upload}' WHERE owner_account_id='fixture-peer'")).await;
    let before = agent_avatar_rows(&pool).await;

    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let after = agent_avatar_rows(&pool).await;

    for (table, id, seed, version) in [
        ("definition", "agent_generated", "3f9a1c2e4b5d6f70", 4),
        ("profile", "fixture-owner", "default-agent-fixture-owner", 2),
    ] {
        let moved = row(&after, table, id);
        assert_eq!(moved["style"], "kordi-birds", "{id}");
        assert_eq!(moved["seed"], seed, "{id} keeps its seed, so its bird");
        assert_eq!(moved["version"], version, "{id}");
        assert_eq!(moved["renderer"], AVATAR_RENDERER_VERSION);
        assert_eq!(
            moved["url"],
            crate::avatars::generated_avatar_marker("kordi-birds", seed, version),
            "{id}"
        );
        let updated = moved["updated"].as_str().unwrap();
        assert!(
            chrono::DateTime::parse_from_rfc3339(updated).is_ok() && updated > "2026-01-01",
            "{id} avatar_updated_at {updated}"
        );
        let old_key = json!({"table":"render_key","renderer":AVATAR_RENDERER_VERSION,"style":"thumbs","seed":seed});
        assert!(after.contains(&old_key), "{id} keeps its thumbs render key");
    }
    for (table, id) in [
        ("definition", "agent_uploaded"),
        ("definition", "agent_picked"),
        ("profile", "fixture-peer"),
        ("human", "fixture-owner"),
        ("human", "fixture-peer"),
    ] {
        assert_eq!(
            row(&after, table, id),
            row(&before, table, id),
            "{table} {id}"
        );
    }

    // The versioned route serves the moved bird and the old thumbs URL.
    for style in ["kordi-birds", "thumbs"] {
        assert_eq!(
            avatar_status(&pool, style, "3f9a1c2e4b5d6f70").await,
            200,
            "{style}"
        );
        assert_eq!(
            avatar_status(&pool, style, "default-agent-fixture-owner").await,
            200,
            "{style}"
        );
    }
    assert_eq!(
        avatar_status(&pool, "kordi-birds", "agent_uploaded").await,
        404
    );

    sqlx_core::raw_sql::raw_sql(MIGRATION_155)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        agent_avatar_rows(&pool).await,
        after,
        "a second run is a no-op"
    );

    // New accounts get a random structured bird from the trigger.
    execute(&pool, "INSERT INTO cloud_accounts(account_id,display_name,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at) SELECT 'fixture-new-' || n,'New','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z','generated','lorelei','fixture-new-' || n,'fixture',1,'2026-02-01T00:00:00Z' FROM generate_series(1, 40) n").await;
    let profiles: Vec<(String, String, String, i64)> = query_as("SELECT avatar_url, avatar_style, avatar_seed, avatar_version FROM cloud_default_agent_profiles WHERE owner_account_id LIKE 'fixture-new-%'")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(profiles.len(), 40);
    let mut seeds = std::collections::BTreeSet::new();
    for (url, style, seed, version) in &profiles {
        assert_eq!((style.as_str(), *version), ("kordi-birds", 1));
        let bird = crate::avatars::birds::parse_structured_bird_seed(seed)
            .unwrap_or_else(|| panic!("{seed:?} is not a structured bird seed"));
        assert_eq!(bird.tone, "color");
        assert_eq!(
            url,
            &crate::avatars::generated_avatar_marker("kordi-birds", seed, 1)
        );
        seeds.insert(seed.clone());
    }
    assert!(seeds.len() > 10, "random seeds: {seeds:?}");
    let new_seed = profiles[0].2.as_str();
    assert_eq!(avatar_status(&pool, "kordi-birds", new_seed).await, 200);
}
