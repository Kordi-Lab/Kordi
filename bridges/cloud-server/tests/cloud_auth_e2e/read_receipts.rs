use super::*;

#[tokio::test]
async fn cloud_sync_returns_read_receipt_events() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("sync-read-a");
    let peer_email = unique_email("sync-read-b");
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
            json!({ "peerAccountId": peer_account_id, "body": "read me" }),
        ))
        .await
        .unwrap();
    assert_eq!(send_resp.status(), StatusCode::CREATED);
    let sent = read_json(send_resp).await;
    let message_id = sent["message"]["messageId"].as_str().unwrap().to_string();

    let read_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages/read",
            &peer_token,
            json!({ "peerAccountId": account_id }),
        ))
        .await
        .unwrap();
    assert_eq!(read_resp.status(), StatusCode::NO_CONTENT);
    let retry_read_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages/read",
            &peer_token,
            json!({ "peerAccountId": account_id }),
        ))
        .await
        .unwrap();
    assert_eq!(retry_read_resp.status(), StatusCode::NO_CONTENT);

    let reader_list_resp = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/messages?peerAccountId={account_id}"),
            &peer_token,
        ))
        .await
        .unwrap();
    assert_eq!(reader_list_resp.status(), StatusCode::OK);
    let reader_list = read_json(reader_list_resp).await;
    assert!(reader_list["peerReadAt"].as_str().is_some());

    let sync_resp = router
        .oneshot(get_with_token("/v1/cloud/sync?cursor=0", &token))
        .await
        .unwrap();
    assert_eq!(sync_resp.status(), StatusCode::OK);
    let sync = read_json(sync_resp).await;
    let read_events = sync["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["eventType"] == "message.read")
        .collect::<Vec<_>>();
    assert_eq!(read_events.len(), 1);
    let read_event = read_events[0];
    assert_eq!(read_event["peerAccountId"], peer_account_id);
    assert_eq!(read_event["payload"]["readerAccountId"], peer_account_id);
    assert_eq!(
        read_event["payload"]["messageIds"].as_array().unwrap(),
        &vec![json!(message_id)]
    );
}

#[tokio::test]
async fn session_read_marks_all_inbound_rows_for_that_session() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let reader_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&unique_email("session-read-reader"), "correct horse"),
        ))
        .await
        .unwrap();
    let reader_body = read_json(reader_signup).await;
    let reader_token = reader_body["session"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    let reader_account_id = reader_body["account"]["accountId"]
        .as_str()
        .unwrap()
        .to_string();

    let peer_one_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&unique_email("session-read-peer-one"), "correct horse"),
        ))
        .await
        .unwrap();
    let peer_one_body = read_json(peer_one_signup).await;
    let peer_one_token = peer_one_body["session"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    let peer_one_account_id = peer_one_body["account"]["accountId"]
        .as_str()
        .unwrap()
        .to_string();

    let peer_two_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&unique_email("session-read-peer-two"), "correct horse"),
        ))
        .await
        .unwrap();
    let peer_two_body = read_json(peer_two_signup).await;
    let peer_two_token = peer_two_body["session"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    let peer_two_account_id = peer_two_body["account"]["accountId"]
        .as_str()
        .unwrap()
        .to_string();

    sqlx_core::query::query(
        "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) VALUES \
         ($1, $2, $4), ($2, $1, $4), ($1, $3, $4), ($3, $1, $4)",
    )
    .bind(&reader_account_id)
    .bind(&peer_one_account_id)
    .bind(&peer_two_account_id)
    .bind("2026-05-13T00:00:00Z")
    .execute(&pool)
    .await
    .unwrap();

    let session_id = format!("session:group:{}", uuid::Uuid::new_v4().simple());
    let other_session_id = format!("session:group:{}", uuid::Uuid::new_v4().simple());
    for (token, peer) in [
        (&peer_one_token, &reader_account_id),
        (&peer_two_token, &reader_account_id),
    ] {
        let response = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/messages",
                token,
                json!({ "peerAccountId": peer, "body": "group unread", "sessionId": session_id }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
    }
    let other_response = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &peer_one_token,
            json!({ "peerAccountId": reader_account_id, "body": "other unread", "sessionId": other_session_id }),
        ))
        .await
        .unwrap();
    assert_eq!(other_response.status(), StatusCode::CREATED);

    let read_resp = router
        .clone()
        .oneshot(post_with_token(
            &format!("/v1/cloud/sessions/{session_id}/read"),
            &reader_token,
        ))
        .await
        .unwrap();
    assert_eq!(read_resp.status(), StatusCode::NO_CONTENT);

    let read_counts: Vec<(String, i64)> = sqlx_core::query_as::query_as(
        "SELECT session_id, COUNT(*) FROM cloud_messages \
         WHERE to_account_id = $1 AND read_at IS NULL AND session_id IN ($2, $3) \
         GROUP BY session_id ORDER BY session_id",
    )
    .bind(&reader_account_id)
    .bind(&session_id)
    .bind(&other_session_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(read_counts, vec![(other_session_id, 1)]);

    let sync_resp = router
        .oneshot(get_with_token("/v1/cloud/sync?cursor=0", &peer_one_token))
        .await
        .unwrap();
    assert_eq!(sync_resp.status(), StatusCode::OK);
    let sync = read_json(sync_resp).await;
    assert!(sync["events"].as_array().unwrap().iter().any(|event| {
        event["eventType"] == "message.read"
            && event["peerAccountId"] == reader_account_id
            && event["payload"]["sessionId"] == session_id
    }));
}

#[tokio::test]
async fn session_read_cursor_marks_legacy_unread_rows_read_for_fresh_listing() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let reader_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&unique_email("session-cursor-reader"), "correct horse"),
        ))
        .await
        .unwrap();
    let reader_body = read_json(reader_signup).await;
    let reader_token = reader_body["session"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    let reader_account_id = reader_body["account"]["accountId"]
        .as_str()
        .unwrap()
        .to_string();

    let peer_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&unique_email("session-cursor-peer"), "correct horse"),
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
    .bind(&reader_account_id)
    .bind(&peer_account_id)
    .bind("2026-05-13T00:00:00Z")
    .execute(&pool)
    .await
    .unwrap();

    let session_id = format!("session:group:{}", uuid::Uuid::new_v4().simple());
    let other_session_id = format!("session:group:{}", uuid::Uuid::new_v4().simple());
    let session_message = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &peer_token,
            json!({ "peerAccountId": reader_account_id.clone(), "body": "legacy unread", "sessionId": session_id.clone() }),
        ))
        .await
        .unwrap();
    assert_eq!(session_message.status(), StatusCode::CREATED);
    let session_message_id = read_json(session_message).await["message"]["messageId"]
        .as_str()
        .unwrap()
        .to_string();

    let other_message = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &peer_token,
            json!({ "peerAccountId": reader_account_id.clone(), "body": "other unread", "sessionId": other_session_id.clone() }),
        ))
        .await
        .unwrap();
    assert_eq!(other_message.status(), StatusCode::CREATED);
    let other_message_id = read_json(other_message).await["message"]["messageId"]
        .as_str()
        .unwrap()
        .to_string();

    let read_resp = router
        .clone()
        .oneshot(post_with_token(
            &format!("/v1/cloud/sessions/{session_id}/read"),
            &reader_token,
        ))
        .await
        .unwrap();
    assert_eq!(read_resp.status(), StatusCode::NO_CONTENT);

    sqlx_core::query::query("UPDATE cloud_messages SET read_at = NULL WHERE message_id = $1")
        .bind(&session_message_id)
        .execute(&pool)
        .await
        .unwrap();

    let list_resp = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/messages?peerAccountId={peer_account_id}"),
            &reader_token,
        ))
        .await
        .unwrap();
    assert_eq!(list_resp.status(), StatusCode::OK);
    let list = read_json(list_resp).await;
    let messages = list["messages"].as_array().unwrap();
    let session_row = messages
        .iter()
        .find(|message| message["messageId"] == session_message_id)
        .unwrap();
    assert!(session_row["readAt"].as_str().is_some());
    let other_row = messages
        .iter()
        .find(|message| message["messageId"] == other_message_id)
        .unwrap();
    assert!(other_row["readAt"].is_null());
}
