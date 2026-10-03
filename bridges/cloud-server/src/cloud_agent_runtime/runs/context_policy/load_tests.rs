//! Reading a run's request body against a real database. Skipped when
//! `DATABASE_URL` is not set; every account and conversation is synthetic.

use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::{request_body, REQUEST_BODY_SQL};
use crate::chat_sync::models::SendMessageRequest;
use crate::plan_cards::tests::{seed_account, seed_conversation};

async fn send(pool: &sqlx_postgres::PgPool, sender: &str, chat: Uuid, text: &str) -> String {
    crate::chat_sync::store::send_message(
        pool,
        sender,
        chat,
        SendMessageRequest {
            client_message_id: Uuid::new_v4(),
            kind: "text".to_string(),
            content: json!({"schema": 1, "blocks": [{"type": "text", "text": text}], "legacy_attachments": []}),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("send message");
    let (wire,): (String,) = query_as(
        "SELECT message_id::text FROM cloud_chat_messages
         WHERE conversation_id = $1 ORDER BY conversation_sequence DESC LIMIT 1",
    )
    .bind(chat)
    .fetch_one(pool)
    .await
    .unwrap();
    wire
}

#[tokio::test]
async fn the_request_body_comes_from_the_window_or_its_own_conversation() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        return;
    };
    let pool = crate::pg::init_pool(&url).await.unwrap();
    let member = format!("request-body-{}", Uuid::new_v4().simple());
    seed_account(&pool, &member).await;
    let (chat, other) = (Uuid::new_v4(), Uuid::new_v4());
    seed_conversation(&pool, chat, &member, &[&member]).await;
    seed_conversation(&pool, other, &member, &[&member]).await;
    let request = send(&pool, &member, chat, "Can you check Friday?").await;
    let elsewhere = send(&pool, &member, other, "Another group's message").await;

    // A request among the newest rows is read from the window, not again.
    let window = vec![(
        request.clone(),
        String::new(),
        member.clone(),
        "text".to_string(),
        "from the window".to_string(),
    )];
    assert_eq!(
        request_body(&pool, chat, &window, &request).await.unwrap(),
        "from the window"
    );
    // An older request is read by primary key within its conversation.
    assert_eq!(
        request_body(&pool, chat, &[], &request).await.unwrap(),
        "Can you check Friday?"
    );
    // Another conversation's message is never the request.
    assert_eq!(
        request_body(&pool, chat, &[], &elsewhere).await.unwrap(),
        ""
    );
    assert_eq!(
        request_body(&pool, chat, &[], "not-an-id").await.unwrap(),
        ""
    );

    // The lookup can use an index: with sequential scans priced out, the
    // plan still never scans every conversation's messages.
    let mut transaction = pool.begin().await.unwrap();
    query("SET LOCAL enable_seqscan = off")
        .execute(&mut *transaction)
        .await
        .unwrap();
    let plan: Vec<(String,)> = query_as(&format!("EXPLAIN {REQUEST_BODY_SQL}"))
        .bind(chat)
        .bind(Uuid::parse_str(&request).unwrap())
        .fetch_all(&mut *transaction)
        .await
        .unwrap();
    transaction.rollback().await.unwrap();
    let plan = plan
        .into_iter()
        .map(|(line,)| line)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!plan.contains("Seq Scan"), "{plan}");
    assert!(plan.contains("Index"), "{plan}");
}
