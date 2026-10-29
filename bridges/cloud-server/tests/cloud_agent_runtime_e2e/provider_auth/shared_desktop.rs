//! A contact's mention uses the authenticated owner Mac's chosen account.
use super::route_safety::{publish, set_provider_auth_env};
use super::*;
use sqlx_core::query::query;

#[tokio::test]
async fn shared_desktop_claim_preserves_owner_auth_for_new_and_queued_runs() {
    let Some(pool) = try_pool().await else { return };
    set_provider_auth_env();
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let owner = signup(&router, "shared-auth-owner", "Owner").await;
    let peer = signup(&router, "shared-auth-peer", "Peer").await;
    accept_contacts(&router, &owner, &peer).await;
    query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&owner.account_id)
        .execute(&pool)
        .await
        .unwrap();
    let agent = format!("cloud-agent:{}", owner.account_id);
    let ready = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/ready",
            &owner.token,
            json!({"agentIds":[agent]}),
        ))
        .await
        .unwrap();
    assert_eq!(ready.status(), StatusCode::OK);
    query("UPDATE cloud_agent_desktop_capabilities SET updated_at=now()+interval '10 minutes' WHERE agent_id=$1")
        .bind(&agent).execute(&pool).await.unwrap();
    publish(
        &router,
        &owner,
        json!({
            "provider":"openai", "authChoice":"cloud-api-key:owner",
            "payload":{"apiKey":"synthetic-owner-key","baseUrl":"https://api.openai.com/v1"}
        }),
    )
    .await;
    publish(
        &router,
        &owner,
        json!({
            "provider":"openai", "authChoice":"cloud-api-key:other",
            "payload":{"apiKey":"synthetic-other-key","baseUrl":"https://api.openai.com/v1"}
        }),
    )
    .await;
    let route = json!({"defaultModel":"openai/gpt-4.1-mini",
        "defaultAuthProvider":"openai","defaultAuthChoice":"cloud-api-key:owner"});

    for queued in [true, false] {
        let session = format!("session:group:{}", uuid::Uuid::new_v4());
        let conversation = create_test_conversation(
            &pool,
            &owner.account_id,
            &session,
            ConversationKind::Group,
            vec![peer.account_id.clone()],
        )
        .await;
        let logical = uuid::Uuid::new_v4().to_string();
        let message = json!({"kind":"group-message","groupId":session,
            "groupSpaceId":session,"createdByAccountId":owner.account_id,
            "actor":{"accountId":peer.account_id,"displayName":"Peer","role":"person"},
            "participants":[{"accountId":owner.account_id,"displayName":"Owner","role":"admin"},
                {"accountId":peer.account_id,"displayName":"Peer","role":"person"}],
            "message":{"schemaVersion":1,"kind":"message","id":logical,
                "senderAccountId":peer.account_id,"senderKind":"human","text":"Reply once",
                "createdAtMs":chrono::Utc::now().timestamp_millis(),"targetCloudAgentId":agent,
                "targetCloudAgentOwnerAccountId":owner.account_id}});
        let encoded = format!(
            "kordi-cloud-group:{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(message.to_string())
        );
        let request = insert_test_message(&pool, &peer.account_id, conversation, &encoded).await;
        let claim_id = uuid::Uuid::new_v4();
        let body = json!({"claimId":claim_id,"requestMessageId":request,"sessionId":session,
            "ownerAccountId":owner.account_id,"requesterAccountId":peer.account_id,
            "prompt":"Reply once","idempotencyKey":format!("shared-auth:{claim_id}"),
            "runtimeRoute":route});
        if queued {
            // A peer's cloud claim must not choose an owner's credential.
            let mut input = body.clone();
            input["requestMessageId"] = json!(logical);
            let input = serde_json::from_value(input).unwrap();
            let held = kordi_cloud_server::cloud_agent_runtime::runs::claim_run_held_for_desktop(
                &pool,
                &input,
                chrono::Utc::now() + chrono::Duration::minutes(10),
            )
            .await
            .unwrap();
            let stored: (Value,) = sqlx_core::query_as::query_as(
                "SELECT runtime_route_json FROM cloud_agent_fallback_runs WHERE run_id=$1",
            )
            .bind(&held.run_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_ne!(stored.0["defaultAuthChoice"], "cloud-api-key:owner");
        }
        let denied = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-runs/desktop/claim",
                &peer.token,
                body.clone(),
            ))
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        let claimed = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-runs/desktop/claim",
                &owner.token,
                body,
            ))
            .await
            .unwrap();
        assert_eq!(claimed.status(), StatusCode::OK);
        let claimed = read_json(claimed).await;
        assert_eq!(claimed["acquired"], true);
        let run = claimed["runId"].as_str().unwrap();
        let path = format!("/v1/cloud/agent-runs/{run}/desktop/provider-auth");
        let denied = router
            .clone()
            .oneshot(post_json_with_token(
                &path,
                &peer.token,
                json!({"claimId":claim_id}),
            ))
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::CONFLICT);
        let material = router
            .clone()
            .oneshot(post_json_with_token(
                &path,
                &owner.token,
                json!({"claimId":claim_id}),
            ))
            .await
            .unwrap();
        let status = material.status();
        let material = read_json(material).await;
        assert_eq!(status, StatusCode::OK, "queued={queued}: {material}");
        assert_eq!(
            material["providerAuth"]["authChoice"],
            "cloud-api-key:owner"
        );
        assert_eq!(
            material["providerAuth"]["payload"]["apiKey"],
            "synthetic-owner-key"
        );
        query("UPDATE cloud_agent_fallback_runs SET status='cancelled' WHERE run_id=$1")
            .bind(run)
            .execute(&pool)
            .await
            .unwrap();
    }
}
