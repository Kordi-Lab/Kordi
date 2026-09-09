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

async fn seed_stale_group(
    pool: &sqlx_postgres::PgPool,
    account_id: &str,
    session_id: Option<&str>,
    space_id: Option<&str>,
    membership: &str,
) -> uuid::Uuid {
    let id = uuid::Uuid::now_v7();
    query(
        "INSERT INTO cloud_chat_conversations \
         (conversation_id, kind, created_by_account_id, client_operation_id, \
          creation_fingerprint, legacy_session_id, group_space_id) \
         VALUES ($1, 'group', $2, $1, 'stale-group-test', $3, $4)",
    )
    .bind(id)
    .bind(account_id)
    .bind(session_id)
    .bind(space_id)
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_chat_conversation_members \
         (conversation_id, account_id, membership_state, pinned_at, muted_until, marked_unread_at) \
         VALUES ($1, $2, $3, NOW(), 'infinity'::timestamptz, NOW())",
    )
    .bind(id)
    .bind(account_id)
    .bind(membership)
    .execute(pool)
    .await
    .unwrap();
    id
}

#[tokio::test]
async fn group_archive_includes_historical_members_without_changing_access() {
    let Some(pool) = try_pool().await else { return };
    let router = fast_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let (token, account_id) = signup_account(&router, "stale-group-owner").await;
    let (other_token, other_id) = signup_account(&router, "stale-group-other").await;
    let space_id = format!("space:{}", uuid::Uuid::now_v7());
    let path = format!("/v1/cloud/group-spaces/{space_id}/hidden");
    let mut session_ids = Vec::new();
    for membership in ["active", "left", "removed"] {
        let session_id = format!("session:group:{}", uuid::Uuid::now_v7());
        seed_stale_group(
            &pool,
            &account_id,
            Some(&session_id),
            Some(&space_id),
            membership,
        )
        .await;
        session_ids.push(session_id);
    }
    // The same space may contain channels this account has never joined.
    let other_session = format!("session:group:{}", uuid::Uuid::now_v7());
    seed_stale_group(
        &pool,
        &other_id,
        Some(&other_session),
        Some(&space_id),
        "active",
    )
    .await;
    for _ in 0..2 {
        let response = router
            .clone()
            .oneshot(put_with_token(&path, &token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }
    let visibility = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/sessions/visibility", &token))
            .await
            .unwrap(),
    )
    .await;
    let hidden = visibility["hiddenSessionIds"].as_array().unwrap();
    assert_eq!(hidden.len(), session_ids.len());
    for session_id in &session_ids {
        assert!(hidden.contains(&json!(session_id)));
    }
    let event_count: (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND event_type = 'session.hidden'",
    )
    .bind(&account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        event_count.0, 3,
        "archive retries must not duplicate sync events"
    );
    let pins: (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_chat_conversation_members \
         WHERE account_id = $1 AND pinned_at IS NOT NULL",
    )
    .bind(&account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(pins.0, 0);
    let other_visibility = read_json(
        router
            .clone()
            .oneshot(get_with_token(
                "/v1/cloud/sessions/visibility",
                &other_token,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(other_visibility["hiddenSessionIds"], json!([]));

    for session_id in &session_ids[1..] {
        let response = router
            .clone()
            .oneshot(put_with_token(
                &format!("/v1/cloud/sessions/{session_id}/muted"),
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    let restored = router
        .clone()
        .oneshot(delete_with_token(&path, &token))
        .await
        .unwrap();
    assert_eq!(restored.status(), StatusCode::NO_CONTENT);
    let historical: (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_chat_conversation_members \
         WHERE account_id = $1 AND membership_state IN ('left', 'removed')",
    )
    .bind(&account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        historical.0, 2,
        "restoring visibility must not rejoin the group"
    );
}

#[tokio::test]
async fn groups_without_catalog_metadata_can_be_archived_by_session_identity() {
    let Some(pool) = try_pool().await else { return };
    let router = fast_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let (token, account_id) = signup_account(&router, "legacy-group-owner").await;
    let (other_token, _) = signup_account(&router, "legacy-group-outsider").await;
    for membership in ["active", "left", "removed"] {
        for prefix in ["session:group:", "group:group:"] {
            let session_id = format!("{prefix}{}", uuid::Uuid::now_v7());
            seed_stale_group(&pool, &account_id, Some(&session_id), None, membership).await;
            let space_id = session_id.trim_start_matches("group:");
            let path = format!("/v1/cloud/group-spaces/{space_id}/hidden");
            let denied = router
                .clone()
                .oneshot(put_with_token(&path, &other_token))
                .await
                .unwrap();
            assert_eq!(denied.status(), StatusCode::FORBIDDEN);
            let archived = router
                .clone()
                .oneshot(put_with_token(&path, &token))
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
            assert!(visibility["hiddenSessionIds"]
                .as_array()
                .unwrap()
                .contains(&json!(session_id)));
            let restored = router
                .clone()
                .oneshot(delete_with_token(&path, &token))
                .await
                .unwrap();
            assert_eq!(restored.status(), StatusCode::NO_CONTENT);
        }
    }
    let id = seed_stale_group(&pool, &account_id, None, None, "removed").await;
    let archived = router
        .clone()
        .oneshot(put_with_token(
            &format!("/v1/cloud/group-spaces/{id}/hidden"),
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(archived.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn historical_members_can_archive_restore_and_delete_their_own_sessions() {
    let Some(pool) = try_pool().await else { return };
    let router = fast_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let (token, account_id) = signup_account(&router, "historical-session-owner").await;
    let (other_token, _) = signup_account(&router, "historical-session-outsider").await;
    for membership in ["left", "removed"] {
        let session_id = format!("session:group:{}", uuid::Uuid::now_v7());
        let id = seed_stale_group(&pool, &account_id, Some(&session_id), None, membership).await;
        let path = format!("/v1/cloud/sessions/{session_id}");
        for request in [
            put_with_token(&format!("{path}/hidden"), &other_token),
            delete_with_token(&format!("{path}/hidden"), &other_token),
            delete_with_token(&path, &other_token),
        ] {
            let response = router.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
        for request in [
            put_with_token(&format!("{path}/hidden"), &token),
            delete_with_token(&format!("{path}/hidden"), &token),
            delete_with_token(&path, &token),
        ] {
            let response = router.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
        }
        let visibility = read_json(
            router
                .clone()
                .oneshot(get_with_token("/v1/cloud/sessions/visibility", &token))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(visibility["hiddenSessionIds"], json!([]));
        assert!(visibility["deletedSessionIds"]
            .as_array()
            .unwrap()
            .contains(&json!(session_id)));
        let preferences: (String, bool, bool, bool) = query_as(
            "SELECT membership_state, pinned_at IS NOT NULL, muted_until IS NOT NULL, \
                    marked_unread_at IS NOT NULL FROM cloud_chat_conversation_members \
             WHERE conversation_id = $1 AND account_id = $2",
        )
        .bind(id)
        .bind(&account_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(preferences, (membership.to_string(), false, false, false));
    }
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
