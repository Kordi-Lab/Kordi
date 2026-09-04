use super::*;

#[tokio::test]
async fn runner_leases_marks_running_and_completes_claimed_run() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "runner-owner", "Owner").await;
    let requester = signup(&router, "runner-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;

    let snapshot = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots?intent=explicit",
            &owner.token,
            json!({
                "provider": "openai",
                "authChoice": "default",
                "payload": { "accessToken": "runner-secret" }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(snapshot.status(), StatusCode::CREATED);

    let offline = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
        .await
        .unwrap();
    assert_eq!(offline.status(), StatusCode::OK);

    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_runner_lifecycle"),
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::OK);
    let claimed = read_json(claim).await;
    let run_id = claimed["runId"].as_str().unwrap().to_string();
    cancel_other_queued_runs(&pool, &run_id).await;

    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": "runner-a" }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    let lease_body = read_json(lease).await;
    assert_eq!(lease_body["run"]["runId"], run_id);
    assert_eq!(lease_body["run"]["status"], "leased");
    assert_eq!(lease_body["run"]["providerAuthAvailable"], true);

    let running = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/running"),
            "runner-test-token",
            json!({ "runnerId": "runner-a" }),
        ))
        .await
        .unwrap();
    assert_eq!(running.status(), StatusCode::OK);
    assert_eq!(read_json(running).await["run"]["status"], "running");

    let complete = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/complete"),
            "runner-test-token",
            json!({ "runnerId": "runner-a", "responseText": "runner skeleton complete" }),
        ))
        .await
        .unwrap();
    assert_eq!(complete.status(), StatusCode::OK);
    let completed = read_json(complete).await;
    assert_eq!(completed["run"]["status"], "completed");
    let response_message_id = completed["run"]["responseMessageId"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(uuid::Uuid::parse_str(&response_message_id).is_ok());
    let body = message_body(&pool, &response_message_id).await;
    assert!(body.starts_with("kordi-cloud-agent-response:"));
    let encoded = body.trim_start_matches("kordi-cloud-agent-response:");
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .unwrap();
    let envelope: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
    assert_eq!(envelope["kind"], "agent-response");
    assert_eq!(envelope["requestId"], "msg_runner_lifecycle");
    assert_eq!(envelope["text"], "runner skeleton complete");
    assert_eq!(envelope["deliveryState"], "complete");
}

#[tokio::test]
async fn runner_canary_lease_only_claims_requested_run_id() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "runner-canary-owner", "Owner").await;
    let requester = signup(&router, "runner-canary-requester", "Requester").await;
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

    let older_claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_runner_canary_older"),
        ))
        .await
        .unwrap();
    assert_eq!(older_claim.status(), StatusCode::OK);
    let older_run_id = read_json(older_claim).await["runId"]
        .as_str()
        .unwrap()
        .to_string();

    let target_claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_runner_canary_target"),
        ))
        .await
        .unwrap();
    assert_eq!(target_claim.status(), StatusCode::OK);
    let target_run_id = read_json(target_claim).await["runId"]
        .as_str()
        .unwrap()
        .to_string();

    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": "runner-canary", "canaryRunId": target_run_id }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    let leased = read_json(lease).await;
    assert_eq!(leased["run"]["runId"], target_run_id);

    let older_status: (String,) = sqlx_core::query_as::query_as(
        "SELECT status FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&older_run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(older_status.0, "queued");

    sqlx_core::query::query(
        "UPDATE cloud_agent_fallback_runs SET status = 'cancelled' WHERE run_id IN ($1, $2)",
    )
    .bind(&older_run_id)
    .bind(&target_run_id)
    .execute(&pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn expired_runner_lease_is_reclaimed_by_exactly_one_runtime() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "runner-expiry-owner", "Owner").await;
    let requester = signup(&router, "runner-expiry-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;

    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_runner_expired_lease"),
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::OK);
    let run_id = read_json(claim).await["runId"]
        .as_str()
        .unwrap()
        .to_string();

    let first_lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": "runner-expired", "canaryRunId": run_id }),
        ))
        .await
        .unwrap();
    assert_eq!(first_lease.status(), StatusCode::OK);
    assert_eq!(read_json(first_lease).await["run"]["runId"], run_id);

    sqlx_core::query::query(
        "UPDATE cloud_agent_fallback_runs \
         SET lease_expires_at = $1 \
         WHERE run_id = $2",
    )
    .bind("2000-01-01T00:00:00+00:00")
    .bind(&run_id)
    .execute(&pool)
    .await
    .unwrap();

    let runner_b = router.clone().oneshot(post_json_with_runner_token(
        "/v1/cloud/agent-runs/lease",
        "runner-test-token",
        json!({ "runnerId": "runner-b", "canaryRunId": run_id }),
    ));
    let runner_c = router.clone().oneshot(post_json_with_runner_token(
        "/v1/cloud/agent-runs/lease",
        "runner-test-token",
        json!({ "runnerId": "runner-c", "canaryRunId": run_id }),
    ));
    let (runner_b, runner_c) = tokio::join!(runner_b, runner_c);
    let runner_b = runner_b.unwrap();
    let runner_c = runner_c.unwrap();
    assert_eq!(runner_b.status(), StatusCode::OK);
    assert_eq!(runner_c.status(), StatusCode::OK);
    let runner_b = read_json(runner_b).await;
    let runner_c = read_json(runner_c).await;
    assert_eq!(
        [runner_b["run"].is_object(), runner_c["run"].is_object()]
            .into_iter()
            .filter(|leased| *leased)
            .count(),
        1,
    );

    sqlx_core::query::query(
        "UPDATE cloud_agent_fallback_runs SET status = 'cancelled' WHERE run_id = $1",
    )
    .bind(&run_id)
    .execute(&pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn runner_lease_reports_missing_provider_auth_and_fail_marks_run_failed() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "runner-missing-provider-owner", "Owner").await;
    let requester = signup(&router, "runner-missing-provider-requester", "Requester").await;
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
            claim_body(&owner, &requester, "msg_runner_missing_provider"),
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::OK);
    let claimed = read_json(claim).await;
    let expected_run_id = claimed["runId"].as_str().unwrap().to_string();
    cancel_other_queued_runs(&pool, &expected_run_id).await;

    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": "runner-missing-provider" }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    let leased = read_json(lease).await;
    let run_id = leased["run"]["runId"].as_str().unwrap().to_string();
    assert_eq!(run_id, expected_run_id);
    assert_eq!(leased["run"]["providerAuthAvailable"], false);

    let failed = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/fail"),
            "runner-test-token",
            json!({
                "runnerId": "runner-missing-provider",
                "errorCode": "missing_provider_auth",
                "message": "owner has not enabled Cloud provider auth"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(failed.status(), StatusCode::OK);
    let failed_body = read_json(failed).await;
    assert_eq!(failed_body["run"]["status"], "failed");
    assert_eq!(failed_body["run"]["errorCode"], "missing_provider_auth");
    let response_message_id = failed_body["run"]["responseMessageId"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(uuid::Uuid::parse_str(&response_message_id).is_ok());
    let body = message_body(&pool, &response_message_id).await;
    assert!(body.starts_with("kordi-cloud-agent-response:"));
    let encoded = body.trim_start_matches("kordi-cloud-agent-response:");
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .unwrap();
    let envelope: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
    assert_eq!(envelope["kind"], "agent-response");
    assert_eq!(envelope["requestId"], "msg_runner_missing_provider");
    assert_eq!(envelope["deliveryState"], "failed");
    assert_eq!(envelope["text"], "No provider configured yet.");
}

#[tokio::test]
async fn runner_endpoints_reject_user_tokens_and_bad_runner_tokens() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = test_router(state);
    let account = signup(&router, "runner-auth-user", "User").await;

    let user_token_response = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            &account.token,
            json!({ "runnerId": "runner-a" }),
        ))
        .await
        .unwrap();
    assert_eq!(user_token_response.status(), StatusCode::UNAUTHORIZED);

    let bad_runner_token_response = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "wrong-runner-token",
            json!({ "runnerId": "runner-a" }),
        ))
        .await
        .unwrap();
    assert_eq!(bad_runner_token_response.status(), StatusCode::UNAUTHORIZED);
}
