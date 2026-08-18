use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use kordi_cloud_server::support::{
    bootstrap_support_agent, PendingSupportConfig, SupportProviderAuth, SupportService,
};

use super::*;

#[tokio::test]
async fn support_runs_use_the_dedicated_service_api_key_without_an_owner_snapshot() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let support_agent_id = format!("cloud_agent_kordi_support_{suffix}");
    let support_secret = format!("support-service-secret-{suffix}");
    let support_config = bootstrap_support_agent(
        &pool,
        PendingSupportConfig {
            owner_account_id: format!("acct_kordi_support_{suffix}"),
            owner_email: unique_email("provider-support-owner"),
            agent_id: support_agent_id.clone(),
            name: "Kordi Support".into(),
            subtitle: "Ask questions or suggest improvements".into(),
            inbox: unique_email("provider-support-inbox"),
            provider_auth: SupportProviderAuth::openai_api_key(&support_secret, "gpt-5.6-luna")
                .unwrap(),
        },
    )
    .await
    .unwrap();
    let support_owner = TestAccount {
        account_id: support_config.owner_account_id.clone(),
        token: String::new(),
    };
    let state = Arc::new(
        ServerState::new(pool.clone(), EventBus::noop())
            .with_support(SupportService::new(support_config)),
    );
    let router = test_router(state);
    let requester = signup(&router, "provider-support-requester", "Requester").await;
    let session_id = format!(
        "session:direct-system-agent:{}:{support_agent_id}",
        requester.account_id
    );
    let ordinary_chat = router
        .clone()
        .oneshot(post_json_with_token(
            "/v2/chat/conversations",
            &requester.token,
            json!({
                "client_operation_id": uuid::Uuid::now_v7(),
                "kind": "direct",
                "shared_title": null,
                "client_session_id": format!("session:direct-person:{}:{}", requester.account_id, support_owner.account_id),
                "member_account_ids": [support_owner.account_id.clone()],
            }),
        ))
        .await
        .unwrap();
    assert_eq!(ordinary_chat.status(), StatusCode::FORBIDDEN);
    let conversation = router
        .clone()
        .oneshot(post_json_with_token(
            "/v2/chat/conversations",
            &requester.token,
            json!({
                "client_operation_id": uuid::Uuid::now_v7(),
                "kind": "direct",
                "shared_title": null,
                "client_session_id": session_id.clone(),
                "member_account_ids": [support_owner.account_id.clone()],
            }),
        ))
        .await
        .unwrap();
    assert_eq!(conversation.status(), StatusCode::CREATED);
    let conversation_id = uuid::Uuid::parse_str(
        read_json(conversation).await["conversation"]["id"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let request_message_id = insert_test_message(
        &pool,
        &requester.account_id,
        conversation_id,
        &format!(
            "kordi-cloud-message:{}",
            URL_SAFE_NO_PAD.encode(
                json!({
                    "schemaVersion": 1,
                    "kind": "message",
                    "text": "How do I use Kordi groups?",
                    "targetCloudAgentId": support_agent_id,
                    "targetCloudAgentName": "Kordi Support",
                    "targetCloudAgentOwnerAccountId": support_owner.account_id,
                    "targetCloudAgentOwnerName": "Kordi",
                })
                .to_string(),
            )
        ),
    )
    .await;

    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body_with_session(&support_owner, &requester, &request_message_id, &session_id),
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::OK);
    let run_id = read_json(claim).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    cancel_other_queued_runs(&pool, &run_id).await;

    let snapshot_count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_provider_auth_snapshots WHERE account_id = $1",
    )
    .bind(&support_owner.account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(snapshot_count.0, 0);

    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": "runner-support-service", "canaryRunId": run_id }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);

    let provider_auth = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "runner-support-service" }),
        ))
        .await
        .unwrap();
    assert_eq!(provider_auth.status(), StatusCode::OK);
    let provider_auth = read_json(provider_auth).await;
    assert_eq!(
        provider_auth["providerAuth"]["snapshotId"],
        "support-service-openai"
    );
    assert_eq!(provider_auth["providerAuth"]["provider"], "openai");
    assert_eq!(
        provider_auth["providerAuth"]["authChoice"],
        "support-service-api-key"
    );
    assert_eq!(
        provider_auth["providerAuth"]["payload"]["apiKey"],
        support_secret
    );
    assert_eq!(
        provider_auth["providerAuth"]["payload"]["model"],
        "gpt-5.6-luna"
    );
}
