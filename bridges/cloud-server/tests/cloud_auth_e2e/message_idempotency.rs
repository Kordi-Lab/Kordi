use super::*;

#[tokio::test]
async fn cloud_message_idempotency_returns_the_existing_message() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("message-idempotency");
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
    let signup_body = read_json(signup).await;
    let token = signup_body["session"]["token"].as_str().unwrap();
    let account_id = signup_body["account"]["accountId"].as_str().unwrap();
    let client_message_id = format!("canonical:test:{}", uuid::Uuid::new_v4().simple());
    let request_body = json!({
        "peerAccountId": account_id,
        "body": "send once",
        "clientMessageId": client_message_id,
    });

    let first = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            token,
            request_body.clone(),
        ))
        .await
        .unwrap();
    let first_status = first.status();
    let first_body = read_json(first).await;
    assert_eq!(first_status, StatusCode::CREATED, "got body {first_body}");

    let second = router
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            token,
            request_body,
        ))
        .await
        .unwrap();
    let second_status = second.status();
    let second_body = read_json(second).await;
    assert_eq!(second_status, StatusCode::CREATED, "got body {second_body}");
    assert_eq!(
        first_body["message"]["messageId"],
        second_body["message"]["messageId"]
    );

    let count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*) FROM cloud_messages \
         WHERE from_account_id = $1 AND to_account_id = $1 AND client_message_id = $2",
    )
    .bind(account_id)
    .bind(&client_message_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count.0, 1);
}

#[tokio::test]
async fn cloud_message_idempotency_rejects_a_changed_command() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);
    let (token, account_id) = signup_account(&router, "message-idempotency-conflict").await;
    let client_message_id = format!("operation:{}", uuid::Uuid::new_v4().simple());

    let first = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &token,
            json!({
                "peerAccountId": account_id,
                "body": "original command",
                "sessionId": "session:original",
                "clientMessageId": client_message_id,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::CREATED);

    let conflict = router
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &token,
            json!({
                "peerAccountId": account_id,
                "body": "mutated command",
                "sessionId": "session:original",
                "clientMessageId": client_message_id,
            }),
        ))
        .await
        .unwrap();
    let status = conflict.status();
    let body = read_json(conflict).await;
    assert_eq!(status, StatusCode::CONFLICT, "got body {body}");
    assert_eq!(body["errorCode"], "idempotency_conflict");
}

#[tokio::test]
async fn legacy_self_message_retries_use_the_source_timestamp_as_an_idempotency_key() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);
    let (token, account_id) = signup_account(&router, "legacy-self-message-retry").await;
    let session_id = format!("session:{}", uuid::Uuid::new_v4().simple());
    let client_created_at = chrono::Utc::now().to_rfc3339();
    let request_body = json!({
        "peerAccountId": account_id,
        "body": "which model are you using",
        "sessionId": session_id,
        "clientCreatedAt": client_created_at,
    });

    let first = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &token,
            request_body.clone(),
        ))
        .await
        .unwrap();
    let first_body = read_json(first).await;
    let retry = router
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &token,
            request_body,
        ))
        .await
        .unwrap();
    let retry_body = read_json(retry).await;

    assert_eq!(
        first_body["message"]["messageId"],
        retry_body["message"]["messageId"]
    );
    let count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*) FROM cloud_messages \
         WHERE from_account_id = $1 AND to_account_id = $1 \
           AND session_id = $2 AND body = $3",
    )
    .bind(&account_id)
    .bind(&session_id)
    .bind("which model are you using")
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count.0, 1);
}

#[tokio::test]
async fn legacy_self_messages_inside_the_replay_window_reuse_the_existing_row() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);
    let (token, account_id) = signup_account(&router, "legacy-self-message-distinct").await;
    let session_id = format!("session:{}", uuid::Uuid::new_v4().simple());
    let base_time = chrono::Utc::now() - chrono::Duration::seconds(2);
    let mut ids = Vec::new();

    for offset_ms in [0, 650] {
        let response = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/messages",
                &token,
                json!({
                    "peerAccountId": account_id,
                    "body": "repeat this intentionally",
                    "sessionId": session_id,
                    "clientCreatedAt": (base_time + chrono::Duration::milliseconds(offset_ms)).to_rfc3339(),
                }),
            ))
            .await
            .unwrap();
        let body = read_json(response).await;
        ids.push(body["message"]["messageId"].as_str().unwrap().to_string());
    }

    assert_eq!(ids[0], ids[1]);
}

#[tokio::test]
async fn legacy_self_messages_outside_the_replay_window_remain_distinct() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);
    let (token, account_id) = signup_account(&router, "legacy-self-message-distinct").await;
    let session_id = format!("session:{}", uuid::Uuid::new_v4().simple());
    let base_time = chrono::Utc::now() - chrono::Duration::seconds(3);
    let mut ids = Vec::new();

    for offset_ms in [0, 1_500] {
        let response = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/messages",
                &token,
                json!({
                    "peerAccountId": account_id,
                    "body": "repeat this intentionally",
                    "sessionId": session_id,
                    "clientCreatedAt": (base_time + chrono::Duration::milliseconds(offset_ms)).to_rfc3339(),
                }),
            ))
            .await
            .unwrap();
        let body = read_json(response).await;
        ids.push(body["message"]["messageId"].as_str().unwrap().to_string());
    }

    assert_ne!(ids[0], ids[1]);
}

#[tokio::test]
async fn message_list_collapses_preexisting_near_time_legacy_self_replays() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);
    let (token, account_id) = signup_account(&router, "legacy-self-message-list").await;
    let session_id = format!("session:{}", uuid::Uuid::new_v4().simple());
    let body = format!("legacy duplicate {}", uuid::Uuid::new_v4().simple());
    let created_at = (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339();

    let mut legacy_message_ids = Vec::new();
    for offset_ms in [0, 650] {
        let message_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
        let row_created_at = (chrono::DateTime::parse_from_rfc3339(&created_at).unwrap()
            + chrono::Duration::milliseconds(offset_ms))
        .to_rfc3339();
        sqlx_core::query::query(
            "INSERT INTO cloud_messages \
             (message_id, from_account_id, to_account_id, body, created_at, delivered_at, read_at, session_id, client_message_id) \
             VALUES ($1, $2, $2, $3, $4, $4, $4, $5, NULL)",
        )
        .bind(&message_id)
        .bind(&account_id)
        .bind(&body)
        .bind(&row_created_at)
        .bind(&session_id)
        .execute(&pool)
        .await
        .unwrap();
        legacy_message_ids.push(message_id);
    }

    let retry = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &token,
            json!({
                "peerAccountId": &account_id,
                "body": &body,
                "sessionId": &session_id,
                "clientCreatedAt": &created_at,
            }),
        ))
        .await
        .unwrap();
    let retry_status = retry.status();
    let retry_body = read_json(retry).await;
    assert_eq!(retry_status, StatusCode::CREATED, "got body {retry_body}");
    assert!(legacy_message_ids.iter().any(|message_id| {
        retry_body["message"]["messageId"].as_str() == Some(message_id.as_str())
    }));
    let raw_count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*) FROM cloud_messages \
         WHERE from_account_id = $1 AND to_account_id = $1 \
           AND session_id = $2 AND body = $3",
    )
    .bind(&account_id)
    .bind(&session_id)
    .bind(&body)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(raw_count.0, 2, "the compatibility retry must not add a row");

    let response = router
        .oneshot(get_with_token(
            &format!("/v1/cloud/messages?peerAccountId={account_id}"),
            &token,
        ))
        .await
        .unwrap();
    let status = response.status();
    let response_body = read_json(response).await;
    assert_eq!(status, StatusCode::OK, "got body {response_body}");
    let matching_messages = response_body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["body"] == body)
        .count();
    assert_eq!(matching_messages, 1);
}

#[tokio::test]
async fn cloud_message_idempotency_is_independent_per_recipient() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);
    let (sender_token, sender_id) = signup_account(&router, "message-idempotency-sender").await;
    let (_, recipient_a) = signup_account(&router, "message-idempotency-a").await;
    let (_, recipient_b) = signup_account(&router, "message-idempotency-b").await;
    let now = chrono::Utc::now().to_rfc3339();
    for recipient in [&recipient_a, &recipient_b] {
        sqlx_core::query::query(
            "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) \
             VALUES ($1, $2, $3) ON CONFLICT (account_id, peer_account_id) DO NOTHING",
        )
        .bind(&sender_id)
        .bind(recipient)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
    }

    let canonical_message_id = format!("canonical:fanout:{}", uuid::Uuid::new_v4().simple());
    let mut stored_message_ids = Vec::new();
    for recipient in [&recipient_a, &recipient_b] {
        let client_message_id = format!("{canonical_message_id}:{recipient}");
        let body = json!({
            "peerAccountId": recipient,
            "body": "fanout once per recipient",
            "clientMessageId": client_message_id,
        });
        let first = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/messages",
                &sender_token,
                body.clone(),
            ))
            .await
            .unwrap();
        let first_body = read_json(first).await;
        let retry = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/messages",
                &sender_token,
                body,
            ))
            .await
            .unwrap();
        let retry_body = read_json(retry).await;
        assert_eq!(
            first_body["message"]["messageId"],
            retry_body["message"]["messageId"]
        );
        stored_message_ids.push(
            first_body["message"]["messageId"]
                .as_str()
                .unwrap()
                .to_string(),
        );
    }

    assert_ne!(stored_message_ids[0], stored_message_ids[1]);
    let count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*) FROM cloud_messages \
         WHERE from_account_id = $1 AND client_message_id LIKE $2",
    )
    .bind(&sender_id)
    .bind(format!("{canonical_message_id}:%"))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count.0, 2);
}

#[tokio::test]
async fn cloud_message_idempotency_attachment_failure_leaves_no_message_row() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("message-idempotency-attachment");
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
    let signup_body = read_json(signup).await;
    let account_id = signup_body["account"]["accountId"].as_str().unwrap();
    let client_message_id = format!("canonical:bad-attachment:{}", uuid::Uuid::new_v4().simple());
    let message_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    let now = chrono::Utc::now().to_rfc3339();
    let attachments = vec![PersistedMessageAttachment {
        attachment_id: "att_missing".into(),
        name: "missing.png".into(),
        kind: "image".into(),
        mime_type: Some("image/png".into()),
        size_bytes: Some(10),
        download_url: None,
        preview_url: None,
    }];
    let result = persist_cloud_message(
        &pool,
        PersistCloudMessageInput {
            message_id: &message_id,
            from_account_id: account_id,
            to_account_id: account_id,
            client_message_id: Some(&client_message_id),
            body: "must roll back",
            session_id: None,
            created_at: &now,
            delivered_at: &now,
            read_at: Some(&now),
            attachments: &attachments,
            claim_legacy_self_replay: false,
            legacy_self_replay_lock_id: None,
        },
    )
    .await;
    assert!(
        result.is_err(),
        "missing attachment must fail inside the transaction"
    );

    let count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*) FROM cloud_messages \
         WHERE from_account_id = $1 AND client_message_id = $2",
    )
    .bind(account_id)
    .bind(&client_message_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count.0, 0);
}
