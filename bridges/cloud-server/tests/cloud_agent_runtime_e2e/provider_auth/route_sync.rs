use super::*;

#[tokio::test]
async fn concurrent_provider_auth_publishes_leave_exactly_one_active_snapshot() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "provider-auth-concurrent-owner", "Owner").await;
    let publish = || {
        router.clone().oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots?intent=explicit",
            &owner.token,
            json!({
                "provider": "openai",
                "authChoice": "default",
                "payload": { "apiKey": "concurrent-secret" }
            }),
        ))
    };
    let (first, second) = tokio::join!(publish(), publish());
    assert_eq!(first.unwrap().status(), StatusCode::CREATED);
    assert_eq!(second.unwrap().status(), StatusCode::CREATED);
    let counts: (i64, i64) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT, COUNT(*) FILTER (WHERE revoked_at IS NULL)::BIGINT \
         FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND provider = 'openai' AND auth_choice = 'default'",
    )
    .bind(&owner.account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(counts, (2, 1));
    let audit_counts: (i64, i64) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*) FILTER (WHERE action = 'created')::BIGINT, \
                COUNT(*) FILTER (WHERE action = 'revoked')::BIGINT \
         FROM cloud_agent_provider_auth_snapshot_audit WHERE account_id = $1",
    )
    .bind(&owner.account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit_counts, (2, 1));
}

#[tokio::test]
async fn publishing_a_provider_alias_replaces_the_active_family_snapshot() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "provider-auth-alias-owner", "Owner").await;
    for (provider, auth_choice) in [
        ("openai", "default"),
        ("openai-codex", "local-active-oauth"),
    ] {
        let response = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-provider-auth/snapshots?intent=explicit",
                &owner.token,
                json!({
                    "provider": provider,
                    "authChoice": auth_choice,
                    "payload": { "accessToken": "alias-secret" }
                }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
    }
    let active: Vec<(String, String)> = sqlx_core::query_as::query_as(
        "SELECT provider, auth_choice FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND provider = ANY($2) AND revoked_at IS NULL",
    )
    .bind(&owner.account_id)
    .bind(vec!["openai", "openai-codex", "codex"])
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        active,
        vec![("openai-codex".to_string(), "local-active-oauth".to_string())]
    );
    let current = router
        .clone()
        .oneshot(get_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/current?provider=openai",
            &owner.token,
        ))
        .await
        .unwrap();
    let current = read_json(current).await;
    assert_eq!(current["snapshot"]["provider"], "openai-codex");
    assert_eq!(current["snapshot"]["authChoice"], "local-active-oauth");
}

#[tokio::test]
async fn provider_auth_removal_falls_back_then_becomes_unconfigured() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "provider-auth-fallback-owner", "Owner").await;
    let publish = |provider: &str, secret: &str| {
        router.clone().oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots?intent=explicit",
            &owner.token,
            json!({
                "provider": provider,
                "authChoice": "default",
                "payload": { "apiKey": secret }
            }),
        ))
    };
    let openai = publish("openai", "openai-secret").await.unwrap();
    let openai_id = read_json(openai).await["snapshotId"]
        .as_str()
        .unwrap()
        .to_string();
    let anthropic = publish("anthropic", "anthropic-secret").await.unwrap();
    let anthropic_id = read_json(anthropic).await["snapshotId"]
        .as_str()
        .unwrap()
        .to_string();
    let revoke = |snapshot_id: &str| {
        router.clone().oneshot(delete_with_token(
            &format!("/v1/cloud/agent-provider-auth/snapshots/{snapshot_id}?intent=explicit"),
            &owner.token,
        ))
    };
    assert_eq!(
        revoke(&anthropic_id).await.unwrap().status(),
        StatusCode::OK
    );
    let fallback = router
        .clone()
        .oneshot(get_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/current",
            &owner.token,
        ))
        .await
        .unwrap();
    let fallback = read_json(fallback).await;
    assert_eq!(fallback["snapshot"]["snapshotId"], openai_id);
    assert_eq!(fallback["snapshot"]["provider"], "openai");
    assert_eq!(revoke(&openai_id).await.unwrap().status(), StatusCode::OK);
    let unconfigured = router
        .clone()
        .oneshot(get_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/current",
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(read_json(unconfigured).await["snapshot"], Value::Null);
}

#[tokio::test]
async fn provider_auth_material_accepts_canonical_route_provider_alias() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "provider-alias-owner", "Owner").await;
    let requester = signup(&router, "provider-alias-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;
    let snapshot = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots?intent=explicit",
            &owner.token,
            json!({
                "provider": "openai-codex",
                "authChoice": "local-active-oauth",
                "payload": { "accessToken": "runner-codex-token", "apiMode": "openai-codex-oauth" }
            }),
        ))
        .await
        .unwrap();
    let snapshot_id = read_json(snapshot).await["snapshotId"]
        .as_str()
        .unwrap()
        .to_string();
    let canonical_current = router.clone().oneshot(get_with_token(
        "/v1/cloud/agent-provider-auth/snapshots/current?provider=openai&authChoice=local-active-oauth",
        &owner.token,
    )).await.unwrap();
    assert_eq!(
        read_json(canonical_current).await["snapshot"]["snapshotId"],
        snapshot_id
    );
    let _ = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
        .await
        .unwrap();
    let mut body = claim_body(&owner, &requester, "msg_provider_alias");
    body["runtimeRoute"] = json!({
        "defaultModel": "openai/gpt-5.6-sol",
        "defaultAuthProvider": "openai",
        "defaultAuthChoice": "local-active-oauth",
        "thinking": "xhigh"
    });
    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            body,
        ))
        .await
        .unwrap();
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
            json!({ "runnerId": "runner-provider-alias" }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    let provider_auth = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "runner-provider-alias" }),
        ))
        .await
        .unwrap();
    let provider_auth = read_json(provider_auth).await;
    assert_eq!(provider_auth["providerAuth"]["snapshotId"], snapshot_id);
    assert_eq!(provider_auth["providerAuth"]["provider"], "openai-codex");
    assert_eq!(
        provider_auth["providerAuth"]["authChoice"],
        "local-active-oauth"
    );
}
