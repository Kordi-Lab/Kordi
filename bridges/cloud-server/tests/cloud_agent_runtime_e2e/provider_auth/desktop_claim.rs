use super::*;

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
