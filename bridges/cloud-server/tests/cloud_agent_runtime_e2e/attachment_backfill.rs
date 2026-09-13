use super::*;

#[tokio::test]
async fn missing_private_history_images_are_backfilled_once_without_new_messages() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "image-backfill-owner", "Owner").await;
    let stranger = signup(&router, "image-backfill-stranger", "Stranger").await;
    let conversation = create_test_conversation(
        &pool,
        &owner.account_id,
        &format!("session:backfill:{}", uuid::Uuid::new_v4()),
        ConversationKind::Ai,
        vec![],
    )
    .await;
    let original = chat_store::send_message(&pool, &owner.account_id, conversation, SendMessageRequest {
        client_message_id: uuid::Uuid::new_v4(), kind: "canonical-history-user".into(),
        content: json!({"schema":1,"blocks":[{"type":"text","text":"Describe the picture"}],"canonical_history":{"localMessageId":"synthetic-local","originalCreatedAt":"2026-09-01T00:00:00Z"},"legacy_attachments":[]}),
        attachment_ids: vec![], reply_to_message_id: None,
    }).await.unwrap().value;
    let attachment = format!("att_{}", uuid::Uuid::new_v4().simple());
    sqlx_core::query::query("INSERT INTO cloud_attachments(attachment_id,owner_account_id,object_key,content_type,size_bytes,created_at,finalized_at) VALUES($1,$2,$1,'image/png',42,now()::text,now()::text)")
        .bind(&attachment).bind(&owner.account_id).execute(&pool).await.unwrap();
    let uri = format!(
        "/v2/chat/conversations/{conversation}/messages/{}/missing-images",
        original.id
    );
    let body = json!([{"attachmentId":attachment,"name":"synthetic.png"}]);
    let denied = router
        .clone()
        .oneshot(post_json_with_token(&uri, &stranger.token, body.clone()))
        .await
        .unwrap();
    assert!(!denied.status().is_success());
    let unavailable = router
        .clone()
        .oneshot(post_json_with_token(
            &uri,
            &owner.token,
            json!([{"attachmentId":"missing","name":"synthetic.png"}]),
        ))
        .await
        .unwrap();
    assert!(!unavailable.status().is_success());
    for mutation in ["version=2", "deleted_at=now()"] {
        sqlx_core::query::query(&format!(
            "UPDATE cloud_chat_messages SET {mutation} WHERE message_id=$1"
        ))
        .bind(original.id)
        .execute(&pool)
        .await
        .unwrap();
        let denied = router
            .clone()
            .oneshot(post_json_with_token(&uri, &owner.token, body.clone()))
            .await
            .unwrap();
        assert!(!denied.status().is_success());
        sqlx_core::query::query(
            "UPDATE cloud_chat_messages SET version=1,deleted_at=NULL WHERE message_id=$1",
        )
        .bind(original.id)
        .execute(&pool)
        .await
        .unwrap();
    }
    let response = router
        .clone()
        .oneshot(post_json_with_token(&uri, &owner.token, body.clone()))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let message = read_json(response).await["message"].clone();
    assert_eq!(message["id"], original.id.to_string());
    assert_eq!(
        message["conversation_sequence"],
        original.conversation_sequence
    );
    assert_eq!(message["content"]["blocks"], original.content["blocks"]);
    assert_eq!(message["attachment_ids"], json!([attachment]));
    assert_eq!(
        message["content"]["legacy_attachments"][0]["attachmentId"],
        attachment
    );
    assert_eq!(message["version"], 2);
    let repeated = router
        .clone()
        .oneshot(post_json_with_token(&uri, &owner.token, body))
        .await
        .unwrap();
    assert!(
        !repeated.status().is_success(),
        "backfill must never overwrite an attached or modified message"
    );
    let count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT count(*) FROM cloud_chat_messages WHERE conversation_id=$1",
    )
    .bind(conversation)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count.0, 1);
    let events:(i64,)=sqlx_core::query_as::query_as("SELECT count(*) FROM cloud_chat_user_sync_events WHERE entity_id=$1 AND event_type='message.updated'").bind(original.id).fetch_one(&pool).await.unwrap();
    assert_eq!(events.0, 1);
}
