use super::*;

#[tokio::test]
async fn exact_message_lookup_recovers_rows_older_than_the_default_window_without_leaking_them() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);
    let (owner_token, owner_account_id) = signup_account(&router, "message-lookup-owner").await;
    let (outsider_token, _) = signup_account(&router, "message-lookup-outsider").await;
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let old_message_id = format!("msg_lookup_old_{suffix}");
    let old_body = format!("legacy-control-body-{suffix}");

    sqlx_core::query::query(
        "INSERT INTO cloud_messages \
         (message_id, from_account_id, to_account_id, body, created_at, delivered_at, read_at) \
         VALUES ($1, $2, $2, $3, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
    )
    .bind(&old_message_id)
    .bind(&owner_account_id)
    .bind(&old_body)
    .execute(&pool)
    .await
    .unwrap();

    for index in 0..200 {
        sqlx_core::query::query(
            "INSERT INTO cloud_messages \
             (message_id, from_account_id, to_account_id, body, created_at, delivered_at, read_at) \
             VALUES ($1, $2, $2, $3, '2026-08-07T00:00:00Z', '2026-08-07T00:00:00Z', '2026-08-07T00:00:00Z')",
        )
        .bind(format!("msg_lookup_recent_{suffix}_{index}"))
        .bind(&owner_account_id)
        .bind(format!("recent-{index}"))
        .execute(&pool)
        .await
        .unwrap();
    }

    let default_list = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/messages?peerAccountId={owner_account_id}"),
            &owner_token,
        ))
        .await
        .unwrap();
    assert_eq!(default_list.status(), StatusCode::OK);
    let default_list = serde_json::from_slice::<serde_json::Value>(
        &to_bytes(default_list.into_body(), 512 * 1024)
            .await
            .expect("read complete default message window"),
    )
    .expect("decode complete default message window");
    let default_messages = default_list["messages"].as_array().unwrap();
    assert_eq!(default_messages.len(), 200);
    assert!(default_messages
        .iter()
        .all(|message| message["messageId"] != old_message_id));

    let owner_lookup = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages/lookup",
            &owner_token,
            json!({ "messageIds": [old_message_id, old_message_id] }),
        ))
        .await
        .unwrap();
    assert_eq!(owner_lookup.status(), StatusCode::OK);
    let owner_lookup = read_json(owner_lookup).await;
    assert_eq!(owner_lookup["messages"].as_array().unwrap().len(), 1);
    assert_eq!(owner_lookup["messages"][0]["messageId"], old_message_id);
    assert_eq!(owner_lookup["messages"][0]["body"], old_body);

    let outsider_lookup = router
        .oneshot(post_json_with_token(
            "/v1/cloud/messages/lookup",
            &outsider_token,
            json!({ "messageIds": [old_message_id] }),
        ))
        .await
        .unwrap();
    assert_eq!(outsider_lookup.status(), StatusCode::OK);
    let outsider_lookup = read_json(outsider_lookup).await;
    assert!(outsider_lookup["messages"].as_array().unwrap().is_empty());
}
