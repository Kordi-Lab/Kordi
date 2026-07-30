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

    let message: (String, String, String, String,) = sqlx_core::query_as::query_as(
        "SELECT from_account_id, to_account_id, session_id, body FROM cloud_messages WHERE message_id = $1",
    )
    .bind(&response_message_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(message.0, owner.account_id);
    assert_eq!(message.1, peer.account_id);
    assert_eq!(message.2, session_id);
    assert!(message.3.starts_with("kordi-cloud-agent-response:"));

    let event_rows: Vec<(String, String)> = sqlx_core::query_as::query_as(
        "SELECT account_id, payload_json->'message'->>'direction' AS direction \
         FROM cloud_sync_events WHERE message_id = $1 ORDER BY account_id",
    )
    .bind(&response_message_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(event_rows.len(), 2);
    assert!(event_rows.contains(&(owner.account_id.clone(), "outgoing".to_string())));
    assert!(event_rows.contains(&(peer.account_id.clone(), "incoming".to_string())));
}

#[tokio::test]
async fn scheduled_group_completion_routes_back_to_originating_group_session() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "scheduled-group-owner", "Owner").await;
    let peer = signup(&router, "scheduled-group-peer", "Peer").await;
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
    let now = chrono::Utc::now().to_rfc3339();
    sqlx_core::query::query(
        "INSERT INTO cloud_messages (message_id, from_account_id, to_account_id, body, created_at, delivered_at, session_id) \
         VALUES ($1, $2, $3, $4, $5, $5, $6)",
    )
    .bind("msg_original_group_reminder_request")
    .bind(&peer.account_id)
    .bind(&owner.account_id)
    .bind(&original_group_body)
    .bind(&now)
    .bind(&session_id)
    .execute(&pool)
    .await
    .unwrap();
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

    let rows: Vec<(String, String, String, String)> = sqlx_core::query_as::query_as(
        "SELECT message_id, from_account_id, to_account_id, body FROM cloud_messages \
         WHERE session_id = $1 AND message_id <> 'msg_original_group_reminder_request' ORDER BY to_account_id",
    )
    .bind(&session_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().any(|row| row.0 == response_message_id));
    assert!(rows.iter().all(|row| row.1 == owner.account_id));
    assert!(rows.iter().any(|row| row.2 == owner.account_id));
    assert!(rows.iter().any(|row| row.2 == peer.account_id));

    let envelope = decode_test_cloud_group_envelope(&rows[0].3);
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
