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

#[tokio::test]
async fn group_message_edit_fanout_reaches_every_recipient() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "mutation-group-owner").await;
    let mut members = Vec::new();
    for index in 0..7 {
        let member = account(&pool, &format!("mutation-group-member-{index}")).await;
        connect_accounts(&pool, &owner, &member).await;
        members.push(member);
    }
    let conversation = store::create_conversation(
        &pool,
        &owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Group,
            shared_title: Some("Mutation group".to_string()),
            client_session_id: format!("session:group:mutation:{}", Uuid::now_v7()),
            member_account_ids: members,
        },
    )
    .await
    .expect("create mutation group")
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
    .expect("send group mutation target")
    .value;

    store::edit_message(
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
    .expect("edit group message");

    let events: Vec<(String, serde_json::Value)> = query_as(
        "SELECT account_id, payload FROM cloud_chat_user_sync_events \
         WHERE event_type = 'message.updated' AND entity_id = $1 \
         ORDER BY account_id ASC",
    )
    .bind(message.id)
    .fetch_all(&pool)
    .await
    .expect("load group edit fanout");
    assert_eq!(events.len(), 8);
    assert_eq!(
        events
            .iter()
            .map(|(account_id, _)| account_id)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        8,
    );
    for (account_id, payload) in events {
        assert_eq!(payload["message"]["version"], 2);
        assert_eq!(
            payload["conversation"]["preferences"]["account_id"],
            account_id
        );
    }
}
