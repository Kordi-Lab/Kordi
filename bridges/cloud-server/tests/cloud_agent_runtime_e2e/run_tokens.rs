//! Run-scoped runner credentials: each lease's token works only for its own
//! run and only while that lease is current.

use super::*;

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

#[tokio::test]
async fn a_lease_from_before_run_tokens_accepts_the_runner_token_only_while_current() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "run-token-upgrade-owner", "Owner").await;
    let requester = signup(&router, "run-token-upgrade-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let run_id = claim_queued_run(
        &router,
        &owner,
        &requester,
        &format!("msg_run_token_upgrade_{suffix}"),
    )
    .await;
    canary_lease(&router, "run-token-upgrade-runner", &run_id).await;
    let set_row = |hash_is_null: bool, status: &'static str, lease: &'static str| {
        let pool = pool.clone();
        let run_id = run_id.clone();
        async move {
            let mut sql = String::from(
                "UPDATE cloud_agent_fallback_runs SET status = $2, lease_expires_at = CASE WHEN $3 = 'future' THEN (now() + interval '2 minutes')::text ELSE '2000-01-01T00:00:00+00:00' END",
            );
            if hash_is_null {
                sql.push_str(", runner_run_token_hash = NULL");
            }
            sql.push_str(" WHERE run_id = $1");
            sqlx_core::query::query(&sql)
                .bind(&run_id)
                .bind(status)
                .bind(lease)
                .execute(&pool)
                .await
                .unwrap();
        }
    };
    let running_without_run_token = || {
        router.clone().oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/running"),
            "runner-test-token",
            json!({ "runnerId": "run-token-upgrade-runner" }),
        ))
    };

    // A current lease issued by a server without run tokens has no stored
    // hash; the runner holding it can still finish the run.
    set_row(true, "leased", "future").await;
    let current = running_without_run_token().await.unwrap();
    assert_eq!(current.status(), StatusCode::OK);

    // Once that lease expires, the runner token alone is refused.
    set_row(true, "running", "past").await;
    assert_eq!(
        runner_error_code(running_without_run_token().await.unwrap()).await,
        (StatusCode::UNAUTHORIZED, json!("invalid_run_token"))
    );

    // A run that is not leased or running is refused even with a future lease.
    set_row(true, "queued", "future").await;
    let provider_auth = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "run-token-upgrade-runner" }),
        ))
        .await
        .unwrap();
    assert_eq!(
        runner_error_code(provider_auth).await,
        (StatusCode::UNAUTHORIZED, json!("invalid_run_token"))
    );

    // Every new lease stores a hash, so the runner token alone stops working.
    set_row(false, "leased", "past").await;
    let token = canary_lease(&router, "run-token-upgrade-runner", &run_id).await;
    assert_eq!(
        runner_error_code(running_without_run_token().await.unwrap()).await,
        (StatusCode::UNAUTHORIZED, json!("invalid_run_token"))
    );
    let with_token = router
        .clone()
        .oneshot(post_json_with_run_token(
            &format!("/v1/cloud/agent-runs/{run_id}/running"),
            "runner-test-token",
            &token,
            json!({ "runnerId": "run-token-upgrade-runner" }),
        ))
        .await
        .unwrap();
    assert_eq!(with_token.status(), StatusCode::OK);

    sqlx_core::query::query(
        "UPDATE cloud_agent_fallback_runs SET status = 'cancelled' WHERE run_id = $1",
    )
    .bind(&run_id)
    .execute(&pool)
    .await
    .unwrap();
}
