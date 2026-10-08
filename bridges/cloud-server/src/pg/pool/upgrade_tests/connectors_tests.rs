use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_113_adds_connectors_without_touching_accounts() {
    let pool = fixture(113).await;
    let before: Vec<(Value,)> =
        query_as("SELECT to_jsonb(a) FROM cloud_accounts a ORDER BY account_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    apply_migrations(&pool).await.unwrap();
    latest_version(&pool).await;
    let after: Vec<(Value,)> =
        query_as("SELECT to_jsonb(a) FROM cloud_accounts a ORDER BY account_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(before, after);

    execute(&pool, "INSERT INTO cloud_connectors(connector_id,account_id,provider,status) VALUES('conn_live','fixture-owner','github','connected')").await;
    execute(&pool, "INSERT INTO cloud_connectors(connector_id,account_id,provider,status,revoked_at) VALUES('conn_old','fixture-owner','github','revoked',now())").await;
    execute(&pool, "INSERT INTO cloud_connector_secrets(connector_id,ciphertext,nonce,key_version) VALUES('conn_live','\\x01','\\x02',1)").await;
    execute(&pool, "INSERT INTO cloud_connector_agent_grants(connector_id,agent_id) VALUES('conn_live','cloud-agent:fixture-owner')").await;
    execute(&pool, "INSERT INTO cloud_connector_events(event_id,connector_id,provider,kind,occurred_at,expires_at) VALUES('evt','conn_live','github','notification',now(),now())").await;
    execute(&pool, "INSERT INTO cloud_connector_audit(audit_id,connector_id,account_id,tool,tool_group,outcome,summary) VALUES('aud','conn_live','fixture-owner','oauth.grant','read','completed','Granted.')").await;
    execute(&pool, "INSERT INTO cloud_connector_removal_requests(request_id,account_id,connector_id) VALUES('req','fixture-owner','conn_old')").await;
    execute(&pool, "INSERT INTO cloud_connector_oauth_states(state_id,account_id,provider,grant_kind,code_verifier,expires_at) VALUES('st','fixture-owner','github','act','v',now())").await;
    for invalid in [
        // A second live connector for the same account and provider.
        "INSERT INTO cloud_connectors(connector_id,account_id,provider,status) VALUES('conn_dup','fixture-owner','github','needs_reauth')",
        "INSERT INTO cloud_connectors(connector_id,account_id,provider,status) VALUES('conn_bad','fixture-owner','slack','paused')",
        "INSERT INTO cloud_connectors(connector_id,account_id,provider,status) VALUES('conn_rev','fixture-owner','slack','revoked')",
        "INSERT INTO cloud_connectors(connector_id,account_id,provider,status) VALUES('conn_x','missing-account','slack','connected')",
        "INSERT INTO cloud_connector_audit(audit_id,connector_id,account_id,tool,tool_group,outcome,summary) VALUES('aud2','conn_live','fixture-owner','t','write','completed','s')",
        "INSERT INTO cloud_connector_audit(audit_id,connector_id,account_id,tool,tool_group,outcome,summary) VALUES('aud3','conn_live','fixture-owner','t','act','skipped','s')",
        "INSERT INTO cloud_connector_oauth_states(state_id,account_id,provider,grant_kind,code_verifier,expires_at) VALUES('st2','fixture-owner','github','admin','v',now())",
    ] {
        assert!(sqlx_core::raw_sql::raw_sql(invalid).execute(&pool).await.is_err(), "{invalid}");
    }

    execute(
        &pool,
        "DELETE FROM cloud_accounts WHERE account_id='fixture-owner'",
    )
    .await;
    for table in [
        "cloud_connectors",
        "cloud_connector_secrets",
        "cloud_connector_agent_grants",
        "cloud_connector_events",
        "cloud_connector_audit",
        "cloud_connector_oauth_states",
    ] {
        let (rows,): (i64,) = query_as(&format!("SELECT COUNT(*)::BIGINT FROM {table}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(rows, 0, "{table} rows go with their account");
    }
    let (requests,): (i64,) =
        query_as("SELECT COUNT(*)::BIGINT FROM cloud_connector_removal_requests")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(requests, 1, "removal requests outlive the connector");
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_114_labels_existing_runs_as_background() {
    let pool = fixture(114).await;
    seed_runs(&pool).await;
    let before = historical_runs(&pool).await;
    apply_migrations(&pool).await.unwrap();
    latest_version(&pool).await;
    assert_eq!(historical_runs(&pool).await, before);
    let rows: Vec<(String, Value)> = query_as(
        "SELECT run_trigger, connector_tools_json FROM cloud_agent_fallback_runs ORDER BY run_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(!rows.is_empty());
    for (trigger, tools) in rows {
        assert_eq!(trigger, "background", "existing runs never gain act tools");
        assert_eq!(tools, serde_json::json!([]));
    }
    for invalid in [
        "UPDATE cloud_agent_fallback_runs SET run_trigger='scheduled'",
        "UPDATE cloud_agent_fallback_runs SET connector_tools_json='{}'::jsonb",
    ] {
        assert!(
            sqlx_core::raw_sql::raw_sql(invalid)
                .execute(&pool)
                .await
                .is_err(),
            "{invalid}"
        );
    }
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_115_labels_existing_runs_as_shared() {
    let pool = fixture(115).await;
    seed_runs(&pool).await;
    let before = historical_runs(&pool).await;
    apply_migrations(&pool).await.unwrap();
    latest_version(&pool).await;
    assert_eq!(historical_runs(&pool).await, before);
    let rows: Vec<(String,)> =
        query_as("SELECT connector_audience FROM cloud_agent_fallback_runs ORDER BY run_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(!rows.is_empty());
    for (audience,) in rows {
        assert_eq!(
            audience, "shared",
            "existing runs never gain connector tools"
        );
    }
    assert!(sqlx_core::raw_sql::raw_sql(
        "UPDATE cloud_agent_fallback_runs SET connector_audience='everyone'"
    )
    .execute(&pool)
    .await
    .is_err());
}

/// Historical runs for fixtures at 80 and later, where `seed_history`'s
/// direct conversation no longer satisfies the direct session identity rule.
/// Runs carry no foreign key to the conversation, so none is needed here.
async fn seed_runs(pool: &PgPool) {
    for (id, created) in [
        ("old-run", "2026-01-01T00:00:00Z"),
        ("new-run", "2026-01-02T00:00:00Z"),
    ] {
        query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,response_message_id,created_at,updated_at) VALUES($1,$1,$1,'old-direct-fixture','fixture-owner','fixture-peer','completed','Historical request',$1,$2,$2)")
            .bind(id)
            .bind(created)
            .execute(pool)
            .await
            .unwrap();
    }
}
