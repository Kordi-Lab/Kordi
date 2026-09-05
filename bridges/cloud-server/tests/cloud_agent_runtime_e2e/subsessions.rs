use super::*;

#[tokio::test]
async fn model_subsession_keeps_parent_acl_identity_and_transcript_isolation() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "subsession-owner", "Owner").await;
    let peer = signup(&router, "subsession-peer", "Requester").await;
    let outsider = signup(&router, "subsession-outsider", "Outsider").await;
    accept_contacts(&router, &owner, &peer).await;
    let parent_id = format!("session:group:{}", uuid::Uuid::new_v4());
    let parent = create_test_conversation(
        &pool,
        &owner.account_id,
        &parent_id,
        ConversationKind::Group,
        vec![peer.account_id.clone()],
    )
    .await;
    let request_id = format!("ios_{}", uuid::Uuid::new_v4());
    let envelope = json!({"kind":"group-message","groupId":parent_id,"groupSpaceId":parent_id,
        "createdByAccountId":owner.account_id,"actor":{"accountId":peer.account_id,"displayName":"Requester","role":"person"},
        "participants":[{"accountId":owner.account_id,"displayName":"Owner","role":"admin"},{"accountId":peer.account_id,"displayName":"Requester","role":"person"}],
        "message":{"id":request_id,"senderAccountId":peer.account_id,"senderKind":"human","text":"Research independently","createdAtMs":1000,
            "targetCloudAgentId":format!("cloud-agent:{}",owner.account_id),"targetCloudAgentOwnerAccountId":owner.account_id}});
    let body = format!(
        "kordi-cloud-group:{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(envelope.to_string())
    );
    insert_test_message(&pool, &peer.account_id, parent, &body).await;
    let before: (i64, i64) = sqlx_core::query_as::query_as("SELECT (SELECT count(*) FROM cloud_chat_conversations), (SELECT count(*) FROM cloud_chat_messages)").fetch_one(&pool).await.unwrap();
    let id = uuid::Uuid::new_v4();
    let uri = format!("/v1/cloud/agent-subsessions/{id}");
    let put = |uri: &str, token: &str, value: &Value| {
        Request::builder()
            .method("PUT")
            .uri(uri)
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(value.to_string()))
            .unwrap()
    };
    let mut snapshot = json!({"parentSessionId":parent_id,"parentRequestId":request_id,"title":"Research task","status":"running","expectedVersion":0,
        "messages":[{"id":"input","role":"user","text":"Task brief","timestampMs":1000}]});
    let created = router
        .clone()
        .oneshot(put(&uri, &owner.token, &snapshot))
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    let created = read_json(created).await;
    assert_eq!(
        created["agentId"],
        format!("cloud-agent:{}", owner.account_id)
    );
    assert_eq!(created["version"], 1);
    assert_eq!(created["messages"], json!([]));
    assert_eq!(
        router
            .clone()
            .oneshot(get_with_token(&uri, &outsider.token))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        router
            .clone()
            .oneshot(put(&uri, &peer.token, &snapshot))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let wrong_owner_uri = format!("/v1/cloud/agent-subsessions/{}", uuid::Uuid::new_v4());
    assert_eq!(
        router
            .clone()
            .oneshot(put(&wrong_owner_uri, &peer.token, &snapshot))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );

    snapshot["expectedVersion"] = json!(1);
    snapshot["status"] = json!("done");
    snapshot["messages"].as_array_mut().unwrap().push(
        json!({"id":"answer","role":"assistant","text":"SUBSESSION_ONLY","timestampMs":2000}),
    );
    assert_eq!(
        router
            .clone()
            .oneshot(put(&uri, &owner.token, &snapshot))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let result = router
        .clone()
        .oneshot(get_with_token(
            &format!("{uri}?includeMessages=true"),
            &peer.token,
        ))
        .await
        .unwrap();
    assert_eq!(result.status(), StatusCode::OK);
    let result = read_json(result).await;
    assert_eq!(result["status"], "done");
    assert_eq!(result["version"], 2);
    assert_eq!(result["messages"].as_array().unwrap().len(), 1);
    assert_eq!(result["messages"][0]["text"], "SUBSESSION_ONLY");
    let owner_result = read_json(router.clone().oneshot(get_with_token(&format!("{uri}?includeMessages=true"), &owner.token)).await.unwrap()).await;
    assert_eq!(owner_result["messages"].as_array().unwrap().len(), 2);
    let replay = router
        .clone()
        .oneshot(put(&uri, &owner.token, &snapshot))
        .await
        .unwrap();
    assert_eq!(read_json(replay).await["version"], 2);
    let mut stale = snapshot.clone();
    stale["status"] = json!("running");
    assert_eq!(
        router
            .clone()
            .oneshot(put(&uri, &owner.token, &stale))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    stale = snapshot.clone();
    stale["parentRequestId"] = json!("another-request");
    assert_eq!(
        router
            .clone()
            .oneshot(put(&uri, &owner.token, &stale))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    stale = snapshot.clone();
    stale["messages"][1]["thinkingText"] = json!("NOT_SHARED");
    assert_eq!(
        router
            .clone()
            .oneshot(put(&uri, &owner.token, &stale))
            .await
            .unwrap()
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );

    sqlx_core::query::query(
        "UPDATE cloud_accounts SET display_name='Renamed Owner' WHERE account_id=$1",
    )
    .bind(&owner.account_id)
    .execute(&pool)
    .await
    .unwrap();
    let renamed = read_json(
        router
            .clone()
            .oneshot(get_with_token(&uri, &peer.token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(renamed["agentId"], created["agentId"]);
    assert_eq!(renamed["ownerDisplayName"], "Renamed Owner");
    subsession_follow::verify(&router, &pool, &owner, &peer, &outsider, &id.to_string(), created["agentId"].as_str().unwrap(), true).await;
    let after: (i64, i64) = sqlx_core::query_as::query_as("SELECT (SELECT count(*) FROM cloud_chat_conversations), (SELECT count(*) FROM cloud_chat_messages)").fetch_one(&pool).await.unwrap();
    assert_eq!(
        before, after,
        "subsessions must not create channels or publish their transcript as chat messages"
    );
    sqlx_core::query::query(
        "DELETE FROM cloud_chat_conversation_members WHERE conversation_id=$1 AND account_id=$2",
    )
    .bind(parent)
    .bind(&peer.account_id)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        router
            .clone()
            .oneshot(get_with_token(&uri, &peer.token))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    println!("SUBSESSION_AUTHORIZATION_AND_ISOLATION_VERIFIED");
}
