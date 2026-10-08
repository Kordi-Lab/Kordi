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
    execute(&pool, "INSERT INTO cloud_connector_pending_grants(completion_code,state_id,account_id,provider,grant_kind,ciphertext,nonce,key_version,expires_at) VALUES('cc','st','fixture-owner','github','read','\\x01','\\x02',1,now())").await;
    for invalid in [
        // A second live connector for the same account and provider.
        "INSERT INTO cloud_connectors(connector_id,account_id,provider,status) VALUES('conn_dup','fixture-owner','github','needs_reauth')",
        "INSERT INTO cloud_connectors(connector_id,account_id,provider,status) VALUES('conn_bad','fixture-owner','slack','paused')",
        "INSERT INTO cloud_connectors(connector_id,account_id,provider,status) VALUES('conn_rev','fixture-owner','slack','revoked')",
        "INSERT INTO cloud_connectors(connector_id,account_id,provider,status) VALUES('conn_x','missing-account','slack','connected')",
        "INSERT INTO cloud_connector_audit(audit_id,connector_id,account_id,tool,tool_group,outcome,summary) VALUES('aud2','conn_live','fixture-owner','t','write','completed','s')",
        "INSERT INTO cloud_connector_audit(audit_id,connector_id,account_id,tool,tool_group,outcome,summary) VALUES('aud3','conn_live','fixture-owner','t','act','skipped','s')",
        "INSERT INTO cloud_connector_oauth_states(state_id,account_id,provider,grant_kind,code_verifier,expires_at) VALUES('st2','fixture-owner','github','admin','v',now())",
        "INSERT INTO cloud_connector_pending_grants(completion_code,state_id,account_id,provider,grant_kind,ciphertext,nonce,key_version,expires_at) VALUES('cc2','st','fixture-owner','github','write','\\x01','\\x02',1,now())",
        "INSERT INTO cloud_connector_pending_grants(completion_code,state_id,account_id,provider,grant_kind,ciphertext,nonce,key_version,expires_at) VALUES('cc','st','fixture-owner','github','read','\\x01','\\x02',1,now())",
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
        "cloud_connector_pending_grants",
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
    // Runs only: `seed_history` builds a pre-0089 direct conversation whose
    // session id the 0089 trigger rejects at this schema version.
    for (run_id, status) in [("old-run", "completed"), ("live-run", "queued")] {
        query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at) VALUES($1,$1,$1,'session:direct-person:fixture-owner:fixture-peer','fixture-owner','fixture-owner',$2,'Historical request','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')")
            .bind(run_id)
            .bind(status)
            .execute(&pool)
            .await
            .unwrap();
    }
    let before = historical_runs(&pool).await;
    apply_migrations(&pool).await.unwrap();
    latest_version(&pool).await;
    assert_eq!(historical_runs(&pool).await, before);
    let rows: Vec<(String, Value, bool)> = query_as(
        "SELECT run_trigger, connector_tools_json, connector_tools_delivered_at IS NULL \
         FROM cloud_agent_fallback_runs ORDER BY run_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2);
    for (trigger, tools, undelivered) in rows {
        assert_eq!(trigger, "background", "existing runs never gain act tools");
        assert_eq!(tools, serde_json::json!([]));
        assert!(undelivered, "existing runs have no delivered tool set yet");
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
async fn upgrade_from_115_adds_provider_state_and_dedupes_events() {
    let pool = fixture(115).await;
    execute(&pool, "INSERT INTO cloud_connectors(connector_id,account_id,provider,status,read_scopes) VALUES('conn_live','fixture-owner','slack','connected','{channels:history}')").await;
    execute(&pool, "INSERT INTO cloud_connector_events(event_id,connector_id,provider,kind,external_id,occurred_at,expires_at) VALUES('evt_a','conn_live','slack','message','message:C1:1',now(),now()+interval '1 day'),('evt_b','conn_live','slack','message','message:C1:1',now(),now()+interval '1 day'),('evt_c','conn_live','slack','message',NULL,now(),now()+interval '1 day'),('evt_d','conn_live','slack','message',NULL,now(),now()+interval '1 day')").await;
    apply_migrations(&pool).await.unwrap();
    latest_version(&pool).await;

    type ProviderState = (Value, Option<String>, Option<String>, Option<String>);
    let state: ProviderState = query_as(
        "SELECT settings, provider_account_id, last_event_at::text, poll_cursor::text FROM cloud_connectors WHERE connector_id='conn_live'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        state,
        (json!({}), None, None, None),
        "existing connectors keep working with empty settings and no poll cursor"
    );
    let (pending_account,): (i64,) = query_as(
        "SELECT count(*) FROM information_schema.columns WHERE table_name='cloud_connector_pending_grants' AND column_name='provider_account_id'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        pending_account, 1,
        "pending grants carry the provider account"
    );
    let events: Vec<(String,)> =
        query_as("SELECT event_id FROM cloud_connector_events ORDER BY event_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        events,
        [
            ("evt_a".to_string(),),
            ("evt_c".to_string(),),
            ("evt_d".to_string(),)
        ],
        "duplicate external ids collapse to the first; events without one stay"
    );

    execute(&pool, "UPDATE cloud_connectors SET settings='{\"channels\":[\"C1\"]}', provider_account_id='T1:U1' WHERE connector_id='conn_live'").await;
    for invalid in [
        "UPDATE cloud_connectors SET settings='[]' WHERE connector_id='conn_live'",
        "INSERT INTO cloud_connector_events(event_id,connector_id,provider,kind,external_id,occurred_at,expires_at) VALUES('evt_e','conn_live','slack','message','message:C1:1',now(),now())",
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
