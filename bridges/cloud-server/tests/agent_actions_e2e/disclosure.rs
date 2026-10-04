use kordi_cloud_server::cloud_agent_runtime::provider_auth::{
    provider_auth_for_run, ProviderAuthForRunResult, ServiceProviderAuth,
};

use super::*;

async fn disclosures(group: &Group, account: &TestAccount, replies: Value) -> (StatusCode, Value) {
    call(
        &group.router,
        request(
            "POST",
            "/v1/cloud/agent-runs/disclosures",
            Some(&account.token),
            Some(json!({"sessionId": group.session, "replies": replies})),
        ),
    )
    .await
}

/// The owner's Mac, ready to answer with the current context contract.
async fn ready_mac(group: &Group) {
    query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&group.owner.account_id)
        .execute(&group.pool)
        .await
        .unwrap();
    let (status, body) = call(
        &group.router,
        request(
            "POST",
            "/v1/cloud/agent-runs/desktop/ready",
            Some(&group.owner.token),
            Some(json!({"agentIds": [group.agent()], "contextContract": 2})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn replies_disclose_where_they_ran_and_only_recorded_models() {
    let Some(group) = Group::new("disclosure", false).await else {
        return;
    };
    // A Kordi Cloud run for the requester.
    let cloud_request = format!("ask-{}", group.tag);
    group
        .ask(&group.requester, &cloud_request, "summarize the plan")
        .await;
    let (status, claimed) = call(
        &group.router,
        request(
            "POST",
            "/v1/cloud/agent-runs/claim",
            Some(&group.requester.token),
            Some(json!({
                "requestMessageId": cloud_request, "sessionId": group.session,
                "ownerAccountId": group.owner.account_id,
                "requesterAccountId": group.requester.account_id,
                "prompt": "@Kordi summarize the plan",
                "idempotencyKey": format!("{}:{cloud_request}:{}", group.session, group.owner.account_id),
            })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{claimed}");
    let run_id = claimed["runId"].as_str().unwrap().to_string();
    let run_token = group.lease_for_runner(&run_id).await;
    query("UPDATE cloud_agent_fallback_runs SET runtime_route_json=$2 WHERE run_id=$1")
        .bind(&run_id)
        .bind(json!({"defaultAuthProvider": "anthropic", "defaultAuthChoice": "actions-e2e"}))
        .execute(&group.pool)
        .await
        .unwrap();
    // The provider is recorded when the server resolves credentials.
    let found = provider_auth_for_run(
        &group.pool,
        None,
        vec![ServiceProviderAuth {
            owner_account_id: &group.owner.account_id,
            snapshot_id: "actions-e2e",
            provider: "anthropic",
            auth_choice: "actions-e2e",
            api_key: "synthetic-test-key",
            base_url: "https://api.anthropic.com",
            model: "synthetic-route-model",
            run_id_prefix: None,
        }],
        &run_id,
        RUNNER_ID,
    )
    .await
    .unwrap();
    assert!(matches!(found, ProviderAuthForRunResult::Found(_)));

    let reply = json!([{"key": "cloud-reply", "requestId": cloud_request,
        "ownerAccountId": group.owner.account_id}]);
    let (_, before) = disclosures(&group, &group.member, reply.clone()).await;
    assert_eq!(before["disclosures"][0]["provider"], "anthropic");
    assert_eq!(
        before["disclosures"][0]["model"],
        Value::Null,
        "the requested route model is never reported as the model used"
    );

    // The runner reports the model it called with the reply.
    let (status, completed) = group
        .runner_post(
            &run_id,
            &run_token,
            "complete",
            json!({"runnerId": RUNNER_ID, "responseText": "Here is the plan.",
                "model": "e2e-model-1"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{completed}");

    let (status, body) = disclosures(&group, &group.member, reply.clone()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let cloud = &body["disclosures"][0];
    assert_eq!(cloud["key"], "cloud-reply");
    assert_eq!(cloud["runtime"], "kordi_cloud");
    assert_eq!(cloud["credentials"], "owner");
    assert_eq!(cloud["providerLabel"], "Anthropic");
    assert_eq!(cloud["model"], "e2e-model-1");
    assert_eq!(cloud["ownerAccountId"], group.owner.account_id);
    assert_eq!(cloud["ownerName"], "Olive Owner");
    assert_eq!(cloud["requesterAccountId"], group.requester.account_id);
    assert_eq!(cloud["requesterName"], "Riley Requester");
    assert_eq!(cloud["agentId"], group.agent());

    // Only active members may ask.
    let (status, body) = disclosures(&group, &group.outsider, reply.clone()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["errorCode"], "run_not_found");
    let (status, _) = disclosures(&group, &group.member, json!([])).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let too_many: Vec<Value> = (0..51)
        .map(|index| {
            json!({"key": index.to_string(), "requestId": cloud_request,
            "ownerAccountId": group.owner.account_id})
        })
        .collect();
    let (status, _) = disclosures(&group, &group.member, json!(too_many)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A run on the owner's Mac never reports a provider or model, even if a
    // value were stored for it.
    ready_mac(&group).await;
    let own_request = format!("own-{}", group.tag);
    group.ask(&group.owner, &own_request, "plan my day").await;
    let claim_id = Uuid::new_v4();
    let (status, body) = call(
        &group.router,
        request(
            "POST",
            "/v1/cloud/agent-runs/desktop/claim",
            Some(&group.owner.token),
            Some(json!({"claimId": claim_id, "requestMessageId": own_request,
                "sessionId": group.session, "ownerAccountId": group.owner.account_id,
                "requesterAccountId": group.owner.account_id, "prompt": "@Kordi plan my day",
                "idempotencyKey": format!("desktop:{claim_id}"), "contextContract": 2})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["acquired"], true, "{body}");
    query(
        "UPDATE cloud_agent_fallback_runs SET disclosed_provider='openai', disclosed_model='x'
         WHERE session_id=$1 AND request_message_id=$2",
    )
    .bind(&group.session)
    .bind(&own_request)
    .execute(&group.pool)
    .await
    .unwrap();
    let (status, body) = disclosures(
        &group,
        &group.requester,
        json!([
            {"key": "mac-reply", "requestId": own_request, "ownerAccountId": group.owner.account_id},
            {"key": "unknown", "requestId": "no-such-request", "ownerAccountId": group.owner.account_id},
        ]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let list = body["disclosures"].as_array().unwrap();
    assert_eq!(list.len(), 1, "replies without a run are left out");
    let mac = &list[0];
    assert_eq!(mac["key"], "mac-reply");
    assert_eq!(mac["runtime"], "owner_device");
    for field in ["credentials", "provider", "providerLabel", "model"] {
        assert_eq!(mac[field], Value::Null, "{field}");
    }
}
