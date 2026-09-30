use super::*;

#[path = "provider_auth/cross_account.rs"]
mod cross_account;
#[path = "provider_auth/login_method.rs"]
mod login_method;
#[path = "provider_auth/login_recovery.rs"]
mod login_recovery;
#[path = "provider_auth/login_session.rs"]
mod login_session;
#[path = "provider_auth/omp_worker.rs"]
mod omp_worker;
#[path = "provider_auth/publish_limits.rs"]
mod publish_limits;
#[path = "provider_auth/readiness.rs"]
mod readiness;
#[path = "provider_auth/real_worker.rs"]
mod real_worker;
#[path = "provider_auth/route_safety.rs"]
mod route_safety;
#[path = "provider_auth/route_sync.rs"]
mod route_sync;
#[path = "provider_auth/route_test.rs"]
mod route_test;
#[path = "provider_auth/support.rs"]
mod support;

#[tokio::test]
async fn desktop_provider_auth_requires_the_live_owner_mac_claim() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "desktop-provider-owner", "Owner").await;
    let other = signup(&router, "desktop-provider-other", "Other").await;
    sqlx_core::query::query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&owner.account_id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/online", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-runs/desktop/ready",
                &owner.token,
                json!({"agentIds":[format!("cloud-agent:{}", owner.account_id)]}),
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let saved = router.clone().oneshot(post_json_with_token(
        "/v1/cloud/agent-provider-auth/snapshots?intent=explicit", &owner.token,
        json!({"provider":"openai","authChoice":"cloud-api-key:work",
            "payload":{"apiKey":"synthetic-desktop-key","baseUrl":"https://api.openai.com/v1","model":"gpt-4.1-mini"}}),
    )).await.unwrap();
    assert_eq!(saved.status(), StatusCode::CREATED);
    let snapshot_id = read_json(saved).await["snapshotId"]
        .as_str()
        .unwrap()
        .to_string();
    let session = format!("session:self-agent:{}", uuid::Uuid::new_v4());
    let conversation = create_test_conversation(
        &pool,
        &owner.account_id,
        &session,
        ConversationKind::Ai,
        vec![],
    )
    .await;
    let request =
        insert_test_message(&pool, &owner.account_id, conversation, "Synthetic request").await;
    let claim_id = uuid::Uuid::new_v4();
    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/claim",
            &owner.token,
            json!({"requestMessageId":request,"sessionId":session,
            "ownerAccountId":owner.account_id,"requesterAccountId":owner.account_id,
            "prompt":"Synthetic request","idempotencyKey":format!("desktop-provider:{claim_id}"),
            "claimId":claim_id,"runtimeRoute":{"defaultModel":"openai/gpt-4.1-mini",
                "defaultAuthProvider":"openai","defaultAuthChoice":"cloud-api-key:work"}}),
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::OK);
    let claim = read_json(claim).await;
    assert_eq!(claim["acquired"], true);
    let run_id = claim["runId"].as_str().unwrap();
    let path = format!("/v1/cloud/agent-runs/{run_id}/desktop/provider-auth");
    let wrong_claim = router
        .clone()
        .oneshot(post_json_with_token(
            &path,
            &owner.token,
            json!({"claimId":uuid::Uuid::new_v4()}),
        ))
        .await
        .unwrap();
    assert_eq!(wrong_claim.status(), StatusCode::CONFLICT);
    let other_account = router
        .clone()
        .oneshot(post_json_with_token(
            &path,
            &other.token,
            json!({"claimId":claim_id}),
        ))
        .await
        .unwrap();
    assert_eq!(other_account.status(), StatusCode::CONFLICT);
    let material = router
        .clone()
        .oneshot(post_json_with_token(
            &path,
            &owner.token,
            json!({"claimId":claim_id}),
        ))
        .await
        .unwrap();
    assert_eq!(material.status(), StatusCode::OK);
    let material = read_json(material).await;
    assert_eq!(material["providerAuth"]["snapshotId"], snapshot_id);
    assert_eq!(material["providerAuth"]["authChoice"], "cloud-api-key:work");
    assert_eq!(
        material["providerAuth"]["payload"]["apiKey"],
        "synthetic-desktop-key"
    );
    assert!(material["providerAuth"]["payload"]
        .get("refreshToken")
        .is_none());
    sqlx_core::query::query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()-interval '1 second')::text WHERE run_id=$1")
        .bind(run_id).execute(&pool).await.unwrap();
    let expired = router
        .clone()
        .oneshot(post_json_with_token(
            &path,
            &owner.token,
            json!({"claimId":claim_id}),
        ))
        .await
        .unwrap();
    assert_eq!(expired.status(), StatusCode::CONFLICT);
}

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

    let passive_create = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots",
            &owner.token,
            json!({
                "provider": "openai",
                "authChoice": "default",
                "payload": { "accessToken": "passive-client-token" }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(passive_create.status(), StatusCode::BAD_REQUEST);

    let create = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots?intent=explicit",
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

    let passive_revoke = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/agent-provider-auth/snapshots/{snapshot_id}"),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(passive_revoke.status(), StatusCode::BAD_REQUEST);

    let revoke = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/agent-provider-auth/snapshots/{snapshot_id}?intent=explicit"),
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
            "/v1/cloud/agent-provider-auth/snapshots?intent=explicit",
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
            "/v1/cloud/agent-provider-auth/snapshots?intent=explicit",
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
