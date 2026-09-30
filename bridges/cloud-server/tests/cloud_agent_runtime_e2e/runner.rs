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
    let run_token = lease_run_token(&lease_body);

    let running = router
        .clone()
        .oneshot(post_json_with_run_token(
            &format!("/v1/cloud/agent-runs/{run_id}/running"),
            "runner-test-token",
            &run_token,
            json!({ "runnerId": "runner-a" }),
        ))
        .await
        .unwrap();
    assert_eq!(running.status(), StatusCode::OK);
    let running_body = read_json(running).await;
    assert_eq!(running_body["run"]["status"], "running");
    assert!(running_body["run"].get("runToken").is_none());

    let complete = router
        .clone()
        .oneshot(post_json_with_run_token(
            &format!("/v1/cloud/agent-runs/{run_id}/complete"),
            "runner-test-token",
            &run_token,
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
    let run_token = lease_run_token(&leased);

    let failed = router
        .clone()
        .oneshot(post_json_with_run_token(
            &format!("/v1/cloud/agent-runs/{run_id}/fail"),
            "runner-test-token",
            &run_token,
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

async fn claim_queued_run(
    router: &axum::Router,
    owner: &TestAccount,
    requester: &TestAccount,
    request_message_id: &str,
) -> String {
    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(owner, requester, request_message_id),
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::OK);
    read_json(claim).await["runId"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn canary_lease(router: &axum::Router, runner_id: &str, run_id: &str) -> String {
    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": runner_id, "canaryRunId": run_id }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    let leased = read_json(lease).await;
    assert_eq!(leased["run"]["runId"], run_id);
    lease_run_token(&leased)
}

async fn runner_error_code(response: axum::response::Response) -> (StatusCode, Value) {
    let status = response.status();
    (status, read_json(response).await["errorCode"].clone())
}

#[tokio::test]
async fn run_specific_runner_endpoints_require_the_leased_runs_token() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "run-token-owner", "Owner").await;
    let requester = signup(&router, "run-token-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;
    let suffix = uuid::Uuid::new_v4().simple().to_string();

    let run_a = claim_queued_run(
        &router,
        &owner,
        &requester,
        &format!("msg_run_token_a_{suffix}"),
    )
    .await;
    let run_b = claim_queued_run(
        &router,
        &owner,
        &requester,
        &format!("msg_run_token_b_{suffix}"),
    )
    .await;
    let token_a = canary_lease(&router, "run-token-runner-a", &run_a).await;
    let token_b = canary_lease(&router, "run-token-runner-b", &run_b).await;
    assert_ne!(token_a, token_b);

    let stored: (Option<String>,) = sqlx_core::query_as::query_as(
        "SELECT runner_run_token_hash FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&run_a)
    .fetch_one(&pool)
    .await
    .unwrap();
    let stored = stored.0.expect("lease stores the run token hash");
    assert_ne!(stored, token_a);
    assert_eq!(
        stored,
        kordi_cloud_server::cloud_agent_runtime::runs::run_tokens::hash_run_token(&token_a)
    );

    let runner_a = json!({ "runnerId": "run-token-runner-a" });
    let endpoints = [
        ("running", runner_a.clone()),
        ("provider-auth", runner_a.clone()),
        (
            "context",
            json!({ "runnerId": "run-token-runner-a", "tool": "read_session", "arguments": {} }),
        ),
        (
            "complete",
            json!({ "runnerId": "run-token-runner-a", "responseText": "done" }),
        ),
        (
            "fail",
            json!({ "runnerId": "run-token-runner-a", "errorCode": "x", "message": "x" }),
        ),
        (
            "artifacts",
            export_body("run-token-runner-a", "notes.md", "notes.md", b"notes"),
        ),
        (
            "plan-card",
            json!({ "runnerId": "run-token-runner-a", "request": {} }),
        ),
        (
            "task-operator",
            json!({ "runnerId": "run-token-runner-a", "toolCallId": "call", "arguments": {} }),
        ),
        (
            "subsession-progress",
            json!({ "runnerId": "run-token-runner-a", "toolCallId": "call", "toolName": "read" }),
        ),
    ];
    for (endpoint, body) in &endpoints {
        let uri = format!("/v1/cloud/agent-runs/{run_a}/{endpoint}");
        let missing = router
            .clone()
            .oneshot(post_json_with_runner_token(
                &uri,
                "runner-test-token",
                body.clone(),
            ))
            .await
            .unwrap();
        assert_eq!(
            runner_error_code(missing).await,
            (StatusCode::UNAUTHORIZED, json!("invalid_run_token")),
            "{endpoint} without a run token"
        );
        let other_run = router
            .clone()
            .oneshot(post_json_with_run_token(
                &uri,
                "runner-test-token",
                &token_b,
                body.clone(),
            ))
            .await
            .unwrap();
        assert_eq!(
            runner_error_code(other_run).await,
            (StatusCode::UNAUTHORIZED, json!("invalid_run_token")),
            "{endpoint} with another run's token"
        );
        let wrong_runner = router
            .clone()
            .oneshot(post_json_with_run_token(
                &uri,
                "wrong-runner-token",
                &token_a,
                body.clone(),
            ))
            .await
            .unwrap();
        assert_eq!(
            runner_error_code(wrong_runner).await,
            (StatusCode::UNAUTHORIZED, json!("invalid_runner_token")),
            "{endpoint} with a wrong runner token"
        );
    }

    let running = router
        .clone()
        .oneshot(post_json_with_run_token(
            &format!("/v1/cloud/agent-runs/{run_a}/running"),
            "runner-test-token",
            &token_a,
            runner_a.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(running.status(), StatusCode::OK);
    let provider_auth = router
        .clone()
        .oneshot(post_json_with_run_token(
            &format!("/v1/cloud/agent-runs/{run_a}/provider-auth"),
            "runner-test-token",
            &token_a,
            runner_a.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(
        runner_error_code(provider_auth).await,
        (StatusCode::NOT_FOUND, json!("provider_auth_not_found"))
    );

    // A new lease replaces the credential; the earlier one stops working.
    sqlx_core::query::query(
        "UPDATE cloud_agent_fallback_runs SET lease_expires_at = $2 WHERE run_id = $1",
    )
    .bind(&run_a)
    .bind("2000-01-01T00:00:00+00:00")
    .execute(&pool)
    .await
    .unwrap();
    let expired = router
        .clone()
        .oneshot(post_json_with_run_token(
            &format!("/v1/cloud/agent-runs/{run_a}/running"),
            "runner-test-token",
            &token_a,
            runner_a.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(
        runner_error_code(expired).await,
        (StatusCode::UNAUTHORIZED, json!("invalid_run_token"))
    );
    let token_c = canary_lease(&router, "run-token-runner-c", &run_a).await;
    assert_ne!(token_c, token_a);
    let replaced = router
        .clone()
        .oneshot(post_json_with_run_token(
            &format!("/v1/cloud/agent-runs/{run_a}/running"),
            "runner-test-token",
            &token_a,
            json!({ "runnerId": "run-token-runner-c" }),
        ))
        .await
        .unwrap();
    assert_eq!(
        runner_error_code(replaced).await,
        (StatusCode::UNAUTHORIZED, json!("invalid_run_token"))
    );
    let current = router
        .clone()
        .oneshot(post_json_with_run_token(
            &format!("/v1/cloud/agent-runs/{run_a}/running"),
            "runner-test-token",
            &token_c,
            json!({ "runnerId": "run-token-runner-c" }),
        ))
        .await
        .unwrap();
    assert_eq!(current.status(), StatusCode::OK);

    sqlx_core::query::query(
        "UPDATE cloud_agent_fallback_runs SET status = 'cancelled' WHERE run_id IN ($1, $2)",
    )
    .bind(&run_a)
    .bind(&run_b)
    .execute(&pool)
    .await
    .unwrap();
}
