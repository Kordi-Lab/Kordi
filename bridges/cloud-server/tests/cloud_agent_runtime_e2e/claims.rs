use super::*;

#[tokio::test]
async fn cloud_agent_runtime_fallback_claim_is_idempotent_when_owner_is_offline() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "offline-owner", "Owner").await;
    let requester = signup(&router, "offline-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;

    let offline = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
        .await
        .unwrap();
    assert_eq!(offline.status(), StatusCode::OK);

    let first = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_agent_request_1"),
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first_body = read_json(first).await;

    let second = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_agent_request_1"),
        ))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::OK);
    let second_body = read_json(second).await;

    assert_eq!(first_body["runId"], second_body["runId"]);
    assert_eq!(first_body["status"], "queued");
    assert_eq!(second_body["status"], "queued");
    let idempotency_key = claim_body(&owner, &requester, "msg_agent_request_1")["idempotencyKey"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        count_cloud_agent_runs_for_key(&pool, &idempotency_key).await,
        1
    );
}

#[tokio::test]
async fn cloud_agent_runtime_fallback_claim_is_rejected_when_owner_is_online() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "online-owner", "Owner").await;
    let requester = signup(&router, "online-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;

    let online = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/online", &owner.token))
        .await
        .unwrap();
    assert_eq!(online.status(), StatusCode::OK);

    let response = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_online_owner"),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn cloud_agent_runtime_fallback_claim_requires_accepted_contact_or_self() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "unauth-owner", "Owner").await;
    let requester = signup(&router, "unauth-requester", "Requester").await;

    let offline = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
        .await
        .unwrap();
    assert_eq!(offline.status(), StatusCode::OK);

    let response = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_unauthorized"),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}
