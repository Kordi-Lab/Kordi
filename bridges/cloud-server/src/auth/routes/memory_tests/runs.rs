//! Replay state and runner memory routes against a real Postgres.

use super::*;

#[tokio::test]
async fn omp_state_count_and_clear() {
    let Some(fx) = fixture().await else { return };
    let (status, body) = fx.send("GET", "/v1/cloud/agent-runs/omp-state", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "runCount": 0 }));

    for _ in 0..2 {
        let run_id = fx.leased_run("omp-state-runner").await;
        query(
            "INSERT INTO cloud_agent_omp_state \
             (run_id, owner_account_id, session_id, execution_agent_id, route_json, auth_snapshot_id, \
              provider, model, response_message_id, state_json) \
             VALUES ($1, $2, 'memory-test-session', $3, '{}'::jsonb, 'snap_test', 'openai', 'gpt-test', \
                     'msg_test', '{\"schemaVersion\":1,\"messages\":[]}'::jsonb)",
        )
        .bind(&run_id)
        .bind(&fx.account_id)
        .bind(format!("cloud-agent:{}", fx.account_id))
        .execute(&fx.pool)
        .await
        .unwrap();
    }
    let (_, body) = fx.send("GET", "/v1/cloud/agent-runs/omp-state", None).await;
    assert_eq!(body, json!({ "runCount": 2 }));
    let (status, body) = fx
        .send("DELETE", "/v1/cloud/agent-runs/omp-state", None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "deleted": 2 }));
    let (_, body) = fx.send("GET", "/v1/cloud/agent-runs/omp-state", None).await;
    assert_eq!(body, json!({ "runCount": 0 }));
    assert_eq!(
        fx.audit_metadata("omp_state_cleared").await,
        vec![json!({ "deleted": 2 })]
    );
}

#[tokio::test]
async fn runner_reads_and_saves_memories_for_a_leased_run() {
    let Some(fx) = fixture().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", RUNNER_TOKEN);
    let runner_auth = format!("Bearer {RUNNER_TOKEN}");
    let runner_id = format!("runner_{}", uuid::Uuid::new_v4().simple());
    let run_id = fx.leased_run(&runner_id).await;
    fx.send(
        "POST",
        "/v1/cloud/memory",
        Some(memory_body("Use the staging bucket")),
    )
    .await;

    let (status, body) = fx
        .send_with_auth(
            "GET",
            &format!("/v1/cloud/agent-runs/{run_id}/memory?runnerId={runner_id}"),
            None,
            &runner_auth,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["memories"].as_array().unwrap().len(), 1);
    assert_eq!(
        body["settings"],
        json!({ "memoryEnabled": true, "excludeSensitive": true })
    );

    let mut save = memory_body("Run the smoke test before deploys");
    save["source"] = json!("repeated_failure");
    save["runnerId"] = json!(runner_id);
    let (status, saved) = fx
        .send_with_auth(
            "POST",
            &format!("/v1/cloud/agent-runs/{run_id}/memory"),
            Some(save.clone()),
            &runner_auth,
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(saved["memory"]["source"], "repeated_failure");
    let memory_id = saved["memory"]["memoryId"].as_str().unwrap().to_string();
    let (_, list) = fx.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(list["memories"].as_array().unwrap().len(), 2);
    let audits = fx.audit_metadata("memory_saved").await;
    assert_eq!(
        audits.last().unwrap(),
        &json!({
            "memoryId": memory_id,
            "scope": "conversation",
            "source": "repeated_failure",
            "runId": run_id,
            "via": "runner",
        })
    );

    let mut sensitive = save.clone();
    sensitive["text"] = json!("Remember my password is hunter2");
    let (status, error) = fx
        .send_with_auth(
            "POST",
            &format!("/v1/cloud/agent-runs/{run_id}/memory"),
            Some(sensitive),
            &runner_auth,
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error["errorCode"], "memory_rejected");

    // Another runner, or a missing token, cannot reach the account's memories.
    let (status, _) = fx
        .send_with_auth(
            "GET",
            &format!("/v1/cloud/agent-runs/{run_id}/memory?runnerId=other-runner"),
            None,
            &runner_auth,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = fx
        .send_with_auth(
            "GET",
            &format!("/v1/cloud/agent-runs/{run_id}/memory?runnerId={runner_id}"),
            None,
            "Bearer wrong",
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    fx.send(
        "PUT",
        "/v1/cloud/memory/settings",
        Some(json!({ "memoryEnabled": false })),
    )
    .await;
    let (status, error) = fx
        .send_with_auth(
            "POST",
            &format!("/v1/cloud/agent-runs/{run_id}/memory"),
            Some(save),
            &runner_auth,
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["errorCode"], "memory_disabled");
}
