use super::*;

#[tokio::test]
async fn desktop_and_cloud_share_one_run_and_preserve_queue_during_takeover() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "execution-owner", "Execution Owner").await;
    sqlx_core::query::query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
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
    let session = format!("session:self-agent:{}", uuid::Uuid::new_v4());
    let conversation = create_test_conversation(
        &pool,
        &owner.account_id,
        &session,
        ConversationKind::Ai,
        vec![],
    )
    .await;
    let request_a = insert_test_message(&pool, &owner.account_id, conversation, "Request A").await;
    let request_b = insert_test_message(&pool, &owner.account_id, conversation, "Request B").await;
    let input = |request: &str, claim_id: uuid::Uuid| json!({"requestMessageId":request,"sessionId":session,"ownerAccountId":owner.account_id,"requesterAccountId":owner.account_id,"prompt":"Test execution", "idempotencyKey":format!("attempt:{claim_id}"),"claimId":claim_id});
    let ready = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/ready",
            &owner.token,
            json!({"agentIds":[format!("cloud-agent:{}",owner.account_id)]}),
        ))
        .await
        .unwrap();
    assert_eq!(ready.status(), StatusCode::OK);
    // Use explicit clock state: the database may be reached over a slow test tunnel.
    sqlx_core::query::query("UPDATE cloud_agent_desktop_capabilities SET updated_at=now()+interval '10 minutes' WHERE agent_id=$1")
        .bind(format!("cloud-agent:{}",owner.account_id)).execute(&pool).await.unwrap();
    sqlx_core::query::query("UPDATE cloud_device_presence SET last_heartbeat_at=(now()+interval '10 minutes')::text WHERE account_id=$1")
        .bind(&owner.account_id).execute(&pool).await.unwrap();
    sqlx_core::query::query("UPDATE cloud_chat_messages SET created_at=now()+interval '10 minutes' WHERE message_id::text=$1")
        .bind(&request_a).execute(&pool).await.unwrap();
    let cloud_wait = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &owner.token,
            input(&request_a, uuid::Uuid::new_v4()),
        ))
        .await
        .unwrap();
    assert_eq!(cloud_wait.status(), StatusCode::CONFLICT);

    let claim_one = uuid::Uuid::new_v4();
    let claim_two = uuid::Uuid::new_v4();
    let (one, two) = tokio::join!(
        router.clone().oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/claim",
            &owner.token,
            input(&request_a, claim_one)
        )),
        router.clone().oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/claim",
            &owner.token,
            input(&request_a, claim_two)
        )),
    );
    let one = one.unwrap();
    let two = two.unwrap();
    assert_eq!(one.status(), StatusCode::OK);
    assert_eq!(two.status(), StatusCode::OK);
    let one = read_json(one).await;
    let two = read_json(two).await;
    assert_eq!(one["runId"], two["runId"]);
    assert_ne!(one["acquired"], two["acquired"]);
    let claim_a = if one["acquired"] == true {
        claim_one
    } else {
        claim_two
    };
    let run_a = one["runId"].as_str().unwrap();
    sqlx_core::query::query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()+interval '10 minutes')::text WHERE run_id=$1")
        .bind(run_a).execute(&pool).await.unwrap();
    let claim_b = uuid::Uuid::new_v4();
    let b = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/claim",
            &owner.token,
            input(&request_b, claim_b),
        ))
        .await
        .unwrap();
    assert_eq!(b.status(), StatusCode::OK);
    let b = read_json(b).await;
    let run_b = b["runId"].as_str().unwrap();
    sqlx_core::query::query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()+interval '10 minutes')::text WHERE run_id=$1")
        .bind(run_b).execute(&pool).await.unwrap();
    let admit_a = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/desktop/{run_a}/admit"),
            &owner.token,
            json!({"claimId":claim_a}),
        ))
        .await
        .unwrap();
    assert_eq!(read_json(admit_a).await["admitted"], true);
    let admit_b = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/desktop/{run_b}/admit"),
            &owner.token,
            json!({"claimId":claim_b}),
        ))
        .await
        .unwrap();
    assert_eq!(read_json(admit_b).await["admitted"], false);

    sqlx_core::query::query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()-interval '1 second')::text WHERE run_id=$1").bind(run_a).execute(&pool).await.unwrap();
    let renew = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/desktop/{run_a}/renew"),
            &owner.token,
            json!({"claimId":claim_a}),
        ))
        .await
        .unwrap();
    assert_eq!(renew.status(), StatusCode::CONFLICT);
    let leased = kordi_cloud_server::cloud_agent_runtime::runs::lease_canary_run(
        &pool,
        "takeover-runner",
        run_a,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(leased.run_id, run_a);
    let late_body = format!("kordi-cloud-agent-response:{}",base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json!({"kind":"agent-response","requestId":request_a,"text":"Late desktop result","deliveryState":"complete"}).to_string()));
    let late = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/desktop/{run_a}/progress"),
            &owner.token,
            json!({"claimId":claim_a,"clientMessageId":uuid::Uuid::new_v4(),"body":late_body}),
        ))
        .await
        .unwrap();
    assert_eq!(late.status(), StatusCode::CONFLICT);
    let still_queued = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/desktop/{run_b}/admit"),
            &owner.token,
            json!({"claimId":claim_b}),
        ))
        .await
        .unwrap();
    assert_eq!(read_json(still_queued).await["admitted"], false);
    kordi_cloud_server::cloud_agent_runtime::runs::complete_run(
        &pool,
        run_a,
        "takeover-runner",
        "Cloud result",
    )
    .await
    .unwrap();
    let admitted = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/desktop/{run_b}/admit"),
            &owner.token,
            json!({"claimId":claim_b}),
        ))
        .await
        .unwrap();
    assert_eq!(read_json(admitted).await["admitted"], true);
    let result_body = format!("kordi-cloud-agent-response:{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json!({"kind":"agent-response","requestId":request_b,"text":"Desktop result","deliveryState":"complete"}).to_string()));
    let publication = json!({"claimId":claim_b,"clientMessageId":uuid::Uuid::new_v4(),"body":result_body});
    let first = router.clone().oneshot(post_json_with_token(&format!("/v1/cloud/agent-runs/desktop/{run_b}/progress"), &owner.token, publication.clone())).await.unwrap();
    assert_eq!(first.status(),StatusCode::OK);
    let first = read_json(first).await;
    let retry = router.clone().oneshot(post_json_with_token(&format!("/v1/cloud/agent-runs/desktop/{run_b}/progress"), &owner.token, publication)).await.unwrap();
    assert_eq!(retry.status(),StatusCode::OK);
    assert_eq!(read_json(retry).await["messageId"], first["messageId"]);

    // An online app without a ready runtime must not block a new cloud request.
    let ready_off = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/ready",
            &owner.token,
            json!({"agentIds":[]}),
        ))
        .await
        .unwrap();
    assert_eq!(ready_off.status(), StatusCode::OK);
    let other_session = format!("session:self-agent:{}", uuid::Uuid::new_v4());
    let other = create_test_conversation(
        &pool,
        &owner.account_id,
        &other_session,
        ConversationKind::Ai,
        vec![],
    )
    .await;
    let request_c =
        insert_test_message(&pool, &owner.account_id, other, "Independent request").await;
    let mut cloud_input = input(&request_c, uuid::Uuid::new_v4());
    cloud_input["sessionId"] = json!(other_session);
    let cloud = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &owner.token,
            cloud_input,
        ))
        .await
        .unwrap();
    assert_eq!(cloud.status(), StatusCode::OK);
    assert_eq!(read_json(cloud).await["executionBackend"], "cloud");
}
