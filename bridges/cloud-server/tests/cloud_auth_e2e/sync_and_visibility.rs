use super::*;

#[tokio::test]
async fn cloud_sync_returns_message_events_after_cursor() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("sync-msg-a");
    let peer_email = unique_email("sync-msg-b");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    let body = read_json(signup).await;
    let token = body["session"]["token"].as_str().unwrap().to_string();
    let account_id = body["account"]["accountId"].as_str().unwrap().to_string();

    let peer_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&peer_email, "correct horse"),
        ))
        .await
        .unwrap();
    let peer_body = read_json(peer_signup).await;
    let peer_token = peer_body["session"]["token"].as_str().unwrap().to_string();
    let peer_account_id = peer_body["account"]["accountId"]
        .as_str()
        .unwrap()
        .to_string();

    sqlx_core::query::query(
        "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) VALUES ($1, $2, $3), ($2, $1, $3)",
    )
    .bind(&account_id)
    .bind(&peer_account_id)
    .bind("2026-05-13T00:00:00Z")
    .execute(&pool)
    .await
    .unwrap();

    let send_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &token,
            json!({ "peerAccountId": peer_account_id, "body": "diff hello" }),
        ))
        .await
        .unwrap();
    assert_eq!(send_resp.status(), StatusCode::CREATED);
    let sent = read_json(send_resp).await;
    let message_id = sent["message"]["messageId"].as_str().unwrap();

    let sync_resp = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/sync?cursor=0", &token))
        .await
        .unwrap();
    assert_eq!(sync_resp.status(), StatusCode::OK);
    let sync = read_json(sync_resp).await;
    assert_eq!(sync["events"].as_array().unwrap().len(), 1);
    assert_eq!(sync["events"][0]["eventType"], "message.upsert");
    assert_eq!(sync["events"][0]["messageId"], message_id);
    assert_eq!(sync["events"][0]["peerAccountId"], peer_account_id);
    assert_eq!(
        sync["events"][0]["payload"]["message"]["body"],
        "diff hello"
    );
    assert!(sync["cursor"].as_str().unwrap().parse::<i64>().unwrap() > 0);

    let peer_sync_resp = router
        .oneshot(get_with_token("/v1/cloud/sync?cursor=0", &peer_token))
        .await
        .unwrap();
    assert_eq!(peer_sync_resp.status(), StatusCode::OK);
    let peer_sync = read_json(peer_sync_resp).await;
    assert_eq!(peer_sync["events"].as_array().unwrap().len(), 1);
    assert_eq!(peer_sync["events"][0]["eventType"], "message.upsert");
    assert_eq!(peer_sync["events"][0]["messageId"], message_id);
    assert_eq!(peer_sync["events"][0]["peerAccountId"], account_id);
}

#[tokio::test]
async fn cloud_session_visibility_hides_unhides_and_deletes_account_scoped_view() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("session-visibility-a");
    let peer_email = unique_email("session-visibility-b");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    let body = read_json(signup).await;
    let token = body["session"]["token"].as_str().unwrap().to_string();
    let account_id = body["account"]["accountId"].as_str().unwrap().to_string();

    let peer_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&peer_email, "correct horse"),
        ))
        .await
        .unwrap();
    let peer_body = read_json(peer_signup).await;
    let peer_token = peer_body["session"]["token"].as_str().unwrap().to_string();
    let peer_account_id = peer_body["account"]["accountId"]
        .as_str()
        .unwrap()
        .to_string();

    sqlx_core::query::query(
        "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) VALUES ($1, $2, $3), ($2, $1, $3)",
    )
    .bind(&account_id)
    .bind(&peer_account_id)
    .bind("2026-05-13T00:00:00Z")
    .execute(&pool)
    .await
    .unwrap();

    let source_session_id = format!("session:test-delete:{}", uuid::Uuid::new_v4().simple());
    let send_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &token,
            json!({ "peerAccountId": peer_account_id, "body": "hide then delete", "sessionId": source_session_id }),
        ))
        .await
        .unwrap();
    assert_eq!(send_resp.status(), StatusCode::CREATED);

    let encoded_session_id = source_session_id.replace(':', "%3A");
    let hide_resp = router
        .clone()
        .oneshot(put_with_token(
            &format!("/v1/cloud/sessions/{encoded_session_id}/hidden"),
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(hide_resp.status(), StatusCode::NO_CONTENT);

    let visibility_resp = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/sessions/visibility", &token))
        .await
        .unwrap();
    assert_eq!(visibility_resp.status(), StatusCode::OK);
    let visibility = read_json(visibility_resp).await;
    assert_eq!(visibility["hiddenSessionIds"], json!([source_session_id]));
    assert_eq!(visibility["deletedSessionIds"], json!([]));

    let unhide_resp = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/sessions/{encoded_session_id}/hidden"),
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(unhide_resp.status(), StatusCode::NO_CONTENT);
    let visibility_resp = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/sessions/visibility", &token))
        .await
        .unwrap();
    let visibility = read_json(visibility_resp).await;
    assert_eq!(visibility["hiddenSessionIds"], json!([]));

    let delete_resp = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/sessions/{encoded_session_id}"),
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(delete_resp.status(), StatusCode::NO_CONTENT);
    let visibility_resp = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/sessions/visibility", &token))
        .await
        .unwrap();
    let visibility = read_json(visibility_resp).await;
    assert_eq!(visibility["hiddenSessionIds"], json!([]));
    assert_eq!(visibility["deletedSessionIds"], json!([source_session_id]));

    let sync_resp = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/sync?cursor=0", &token))
        .await
        .unwrap();
    assert_eq!(sync_resp.status(), StatusCode::OK);
    let sync = read_json(sync_resp).await;
    assert!(sync["events"].as_array().unwrap().iter().any(|event| {
        event["eventType"] == "session.hidden" && event["payload"]["sessionId"] == source_session_id
    }));
    assert!(sync["events"].as_array().unwrap().iter().any(|event| {
        event["eventType"] == "session.unhidden"
            && event["payload"]["sessionId"] == source_session_id
    }));
    assert!(sync["events"].as_array().unwrap().iter().any(|event| {
        event["eventType"] == "session.deleted"
            && event["payload"]["sessionId"] == source_session_id
    }));

    let peer_messages_resp = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/messages?peerAccountId={account_id}"),
            &peer_token,
        ))
        .await
        .unwrap();
    assert_eq!(peer_messages_resp.status(), StatusCode::OK);
    let peer_messages = read_json(peer_messages_resp).await;
    assert_eq!(peer_messages["messages"].as_array().unwrap().len(), 1);
    assert_eq!(peer_messages["messages"][0]["body"], "hide then delete");

    let peer_update_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &peer_token,
            json!({ "peerAccountId": account_id, "body": "new update", "sessionId": source_session_id }),
        ))
        .await
        .unwrap();
    assert_eq!(peer_update_resp.status(), StatusCode::CREATED);

    let visibility_resp = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/sessions/visibility", &token))
        .await
        .unwrap();
    let visibility = read_json(visibility_resp).await;
    assert_eq!(visibility["deletedSessionIds"], json!([]));

    let sync_resp = router
        .oneshot(get_with_token("/v1/cloud/sync?cursor=0", &token))
        .await
        .unwrap();
    let sync = read_json(sync_resp).await;
    assert!(sync["events"].as_array().unwrap().iter().any(|event| {
        event["eventType"] == "message.upsert"
            && event["payload"]["message"]["body"] == "new update"
    }));
}

#[tokio::test]
async fn cloud_sync_paginates_and_advances_cursor() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("sync-page");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);

    let signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    let body = read_json(signup).await;
    let token = body["session"]["token"].as_str().unwrap().to_string();
    let account_id = body["account"]["accountId"].as_str().unwrap().to_string();

    for text in ["first diff", "second diff"] {
        let send_resp = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/messages",
                &token,
                json!({ "peerAccountId": account_id, "body": text }),
            ))
            .await
            .unwrap();
        assert_eq!(send_resp.status(), StatusCode::CREATED);
    }

    let page1_resp = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/sync?cursor=0&limit=1", &token))
        .await
        .unwrap();
    assert_eq!(page1_resp.status(), StatusCode::OK);
    let page1 = read_json(page1_resp).await;
    assert_eq!(page1["events"].as_array().unwrap().len(), 1);
    assert_eq!(page1["hasMore"], true);
    let cursor1 = page1["cursor"].as_str().unwrap();

    let page2_resp = router
        .oneshot(get_with_token(
            &format!("/v1/cloud/sync?cursor={cursor1}&limit=1"),
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(page2_resp.status(), StatusCode::OK);
    let page2 = read_json(page2_resp).await;
    assert_eq!(page2["events"].as_array().unwrap().len(), 1);
    assert_eq!(page2["hasMore"], false);
    assert!(
        page2["cursor"].as_str().unwrap().parse::<i64>().unwrap() > cursor1.parse::<i64>().unwrap()
    );
}
