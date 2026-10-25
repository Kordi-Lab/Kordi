use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_148_adds_proactive_agents() {
    let pool = fixture(148).await;
    execute(&pool, "INSERT INTO cloud_agent_definitions(agent_id,owner_account_id,name,role,system_prompt,model_routing_json,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at) VALUES('cloud_agent_fixture','fixture-owner','Scout','Helper','Help.','{\"defaultModel\":\"gpt-test\"}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','generated','thumbs','cloud_agent_fixture','fixture',1,'2026-01-01T00:00:00Z')").await;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let (proactive, routing): (Value, Value) = query_as(
        "SELECT proactive_json, model_routing_json FROM cloud_agent_definitions WHERE agent_id = 'cloud_agent_fixture'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        proactive,
        json!({"enabled": false}),
        "existing agents stay off"
    );
    assert_eq!(
        routing,
        json!({"defaultModel": "gpt-test"}),
        "other fields are untouched"
    );
    execute(&pool, "INSERT INTO cloud_chat_conversations(conversation_id,kind,created_by_account_id,client_operation_id,creation_fingerprint) VALUES('00000000-0000-4000-8000-000000000149','group','fixture-owner','00000000-0000-4000-8000-000000000001','fixture')").await;
    execute(&pool, "INSERT INTO cloud_agent_proactive_state(agent_id,owner_account_id,conversation_id) VALUES('cloud_agent_fixture','fixture-owner','00000000-0000-4000-8000-000000000149')").await;
    // The default agent has no definition row; its rows need only the owner.
    execute(&pool, "INSERT INTO cloud_account_proactive_settings(account_id,enabled) VALUES('fixture-owner',TRUE)").await;
    execute(&pool, "INSERT INTO cloud_agent_proactive_state(agent_id,owner_account_id,conversation_id) VALUES('cloud-agent:fixture-owner','fixture-owner','00000000-0000-4000-8000-000000000149')").await;
    let (enabled,): (bool,) = query_as(
        "SELECT enabled FROM cloud_account_proactive_settings WHERE account_id = 'fixture-owner'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(enabled);
    let orphan = sqlx_core::raw_sql::raw_sql(
        "INSERT INTO cloud_account_proactive_settings(account_id) VALUES('no-such-account')",
    )
    .execute(&pool)
    .await;
    assert!(orphan.is_err(), "the setting belongs to an account");
    let insert = |id: &str, run: &str| {
        format!("INSERT INTO cloud_agent_proactive_proposals(proposal_id,agent_id,owner_account_id,conversation_id,session_id,trigger_message_id,problem,offer,plan,evaluation_run_id,expires_at) VALUES('{id}','cloud_agent_fixture','fixture-owner','00000000-0000-4000-8000-000000000149','session:group:g','m1','p','o','l','{run}',now() + interval '1 day')")
    };
    execute(&pool, &insert("pro_a", "proactive_eval_a")).await;
    let second = sqlx_core::raw_sql::raw_sql(&insert("pro_b", "proactive_eval_b"))
        .execute(&pool)
        .await;
    assert!(
        second.is_err(),
        "one pending proposal per agent and conversation"
    );
    execute(
        &pool,
        "UPDATE cloud_agent_proactive_proposals SET status = 'declined'",
    )
    .await;
    execute(&pool, &insert("pro_b", "proactive_eval_b")).await;
    let bad = sqlx_core::raw_sql::raw_sql(
        "UPDATE cloud_agent_proactive_proposals SET status = 'maybe' WHERE proposal_id = 'pro_b'",
    )
    .execute(&pool)
    .await;
    assert!(bad.is_err(), "status values are checked");
    let (state_rows,): (i64,) = query_as("SELECT count(*) FROM cloud_agent_proactive_state")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(state_rows, 2);
    let default_proposal = insert("pro_c", "proactive_eval_c").replace(
        "'pro_c','cloud_agent_fixture'",
        "'pro_c','cloud-agent:fixture-owner'",
    );
    execute(&pool, &default_proposal).await;
}
