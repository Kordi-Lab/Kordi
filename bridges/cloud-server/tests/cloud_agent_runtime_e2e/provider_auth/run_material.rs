use super::*;

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
    let target_agent_id = format!("cloud_agent_provider_route_{}", owner.account_id);
    let now = chrono::Utc::now().to_rfc3339();
    sqlx_core::query::query(
        "INSERT INTO cloud_agent_definitions (
            agent_id, owner_account_id, access_scope, status, name, role,
            system_prompt, model_routing_json, created_at, updated_at
         ) VALUES ($1, $2, 'participant_conversations', 'active',
                   'Provider route agent', 'Assistant', 'Help.', $3, $4, $4)",
    )
    .bind(&target_agent_id)
    .bind(&owner.account_id)
    .bind(json!({
        "defaultAuthProvider": "openai",
        "defaultAuthChoice": "default",
        "defaultModel": "openai/gpt-5.4"
    }))
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();
    sqlx_core::query::query(
        "UPDATE cloud_agent_fallback_runs SET target_agent_id = $2 WHERE run_id = $1",
    )
    .bind(&run_id)
    .bind(&target_agent_id)
    .execute(&pool)
    .await
    .unwrap();
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
    assert_eq!(body["providerAuth"]["payload"]["model"], "openai/gpt-5.4");

    let audit_count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_provider_auth_snapshot_audit WHERE snapshot_id = $1 AND run_id = $2 AND action = 'used'",
    )
    .bind(&snapshot_id)
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit_count.0, 1);

    sqlx_core::query::query(
        "UPDATE cloud_agent_definitions SET model_routing_json = $2, updated_at = $3 \
         WHERE agent_id = $1",
    )
    .bind(&target_agent_id)
    .bind(json!({
        "defaultAuthProvider": "openai",
        "defaultAuthChoice": "profile:replaced-auth",
        "defaultModel": "openai/gpt-5.4"
    }))
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();
    let sole_replacement = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "runner-material" }),
        ))
        .await
        .unwrap();
    assert_eq!(sole_replacement.status(), StatusCode::OK);
    assert_eq!(
        read_json(sole_replacement).await["providerAuth"]["snapshotId"],
        snapshot_id
    );

    let second_snapshot = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots",
            &owner.token,
            json!({
                "provider": "openai",
                "authChoice": "profile:second-auth",
                "payload": {
                    "apiKey": "second-runner-secret",
                    "model": "openai/gpt-5.4"
                }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(second_snapshot.status(), StatusCode::CREATED);
    let second_snapshot_id = read_json(second_snapshot).await["snapshotId"]
        .as_str()
        .unwrap()
        .to_string();
    let ambiguous_replacement = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "runner-material" }),
        ))
        .await
        .unwrap();
    assert_eq!(ambiguous_replacement.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        read_json(ambiguous_replacement).await["errorCode"],
        "provider_auth_not_found"
    );
    let revoke_second = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/agent-provider-auth/snapshots/{second_snapshot_id}"),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(revoke_second.status(), StatusCode::OK);
    sqlx_core::query::query(
        "UPDATE cloud_agent_definitions SET model_routing_json = $2, updated_at = $3 \
         WHERE agent_id = $1",
    )
    .bind(&target_agent_id)
    .bind(json!({
        "defaultAuthProvider": "openai",
        "defaultAuthChoice": "default",
        "defaultModel": "openai/gpt-5.4"
    }))
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();

    let refresh = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth/refresh"),
            "runner-test-token",
            json!({
                "runnerId": "runner-material",
                "snapshotId": snapshot_id,
                "payload": {
                    "apiMode": "openai-codex-oauth",
                    "accessToken": "rotated-runner-secret",
                    "refreshToken": "rotated-refresh-secret",
                    "expiresAt": 4102444800000_i64,
                    "model": "openai/gpt-5.4"
                }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(refresh.status(), StatusCode::OK);
    let refreshed_body = read_json(refresh).await;
    assert_eq!(
        refreshed_body["providerAuth"]["payload"]["accessToken"],
        "rotated-runner-secret"
    );

    let fetched_after_refresh = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "runner-material" }),
        ))
        .await
        .unwrap();
    assert_eq!(fetched_after_refresh.status(), StatusCode::OK);
    assert_eq!(
        read_json(fetched_after_refresh).await["providerAuth"]["payload"]["accessToken"],
        "rotated-runner-secret"
    );
    let encrypted_after_refresh: (Vec<u8>,) = sqlx_core::query_as::query_as(
        "SELECT encrypted_payload FROM cloud_agent_provider_auth_snapshots WHERE snapshot_id = $1",
    )
    .bind(&snapshot_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!String::from_utf8_lossy(&encrypted_after_refresh.0).contains("rotated-runner-secret"));
    let refreshed_audit_count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_provider_auth_snapshot_audit WHERE snapshot_id = $1 AND run_id = $2 AND action = 'refreshed'",
    )
    .bind(&snapshot_id)
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(refreshed_audit_count.0, 1);

    sqlx_core::query::query(
        "UPDATE cloud_agent_provider_auth_snapshots \
         SET encryption_key_id = 'foreign-mirror-key:v1' WHERE snapshot_id = $1",
    )
    .bind(&snapshot_id)
    .execute(&pool)
    .await
    .unwrap();
    let incompatible_snapshot = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "runner-material" }),
        ))
        .await
        .unwrap();
    assert_eq!(incompatible_snapshot.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        read_json(incompatible_snapshot).await["errorCode"],
        "provider_auth_not_found"
    );
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
