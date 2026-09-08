use super::*;
use crate::chat_sync::{models::SendMessageRequest, store};
use crate::cloud_agent_runtime::runs::{claim_run, ClaimRunRequest};
use serde_json::{json, Value};
use uuid::Uuid;

mod title_tests;

async fn fixture(version: i64) -> PgPool {
    let url = std::env::var("KORDI_MIGRATION_TEST_DATABASE_URL")
        .expect("set a dedicated, empty migration fixture database");
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .unwrap();
    let (name, existing): (String, Option<String>) =
        query_as("SELECT current_database(),to_regclass('public.cloud_accounts')::text")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        name.starts_with("kordi_migration_test_") && existing.is_none(),
        "only a fresh migration fixture is allowed"
    );
    execute(&pool, "CREATE TABLE cloud_schema_versions(version BIGINT PRIMARY KEY,description TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())").await;
    for migration in EMBEDDED_MIGRATIONS.iter().filter(|m| m.version <= version) {
        let mut tx = pool.begin().await.unwrap();
        sqlx_core::raw_sql::raw_sql(migration.sql)
            .execute(&mut *tx)
            .await
            .unwrap();
        query("INSERT INTO cloud_schema_versions(version,description) VALUES($1,$2)")
            .bind(migration.version)
            .bind(migration.description)
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
    execute(&pool, "INSERT INTO cloud_accounts(account_id,display_name,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at) SELECT id,id,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','generated','lorelei',id,'fixture',1,'2026-01-01T00:00:00Z' FROM unnest(ARRAY['fixture-owner','fixture-peer']) id").await;
    pool
}

async fn execute(pool: &PgPool, sql: &str) {
    sqlx_core::raw_sql::raw_sql(sql)
        .execute(pool)
        .await
        .unwrap();
}

async fn seed_history(pool: &PgPool, status: &str) -> Uuid {
    let conversation = Uuid::new_v4();
    query("INSERT INTO cloud_chat_conversations(conversation_id,kind,created_by_account_id,client_operation_id,creation_fingerprint,legacy_session_id,next_message_sequence,latest_message_sequence) VALUES($1,'direct','fixture-owner',$2,'fixture','old-direct-fixture',2,1)")
        .bind(conversation).bind(Uuid::new_v4()).execute(pool).await.unwrap();
    query("INSERT INTO cloud_chat_conversation_members(conversation_id,account_id) VALUES($1,'fixture-owner'),($1,'fixture-peer')")
        .bind(conversation).execute(pool).await.unwrap();
    query("INSERT INTO cloud_chat_messages(message_id,conversation_id,conversation_sequence,sender_account_id,client_message_id,request_fingerprint,content) VALUES($1,$2,1,'fixture-owner',$3,'fixture',$4)")
        .bind(Uuid::new_v4()).bind(conversation).bind(Uuid::new_v4())
        .bind(json!({"schema":1,"blocks":[{"type":"text","text":"Historical message"}]})).execute(pool).await.unwrap();
    for (id, created) in [
        ("old-run", "2026-01-01T00:00:00Z"),
        ("new-run", "2026-01-02T00:00:00Z"),
    ] {
        query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,response_message_id,created_at,updated_at) VALUES($1,$1,'legacy-request','old-direct-fixture','fixture-owner','fixture-peer',$2,'Historical request',$1,$3,$3)")
            .bind(id).bind(status).bind(created).execute(pool).await.unwrap();
        query("INSERT INTO cloud_agent_fallback_run_events(event_id,run_id,event_type,payload_json,created_at) VALUES($1,$1,'history',$2,$3)")
            .bind(id).bind(json!({"history":"retained"})).bind(created).execute(pool).await.unwrap();
    }
    conversation
}

async fn latest_version(pool: &PgPool) {
    let (version,): (i64,) = query_as("SELECT max(version) FROM cloud_schema_versions")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(version, EMBEDDED_MIGRATIONS.last().unwrap().version);
}

async fn historical_runs(pool: &PgPool) -> Vec<(String, Value)> {
    query_as("SELECT run_id,to_jsonb(r)-ARRAY['execution_backend','execution_agent_id','legacy_duplicate','parent_run_id','subsession_id','subsession_write_scope','turn_identity'] FROM cloud_agent_fallback_runs r ORDER BY run_id")
        .fetch_all(pool).await.unwrap()
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_75_preserves_history_and_new_identity_guards() {
    let pool = fixture(75).await;
    let conversation = seed_history(&pool, "completed").await;
    let seed_conversation = Uuid::new_v4();
    query("INSERT INTO cloud_chat_conversations(conversation_id,kind,created_by_account_id,client_operation_id,creation_fingerprint,legacy_session_id) VALUES($1,'direct','fixture-owner',$2,'fixture-seed','session:seed:historical-fixture')")
        .bind(seed_conversation).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    query("INSERT INTO cloud_chat_messages(message_id,conversation_id,conversation_sequence,sender_account_id,client_message_id,request_fingerprint,content) VALUES($1,$2,1,'fixture-owner',$3,'fixture-seed',$4)")
        .bind(Uuid::new_v4()).bind(seed_conversation).bind(Uuid::new_v4()).bind(json!({"schema":1,"blocks":[{"type":"text","text":"Seed-prefixed historical message"}]})).execute(&pool).await.unwrap();
    let before = historical_runs(&pool).await;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let (seed_messages,): (i64,) =
        query_as("SELECT count(*) FROM cloud_chat_messages WHERE conversation_id=$1")
            .bind(seed_conversation)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        seed_messages, 1,
        "a legacy prefix must not delete real history"
    );
    assert_eq!(historical_runs(&pool).await, before);
    let (events,): (i64,) = query_as("SELECT count(*) FROM cloud_agent_fallback_run_events")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(events, 2);
    let rows: Vec<(String, bool)> =
        query_as("SELECT run_id,legacy_duplicate FROM cloud_agent_fallback_runs ORDER BY run_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        rows,
        vec![("new-run".into(), false), ("old-run".into(), true)]
    );
    let request = ClaimRunRequest {
        request_message_id: "legacy-request".into(),
        session_id: "old-direct-fixture".into(),
        owner_account_id: "fixture-owner".into(),
        requester_account_id: "fixture-peer".into(),
        prompt: "Retry".into(),
        runtime_route: None,
        idempotency_key: "another-device-retry".into(),
    };
    assert_eq!(claim_run(&pool, &request).await.unwrap().run_id, "new-run");
    assert_eq!(historical_runs(&pool).await, before);
    execute(&pool,"UPDATE cloud_chat_conversations SET shared_title='Renamed',kind=kind,legacy_session_id=legacy_session_id WHERE legacy_session_id='old-direct-fixture'").await;
    let sent = store::send_message(
        &pool,
        "fixture-peer",
        conversation,
        SendMessageRequest {
            client_message_id: Uuid::new_v4(),
            content: json!({"schema":1,"blocks":[{"type":"text","text":"New message"}]}),
            kind: "text".into(),
            attachment_ids: vec![],
            reply_to_message_id: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(sent.value.conversation_id, conversation);
    let (legacy, count): (String,i64) = query_as("SELECT legacy_session_id,(SELECT count(*) FROM cloud_chat_messages WHERE conversation_id=$1) FROM cloud_chat_conversations WHERE conversation_id=$1")
        .bind(conversation).fetch_one(&pool).await.unwrap();
    assert_eq!(legacy, "old-direct-fixture");
    assert_eq!(count, 2);
    let error=query("UPDATE cloud_chat_conversations SET legacy_session_id='another-invalid-id' WHERE conversation_id=$1").bind(conversation).execute(&pool).await.unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23514")
    );
    let error=query("INSERT INTO cloud_chat_conversations(conversation_id,kind,created_by_account_id,client_operation_id,creation_fingerprint,legacy_session_id) VALUES($1,'direct','fixture-owner',$2,'bad','invalid-new')")
        .bind(Uuid::new_v4()).bind(Uuid::new_v4()).execute(&pool).await.unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23514")
    );
    let error =
        query("UPDATE cloud_agent_fallback_runs SET status='queued' WHERE legacy_duplicate")
            .execute(&pool)
            .await
            .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23514")
    );
    let error=query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at) SELECT 'third-run','third-run',request_message_id,session_id,owner_account_id,requester_account_id,'queued',prompt,created_at,updated_at FROM cloud_agent_fallback_runs WHERE run_id='new-run'").execute(&pool).await.unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23505")
    );
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_digest_76_preserves_existing_report_and_calendar() {
    let pool = fixture(75).await;
    execute(
        &pool,
        include_str!("../../../migrations/0076_rolling_digest.sql"),
    )
    .await;
    execute(&pool,"INSERT INTO cloud_schema_versions(version,description) VALUES(76,'rolling digest and account calendar'); INSERT INTO cloud_account_digests(account_id,snapshot_json) VALUES('fixture-owner','{\"kept\":true}'); INSERT INTO cloud_calendar_events(account_id,event_id,payload) VALUES('fixture-owner','fixture-event','{\"kept\":true}')").await;
    apply_migrations(&pool).await.unwrap();
    apply_migrations(&pool).await.unwrap();
    latest_version(&pool).await;
    let (digest,calendar,description): (Value,Value,String) = query_as("SELECT d.snapshot_json,c.payload,v.description FROM cloud_account_digests d JOIN cloud_calendar_events c USING(account_id) CROSS JOIN cloud_schema_versions v WHERE v.version=76").fetch_one(&pool).await.unwrap();
    assert_eq!(digest, json!({"kept":true}));
    assert_eq!(calendar, digest);
    assert_eq!(description, "rolling digest and account calendar");
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_88_retains_old_and_new_upsert_compatibility() {
    let pool = fixture(88).await;
    // fixture applies the immutable released SQL, including the original
    // direct-identity constraint and full execution-ownership unique index.
    apply_migrations(&pool).await.unwrap();
    latest_version(&pool).await;
    execute(&pool,"INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at) VALUES('fixture-run','fixture-run','fixture-request','fixture-session','fixture-owner','fixture-owner','queued','Test','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").await;
    for predicate in ["", "WHERE NOT legacy_duplicate"] {
        let (id,): (String,) = query_as(&format!("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at) SELECT 'other-run','other-run',request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at FROM cloud_agent_fallback_runs WHERE run_id='fixture-run' ON CONFLICT(owner_account_id,execution_agent_id,request_message_id) {predicate} DO UPDATE SET request_message_id=EXCLUDED.request_message_id RETURNING run_id")).fetch_one(&pool).await.unwrap();
        assert_eq!(id, "fixture-run");
    }
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn multiple_live_executors_require_drain_without_losing_history() {
    let pool = fixture(75).await;
    seed_history(&pool, "running").await;
    let before = historical_runs(&pool).await;
    assert!(matches!(
        apply_migrations(&pool).await,
        Err(PgPoolError::Migrate(_))
    ));
    assert_eq!(historical_runs(&pool).await, before);
    let (version,): (i64,) = query_as("SELECT max(version) FROM cloud_schema_versions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(version, 80);
    execute(
        &pool,
        "UPDATE cloud_agent_fallback_runs SET status='completed' WHERE run_id='old-run'",
    )
    .await;
    apply_migrations(&pool).await.unwrap();
    latest_version(&pool).await;
    let (count,): (i64,) = query_as("SELECT count(*) FROM cloud_agent_fallback_runs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
    let active: Vec<(String, bool)> = query_as(
        "SELECT run_id,legacy_duplicate FROM cloud_agent_fallback_runs WHERE status='running'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(active, vec![("new-run".into(), false)]);
}
