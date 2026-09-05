use super::*;

#[tokio::test]
async fn group_logical_request_prefers_mac_and_rejects_another_default_agent_owner() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "group-target-owner", "Target Owner").await;
    let peer = signup(&router, "group-other-owner", "Other Owner").await;
    accept_contacts(&router, &owner, &peer).await;
    sqlx_core::query::query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&owner.account_id)
        .execute(&pool)
        .await
        .unwrap();
    let online = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/online", &owner.token))
        .await
        .unwrap();
    assert_eq!(online.status(), StatusCode::OK);
    let ready = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/ready",
            &owner.token,
            json!({"agentIds":[format!("cloud-agent:{}",owner.account_id)]}),
        ))
        .await
        .unwrap();
    assert_eq!(ready.status(), StatusCode::OK);
    // Explicit test clock state keeps network latency out of readiness assertions.
    sqlx_core::query::query("UPDATE cloud_agent_desktop_capabilities SET updated_at=now()+interval '10 minutes' WHERE agent_id=$1")
        .bind(format!("cloud-agent:{}",owner.account_id)).execute(&pool).await.unwrap();
    sqlx_core::query::query("UPDATE cloud_device_presence SET last_heartbeat_at=(now()+interval '10 minutes')::text WHERE account_id=$1")
        .bind(&owner.account_id).execute(&pool).await.unwrap();
    let session_id = format!("session:group:{}", uuid::Uuid::new_v4());
    let conversation = create_test_conversation(
        &pool,
        &owner.account_id,
        &session_id,
        ConversationKind::Group,
        vec![peer.account_id.clone()],
    )
    .await;
    let logical_id = format!("ios_{}", uuid::Uuid::new_v4());
    let mut envelope = json!({
        "kind":"group-message","groupId":session_id,"groupSpaceId":session_id,
        "createdByAccountId":owner.account_id,"actor":{"accountId":owner.account_id,"displayName":"Target Owner","role":"admin"},
        "participants":[{"accountId":owner.account_id,"displayName":"Target Owner","role":"admin"},{"accountId":peer.account_id,"displayName":"Other Owner","role":"person"}],
        "message":{"id":logical_id,"senderAccountId":owner.account_id,"senderKind":"human","text":"@Kordi reply once","createdAtMs":chrono::Utc::now().timestamp_millis(),
            "targetCloudAgentId":format!("cloud-agent:{}",owner.account_id),"targetCloudAgentOwnerAccountId":owner.account_id,"targetCloudAgentName":"Kordi"}
    });
    let encode = |value: &Value| {
        format!(
            "kordi-cloud-group:{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
        )
    };
    let wire_id =
        insert_test_message(&pool, &owner.account_id, conversation, &encode(&envelope)).await;
    assert_ne!(wire_id, logical_id);
    sqlx_core::query::query("UPDATE cloud_chat_messages SET created_at=now()+interval '10 minutes' WHERE message_id::text=$1")
        .bind(&wire_id).execute(&pool).await.unwrap();
    let input = |target: &str, request: &str, session: &str| json!({"requestMessageId":request,"sessionId":session,"ownerAccountId":target,"requesterAccountId":owner.account_id,"prompt":"Reply once","idempotencyKey":format!("group-owner:{request}:{target}")});
    let claim = |body| {
        router.clone().oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &owner.token,
            body,
        ))
    };
    let correct = claim(input(&owner.account_id, &logical_id, &session_id))
        .await
        .unwrap();
    assert_eq!(correct.status(), StatusCode::CONFLICT);
    assert_eq!(read_json(correct).await["errorCode"], "owner_online");
    let wrong = claim(input(&peer.account_id, &logical_id, &session_id))
        .await
        .unwrap();
    assert_eq!(wrong.status(), StatusCode::FORBIDDEN);

    // A long-running Mac request remains protected after the initial admission window.
    sqlx_core::query::query("UPDATE cloud_chat_messages SET created_at=now()-interval '1 minute' WHERE message_id::text=$1")
        .bind(&wire_id).execute(&pool).await.unwrap();
    envelope["message"] = json!({"id":"desktop-progress","senderAccountId":owner.account_id,"senderKind":"agent","senderAgentId":format!("cloud-agent:{}",owner.account_id),"requestId":logical_id,"text":"processing...","deliveryState":"processing","createdAtMs":chrono::Utc::now().timestamp_millis()});
    let progress =
        insert_test_message(&pool, &owner.account_id, conversation, &encode(&envelope)).await;
    sqlx_core::query::query("UPDATE cloud_chat_messages SET created_at=now()+interval '10 minutes' WHERE message_id::text=$1")
        .bind(&progress).execute(&pool).await.unwrap();
    let running = claim(input(&owner.account_id, &logical_id, &session_id))
        .await
        .unwrap();
    assert_eq!(running.status(), StatusCode::CONFLICT);
    assert_eq!(read_json(running).await["errorCode"], "owner_online");
    let (count,): (i64,) = sqlx_core::query_as::query_as(
        "SELECT count(*) FROM cloud_agent_fallback_runs WHERE request_message_id=$1",
    )
    .bind(&logical_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 0);

    sqlx_core::query::query("UPDATE cloud_device_presence SET state='offline' WHERE account_id=$1")
        .bind(&owner.account_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx_core::query::query("UPDATE cloud_chat_messages SET created_at=now()-interval '1 minute' WHERE message_id::text=$1").bind(&progress).execute(&pool).await.unwrap();
    let offline = claim(input(&owner.account_id, &logical_id, &session_id))
        .await
        .unwrap();
    assert_eq!(offline.status(), StatusCode::OK);
    assert_eq!(read_json(offline).await["executionBackend"], "cloud");
    assert_eq!(
        claim(input(&peer.account_id, &logical_id, &session_id))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );

    // Contact conversations use the same explicit default-owner authorization.
    let mut direct_members = [owner.account_id.clone(), peer.account_id.clone()];
    direct_members.sort();
    let direct_session = format!(
        "session:direct-person:{}:{}",
        direct_members[0], direct_members[1]
    );
    let direct = create_test_conversation(
        &pool,
        &owner.account_id,
        &direct_session,
        ConversationKind::Direct,
        vec![peer.account_id.clone()],
    )
    .await;
    let body = format!("kordi-cloud-message:{}",base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json!({"schemaVersion":1,"kind":"message","text":"@Kordi reply once","targetCloudAgentId":format!("cloud-agent:{}",owner.account_id),"targetCloudAgentOwnerAccountId":owner.account_id}).to_string()));
    let direct_id = insert_test_message(&pool, &owner.account_id, direct, &body).await;
    assert_eq!(
        claim(input(&peer.account_id, &direct_id, &direct_session))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
}
