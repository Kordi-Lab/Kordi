use super::*;

#[tokio::test]
async fn scheduled_direct_contact_completion_routes_back_to_originating_contact_session() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "scheduled-direct-owner", "Owner").await;
    let peer = signup(&router, "scheduled-direct-peer", "Peer").await;
    accept_contacts(&router, &peer, &owner).await;
    let session_id = format!(
        "session:direct-person:{}:{}",
        owner.account_id, peer.account_id
    );
    create_test_conversation(
        &pool,
        &owner.account_id,
        &session_id,
        ConversationKind::Direct,
        vec![peer.account_id.clone()],
    )
    .await;
    let run_id =
        insert_leased_scheduled_run(&pool, &owner, &owner, &session_id, "runner-direct").await;

    let complete = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/complete"),
            "runner-test-token",
            json!({ "runnerId": "runner-direct", "responseText": "Time to review the launch checklist." }),
        ))
        .await
        .unwrap();
    assert_eq!(complete.status(), StatusCode::OK);
    let response_message_id = read_json(complete).await["run"]["responseMessageId"]
        .as_str()
        .unwrap()
        .to_string();

    let message: (String, String, String) = sqlx_core::query_as::query_as(
        "SELECT message.sender_account_id, conversation.legacy_session_id, \
                message.content #>> '{blocks,0,text}' \
         FROM cloud_chat_messages message \
         JOIN cloud_chat_conversations conversation \
           ON conversation.conversation_id = message.conversation_id \
         WHERE message.message_id::text = $1",
    )
    .bind(&response_message_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(message.0, owner.account_id);
    assert_eq!(message.1, session_id);
    assert!(message.2.starts_with("kordi-cloud-agent-response:"));

    let event_rows: Vec<(String, String)> = sqlx_core::query_as::query_as(
        "SELECT account_id, event_type FROM cloud_chat_user_sync_events \
         WHERE entity_id::text = $1 AND event_type = 'message.created' ORDER BY account_id",
    )
    .bind(&response_message_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(event_rows.len(), 2);
    assert!(event_rows.contains(&(owner.account_id.clone(), "message.created".to_string())));
    assert!(event_rows.contains(&(peer.account_id.clone(), "message.created".to_string())));
}

#[tokio::test]
async fn scheduled_group_completion_routes_back_to_originating_group_session() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "scheduled-group-owner", "Owner").await;
    let peer = signup(&router, "scheduled-group-peer", "Peer").await;
    accept_contacts(&router, &peer, &owner).await;
    let session_id = format!("session:group:scheduled-{}", uuid::Uuid::new_v4().simple());
    let original_group_body = encode_test_cloud_group_envelope(json!({
        "kind": "group-message",
        "groupId": session_id,
        "groupSpaceId": session_id,
        "groupTitle": "Launch room",
        "createdByAccountId": peer.account_id,
        "actor": {
            "accountId": peer.account_id,
            "displayName": "Peer",
            "role": "admin"
        },
        "participants": [
            {
                "accountId": owner.account_id,
                "displayName": "Owner",
                "role": "person"
            },
            {
                "accountId": peer.account_id,
                "displayName": "Peer",
                "role": "admin"
            }
        ],
        "message": {
            "id": "msg_original_group_reminder_request",
            "senderAccountId": peer.account_id,
            "senderKind": "human",
            "text": "@OwnerKordi remind us about the launch checklist",
            "createdAtMs": 1
        }
    }));
    let conversation_id = create_test_conversation(
        &pool,
        &peer.account_id,
        &session_id,
        ConversationKind::Group,
        vec![owner.account_id.clone()],
    )
    .await;
    insert_test_message(
        &pool,
        &peer.account_id,
        conversation_id,
        &original_group_body,
    )
    .await;
    let run_id =
        insert_leased_scheduled_run(&pool, &owner, &owner, &session_id, "runner-group").await;

    let complete = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/complete"),
            "runner-test-token",
            json!({ "runnerId": "runner-group", "responseText": "Time to review the launch checklist." }),
        ))
        .await
        .unwrap();
    assert_eq!(complete.status(), StatusCode::OK);
    let response_message_id = read_json(complete).await["run"]["responseMessageId"]
        .as_str()
        .unwrap()
        .to_string();

    let rows: Vec<(String, String, String)> = sqlx_core::query_as::query_as(
        "SELECT message.message_id::text, message.sender_account_id, \
                message.content #>> '{blocks,0,text}' \
         FROM cloud_chat_messages message \
         WHERE message.conversation_id = $1 AND message.conversation_sequence > 1 \
         ORDER BY message.conversation_sequence ASC",
    )
    .bind(conversation_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, response_message_id);
    assert_eq!(rows[0].1, owner.account_id);

    let envelope = decode_test_cloud_group_envelope(&rows[0].2);
    assert_eq!(envelope["kind"], "group-message");
    assert_eq!(envelope["groupId"], session_id);
    assert_eq!(envelope["message"]["senderAccountId"], owner.account_id);
    assert_eq!(envelope["message"]["senderKind"], "agent");
    assert!(envelope["message"]["requestId"]
        .as_str()
        .unwrap()
        .starts_with("scheduled_run_"));
    assert_eq!(envelope["message"]["deliveryState"], "complete");
    assert_eq!(
        envelope["message"]["text"],
        "Time to review the launch checklist."
    );
}
