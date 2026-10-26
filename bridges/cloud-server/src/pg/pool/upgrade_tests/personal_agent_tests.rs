use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_155_adds_personal_agents() {
    let pool = fixture(155).await;
    execute(&pool, "INSERT INTO cloud_agent_definitions(agent_id,owner_account_id,name,role,system_prompt,model_routing_json,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at,proactive_json) VALUES('cloud_agent_fixture','fixture-owner','Scout','Helper','Help.','{}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','generated','thumbs','cloud_agent_fixture','fixture',1,'2026-01-01T00:00:00Z','{\"enabled\":true}')").await;
    execute(&pool, "INSERT INTO cloud_connectors(connector_id,account_id,provider,status) VALUES('conn_mail','fixture-owner','gmail','connected')").await;
    execute(&pool, "INSERT INTO cloud_connector_events(event_id,connector_id,provider,kind,occurred_at,expires_at) VALUES('evt_old','conn_mail','gmail','message.received',now(),now() + interval '1 day')").await;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let (proactive, settings, events): (Value, i64, i64) = query_as(
        "SELECT (SELECT proactive_json FROM cloud_agent_definitions WHERE agent_id = 'cloud_agent_fixture'), \
                (SELECT count(*) FROM cloud_personal_agent_settings), \
                (SELECT count(*) FROM cloud_connector_events)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        proactive,
        json!({"enabled": true}),
        "the group setting stays"
    );
    assert_eq!(
        (settings, events),
        (0, 1),
        "every agent starts off; events stay"
    );
    execute(&pool, "INSERT INTO cloud_personal_agent_settings(agent_id,owner_account_id,proactive) VALUES('cloud-agent:fixture-owner','fixture-owner',TRUE),('cloud_agent_fixture','fixture-owner',FALSE)").await;
    let orphan = sqlx_core::raw_sql::raw_sql(
        "INSERT INTO cloud_personal_agent_settings(agent_id,owner_account_id) VALUES('x','no-such-account')",
    )
    .execute(&pool)
    .await;
    assert!(orphan.is_err(), "the setting belongs to an account");
    execute(&pool, "INSERT INTO cloud_chat_conversations(conversation_id,kind,created_by_account_id,client_operation_id,creation_fingerprint,legacy_session_id) VALUES('00000000-0000-4000-8000-000000000156','ai','fixture-owner','00000000-0000-4000-8000-000000000003','fixture','session:self-agent:fixture-owner:personal:cloud-agent:fixture-owner')").await;
    execute(&pool, "INSERT INTO cloud_personal_agent_sessions(agent_id,owner_account_id,conversation_id) VALUES('cloud-agent:fixture-owner','fixture-owner','00000000-0000-4000-8000-000000000156')").await;
    let shared = sqlx_core::raw_sql::raw_sql(
        "INSERT INTO cloud_personal_agent_sessions(agent_id,owner_account_id,conversation_id) VALUES('cloud_agent_fixture','fixture-owner','00000000-0000-4000-8000-000000000156')",
    )
    .execute(&pool)
    .await;
    assert!(shared.is_err(), "one agent per personal session");
    execute(&pool, "INSERT INTO cloud_personal_agent_state(agent_id,owner_account_id,active_run_id) VALUES('cloud-agent:fixture-owner','fixture-owner','personal_agent_eval_a')").await;
    let twice = sqlx_core::raw_sql::raw_sql(
        "INSERT INTO cloud_personal_agent_state(agent_id,owner_account_id,active_run_id) VALUES('cloud_agent_fixture','fixture-owner','personal_agent_eval_a')",
    )
    .execute(&pool)
    .await;
    assert!(twice.is_err(), "a run is active for one agent");
    execute(&pool, "INSERT INTO cloud_personal_agent_messages(run_id,agent_id,owner_account_id,message_id,text,event_ids) VALUES('personal_agent_eval_a','cloud-agent:fixture-owner','fixture-owner','00000000-0000-4000-8000-000000000157','Sam wrote.',ARRAY['evt_old'])").await;
    let (cursor_now, index): (bool, Option<String>) = query_as(
        "SELECT (SELECT cursor_received_at > now() - interval '1 minute' FROM cloud_personal_agent_state LIMIT 1), \
                to_regclass('public.idx_cloud_connector_events_connector_received')::text",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(cursor_now, "a new state row starts at now");
    assert!(index.is_some(), "events are read by received_at");
}
