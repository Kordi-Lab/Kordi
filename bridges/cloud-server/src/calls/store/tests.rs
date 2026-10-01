use super::{
    active, active_for_account, end, join, preferred_account_display_name, start, CallStoreError,
};
use crate::calls::models::{CallKind, CallState, StartCallRequest};
use crate::chat_sync::models::{ConversationKind, CreateConversationRequest};
use crate::chat_sync::store::create_conversation;
use sqlx_core::query::query;
use uuid::Uuid;

#[test]
fn call_display_name_prefers_a_non_empty_profile_name() {
    assert_eq!(
        preferred_account_display_name(Some("Alex".to_string()), 123_456_789),
        "Alex"
    );
}

#[test]
fn call_display_name_formats_the_numeric_public_account_number() {
    assert_eq!(
        preferred_account_display_name(Some("  ".to_string()), 123_456_789),
        "123456789"
    );
}

async fn test_pool() -> Option<sqlx_postgres::PgPool> {
    let database_url = std::env::var("DATABASE_URL").ok()?;
    Some(crate::pg::init_pool(&database_url).await.unwrap())
}

async fn account(pool: &sqlx_postgres::PgPool, account_id: &str) {
    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, created_at, updated_at, avatar_source, \
          avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, $1, $1 || '@example.test', $2, $2, 'generated', 'lorelei', $1, 'test', 1, $2)",
    )
    .bind(account_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await
    .unwrap();
}

async fn connect(pool: &sqlx_postgres::PgPool, left: &str, right: &str) {
    query(
        "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) \
         VALUES ($1, $2, $3), ($2, $1, $3)",
    )
    .bind(left)
    .bind(right)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn concurrent_end_and_join_leave_a_terminal_call() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let suffix = Uuid::new_v4().simple().to_string();
    let caller = format!("acct_call_caller_{suffix}");
    let callee = format!("acct_call_callee_{suffix}");
    account(&pool, &caller).await;
    account(&pool, &callee).await;
    connect(&pool, &caller, &callee).await;
    let mut direct_members = [caller.as_str(), callee.as_str()];
    direct_members.sort_unstable();
    let conversation = create_conversation(
        &pool,
        &caller,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Direct,
            shared_title: None,
            client_session_id: format!(
                "session:direct-person:{}:{}",
                direct_members[0], direct_members[1]
            ),
            member_account_ids: vec![callee.clone()],
        },
    )
    .await
    .unwrap()
    .value;
    let started = start(
        &pool,
        &caller,
        conversation.id,
        StartCallRequest {
            client_operation_id: Uuid::now_v7(),
            kind: CallKind::Video,
        },
    )
    .await
    .unwrap();

    let (ended, joined) = tokio::join!(
        end(&pool, &caller, started.call.id),
        join(&pool, &callee, started.call.id),
    );
    let ended = ended.unwrap();
    assert_eq!(ended.state, CallState::Ended);
    if let Ok(joined) = joined {
        assert!(joined.call.revision < ended.revision);
    }
    assert!(active(&pool, &caller, conversation.id)
        .await
        .unwrap()
        .is_none());
    assert!(active(&pool, &callee, conversation.id)
        .await
        .unwrap()
        .is_none());
    assert!(active_for_account(&pool, &caller).await.unwrap().is_empty());
    assert!(active_for_account(&pool, &callee).await.unwrap().is_empty());

    let repeated = end(&pool, &caller, started.call.id).await.unwrap();
    assert_eq!(repeated.state, CallState::Ended);
    assert_eq!(repeated.revision, ended.revision);
}

#[tokio::test]
async fn direct_calls_need_the_two_people_to_be_contacts() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let suffix = Uuid::new_v4().simple().to_string();
    let caller = format!("acct_call_consent_a_{suffix}");
    let callee = format!("acct_call_consent_b_{suffix}");
    account(&pool, &caller).await;
    account(&pool, &callee).await;
    connect(&pool, &caller, &callee).await;
    let mut members = [caller.as_str(), callee.as_str()];
    members.sort_unstable();
    let conversation = create_conversation(
        &pool,
        &caller,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Direct,
            shared_title: None,
            client_session_id: format!("session:direct-person:{}:{}", members[0], members[1]),
            member_account_ids: vec![callee.clone()],
        },
    )
    .await
    .unwrap()
    .value;
    let request = || StartCallRequest {
        client_operation_id: Uuid::now_v7(),
        kind: CallKind::Voice,
    };

    // A single remaining row (one side removed the other) grants nothing.
    query("DELETE FROM cloud_contacts WHERE account_id = $1 AND peer_account_id = $2")
        .bind(&callee)
        .bind(&caller)
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        start(&pool, &caller, conversation.id, request()).await,
        Err(CallStoreError::Forbidden)
    ));
    assert!(matches!(
        start(&pool, &callee, conversation.id, request()).await,
        Err(CallStoreError::Forbidden)
    ));

    // Mutual rows with a block in either direction still refuse the call.
    query(
        "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) VALUES ($1, $2, $3)",
    )
    .bind(&callee)
    .bind(&caller)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_account_blocks (blocker_account_id, blocked_account_id) VALUES ($1, $2)",
    )
    .bind(&callee)
    .bind(&caller)
    .execute(&pool)
    .await
    .unwrap();
    assert!(matches!(
        start(&pool, &caller, conversation.id, request()).await,
        Err(CallStoreError::Forbidden)
    ));

    query("DELETE FROM cloud_account_blocks WHERE blocker_account_id = $1")
        .bind(&callee)
        .execute(&pool)
        .await
        .unwrap();
    let started = start(&pool, &caller, conversation.id, request())
        .await
        .unwrap();
    assert!(started.inserted);
    end(&pool, &caller, started.call.id).await.unwrap();
}
