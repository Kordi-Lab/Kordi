use super::*;

pub(super) async fn create_v2_test_conversation(
    pool: &sqlx_postgres::PgPool,
    creator_account_id: &str,
    session_id: &str,
    kind: ConversationKind,
    member_account_ids: Vec<String>,
) -> uuid::Uuid {
    chat_store::create_conversation(
        pool,
        creator_account_id,
        CreateConversationRequest {
            client_operation_id: uuid::Uuid::now_v7(),
            kind,
            shared_title: None,
            client_session_id: session_id.to_string(),
            member_account_ids,
        },
    )
    .await
    .expect("create v2 test conversation")
    .value
    .id
}

pub(super) async fn insert_v2_test_message(
    pool: &sqlx_postgres::PgPool,
    sender_account_id: &str,
    conversation_id: uuid::Uuid,
    body: &str,
) -> String {
    chat_store::send_message(
        pool,
        sender_account_id,
        conversation_id,
        SendMessageRequest {
            client_message_id: uuid::Uuid::now_v7(),
            kind: "text".to_string(),
            content: json!({
                "schema": 1,
                "blocks": [{ "type": "text", "text": body }]
            }),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("insert v2 test message")
    .value
    .id
    .to_string()
}

pub(super) async fn v2_message_body(pool: &sqlx_postgres::PgPool, message_id: &str) -> String {
    let (body,): (String,) = sqlx_core::query_as::query_as(
        "SELECT content #>> '{blocks,0,text}' FROM cloud_chat_messages \
         WHERE message_id::text = $1",
    )
    .bind(message_id)
    .fetch_one(pool)
    .await
    .expect("load v2 message body");
    body
}
