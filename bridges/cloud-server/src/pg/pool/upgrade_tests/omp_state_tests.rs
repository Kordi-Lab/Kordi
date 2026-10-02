use super::*;

async fn save_state(pool: &PgPool, run_id: &str, state: Value) {
    query(
        "INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,response_message_id,created_at,updated_at) \
         VALUES($1,$1,$1,'old-direct-fixture','fixture-owner','fixture-peer','completed','Fixture request',$1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z') \
         ON CONFLICT(run_id) DO NOTHING",
    )
    .bind(run_id)
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_agent_omp_state(run_id,owner_account_id,session_id,execution_agent_id,route_json,auth_snapshot_id,provider,model,response_message_id,state_json) \
         VALUES($1,'fixture-owner','old-direct-fixture','fixture-agent','{}'::jsonb,'fixture-snapshot','openai','fixture-model',$1,$2)",
    )
    .bind(run_id)
    .bind(state)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_117_flags_only_replayable_omp_states() {
    let pool = fixture(117).await;
    save_state(
        &pool,
        "old-run",
        json!({"replayable": true, "messages": []}),
    )
    .await;
    save_state(
        &pool,
        "new-run",
        json!({"replayable": "true", "messages": []}),
    )
    .await;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;

    let flags: Vec<(String, bool, Value)> =
        query_as("SELECT run_id,replayable,state_json FROM cloud_agent_omp_state ORDER BY run_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        flags,
        vec![
            (
                "new-run".to_string(),
                false,
                json!({"replayable": "true", "messages": []})
            ),
            (
                "old-run".to_string(),
                true,
                json!({"replayable": true, "messages": []})
            ),
        ],
        "only a boolean replay flag is carried over, and states are unchanged"
    );
    // A state that a server without the column saves during a rolling
    // update is not replayed.
    query("DELETE FROM cloud_agent_omp_state WHERE run_id='new-run'")
        .execute(&pool)
        .await
        .unwrap();
    save_state(
        &pool,
        "new-run",
        json!({"replayable": true, "messages": []}),
    )
    .await;
    let (replayable,): (bool,) =
        query_as("SELECT replayable FROM cloud_agent_omp_state WHERE run_id='new-run'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(!replayable);
}
