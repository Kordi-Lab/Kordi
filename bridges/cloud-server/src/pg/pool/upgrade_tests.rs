use super::*;
use crate::chat_sync::{
    models::{ConversationKind, CreateConversationRequest, SendMessageRequest},
    store,
};
use serde_json::json;
use uuid::Uuid;

#[tokio::test]
async fn main_upgrade_preserves_existing_chat_digest_and_calendar() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        return;
    };
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .unwrap();
    let (existing,): (Option<String>,) = query_as("SELECT to_regclass('cloud_accounts')::text")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        existing.is_none(),
        "upgrade test requires a new isolated fixture database"
    );
    query("CREATE TABLE cloud_schema_versions(version BIGINT PRIMARY KEY,description TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())")
        .execute(&pool).await.unwrap();
    for migration in EMBEDDED_MIGRATIONS
        .iter()
        .filter(|migration| migration.version < 76)
    {
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
    sqlx_core::raw_sql::raw_sql(include_str!("../../../migrations/0076_rolling_digest.sql"))
        .execute(&pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_schema_versions(version,description) VALUES(76,'rolling digest and account calendar')")
        .execute(&pool).await.unwrap();
    let owner = "upgrade-fixture-owner";
    query("INSERT INTO cloud_accounts(account_id,display_name,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at) VALUES($1,'Owner','2026-09-06T00:00:00Z','2026-09-06T00:00:00Z','generated','lorelei',$1,'fixture',1,'2026-09-06T00:00:00Z')")
        .bind(owner).execute(&pool).await.unwrap();
    query("INSERT INTO cloud_account_digests(account_id,snapshot_json) VALUES($1,$2)")
        .bind(owner)
        .bind(json!({"fixture":"digest-preserved"}))
        .execute(&pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_calendar_events(account_id,event_id,payload) VALUES($1,'event',$2)")
        .bind(owner)
        .bind(json!({"fixture":"calendar-preserved"}))
        .execute(&pool)
        .await
        .unwrap();
    let conversation = store::create_conversation(
        &pool,
        owner,
        CreateConversationRequest {
            client_operation_id: Uuid::new_v4(),
            kind: ConversationKind::Ai,
            shared_title: None,
            client_session_id: "session:self-agent:upgrade-fixture".into(),
            member_account_ids: vec![],
        },
    )
    .await
    .unwrap()
    .value;
    let message = store::send_message(
        &pool,
        owner,
        conversation.id,
        SendMessageRequest {
            client_message_id: Uuid::new_v4(),
            content: json!({"schema":1,"blocks":[{"type":"text","text":"CHAT_PRESERVED"}]}),
            kind: "text".into(),
            attachment_ids: vec![],
            reply_to_message_id: None,
        },
    )
    .await
    .unwrap()
    .value;
    apply_migrations(&pool).await.unwrap();
    apply_migrations(&pool).await.unwrap();
    let (version,): (i64,) = query_as("SELECT max(version) FROM cloud_schema_versions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(version, 87);
    let (body,): (String,) = query_as(
        "SELECT content #>> '{blocks,0,text}' FROM cloud_chat_messages WHERE message_id=$1",
    )
    .bind(message.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(body, "CHAT_PRESERVED");
    let (digest, calendar): (serde_json::Value, serde_json::Value) = query_as("SELECT d.snapshot_json,c.payload FROM cloud_account_digests d JOIN cloud_calendar_events c USING(account_id) WHERE d.account_id=$1")
        .bind(owner).fetch_one(&pool).await.unwrap();
    assert_eq!(digest, json!({"fixture":"digest-preserved"}));
    assert_eq!(calendar, json!({"fixture":"calendar-preserved"}));
    let (description,): (String,) =
        query_as("SELECT description FROM cloud_schema_versions WHERE version=76")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(description, "rolling digest and account calendar");
}
