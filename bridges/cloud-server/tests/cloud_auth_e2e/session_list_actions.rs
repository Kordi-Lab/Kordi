use super::*;
use kordi_cloud_server::chat_sync::models::{ConversationKind, CreateConversationRequest};
use kordi_cloud_server::chat_sync::store;
use sqlx_core::{query::query, query_as::query_as};

fn put_with_token(uri: &str, token: &str) -> Request<Body> {
    Request::builder()
        .method("PUT")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn chat_list_preferences_are_account_scoped_and_archive_delete_clear_pin() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);
    let (token, account_id) = signup_account(&router, "session-list-actions").await;
    let session_id = format!("session:self-agent:{}", uuid::Uuid::now_v7());
    store::create_conversation(
        &pool,
        &account_id,
        CreateConversationRequest {
            client_operation_id: uuid::Uuid::now_v7(),
            kind: ConversationKind::Ai,
            shared_title: Some("List actions".to_string()),
            client_session_id: session_id.clone(),
            member_account_ids: Vec::new(),
        },
    )
    .await
    .expect("create AI conversation");
    let path = format!("/v1/cloud/sessions/{session_id}");
    let group_space_id = format!("group:space:{}", uuid::Uuid::now_v7());
    let group_pin_path = format!("/v1/cloud/group-spaces/{group_space_id}/pinned");

    for suffix in ["pinned", "muted", "unread"] {
        let response = router
            .clone()
            .oneshot(put_with_token(&format!("{path}/{suffix}"), &token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }
    let group_pinned = router
        .clone()
        .oneshot(put_with_token(&group_pin_path, &token))
        .await
        .unwrap();
    assert_eq!(group_pinned.status(), StatusCode::NO_CONTENT);
    let mutation_event_count: (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND event_type IN \
           ('session.pinned', 'session.muted', 'session.marked_unread', 'group_space.pinned')",
    )
    .bind(&account_id)
    .fetch_one(&pool)
    .await
    .expect("count initial list mutation events");
    assert_eq!(mutation_event_count.0, 4);
    for suffix in ["pinned", "muted", "unread"] {
        let retry = router
            .clone()
            .oneshot(put_with_token(&format!("{path}/{suffix}"), &token))
            .await
            .unwrap();
        assert_eq!(retry.status(), StatusCode::NO_CONTENT);
    }
    let group_pin_retry = router
        .clone()
        .oneshot(put_with_token(&group_pin_path, &token))
        .await
        .unwrap();
    assert_eq!(group_pin_retry.status(), StatusCode::NO_CONTENT);
    let retry_event_count: (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND event_type IN \
           ('session.pinned', 'session.muted', 'session.marked_unread', 'group_space.pinned')",
    )
    .bind(&account_id)
    .fetch_one(&pool)
    .await
    .expect("count retried list mutation events");
    assert_eq!(retry_event_count, mutation_event_count);
    let visibility = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/sessions/visibility", &token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(visibility["pinnedSessionIds"], json!([session_id.clone()]));
    assert_eq!(visibility["mutedSessionIds"], json!([session_id.clone()]));
    assert_eq!(visibility["unreadSessionIds"], json!([session_id.clone()]));
    assert_eq!(
        visibility["pinnedGroupSpaceIds"],
        json!([group_space_id.clone()])
    );

    let archived = router
        .clone()
        .oneshot(put_with_token(&format!("{path}/hidden"), &token))
        .await
        .unwrap();
    assert_eq!(archived.status(), StatusCode::NO_CONTENT);
    let visibility = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/sessions/visibility", &token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(visibility["hiddenSessionIds"], json!([session_id.clone()]));
    assert_eq!(visibility["pinnedSessionIds"], json!([]));
    assert_eq!(visibility["mutedSessionIds"], json!([session_id.clone()]));
    assert_eq!(visibility["unreadSessionIds"], json!([session_id.clone()]));

    let deleted = router
        .clone()
        .oneshot(delete_with_token(&path, &token))
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
    let visibility = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/sessions/visibility", &token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(visibility["deletedSessionIds"], json!([session_id]));
    assert_eq!(visibility["pinnedSessionIds"], json!([]));
    assert_eq!(visibility["mutedSessionIds"], json!([]));
    assert_eq!(visibility["unreadSessionIds"], json!([]));

    let group_unpinned = router
        .clone()
        .oneshot(delete_with_token(&group_pin_path, &token))
        .await
        .unwrap();
    assert_eq!(group_unpinned.status(), StatusCode::NO_CONTENT);
    let visibility = read_json(
        router
            .oneshot(get_with_token("/v1/cloud/sessions/visibility", &token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(visibility["pinnedGroupSpaceIds"], json!([]));
}

#[tokio::test]
async fn message_pin_updates_are_durable_and_idempotent() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);
    let (token, account_id) = signup_account(&router, "message-pin-actions").await;
    let session_id = format!("session:self-agent:{}", uuid::Uuid::now_v7());
    store::create_conversation(
        &pool,
        &account_id,
        CreateConversationRequest {
            client_operation_id: uuid::Uuid::now_v7(),
            kind: ConversationKind::Ai,
            shared_title: Some("Message pins".to_string()),
            client_session_id: session_id.clone(),
            member_account_ids: Vec::new(),
        },
    )
    .await
    .expect("create AI conversation");
    let path = format!("/v1/cloud/sessions/{session_id}/pin");
    let message_id = uuid::Uuid::now_v7().to_string();
    let pin = || json!({ "messageId": message_id, "scope": "private" });

    for _ in 0..2 {
        let response = router
            .clone()
            .oneshot(put_json_with_token(&path, &token, pin()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = read_json(response).await;
        assert_eq!(body["pin"]["effectiveMessageId"], message_id);
    }
    let pin_events: (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND event_type = 'session.pin.updated'",
    )
    .bind(&account_id)
    .fetch_one(&pool)
    .await
    .expect("count idempotent message pin events");
    assert_eq!(pin_events.0, 1);

    let response = router
        .clone()
        .oneshot(put_json_with_token(
            &path,
            &token,
            json!({ "messageId": null, "scope": "private" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    assert_eq!(body["pin"]["effectiveMessageId"], serde_json::Value::Null);
    let pin_events: (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND event_type = 'session.pin.updated'",
    )
    .bind(&account_id)
    .fetch_one(&pool)
    .await
    .expect("count message unpin event");
    assert_eq!(pin_events.0, 2);
}

#[tokio::test]
async fn chat_list_mutations_roll_back_when_sync_append_fails() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);
    let (token, account_id) = signup_account(&router, "session-list-atomicity").await;
    let session_id = format!("session:self-agent:{}", uuid::Uuid::now_v7());
    let conversation = store::create_conversation(
        &pool,
        &account_id,
        CreateConversationRequest {
            client_operation_id: uuid::Uuid::now_v7(),
            kind: ConversationKind::Ai,
            shared_title: Some("Atomic list actions".to_string()),
            client_session_id: session_id.clone(),
            member_account_ids: Vec::new(),
        },
    )
    .await
    .expect("create AI conversation")
    .value;
    query(
        "UPDATE cloud_chat_user_sync_heads SET last_seq = $2 \
         WHERE account_id = $1",
    )
    .bind(&account_id)
    .bind(i64::MAX)
    .execute(&pool)
    .await
    .expect("force sync append overflow");

    let path = format!("/v1/cloud/sessions/{session_id}");
    let failed_pin = router
        .clone()
        .oneshot(put_with_token(&format!("{path}/pinned"), &token))
        .await
        .unwrap();
    assert_eq!(failed_pin.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let pinned_at: (Option<chrono::DateTime<chrono::Utc>>,) = query_as(
        "SELECT pinned_at FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation.id)
    .bind(&account_id)
    .fetch_one(&pool)
    .await
    .expect("load rolled back session pin");
    assert_eq!(pinned_at.0, None);

    query(
        "UPDATE cloud_chat_conversation_members \
         SET pinned_at = NOW(), muted_until = 'infinity'::timestamptz, marked_unread_at = NOW() \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation.id)
    .bind(&account_id)
    .execute(&pool)
    .await
    .expect("seed list preferences");
    let failed_delete = router
        .clone()
        .oneshot(delete_with_token(&path, &token))
        .await
        .unwrap();
    assert_eq!(failed_delete.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let visibility_count: (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_account_session_visibility \
         WHERE account_id = $1 AND session_id = $2",
    )
    .bind(&account_id)
    .bind(&session_id)
    .fetch_one(&pool)
    .await
    .expect("count rolled back visibility rows");
    assert_eq!(visibility_count.0, 0);
    let preferences: (bool, bool, bool) = query_as(
        "SELECT pinned_at IS NOT NULL, muted_until IS NOT NULL, marked_unread_at IS NOT NULL \
         FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation.id)
    .bind(&account_id)
    .fetch_one(&pool)
    .await
    .expect("load rolled back list preferences");
    assert_eq!(preferences, (true, true, true));

    let group_space_id = format!("group:space:{}", uuid::Uuid::now_v7());
    let failed_group_pin = router
        .clone()
        .oneshot(put_with_token(
            &format!("/v1/cloud/group-spaces/{group_space_id}/pinned"),
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(failed_group_pin.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let group_pin_count: (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_account_group_space_preferences \
         WHERE account_id = $1 AND group_space_id = $2",
    )
    .bind(&account_id)
    .bind(&group_space_id)
    .fetch_one(&pool)
    .await
    .expect("count rolled back group pins");
    assert_eq!(group_pin_count.0, 0);

    let failed_message_pin = router
        .clone()
        .oneshot(put_json_with_token(
            &format!("{path}/pin"),
            &token,
            json!({ "messageId": uuid::Uuid::now_v7(), "scope": "private" }),
        ))
        .await
        .unwrap();
    assert_eq!(
        failed_message_pin.status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    let message_pin_count: (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_account_session_pins \
         WHERE account_id = $1 AND session_id = $2",
    )
    .bind(&account_id)
    .bind(&session_id)
    .fetch_one(&pool)
    .await
    .expect("count rolled back message pins");
    assert_eq!(message_pin_count.0, 0);
}
