use super::*;

#[tokio::test]
async fn sandbox_group_sessions_reuse_shared_session_sandbox() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "sandbox-group-owner", "Owner").await;
    let requester_a = signup(&router, "sandbox-group-a", "Requester A").await;
    let requester_b = signup(&router, "sandbox-group-b", "Requester B").await;
    accept_contacts(&router, &requester_a, &owner).await;
    accept_contacts(&router, &requester_b, &owner).await;
    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let session_id = format!(
        "session:group:sandbox-shared-{}",
        uuid::Uuid::new_v4().simple()
    );
    let run_a = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester_a.token,
            claim_body_with_session(&owner, &requester_a, "msg_group_a", &session_id),
        ))
        .await
        .unwrap();
    assert_eq!(run_a.status(), StatusCode::OK);
    let run_a_id = read_json(run_a).await["runId"]
        .as_str()
        .unwrap()
        .to_string();

    let run_b = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester_b.token,
            claim_body_with_session(&owner, &requester_b, "msg_group_b", &session_id),
        ))
        .await
        .unwrap();
    assert_eq!(run_b.status(), StatusCode::OK);
    let run_b_id = read_json(run_b).await["runId"]
        .as_str()
        .unwrap()
        .to_string();

    let sandbox_a = run_sandbox_id(&pool, &run_a_id).await.unwrap();
    let sandbox_b = run_sandbox_id(&pool, &run_b_id).await.unwrap();
    assert_eq!(sandbox_a, sandbox_b);
}

#[tokio::test]
async fn sandbox_direct_sessions_are_requester_isolated() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "sandbox-direct-owner", "Owner").await;
    let requester_a = signup(&router, "sandbox-direct-a", "Requester A").await;
    let requester_b = signup(&router, "sandbox-direct-b", "Requester B").await;
    accept_contacts(&router, &requester_a, &owner).await;
    accept_contacts(&router, &requester_b, &owner).await;
    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let session_id = format!(
        "session:direct-person:sandbox-same-{}",
        uuid::Uuid::new_v4().simple()
    );
    let run_a = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester_a.token,
            claim_body_with_session(&owner, &requester_a, "msg_direct_a", &session_id),
        ))
        .await
        .unwrap();
    assert_eq!(run_a.status(), StatusCode::OK);
    let run_a_id = read_json(run_a).await["runId"]
        .as_str()
        .unwrap()
        .to_string();

    let run_b = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester_b.token,
            claim_body_with_session(&owner, &requester_b, "msg_direct_b", &session_id),
        ))
        .await
        .unwrap();
    assert_eq!(run_b.status(), StatusCode::OK);
    let run_b_id = read_json(run_b).await["runId"]
        .as_str()
        .unwrap()
        .to_string();

    let sandbox_a = run_sandbox_id(&pool, &run_a_id).await.unwrap();
    let sandbox_b = run_sandbox_id(&pool, &run_b_id).await.unwrap();
    assert_ne!(sandbox_a, sandbox_b);
}

#[tokio::test]
async fn sandbox_expired_rows_are_not_reused_and_runner_lease_includes_sandbox_id() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "sandbox-expiry-owner", "Owner").await;
    let requester = signup(&router, "sandbox-expiry-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;
    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let session_id = format!(
        "session:group:sandbox-expiry-{}",
        uuid::Uuid::new_v4().simple()
    );
    let first = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body_with_session(&owner, &requester, "msg_expiry_first", &session_id),
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first_run_id = read_json(first).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    let first_sandbox = run_sandbox_id(&pool, &first_run_id).await.unwrap();
    expire_sandbox(&pool, &first_sandbox).await;

    let second = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body_with_session(&owner, &requester, "msg_expiry_second", &session_id),
        ))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::OK);
    let second_run_id = read_json(second).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    let second_sandbox = run_sandbox_id(&pool, &second_run_id).await.unwrap();
    assert_ne!(first_sandbox, second_sandbox);
    cancel_other_queued_runs(&pool, &second_run_id).await;

    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": "runner-sandbox" }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    let lease_body = read_json(lease).await;
    assert_eq!(lease_body["run"]["runId"], second_run_id);
    assert_eq!(lease_body["run"]["sandboxId"], second_sandbox);
}

#[tokio::test]
async fn sandbox_rejected_claim_does_not_create_sandbox_for_unauthorized_requester() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "sandbox-unauth-owner", "Owner").await;
    let intruder = signup(&router, "sandbox-unauth-intruder", "Intruder").await;
    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let session_id = format!(
        "session:group:sandbox-unauth-{}",
        uuid::Uuid::new_v4().simple()
    );
    let rejected = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &intruder.token,
            claim_body_with_session(&owner, &intruder, "msg_unauth_sandbox", &session_id),
        ))
        .await
        .unwrap();

    assert_eq!(rejected.status(), StatusCode::FORBIDDEN);
    assert_eq!(count_sandboxes_for_session(&pool, &session_id).await, 0);
}
