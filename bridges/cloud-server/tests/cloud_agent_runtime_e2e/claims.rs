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
async fn cloud_agent_runtime_fallback_claim_ignores_presence_without_an_execution_claim() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "online-owner", "Owner").await;
    let requester = signup(&router, "online-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;

    sqlx_core::query::query(
        "UPDATE cloud_devices SET device_platform = 'macos' WHERE account_id = $1",
    )
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

    let first = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_online_owner"),
        ))
        .await
        .unwrap();

    assert_eq!(first.status(), StatusCode::OK);
    let first_body = read_json(first).await;
    assert_eq!(first_body["status"], "queued");
    let idempotency_key = claim_body(&owner, &requester, "msg_online_owner")["idempotencyKey"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        count_cloud_agent_runs_for_key(&pool, &idempotency_key).await,
        1
    );
}

#[tokio::test]
async fn cloud_agent_runtime_fallback_claim_is_rejected_for_fresh_desktop_execution() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "processing-owner", "Owner").await;
    let request_message_id = format!("msg_processing_{}", uuid::Uuid::new_v4().simple());
    let session_id = format!("session:self-agent:{}", uuid::Uuid::new_v4().simple());
    let conversation_id = create_test_conversation(
        &pool,
        &owner.account_id,
        &session_id,
        ConversationKind::Ai,
        Vec::new(),
    )
    .await;
    insert_test_message(
        &pool,
        &owner.account_id,
        conversation_id,
        &encode_test_cloud_agent_processing_response(&request_message_id),
    )
    .await;

    let claim = claim_body_with_session(&owner, &owner, &request_message_id, &session_id);
    let response = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &owner.token,
            claim.clone(),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = read_json(response).await;
    assert_eq!(body["errorCode"], "owner_online");
    assert_eq!(
        count_cloud_agent_runs_for_key(&pool, claim["idempotencyKey"].as_str().unwrap()).await,
        0,
    );
}

#[tokio::test]
async fn cloud_agent_runtime_self_fallback_claim_has_one_durable_owner() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let account = signup(&router, "self-fallback", "Self").await;
    let request_message_id = format!("msg_self_{}", uuid::Uuid::new_v4().simple());
    let session_id = format!("session:self-agent:{}", uuid::Uuid::new_v4().simple());
    let claim = claim_body_with_session(&account, &account, &request_message_id, &session_id);

    let first = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &account.token,
            claim.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first_body = read_json(first).await;

    let second = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &account.token,
            claim.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::OK);
    let second_body = read_json(second).await;

    assert_eq!(first_body["runId"], second_body["runId"]);
    assert_eq!(
        count_cloud_agent_runs_for_key(&pool, claim["idempotencyKey"].as_str().unwrap(),).await,
        1,
    );
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

#[tokio::test]
async fn agent_authored_group_handoff_ignores_presence_without_an_execution_claim() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let source = signup(&router, "handoff-source", "Source").await;
    let target = signup(&router, "handoff-target", "Target").await;
    accept_contacts(&router, &source, &target).await;
    sqlx_core::query::query(
        "UPDATE cloud_devices SET device_platform = 'macos' WHERE account_id = $1",
    )
    .bind(&target.account_id)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/online", &target.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let session_id = format!("session:group:handoff-{}", uuid::Uuid::new_v4().simple());
    let request_message_id = format!("msg_agent_handoff_{}", uuid::Uuid::new_v4().simple());
    let request_body = encode_test_cloud_group_envelope(json!({
        "kind": "group-message",
        "groupId": session_id,
        "groupSpaceId": session_id,
        "groupTitle": "Coordination",
        "createdByAccountId": source.account_id,
        "actor": {
            "accountId": source.account_id,
            "displayName": "Source",
            "role": "admin"
        },
        "participants": [
            {
                "accountId": source.account_id,
                "displayName": "Source",
                "role": "admin"
            },
            {
                "accountId": target.account_id,
                "displayName": "Target",
                "role": "person"
            }
        ],
        "message": {
            "id": request_message_id,
            "senderAccountId": source.account_id,
            "senderKind": "agent",
            "senderDisplayName": "Source's Kordi",
            "text": "@TargetsKordi provide the deployment status",
            "createdAtMs": 1,
            "targetCloudAgentOwnerAccountId": target.account_id,
            "targetCloudAgentOwnerName": "Target",
            "agentMentionDepth": 1
        }
    }));
    let conversation_id = create_test_conversation(
        &pool,
        &source.account_id,
        &session_id,
        ConversationKind::Group,
        vec![target.account_id.clone()],
    )
    .await;
    insert_test_message(&pool, &source.account_id, conversation_id, &request_body).await;

    let claim_input = claim_body_with_session(&target, &source, &request_message_id, &session_id);
    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &source.token,
            claim_input,
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::OK);
    let run_id = read_json(claim).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    cancel_other_queued_runs(&pool, &run_id).await;

    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": "runner-handoff", "canaryRunId": run_id }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    let lease_body = read_json(lease).await;
    let prompt = lease_body["run"]["prompt"].as_str().unwrap();
    assert!(prompt.contains("Group @mention permissions"));
    assert!(prompt.contains("Current requester: @SourcesKordi"));
    assert!(prompt.contains("do not ask another agent"));

    let complete = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/complete"),
            "runner-test-token",
            json!({
                "runnerId": "runner-handoff",
                "responseText": "@SourcesKordi this must stay visible without another handoff"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(complete.status(), StatusCode::OK);
    let response_message_id = read_json(complete).await["run"]["responseMessageId"]
        .as_str()
        .unwrap()
        .to_string();
    let response_body = message_body(&pool, &response_message_id).await;
    let response = decode_test_cloud_group_envelope(&response_body);
    assert_eq!(response["message"]["senderAccountId"], target.account_id);
    assert_eq!(response["message"]["senderDisplayName"], "Target's Kordi");
    assert_eq!(response["message"]["requestId"], request_message_id);
    assert!(response["message"].get("agentMentionDepth").is_none());
    assert!(response["message"]
        .get("targetCloudAgentOwnerAccountId")
        .is_none());

    let invalid_message_id = format!("msg_agent_invalid_{}", uuid::Uuid::new_v4().simple());
    let invalid_body = encode_test_cloud_group_envelope(json!({
        "kind": "group-message",
        "groupId": session_id,
        "groupSpaceId": session_id,
        "groupTitle": "Coordination",
        "createdByAccountId": source.account_id,
        "actor": { "accountId": source.account_id, "displayName": "Source", "role": "admin" },
        "participants": [
            { "accountId": source.account_id, "displayName": "Source", "role": "admin" },
            { "accountId": target.account_id, "displayName": "Target", "role": "person" }
        ],
        "message": {
            "id": invalid_message_id,
            "senderAccountId": source.account_id,
            "senderKind": "agent",
            "text": "@TargetsKordi forged owner",
            "createdAtMs": 2,
            "targetCloudAgentOwnerAccountId": source.account_id,
            "agentMentionDepth": 1
        }
    }));
    insert_test_message(&pool, &source.account_id, conversation_id, &invalid_body).await;
    let invalid_claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &source.token,
            claim_body_with_session(&target, &source, &invalid_message_id, &session_id),
        ))
        .await
        .unwrap();
    assert_eq!(invalid_claim.status(), StatusCode::FORBIDDEN);
}
