//! Server-authored rewrites of a deleted message keep the tombstone.

use super::*;
use crate::chat_sync::models::{ConversationKind, CreateConversationRequest, SendMessageRequest};

async fn account(pool: &PgPool, label: &str) -> String {
    let account_id = format!("chat-{label}-{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_accounts(account_id, display_name, created_at, updated_at, \
         avatar_source, avatar_style, avatar_seed, avatar_renderer_version, avatar_version, \
         avatar_updated_at) \
         VALUES ($1, $2, $3, $3, 'generated', 'lorelei', $1, 'test', 1, $3)",
    )
    .bind(&account_id)
    .bind(label)
    .bind(now)
    .execute(pool)
    .await
    .unwrap();
    account_id
}

#[tokio::test]
async fn server_message_rewrites_return_the_tombstone_unchanged() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        return;
    };
    let pool = crate::pg::init_pool(&url).await.unwrap();
    let owner = account(&pool, "tombstone-owner").await;
    let peer = account(&pool, "tombstone-peer").await;
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_contacts(account_id, peer_account_id, created_at) \
         VALUES ($1, $2, $3), ($2, $1, $3)",
    )
    .bind(&owner)
    .bind(&peer)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();
    let mut members = [owner.as_str(), peer.as_str()];
    members.sort_unstable();
    let conversation = super::super::create_conversation(
        &pool,
        &owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Direct,
            shared_title: None,
            client_session_id: format!("session:direct-person:{}:{}", members[0], members[1]),
            member_account_ids: vec![peer.clone()],
        },
    )
    .await
    .unwrap()
    .value;
    let client_message_id = Uuid::now_v7();
    let sent = super::super::send_message(
        &pool,
        &owner,
        conversation.id,
        SendMessageRequest {
            client_message_id,
            kind: "call-started".to_string(),
            content: json!({ "schema": 1, "blocks": [{ "type": "text", "text": "Call started" }] }),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .unwrap()
    .value;
    super::super::delete_message(&pool, &owner, conversation.id, sent.id, true)
        .await
        .unwrap();
    let (head_before,): (i64,) =
        query_as("SELECT last_seq FROM cloud_chat_user_sync_heads WHERE account_id = $1")
            .bind(&peer)
            .fetch_one(&pool)
            .await
            .unwrap();
    let mut transaction = pool.begin().await.unwrap();
    let rewritten = super::super::replace_server_message_in_transaction(
        &mut transaction,
        &owner,
        client_message_id,
        "call-ended",
        json!({ "schema": 1, "blocks": [{ "type": "text", "text": "Call ended" }] }),
    )
    .await
    .unwrap()
    .expect("the deleted message is found");
    transaction.commit().await.unwrap();
    assert!(rewritten.deleted_at.is_some());
    assert_eq!(rewritten.kind, "call-started");
    assert_eq!(rewritten.content["blocks"], json!([]));
    let (head_after,): (i64,) =
        query_as("SELECT last_seq FROM cloud_chat_user_sync_heads WHERE account_id = $1")
            .bind(&peer)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(head_after, head_before, "no fanout for a tombstone");
}
