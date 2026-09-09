use super::*;

#[tokio::test]
async fn legacy_and_structured_group_requests_reject_unrelated_executors() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let sender = signup(&router, "group-target-sender", "Sender").await;
    let peer = signup(&router, "group-target-peer", "Peer").await;
    accept_contacts(&router, &sender, &peer).await;
    let session = format!("session:group:{}", uuid::Uuid::new_v4());
    let conversation = create_test_conversation(
        &pool,
        &sender.account_id,
        &session,
        ConversationKind::Group,
        vec![peer.account_id.clone()],
    )
    .await;
    let participants = json!([
        {"accountId":sender.account_id,"displayName":"Sender","agentDisplayName":"Kordi"},
        {"accountId":peer.account_id,"displayName":"Peer","agentDisplayName":"Kordi"}
    ]);
    for structured in [false, true] {
        let request_id = format!("request-{}", uuid::Uuid::new_v4());
        // No top-level target, matching old clients and structured-only messages.
        let mut message = json!({"id":request_id,"senderAccountId":sender.account_id,"text":"@Kordi check status","createdAtMs":1});
        let (correct, wrong) = if structured {
            (&peer, &sender)
        } else {
            (&sender, &peer)
        };
        if structured {
            message["mentions"] = json!([{"label":"Kordi","targetKind":"agent","targetIdentityId":format!("agent:cloud-agent:{}",peer.account_id),"humanId":peer.account_id,"agentId":format!("cloud-agent:{}",peer.account_id),"startUtf16":0,"lengthUtf16":6,"displayText":"@Kordi"}]);
        }
        let body = encode_test_cloud_group_envelope(
            json!({"kind":"group-message","groupId":session,"createdByAccountId":sender.account_id,"actor":participants[0],"participants":participants,"message":message}),
        );
        let wire_id = insert_test_message(&pool, &sender.account_id, conversation, &body).await;
        let wrong_input = claim_body_with_session(wrong, &sender, &request_id, &session);
        let wrong_cloud = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-runs/claim",
                &sender.token,
                wrong_input.clone(),
            ))
            .await
            .unwrap();
        assert_eq!(wrong_cloud.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            read_json(wrong_cloud).await["errorCode"],
            "agent_not_available"
        );
        // Give the wrong Mac a valid capability: target validation, not readiness,
        // must prevent it from executing a received group message.
        sqlx_core::query::query(
            "UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1",
        )
        .bind(&wrong.account_id)
        .execute(&pool)
        .await
        .unwrap();
        let ready = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-runs/desktop/ready",
                &wrong.token,
                json!({"agentIds":[format!("cloud-agent:{}",wrong.account_id)]}),
            ))
            .await
            .unwrap();
        assert_eq!(ready.status(), StatusCode::OK);
        let mut desktop_input = wrong_input.clone();
        desktop_input["claimId"] = json!(uuid::Uuid::new_v4());
        desktop_input["requestMessageId"] = json!(wire_id);
        let desktop = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-runs/desktop/claim",
                &wrong.token,
                desktop_input,
            ))
            .await
            .unwrap();
        assert_eq!(desktop.status(), StatusCode::FORBIDDEN);
        let (wrong_runs,): (i64,) = sqlx_core::query_as::query_as("SELECT count(*) FROM cloud_agent_fallback_runs WHERE request_message_id=$1 AND owner_account_id=$2").bind(&request_id).bind(&wrong.account_id).fetch_one(&pool).await.unwrap();
        assert_eq!(wrong_runs, 0);
        // Remove this test's previous readiness before testing the intended Cloud path.
        sqlx_core::query::query("DELETE FROM cloud_agent_desktop_capabilities WHERE device_id IN(SELECT device_id FROM cloud_devices WHERE account_id=ANY($1))").bind(vec![sender.account_id.clone(),peer.account_id.clone()]).execute(&pool).await.unwrap();
        let correct_input = claim_body_with_session(correct, &sender, &request_id, &session);
        for _ in 0..2 {
            let accepted = router
                .clone()
                .oneshot(post_json_with_token(
                    "/v1/cloud/agent-runs/claim",
                    &sender.token,
                    correct_input.clone(),
                ))
                .await
                .unwrap();
            assert_eq!(accepted.status(), StatusCode::OK);
        }
        let (runs,): (i64,) = sqlx_core::query_as::query_as(
            "SELECT count(*) FROM cloud_agent_fallback_runs WHERE request_message_id=$1",
        )
        .bind(&request_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            runs, 1,
            "one intended run after retries and wrong-owner claims"
        );
    }
}

#[tokio::test]
async fn sender_group_alias_can_read_only_the_admitted_owners_calendar() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "group-calendar-owner", "Owner").await;
    let peer = signup(&router, "group-calendar-peer", "Peer").await;
    accept_contacts(&router, &owner, &peer).await;
    let session = format!("session:group:{}", uuid::Uuid::new_v4());
    let conversation = create_test_conversation(
        &pool,
        &owner.account_id,
        &session,
        ConversationKind::Group,
        vec![peer.account_id.clone()],
    )
    .await;
    let request = format!("request-{}", uuid::Uuid::new_v4());
    let body = encode_test_cloud_group_envelope(json!({
        "kind":"group-message", "groupId":session, "createdByAccountId":owner.account_id,
        "actor":{"accountId":owner.account_id,"displayName":"Owner"},
        "participants":[{"accountId":owner.account_id,"displayName":"Owner","agentDisplayName":"Kordi"},{"accountId":peer.account_id,"displayName":"Peer","agentDisplayName":"Kordi"}],
        "message":{"id":request,"senderAccountId":owner.account_id,"senderKind":"human","text":"@Kordi what is on my calendar?","createdAtMs":1}
    }));
    insert_test_message(&pool, &owner.account_id, conversation, &body).await;
    sqlx_core::query::query("INSERT INTO cloud_calendar_events(account_id,event_id,payload) VALUES($1,'saved',$2)")
        .bind(&owner.account_id)
        .bind(json!({"id":"saved","title":"Calendar integration fixture","startAt":"2026-09-09T12:00:00Z","sourceIds":[]}))
        .execute(&pool).await.unwrap();
    let wrong = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &owner.token,
            claim_body_with_session(&peer, &owner, &request, &session),
        ))
        .await
        .unwrap();
    assert_eq!(wrong.status(), StatusCode::FORBIDDEN);
    let admitted = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &owner.token,
            claim_body_with_session(&owner, &owner, &request, &session),
        ))
        .await
        .unwrap();
    assert_eq!(admitted.status(), StatusCode::OK);
    let run = read_json(admitted).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    let leased = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({"runnerId":"group-calendar-runner","canaryRunId":run}),
        ))
        .await
        .unwrap();
    assert_eq!(leased.status(), StatusCode::OK);
    assert_eq!(read_json(leased).await["run"]["runId"], run);
    let read = router.clone().oneshot(post_json_with_runner_token(&format!("/v1/cloud/agent-runs/{run}/context"), "runner-test-token", json!({"runnerId":"group-calendar-runner","tool":"read_calendar","arguments":{"shareInConversation":true}}))).await.unwrap();
    assert_eq!(read.status(), StatusCode::OK);
    assert_eq!(
        read_json(read).await["events"][0]["title"],
        "Calendar integration fixture"
    );
    let (count,): (i64,) = sqlx_core::query_as::query_as(
        "SELECT count(*) FROM cloud_agent_fallback_runs WHERE request_message_id=$1",
    )
    .bind(&request)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
}
