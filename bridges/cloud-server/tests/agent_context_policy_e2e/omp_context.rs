//! The OMP runtime reads a run's structured input through the context route
//! instead of the leased prompt, so that route applies an AI access change
//! made after the claim too.

use super::*;

#[tokio::test]
async fn an_omp_context_after_an_access_change_rebuilds_the_input() {
    let Some(group) = Group::new("policy-omp").await else {
        return;
    };
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let tag = group.tag.clone();
    let (status, _) = group
        .set_ai_access(&group.owner, json!({"history_scope": "recent"}))
        .await;
    assert_eq!(status, StatusCode::OK);
    group
        .say(
            &group.member,
            &format!("m-{tag}"),
            &format!("SECRET_M_{tag}"),
        )
        .await;
    group
        .say(
            &group.member2,
            &format!("c-{tag}"),
            &format!("CHATTER_M2_{tag}"),
        )
        .await;
    let request_id = format!("q-{tag}");
    group
        .ask(
            &group.requester,
            &request_id,
            &format!("CURRENT_{tag}"),
            None,
        )
        .await;
    let (status, run) = group.claim_cloud(&group.requester, &request_id).await;
    assert_eq!(status, StatusCode::OK, "{run}");
    let run_id = run["runId"].as_str().unwrap().to_string();
    // Positive control: the stored input holds recent messages from everyone.
    let (stored,): (Value,) =
        query_as("SELECT omp_input_json FROM cloud_agent_fallback_runs WHERE run_id=$1")
            .bind(&run_id)
            .fetch_one(&group.pool)
            .await
            .unwrap();
    assert!(
        stored.to_string().contains(&format!("SECRET_M_{tag}")),
        "{stored}"
    );

    let (status, published) = call(
        &group.router,
        request(
            "POST",
            "/v1/cloud/agent-provider-auth/snapshots?intent=explicit",
            Some(&group.owner.token),
            Some(json!({"provider": "openai", "authChoice": "default",
                "payload": {"accessToken": "synthetic-omp-policy-test"}})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{published}");
    let (snapshot,): (String,) = query_as(
        "SELECT snapshot_id FROM cloud_agent_provider_auth_snapshots
         WHERE account_id=$1 AND revoked_at IS NULL",
    )
    .bind(&group.owner.account_id)
    .fetch_one(&group.pool)
    .await
    .unwrap();
    let run_token = group.lease_for_runner(&run_id).await;
    query(
        "UPDATE cloud_agent_fallback_runs SET status='running', execution_backend='cloud',
             runtime_route_json=$2 WHERE run_id=$1",
    )
    .bind(&run_id)
    .bind(
        json!({"defaultModel": "openai/fixture-model", "defaultAuthProvider": "openai",
        "defaultAuthChoice": "default"}),
    )
    .execute(&group.pool)
    .await
    .unwrap();

    // After the claim, the member opts out and the owner narrows the group
    // back to messages sent to agents.
    let (status, _) = group
        .set_ai_access(&group.member, json!({"exclude_my_messages": true}))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = group
        .set_ai_access(&group.owner, json!({"history_scope": "mentions"}))
        .await;
    assert_eq!(status, StatusCode::OK);

    let mut context = request(
        "POST",
        &format!("/v1/cloud/agent-runs/{run_id}/omp-context"),
        Some(RUNNER_TOKEN),
        Some(
            json!({"runnerId": RUNNER_ID, "provider": "openai", "model": "fixture-model",
            "authSnapshotId": snapshot}),
        ),
    );
    context
        .headers_mut()
        .insert("x-kordi-run-token", run_token.parse().unwrap());
    let (status, context) = call(&group.router, context).await;
    assert_eq!(status, StatusCode::OK, "{context}");
    let text = context.to_string();
    for left_out in [format!("SECRET_M_{tag}"), format!("CHATTER_M2_{tag}")] {
        assert!(!text.contains(&left_out), "{text}");
    }
    assert!(text.contains(&format!("CURRENT_{tag}")), "{text}");
    // The stored input is left as it was.
    let (unchanged,): (Value,) =
        query_as("SELECT omp_input_json FROM cloud_agent_fallback_runs WHERE run_id=$1")
            .bind(&run_id)
            .fetch_one(&group.pool)
            .await
            .unwrap();
    assert_eq!(unchanged, stored);
}
