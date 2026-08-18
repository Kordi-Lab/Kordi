use super::*;

#[path = "provider_auth/route_sync.rs"]
mod route_sync;

#[tokio::test]
async fn provider_auth_snapshot_create_current_revoke_and_audit() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "provider-auth-owner", "Owner").await;

    let create = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots",
            &owner.token,
            json!({
                "provider": "openai",
                "authChoice": "default",
                "payload": {
                    "accessToken": "secret-access-token",
                    "refreshToken": "secret-refresh-token"
                }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::CREATED);
    let created = read_json(create).await;
    let snapshot_id = created["snapshotId"].as_str().unwrap().to_string();
    assert_eq!(created["provider"], "openai");
    assert_eq!(created["authChoice"], "default");
    assert_eq!(created["revokedAt"], Value::Null);
    assert!(
        created.get("payload").is_none(),
        "snapshot response must not echo secrets"
    );

    let encrypted: (Vec<u8>,) = sqlx_core::query_as::query_as(
        "SELECT encrypted_payload FROM cloud_agent_provider_auth_snapshots WHERE snapshot_id = $1",
    )
    .bind(&snapshot_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let encrypted_text = String::from_utf8_lossy(&encrypted.0);
    assert!(!encrypted_text.contains("secret-access-token"));

    let current = router
        .clone()
        .oneshot(get_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/current?provider=openai&authChoice=default",
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(current.status(), StatusCode::OK);
    let current_body = read_json(current).await;
    assert_eq!(current_body["snapshot"]["snapshotId"], snapshot_id);
    assert!(current_body["snapshot"].get("payload").is_none());

    kordi_cloud_server::cloud_agent_runtime::provider_auth::record_snapshot_used(
        &pool,
        &snapshot_id,
        &owner.account_id,
        Some("car_test_run"),
    )
    .await
    .unwrap();

    let revoke = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/agent-provider-auth/snapshots/{snapshot_id}"),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(revoke.status(), StatusCode::OK);

    let current_after_revoke = router
        .clone()
        .oneshot(get_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/current?provider=openai&authChoice=default",
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(current_after_revoke.status(), StatusCode::OK);
    let current_after_revoke_body = read_json(current_after_revoke).await;
    assert_eq!(current_after_revoke_body["snapshot"], Value::Null);

    let audit_count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_provider_auth_snapshot_audit WHERE snapshot_id = $1 AND action IN ('created', 'used', 'revoked')",
    )
    .bind(&snapshot_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit_count.0, 3);

    let sync_events: Vec<(String, Value)> = sqlx_core::query_as::query_as(
        "SELECT event_type, payload FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND event_type = 'provider-auth.updated' \
         ORDER BY stream_seq ASC",
    )
    .bind(&owner.account_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(sync_events.len(), 2);
    assert_eq!(sync_events[0].1["action"], "published");
    assert_eq!(sync_events[0].1["provider"], "openai");
    assert_eq!(sync_events[1].1["action"], "revoked");
    assert_eq!(sync_events[1].1["snapshotId"], snapshot_id);
}

#[tokio::test]
async fn provider_auth_snapshot_is_account_scoped() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "provider-auth-owner-scope", "Owner").await;
    let other = signup(&router, "provider-auth-other-scope", "Other").await;

    let create = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots",
            &owner.token,
            json!({
                "provider": "openai",
                "authChoice": "default",
                "payload": { "accessToken": "owner-only" }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::CREATED);

    let other_current = router
        .clone()
        .oneshot(get_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/current?provider=openai&authChoice=default",
            &other.token,
        ))
        .await
        .unwrap();
    assert_eq!(other_current.status(), StatusCode::OK);
    let body = read_json(other_current).await;
    assert_eq!(body["snapshot"], Value::Null);
}

#[tokio::test]
async fn provider_auth_material_is_run_scoped_runner_only_and_audited() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "provider-material-owner", "Owner").await;
    let requester = signup(&router, "provider-material-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;

    let snapshot = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots",
            &owner.token,
            json!({
                "provider": "openai",
                "authChoice": "default",
                "payload": {
                    "apiKey": "runner-secret",
                    "baseUrl": "https://api.openai.com/v1",
                    "model": "gpt-4.1-mini"
                }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(snapshot.status(), StatusCode::CREATED);
    let snapshot_id = read_json(snapshot).await["snapshotId"]
        .as_str()
        .unwrap()
        .to_string();

    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_provider_material"),
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
            json!({ "runnerId": "runner-material" }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);

    let user_token_response = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            &requester.token,
            json!({ "runnerId": "runner-material" }),
        ))
        .await
        .unwrap();
    assert_eq!(user_token_response.status(), StatusCode::UNAUTHORIZED);

    let wrong_runner_response = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "runner-other" }),
        ))
        .await
        .unwrap();
    assert_eq!(wrong_runner_response.status(), StatusCode::NOT_FOUND);
    let wrong_runner_body = read_json(wrong_runner_response).await;
    assert_eq!(wrong_runner_body["errorCode"], "agent_run_not_found");

    let provider_auth = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "runner-material" }),
        ))
        .await
        .unwrap();
    assert_eq!(provider_auth.status(), StatusCode::OK);
    let body = read_json(provider_auth).await;
    assert_eq!(body["providerAuth"]["snapshotId"], snapshot_id);
    assert_eq!(body["providerAuth"]["provider"], "openai");
    assert_eq!(body["providerAuth"]["authChoice"], "default");
    assert_eq!(body["providerAuth"]["payload"]["apiKey"], "runner-secret");
    assert_eq!(
        body["providerAuth"]["payload"]["baseUrl"],
        "https://api.openai.com/v1"
    );
    assert_eq!(body["providerAuth"]["payload"]["model"], "gpt-4.1-mini");

    let audit_count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_provider_auth_snapshot_audit WHERE snapshot_id = $1 AND run_id = $2 AND action = 'used'",
    )
    .bind(&snapshot_id)
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit_count.0, 1);
}

#[tokio::test]
async fn provider_auth_material_missing_snapshot_returns_not_found() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "provider-material-missing-owner", "Owner").await;
    let requester = signup(&router, "provider-material-missing-requester", "Requester").await;
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
    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_provider_material_missing"),
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
            json!({ "runnerId": "runner-material-missing" }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);

    let missing_snapshot_response = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "runner-material-missing" }),
        ))
        .await
        .unwrap();
    assert_eq!(missing_snapshot_response.status(), StatusCode::NOT_FOUND);
    let body = read_json(missing_snapshot_response).await;
    assert_eq!(body["errorCode"], "provider_auth_not_found");
}

#[tokio::test]
async fn support_runs_use_the_dedicated_service_api_key_without_an_owner_snapshot() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use kordi_cloud_server::support::{
        bootstrap_support_agent, PendingSupportConfig, SupportProviderAuth, SupportService,
    };

    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let support_agent_id = format!("cloud_agent_kordi_support_{suffix}");
    let support_secret = format!("support-service-secret-{suffix}");
    let support_config = bootstrap_support_agent(
        &pool,
        PendingSupportConfig {
            owner_account_id: format!("acct_kordi_support_{suffix}"),
            owner_email: unique_email("provider-support-owner"),
            agent_id: support_agent_id.clone(),
            name: "Kordi Support".into(),
            subtitle: "Ask questions or suggest improvements".into(),
            inbox: unique_email("provider-support-inbox"),
            provider_auth: SupportProviderAuth::openai_api_key(&support_secret, "gpt-5.6-luna")
                .unwrap(),
        },
    )
    .await
    .unwrap();
    let support_owner = TestAccount {
        account_id: support_config.owner_account_id.clone(),
        token: String::new(),
    };
    let state = Arc::new(
        ServerState::new(pool.clone(), EventBus::noop())
            .with_support(SupportService::new(support_config)),
    );
    let router = test_router(state);
    let requester = signup(&router, "provider-support-requester", "Requester").await;
    let session_id = format!(
        "session:direct-system-agent:{}:{support_agent_id}",
        requester.account_id
    );
    let ordinary_chat = router
        .clone()
        .oneshot(post_json_with_token(
            "/v2/chat/conversations",
            &requester.token,
            json!({
                "client_operation_id": uuid::Uuid::now_v7(),
                "kind": "direct",
                "shared_title": null,
                "client_session_id": format!("session:direct-person:{}:{}", requester.account_id, support_owner.account_id),
                "member_account_ids": [support_owner.account_id.clone()],
            }),
        ))
        .await
        .unwrap();
    assert_eq!(ordinary_chat.status(), StatusCode::FORBIDDEN);
    let conversation = router
        .clone()
        .oneshot(post_json_with_token(
            "/v2/chat/conversations",
            &requester.token,
            json!({
                "client_operation_id": uuid::Uuid::now_v7(),
                "kind": "direct",
                "shared_title": null,
                "client_session_id": session_id.clone(),
                "member_account_ids": [support_owner.account_id.clone()],
            }),
        ))
        .await
        .unwrap();
    assert_eq!(conversation.status(), StatusCode::CREATED);
    let conversation_id = uuid::Uuid::parse_str(
        read_json(conversation).await["conversation"]["id"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let request_message_id = insert_test_message(
        &pool,
        &requester.account_id,
        conversation_id,
        &format!(
            "kordi-cloud-message:{}",
            URL_SAFE_NO_PAD.encode(
                json!({
                    "schemaVersion": 1,
                    "kind": "message",
                    "text": "How do I use Kordi groups?",
                    "targetCloudAgentId": support_agent_id,
                    "targetCloudAgentName": "Kordi Support",
                    "targetCloudAgentOwnerAccountId": support_owner.account_id,
                    "targetCloudAgentOwnerName": "Kordi",
                })
                .to_string(),
            )
        ),
    )
    .await;

    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body_with_session(&support_owner, &requester, &request_message_id, &session_id),
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::OK);
    let run_id = read_json(claim).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    cancel_other_queued_runs(&pool, &run_id).await;

    let snapshot_count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_provider_auth_snapshots WHERE account_id = $1",
    )
    .bind(&support_owner.account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(snapshot_count.0, 0);

    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": "runner-support-service", "canaryRunId": run_id }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);

    let provider_auth = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "runner-support-service" }),
        ))
        .await
        .unwrap();
    assert_eq!(provider_auth.status(), StatusCode::OK);
    let provider_auth = read_json(provider_auth).await;
    assert_eq!(
        provider_auth["providerAuth"]["snapshotId"],
        "support-service-openai"
    );
    assert_eq!(provider_auth["providerAuth"]["provider"], "openai");
    assert_eq!(
        provider_auth["providerAuth"]["authChoice"],
        "support-service-api-key"
    );
    assert_eq!(
        provider_auth["providerAuth"]["payload"]["apiKey"],
        support_secret
    );
    assert_eq!(
        provider_auth["providerAuth"]["payload"]["model"],
        "gpt-5.6-luna"
    );
}
