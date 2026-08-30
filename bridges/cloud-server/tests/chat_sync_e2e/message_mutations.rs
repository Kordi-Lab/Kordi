use super::*;

#[tokio::test]
async fn message_edits_and_both_deletion_scopes_converge() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "mutation-owner").await;
    let peer = account(&pool, "mutation-peer").await;
    connect_accounts(&pool, &owner, &peer).await;
    let conversation = store::create_conversation(
        &pool,
        &owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Direct,
            shared_title: None,
            client_session_id: format!("session:mutation:{}", Uuid::now_v7()),
            member_account_ids: vec![peer.clone()],
        },
    )
    .await
    .expect("create mutation conversation")
    .value;
    let message = store::send_message(
        &pool,
        &owner,
        conversation.id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".to_string(),
            content: content("before"),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("send mutation target")
    .value;

    assert!(matches!(
        store::edit_message(
            &pool,
            &peer,
            conversation.id,
            message.id,
            UpdateMessageRequest {
                expected_version: 1,
                text: "not mine".to_string(),
            },
        )
        .await,
        Err(StoreError::Forbidden)
    ));
    let edited = store::edit_message(
        &pool,
        &owner,
        conversation.id,
        message.id,
        UpdateMessageRequest {
            expected_version: 1,
            text: "after".to_string(),
        },
    )
    .await
    .expect("edit own message");
    assert_eq!(edited.version, 2);
    assert!(edited.edited_at.is_some());
    assert_eq!(edited.content["blocks"][0]["text"], "after");
    assert!(matches!(
        store::edit_message(
            &pool,
            &owner,
            conversation.id,
            message.id,
            UpdateMessageRequest {
                expected_version: 1,
                text: "stale".to_string(),
            },
        )
        .await,
        Err(StoreError::MessageVersionConflict(_))
    ));

    store::delete_message(&pool, &peer, conversation.id, message.id, false)
        .await
        .expect("delete for peer only");
    assert!(store::history(&pool, &peer, conversation.id, None, None)
        .await
        .expect("peer history")
        .messages
        .is_empty());
    assert_eq!(
        store::history(&pool, &owner, conversation.id, None, None)
            .await
            .expect("owner history")
            .messages
            .len(),
        1
    );

    store::delete_message(&pool, &owner, conversation.id, message.id, true)
        .await
        .expect("delete for everyone");
    for account_id in [&owner, &peer] {
        assert!(
            store::history(&pool, account_id, conversation.id, None, None)
                .await
                .expect("deleted history")
                .messages
                .is_empty()
        );
    }
    let tombstone: (serde_json::Value, bool) = query_as(
        "SELECT content, deleted_at IS NOT NULL FROM cloud_chat_messages WHERE message_id = $1",
    )
    .bind(message.id)
    .fetch_one(&pool)
    .await
    .expect("load deletion tombstone");
    assert_eq!(tombstone.0, json!({ "schema": 1, "blocks": [] }));
    assert!(tombstone.1);
}
