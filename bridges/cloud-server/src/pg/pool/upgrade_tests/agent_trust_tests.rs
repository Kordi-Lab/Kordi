use super::*;

async fn add_conversation(pool: &PgPool, kind: &str, session_id: &str) -> Uuid {
    let conversation = Uuid::new_v4();
    query("INSERT INTO cloud_chat_conversations(conversation_id,kind,created_by_account_id,client_operation_id,creation_fingerprint,legacy_session_id,next_message_sequence,latest_message_sequence) VALUES($1,$2,'fixture-owner',$3,'agent-trust-fixture',$4,2,1)")
        .bind(conversation)
        .bind(kind)
        .bind(Uuid::new_v4())
        .bind(session_id)
        .execute(pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_chat_conversation_members(conversation_id,account_id) VALUES($1,'fixture-owner'),($1,'fixture-peer')")
        .bind(conversation)
        .execute(pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_chat_messages(message_id,conversation_id,conversation_sequence,sender_account_id,client_message_id,request_fingerprint,content) VALUES($1,$2,1,'fixture-peer',$3,'fixture',$4)")
        .bind(Uuid::new_v4())
        .bind(conversation)
        .bind(Uuid::new_v4())
        .bind(json!({"schema":1,"blocks":[{"type":"text","text":format!("{kind} history")}]}))
        .execute(pool)
        .await
        .unwrap();
    conversation
}

/// Rows the upgrade must leave exactly as they were.
async fn untouched_rows(pool: &PgPool) -> Value {
    let (snapshot,): (Value,) = query_as(
        "SELECT jsonb_build_object(
            'messages', (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.message_id) FROM cloud_chat_messages m),
            'members', (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.conversation_id, m.account_id) FROM cloud_chat_conversation_members m),
            'conversations', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.conversation_id) FROM cloud_chat_conversations c),
            'runs', (SELECT jsonb_agg(to_jsonb(r) - 'disclosed_provider' - 'disclosed_model' ORDER BY r.run_id) FROM cloud_agent_fallback_runs r),
            'sandboxes', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.sandbox_id) FROM cloud_agent_sandboxes s))",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    snapshot
}

/// The agent trust migration's version.
const AGENT_TRUST_VERSION: i64 = 112;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_to_agent_trust_backfills_group_ai_policies() {
    // Every migration before agent trust, however the versions below it are
    // numbered.
    let pool = fixture(AGENT_TRUST_VERSION - 1).await;
    let group = add_conversation(&pool, "group", "session:group:agent-trust-fixture").await;
    let second_group =
        add_conversation(&pool, "group", "session:group:agent-trust-fixture-2").await;
    let direct = add_conversation(
        &pool,
        "direct",
        "session:direct-person:fixture-owner:fixture-peer",
    )
    .await;
    let ai = add_conversation(&pool, "ai", "session:self-agent:fixture-owner:default").await;
    query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at) VALUES('fixture-run','fixture-run','fixture-request','session:group:agent-trust-fixture','fixture-owner','fixture-peer','completed','Historical request','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')")
        .execute(&pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_agent_sandboxes(sandbox_id,owner_account_id,requester_account_id,session_id,scope,status,workspace_key,storage_bytes_used,storage_bytes_quota,created_at,last_active_at,expires_at) VALUES('fixture-sandbox','fixture-owner',NULL,'session:group:agent-trust-fixture','shared_session','active','fixture-workspace',0,1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2027-01-01T00:00:00Z')")
        .execute(&pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_devices(device_id,account_id,device_public_key,created_at,last_seen_at) VALUES('fixture-mac','fixture-owner','fixture-key','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')")
        .execute(&pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_agent_desktop_capabilities(device_id,agent_id) VALUES('fixture-mac','cloud-agent:fixture-owner')")
        .execute(&pool)
        .await
        .unwrap();
    let before = untouched_rows(&pool).await;

    let (first, second) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    first.unwrap();
    second.unwrap();
    latest_version(&pool).await;

    let policies: Vec<(Uuid, String, bool)> = query_as(
        "SELECT conversation_id, history_scope, pip_enabled FROM cloud_chat_ai_policies ORDER BY conversation_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let mut expected = vec![
        (group, "mentions".to_string(), true),
        (second_group, "mentions".to_string(), true),
    ];
    expected.sort();
    assert_eq!(policies, expected, "only existing groups get a policy row");
    for conversation in [direct, ai] {
        assert!(!policies.iter().any(|row| row.0 == conversation));
    }
    let (contract,): (i16,) = query_as(
        "SELECT context_contract FROM cloud_agent_desktop_capabilities WHERE device_id='fixture-mac'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(contract, 1, "existing desktops are legacy executors");
    let (opt_outs, pending): (i64, i64) = query_as(
        "SELECT (SELECT COUNT(*) FROM cloud_chat_ai_opt_outs), (SELECT COUNT(*) FROM cloud_agent_pending_actions)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((opt_outs, pending), (0, 0));
    assert_eq!(untouched_rows(&pool).await, before);

    // Re-running the released SQL is a no-op, even after a setting changed.
    query("UPDATE cloud_chat_ai_policies SET history_scope='recent', pip_enabled=false WHERE conversation_id=$1")
        .bind(group)
        .execute(&pool)
        .await
        .unwrap();
    let migration = EMBEDDED_MIGRATIONS
        .iter()
        .find(|migration| migration.version == AGENT_TRUST_VERSION)
        .unwrap();
    sqlx_core::raw_sql::raw_sql(migration.sql)
        .execute(&pool)
        .await
        .unwrap();
    let (scope, pip): (String, bool) = query_as(
        "SELECT history_scope, pip_enabled FROM cloud_chat_ai_policies WHERE conversation_id=$1",
    )
    .bind(group)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((scope.as_str(), pip), ("recent", false));
    assert_eq!(untouched_rows(&pool).await, before);
}
