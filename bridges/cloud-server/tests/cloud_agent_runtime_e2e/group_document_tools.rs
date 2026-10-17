use super::*;

/// Issue 1808: the Mac's claim of a group request must carry the document
/// tools, `create_document` included, whoever asked the owner's agent.
#[tokio::test]
async fn a_macs_group_claim_carries_create_document() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let owner = signup(&router, "group-doc-tools-owner", "Owner").await;
    let member = signup(&router, "group-doc-tools-member", "Member").await;
    accept_contacts(&router, &owner, &member).await;
    let session = format!("session:group:{}", uuid::Uuid::new_v4());
    let conversation = create_test_conversation(
        &pool,
        &owner.account_id,
        &session,
        ConversationKind::Group,
        vec![member.account_id.clone()],
    )
    .await;
    sqlx_core::query::query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&owner.account_id)
        .execute(&pool)
        .await
        .unwrap();
    let participants = json!([
        {"accountId":owner.account_id,"displayName":"Owner","agentDisplayName":"Kordi"},
        {"accountId":member.account_id,"displayName":"Member","agentDisplayName":"Kordi"}
    ]);
    for requester in [&owner, &member] {
        let ready = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-runs/desktop/ready",
                &owner.token,
                json!({"agentIds":[format!("cloud-agent:{}", owner.account_id)]}),
            ))
            .await
            .unwrap();
        assert_eq!(ready.status(), StatusCode::OK);
        let request_id = format!("request-{}", uuid::Uuid::new_v4());
        let message = json!({
            "id": request_id, "senderAccountId": requester.account_id, "senderKind": "human",
            "text": "@Kordi create a doc with the launch plan", "createdAtMs": 1,
            "mentions": [{"label":"Kordi","targetKind":"agent",
                "targetIdentityId": format!("agent:cloud-agent:{}", owner.account_id),
                "humanId": owner.account_id, "agentId": format!("cloud-agent:{}", owner.account_id),
                "startUtf16":0,"lengthUtf16":6,"displayText":"@Kordi"}]
        });
        let body = encode_test_cloud_group_envelope(json!({
            "kind":"group-message","groupId":session,"createdByAccountId":owner.account_id,
            "actor":{"accountId":requester.account_id,"displayName":"Requester"},
            "participants":participants,"message":message
        }));
        let wire_id = insert_test_message(&pool, &requester.account_id, conversation, &body).await;
        let mut input = claim_body_with_session(&owner, requester, &request_id, &session);
        input["claimId"] = json!(uuid::Uuid::new_v4());
        input["requestMessageId"] = json!(wire_id);
        let claim = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-runs/desktop/claim",
                &owner.token,
                input,
            ))
            .await
            .unwrap();
        assert_eq!(claim.status(), StatusCode::OK);
        let claim = read_json(claim).await;
        assert_eq!(claim["acquired"], true, "{claim}");
        let names: Vec<&str> = claim["connectorTools"]
            .as_array()
            .unwrap_or_else(|| panic!("no connectorTools in {claim}"))
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert!(
            names.contains(&"create_document"),
            "requester {}: {claim}",
            requester.account_id
        );
    }
}
