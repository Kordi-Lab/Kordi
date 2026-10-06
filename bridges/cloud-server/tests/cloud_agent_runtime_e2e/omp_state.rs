use super::*;
use sqlx_core::{query::query, query_as::query_as};

#[tokio::test]
async fn omp_state_is_private_route_scoped_and_fenced_with_completion() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let owner = signup(&router, "omp-owner", "Owner").await;
    let peer = signup(&router, "omp-peer", "Requester").await;
    accept_contacts(&router, &owner, &peer).await;
    let published = router.clone().oneshot(post_json_with_token(
        "/v1/cloud/agent-provider-auth/snapshots?intent=explicit", &owner.token,
        json!({"provider":"openai","authChoice":"default","payload":{"accessToken":"synthetic-omp-test"}}),
    )).await.unwrap();
    assert_eq!(published.status(), StatusCode::CREATED);
    let snapshot = read_json(published).await["snapshot"]["snapshotId"]
        .as_str()
        .map(str::to_owned);
    // Snapshot APIs have returned both an envelope and the record over time;
    // query only synthetic fixture metadata to bind the exact saved choice.
    let snapshot = if let Some(id) = snapshot {
        id
    } else {
        query_as::<_,(String,)>("SELECT snapshot_id FROM cloud_agent_provider_auth_snapshots WHERE account_id=$1 AND revoked_at IS NULL")
            .bind(&owner.account_id).fetch_one(&pool).await.unwrap().0
    };
    router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
        .await
        .unwrap();
    let claimed = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &peer.token,
            claim_body(&owner, &peer, "omp-first-request"),
        ))
        .await
        .unwrap();
    assert_eq!(claimed.status(), StatusCode::OK);
    let run = read_json(claimed).await["runId"]
        .as_str()
        .unwrap()
        .to_owned();
    let route = json!({"defaultModel":"openai/fixture-model","defaultAuthProvider":"openai","defaultAuthChoice":"default"});
    query("UPDATE cloud_agent_fallback_runs SET status='running',execution_backend='cloud',claimed_by='omp-runner',lease_expires_at=(now()+interval '2 minutes')::text,runtime_route_json=$2 WHERE run_id=$1")
        .bind(&run).bind(&route).execute(&pool).await.unwrap();
    let context_body = json!({"runnerId":"omp-runner","provider":"openai","model":"fixture-model","authSnapshotId":snapshot});
    let denied = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/{run}/omp-context"),
            &owner.token,
            context_body.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    let state = json!({"schemaVersion":1,"replayable":true,"provider":"openai","model":"fixture-model","authSnapshotId":snapshot,
        "messages":[{"role":"user","content":[{"type":"text","text":"question"}],"timestamp":1},
            {"role":"assistant","content":[{"type":"text","text":"answer","textSignature":"private-replay-signature"}],"timestamp":2}]});
    let complete = json!({"runnerId":"omp-runner","responseText":"answer","ompState":state});
    let completed = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run}/complete"),
            "runner-test-token",
            complete.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(completed.status(), StatusCode::OK);
    let response = read_json(completed).await["run"]["responseMessageId"]
        .as_str()
        .unwrap()
        .to_owned();
    let (stored,): (Value,) =
        query_as("SELECT state_json FROM cloud_agent_omp_state WHERE run_id=$1")
            .bind(&run)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored, state);
    assert!(!message_body(&pool, &response)
        .await
        .contains("private-replay-signature"));
    let late = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run}/complete"),
            "runner-test-token",
            complete,
        ))
        .await
        .unwrap();
    assert_eq!(late.status(), StatusCode::NOT_FOUND);
    let next_claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &peer.token,
            claim_body(&owner, &peer, "omp-next-request"),
        ))
        .await
        .unwrap();
    assert_eq!(next_claim.status(), StatusCode::OK);
    let next = read_json(next_claim).await["runId"]
        .as_str()
        .unwrap()
        .to_owned();
    query("UPDATE cloud_agent_fallback_runs SET status='running',execution_backend='cloud',claimed_by='omp-runner',lease_expires_at=(now()+interval '2 minutes')::text,runtime_route_json=$2,omp_input_json=$3 WHERE run_id=$1")
        .bind(&next).bind(&route).bind(json!({"prompt":"next","history":[{"ids":[response],"version":1,"message":{"role":"user","content":"answer"}}]}))
        .execute(&pool).await.unwrap();
    let replay = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{next}/omp-context"),
            "runner-test-token",
            context_body.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(replay.status(), StatusCode::OK);
    let replay = read_json(replay).await;
    assert_eq!(replay["messages"], state["messages"]);
    assert_eq!(replay["prompt"], "next");
    // A private hide after admission invalidates both frozen canonical content
    // and structured replay, so saved signatures cannot revive hidden content.
    query("INSERT INTO cloud_chat_message_visibility(account_id,message_id) VALUES($1,$2::uuid)")
        .bind(&owner.account_id)
        .bind(&response)
        .execute(&pool)
        .await
        .unwrap();
    let hidden = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{next}/omp-context"),
            "runner-test-token",
            context_body.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(hidden.status(), StatusCode::OK);
    let hidden = read_json(hidden).await;
    assert_eq!(hidden["messages"], json!([]));
    assert!(!hidden.to_string().contains("private-replay-signature"));
    // The current queued request is also fenced against a later private hide.
    query("UPDATE cloud_agent_fallback_runs SET omp_input_json=omp_input_json || $2::jsonb WHERE run_id=$1")
        .bind(&next).bind(json!({"request":{"id":response,"version":1}})).execute(&pool).await.unwrap();
    let hidden_request = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{next}/omp-context"),
            "runner-test-token",
            context_body.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(hidden_request.status(), StatusCode::NOT_FOUND);
    query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()-interval '1 minute')::text WHERE run_id=$1").bind(&next).execute(&pool).await.unwrap();
    let expired = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{next}/omp-context"),
            "runner-test-token",
            context_body,
        ))
        .await
        .unwrap();
    assert_eq!(expired.status(), StatusCode::NOT_FOUND);
    let (count,): (i64,) = query_as("SELECT count(*) FROM cloud_agent_omp_state WHERE run_id=$1")
        .bind(&run)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}
