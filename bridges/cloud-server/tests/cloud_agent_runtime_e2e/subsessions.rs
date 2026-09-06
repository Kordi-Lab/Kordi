use super::*;

#[tokio::test]
async fn thread_read_cursors_sync_per_account_without_reading_other_threads_or_parent() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "thread-reader", "Reader").await;
    let peer = signup(&router, "thread-peer", "Peer").await;
    let outsider = signup(&router, "thread-outsider", "Outsider").await;
    accept_contacts(&router, &owner, &peer).await;
    for kind in [ConversationKind::Group, ConversationKind::Direct] {
        let session_id = if kind == ConversationKind::Group {
            format!("session:group:{}", uuid::Uuid::new_v4())
        } else {
            let mut members = [owner.account_id.clone(), peer.account_id.clone()];
            members.sort();
            format!("session:direct-person:{}:{}", members[0], members[1])
        };
        let parent = create_test_conversation(&pool, &owner.account_id, &session_id, kind, vec![peer.account_id.clone()]).await;
        let root = insert_test_message(&pool, &peer.account_id, parent, "Root").await;
        let reply = insert_test_message(&pool, &peer.account_id, parent, "Reply").await;
        let (sequence,): (i64,) = sqlx_core::query_as::query_as("SELECT conversation_sequence FROM cloud_chat_messages WHERE message_id=$1")
            .bind(uuid::Uuid::parse_str(&reply).unwrap()).fetch_one(&pool).await.unwrap();
        let uri = format!("/v2/chat/conversations/{parent}/threads/read");
        let put = |token: &str, root: &str, sequence: i64| Request::builder().method("PUT").uri(&uri)
            .header("authorization", format!("Bearer {token}")).header("content-type", "application/json")
            .body(Body::from(json!({"root_message_id":root,"sequence":sequence}).to_string())).unwrap();
        let saved = router.clone().oneshot(put(&owner.token, &root, sequence)).await.unwrap();
        assert_eq!(saved.status(), StatusCode::OK);
        let saved = read_json(saved).await;
        let client_root = saved["root_client_message_id"].as_str().unwrap();
        let stale = router.clone().oneshot(put(&owner.token, client_root, 0)).await.unwrap();
        assert_eq!(read_json(stale).await["last_read_sequence"], sequence);
        let other_device = read_json(router.clone().oneshot(get_with_token(&uri, &owner.token)).await.unwrap()).await;
        assert_eq!(other_device, json!([saved]));
        let peer_state = read_json(router.clone().oneshot(get_with_token(&uri, &peer.token)).await.unwrap()).await;
        assert_eq!(peer_state, json!([]));
        let (parent_read,): (i64,) = sqlx_core::query_as::query_as("SELECT last_read_sequence FROM cloud_chat_conversation_members WHERE conversation_id=$1 AND account_id=$2")
            .bind(parent).bind(&owner.account_id).fetch_one(&pool).await.unwrap();
        assert_eq!(parent_read, 0);
        insert_test_message(&pool, &peer.account_id, parent, "New unread reply").await;
        let unchanged = read_json(router.clone().oneshot(get_with_token(&uri, &owner.token)).await.unwrap()).await;
        assert_eq!(unchanged[0]["last_read_sequence"], sequence);
        assert_eq!(router.clone().oneshot(put(&owner.token, &root, sequence + 100)).await.unwrap().status(), StatusCode::BAD_REQUEST);
        assert_eq!(router.clone().oneshot(put(&owner.token, &uuid::Uuid::new_v4().to_string(), sequence)).await.unwrap().status(), StatusCode::NOT_FOUND);
        assert!(!router.clone().oneshot(get_with_token(&uri, &outsider.token)).await.unwrap().status().is_success());
        assert!(!router.clone().oneshot(put(&outsider.token, &root, sequence)).await.unwrap().status().is_success());
        sqlx_core::query::query("UPDATE cloud_chat_conversation_members SET membership_state='left' WHERE conversation_id=$1 AND account_id=$2")
            .bind(parent).bind(&peer.account_id).execute(&pool).await.unwrap();
        assert!(!router.clone().oneshot(get_with_token(&uri, &peer.token)).await.unwrap().status().is_success());
    }
}

#[tokio::test]
async fn private_agent_session_is_not_readable_by_shared_subsession_members() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "private-panel-owner", "Owner").await;
    let peer = signup(&router, "private-panel-peer", "Peer").await;
    accept_contacts(&router, &owner, &peer).await;
    let private = create_test_conversation(
        &pool,
        &owner.account_id,
        &format!("session:self-agent:{}", uuid::Uuid::new_v4()),
        ConversationKind::Ai,
        vec![],
    )
    .await;
    insert_test_message(&pool, &owner.account_id, private, "PRIVATE_PANEL_CANARY").await;
    let uri = format!("/v2/chat/conversations/{private}/messages");
    let own = router
        .clone()
        .oneshot(get_with_token(&uri, &owner.token))
        .await
        .unwrap();
    assert_eq!(own.status(), StatusCode::OK);
    assert!(read_json(own)
        .await
        .to_string()
        .contains("PRIVATE_PANEL_CANARY"));
    let other = router
        .clone()
        .oneshot(get_with_token(&uri, &peer.token))
        .await
        .unwrap();
    assert!(matches!(
        other.status(),
        StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
    ));
    assert!(!read_json(other)
        .await
        .to_string()
        .contains("PRIVATE_PANEL_CANARY"));
}

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
    assert_eq!(result["messages"].as_array().unwrap().len(), 2);
    assert_eq!(result["messages"][0]["text"], "Task brief");
    assert_eq!(result["messages"][0]["senderAgentId"], result["agentId"]);
    assert!(result["messages"][0]["senderAccountId"].is_null());
    assert_eq!(result["messages"][1]["text"], "SUBSESSION_ONLY");
    let owner_result = read_json(
        router
            .clone()
            .oneshot(get_with_token(
                &format!("{uri}?includeMessages=true"),
                &owner.token,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(owner_result["messages"].as_array().unwrap().len(), 2);
    assert_eq!(owner_result["messages"], result["messages"]);
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
    let catalog_uri = format!("/v1/cloud/agent-subsessions?parentSessionId={parent_id}");
    let catalog = read_json(
        router
            .clone()
            .oneshot(get_with_token(&catalog_uri, &peer.token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(catalog["sessions"][0]["sessionId"], id.to_string());
    assert_eq!(catalog["sessions"][0]["status"], "done");
    assert_eq!(catalog["sessions"][0]["startedAtMs"], 1000);
    assert_eq!(catalog["sessions"][0]["finishedAtMs"], 2000);
    assert!(
        !catalog.to_string().contains("SUBSESSION_ONLY"),
        "the catalog must not include transcripts"
    );
    assert!(matches!(
        router
            .clone()
            .oneshot(get_with_token(&catalog_uri, &outsider.token))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND | StatusCode::FORBIDDEN
    ));
    // More than one page must remain reachable without loading parent history.
    sqlx_core::query::query("INSERT INTO cloud_agent_subsessions(subsession_id,parent_conversation_id,parent_session_id,parent_request_id,owner_account_id,publisher_device_id,agent_id,title,status) SELECT gen_random_uuid(),s.parent_conversation_id,s.parent_session_id,s.parent_request_id,s.owner_account_id,s.publisher_device_id,s.agent_id,'Catalog fixture','done' FROM cloud_agent_subsessions s CROSS JOIN generate_series(1,101) WHERE s.subsession_id=$1")
        .bind(id).execute(&pool).await.unwrap();
    let first = read_json(
        router
            .clone()
            .oneshot(get_with_token(&catalog_uri, &peer.token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(first["sessions"].as_array().unwrap().len(), 100);
    let after = first["nextCursor"].as_str().unwrap();
    let second = read_json(
        router
            .clone()
            .oneshot(get_with_token(
                &format!("{catalog_uri}&after={after}"),
                &peer.token,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(second["sessions"].as_array().unwrap().len(), 2);
    assert!(second["nextCursor"].is_null());
    subsession_follow::verify(
        &router,
        &pool,
        &owner,
        &peer,
        &outsider,
        &id.to_string(),
        created["agentId"].as_str().unwrap(),
        true,
    )
    .await;
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
    assert!(matches!(
        router
            .clone()
            .oneshot(get_with_token(&catalog_uri, &peer.token))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND | StatusCode::FORBIDDEN
    ));
    println!("SUBSESSION_AUTHORIZATION_AND_ISOLATION_VERIFIED");
}
