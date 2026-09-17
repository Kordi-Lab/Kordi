//! PiP joining a group against a real database: members' devices hear about
//! it, PiP starts reading at the newest message, and the member lists clients
//! send never remove PiP.

use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use crate::chat_sync::models::{AddConversationMembersRequest, SendMessageRequest};
use crate::plan_cards::tests::{seed_account, seed_conversation};

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn pip_joins_at_the_newest_message_and_client_member_lists_keep_it() {
    let url =
        std::env::var("KORDI_DIGEST_TEST_DATABASE_URL").expect("isolated test database required");
    let pool = sqlx_postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .expect("connect isolated database");
    crate::pg::pool::apply_migrations(&pool)
        .await
        .expect("migrate test database");
    let pip = super::test_service_account();
    query("INSERT INTO cloud_accounts(account_id,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at,avatar_url) VALUES($1,$2,$2,'generated','lorelei',$1,'test',1,$2,$3) ON CONFLICT (account_id) DO NOTHING")
        .bind(pip)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(crate::avatars::generated_avatar_marker("lorelei", pip, 1))
        .execute(&pool)
        .await
        .unwrap();
    let suffix = Uuid::new_v4().simple().to_string();
    let (jordan, maya) = (format!("jordan-{suffix}"), format!("maya-{suffix}"));
    for account in [&jordan, &maya] {
        seed_account(&pool, account).await;
    }
    let chat = Uuid::new_v4();
    seed_conversation(&pool, chat, &jordan, &[&jordan, &maya]).await;
    query("UPDATE cloud_chat_conversation_members SET role = 'owner' WHERE conversation_id = $1 AND account_id = $2")
        .bind(chat)
        .bind(&jordan)
        .execute(&pool)
        .await
        .unwrap();
    for text in ["Dinner Friday?", "Sure, 7pm works"] {
        let request = SendMessageRequest {
            client_message_id: Uuid::new_v4(),
            kind: "text".to_string(),
            content: json!({"schema": 1, "blocks": [{"type": "text", "text": text}], "legacy_attachments": []}),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        };
        crate::chat_sync::store::send_message(&pool, &jordan, chat, request)
            .await
            .expect("send message");
    }

    assert!(super::membership::join_conversation(&pool, pip, chat)
        .await
        .unwrap());
    assert!(
        !super::membership::join_conversation(&pool, pip, chat)
            .await
            .unwrap(),
        "joining again changes nothing"
    );
    let (seen, latest): (i64, i64) = query_as(
        "SELECT state.seen_sequence, conversation.latest_message_sequence
         FROM cloud_pip_conversation_state state
         JOIN cloud_chat_conversations conversation USING (conversation_id)
         WHERE conversation_id = $1",
    )
    .bind(chat)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(latest >= 2);
    assert_eq!(seen, latest, "history from before PiP joined is not new");

    let notified: Vec<(String,)> = query_as(
        "SELECT account_id FROM cloud_chat_user_sync_events
         WHERE conversation_id = $1 AND event_type = 'membership.updated'
         ORDER BY account_id",
    )
    .bind(chat)
    .fetch_all(&pool)
    .await
    .unwrap();
    let mut expected = vec![jordan.clone(), maya.clone()];
    expected.sort();
    assert_eq!(
        notified.into_iter().map(|row| row.0).collect::<Vec<_>>(),
        expected
    );

    // The owner's client sends the group as it shows it: without PiP.
    let conversation = crate::chat_sync::store::add_conversation_members(
        &pool,
        &jordan,
        chat,
        AddConversationMembersRequest {
            client_operation_id: Uuid::new_v4(),
            member_account_ids: vec![maya.clone()],
            replace: true,
        },
    )
    .await
    .expect("replace members");
    assert!(conversation
        .members
        .iter()
        .any(|member| member.account_id == pip && member.membership_state == "active"));
}
