use super::*;

fn decode_agent_response(body: &str) -> serde_json::Value {
    let encoded = body
        .strip_prefix("kordi-cloud-agent-response:")
        .expect("agent response envelope");
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .expect("base64 agent response");
    serde_json::from_slice(&decoded).expect("JSON agent response")
}

#[tokio::test]
async fn concurrent_complete_and_fail_commit_one_matching_terminal_state() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "terminal-race-owner", "Owner").await;
    let requester = signup(&router, "terminal-race-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;

    let request_message_id = format!("msg_terminal_race_{}", uuid::Uuid::new_v4().simple());
    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, &request_message_id),
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::OK);
    let run_id = read_json(claim).await["runId"]
        .as_str()
        .unwrap()
        .to_string();

    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": "terminal-race", "canaryRunId": run_id }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    let running = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/running"),
            "runner-test-token",
            json!({ "runnerId": "terminal-race" }),
        ))
        .await
        .unwrap();
    assert_eq!(running.status(), StatusCode::OK);

    let complete = router.clone().oneshot(post_json_with_runner_token(
        &format!("/v1/cloud/agent-runs/{run_id}/complete"),
        "runner-test-token",
        json!({ "runnerId": "terminal-race", "responseText": "completion won" }),
    ));
    let fail = router.clone().oneshot(post_json_with_runner_token(
        &format!("/v1/cloud/agent-runs/{run_id}/fail"),
        "runner-test-token",
        json!({
            "runnerId": "terminal-race",
            "errorCode": "runner_error",
            "message": "failure won"
        }),
    ));
    let (complete, fail) = tokio::join!(complete, fail);
    let complete = complete.unwrap();
    let fail = fail.unwrap();
    assert_eq!(
        [complete.status(), fail.status()]
            .into_iter()
            .filter(|status| *status == StatusCode::OK)
            .count(),
        1,
    );
    assert_eq!(
        [complete.status(), fail.status()]
            .into_iter()
            .filter(|status| *status == StatusCode::NOT_FOUND)
            .count(),
        1,
    );

    let (status, response_message_id): (String, Option<String>) = sqlx_core::query_as::query_as(
        "SELECT status, response_message_id FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let response_message_id = response_message_id.expect("terminal response message");
    let (message_count,): (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*) FROM cloud_messages WHERE client_message_id = $1",
    )
    .bind(format!("cloud-agent-run:{run_id}:{}", requester.account_id))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(message_count, 1);

    let (body,): (String,) =
        sqlx_core::query_as::query_as("SELECT body FROM cloud_messages WHERE message_id = $1")
            .bind(&response_message_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let envelope = decode_agent_response(&body);
    assert_eq!(envelope["requestId"], request_message_id);
    assert_eq!(
        envelope["deliveryState"],
        if status == "completed" {
            "complete"
        } else {
            "failed"
        },
    );
    let (sync_count,): (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*) FROM cloud_sync_events \
         WHERE account_id = $1 AND event_type = 'message.upsert' AND message_id = $2",
    )
    .bind(&requester.account_id)
    .bind(&response_message_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(sync_count, 1);
}

#[tokio::test]
async fn requester_cancellation_is_terminal_before_runner_completion() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "cancel-run-owner", "Owner").await;
    let requester = signup(&router, "cancel-run-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;
    let request_message_id = format!("msg_cancel_run_{}", uuid::Uuid::new_v4().simple());

    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, &request_message_id),
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::OK);
    let run_id = read_json(claim).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": "cancel-run", "canaryRunId": run_id }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    let running = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/running"),
            "runner-test-token",
            json!({ "runnerId": "cancel-run" }),
        ))
        .await
        .unwrap();
    assert_eq!(running.status(), StatusCode::OK);

    let cancelled = router
        .clone()
        .oneshot(post_with_token(
            &format!("/v1/cloud/agent-runs/request/{request_message_id}/cancel"),
            &requester.token,
        ))
        .await
        .unwrap();
    assert_eq!(cancelled.status(), StatusCode::OK);
    assert_eq!(read_json(cancelled).await["run"]["status"], "cancelled");

    let late_complete = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/complete"),
            "runner-test-token",
            json!({ "runnerId": "cancel-run", "responseText": "too late" }),
        ))
        .await
        .unwrap();
    assert_eq!(late_complete.status(), StatusCode::NOT_FOUND);
    let lookup = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/agent-runs/request/{request_message_id}"),
            &requester.token,
        ))
        .await
        .unwrap();
    assert_eq!(lookup.status(), StatusCode::OK);
    assert_eq!(read_json(lookup).await["run"]["status"], "cancelled");
    let (message_count,): (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*) FROM cloud_messages WHERE client_message_id = $1",
    )
    .bind(format!("cloud-agent-run:{run_id}:{}", requester.account_id))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(message_count, 0);
}
