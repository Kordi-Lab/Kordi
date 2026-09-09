use super::*;
use sqlx_core::query::query;

#[tokio::test]
async fn chat_calendar_enforces_owner_disclosure_membership_and_live_runner_scope() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "calendar-owner", "Owner").await;
    let peer = signup(&router, "calendar-peer", "Peer").await;
    accept_contacts(&router, &owner, &peer).await;
    let event = json!({"id":"saved","title":"Saved appointment","startAt":"2026-09-09T12:00:00Z","sourceIds":[]});
    query("INSERT INTO cloud_calendar_events(account_id,event_id,payload) VALUES($1,'saved',$2)")
        .bind(&owner.account_id)
        .bind(&event)
        .execute(&pool)
        .await
        .unwrap();
    let read = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/calendar/read",
            &owner.token,
            json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(read.status(), StatusCode::OK);
    assert_eq!(
        read_json(read).await["events"][0]["title"],
        "Saved appointment"
    );
    query("INSERT INTO cloud_account_digests(account_id,snapshot_json) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET snapshot_json=excluded.snapshot_json")
        .bind(&peer.account_id).bind(json!({"calendarCandidates":[{"id":"proposal","title":"Tentative appointment"}]})).execute(&pool).await.unwrap();
    let empty = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/calendar/read",
            &peer.token,
            json!({}),
        ))
        .await
        .unwrap();
    let empty = read_json(empty).await;
    assert_eq!(empty["status"], "empty");
    assert_eq!(empty["events"], json!([]));
    let spoof = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/calendar/read",
            &peer.token,
            json!({"accountId":owner.account_id}),
        ))
        .await
        .unwrap();
    assert!(!spoof.status().is_success());

    let session = format!("session:group:calendar-{}", uuid::Uuid::new_v4().simple());
    let conversation = create_test_conversation(
        &pool,
        &owner.account_id,
        &session,
        ConversationKind::Group,
        vec![peer.account_id.clone()],
    )
    .await;
    let owner_request = insert_test_message(
        &pool,
        &owner.account_id,
        conversation,
        "Please share my saved calendar here",
    )
    .await;
    let peer_request = insert_test_message(
        &pool,
        &peer.account_id,
        conversation,
        "Read the owner's calendar",
    )
    .await;
    let input =
        json!({"sessionId":session,"requestMessageId":owner_request,"shareInConversation":true});
    for (token, request, allowed) in [
        (&owner.token, input.clone(), true),
        (
            &owner.token,
            json!({"sessionId":session,"requestMessageId":owner_request}),
            false,
        ),
        (
            &owner.token,
            json!({"sessionId":session,"requestMessageId":peer_request,"shareInConversation":true}),
            false,
        ),
        (&peer.token, input.clone(), false),
    ] {
        let response = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/calendar/read",
                token,
                request,
            ))
            .await
            .unwrap();
        assert_eq!(response.status().is_success(), allowed);
    }
    // Model arguments cannot change the run's admitted account or conversation.
    let run = insert_leased_scheduled_run(&pool, &owner, &owner, &session, "calendar-runner").await;
    query("UPDATE cloud_agent_fallback_runs SET request_message_id=$2,execution_backend='cloud' WHERE run_id=$1")
        .bind(&run).bind(&owner_request).execute(&pool).await.unwrap();
    let uri = format!("/v1/cloud/agent-runs/{run}/context");
    for (runner, arguments, allowed) in [
        ("calendar-runner", json!({"shareInConversation":true}), true),
        ("other-runner", json!({"shareInConversation":true}), false),
        ("calendar-runner", json!({}), false),
        (
            "calendar-runner",
            json!({"accountId":peer.account_id,"shareInConversation":true}),
            false,
        ),
        ("calendar-runner", input.clone(), false),
    ] {
        let response = router
            .clone()
            .oneshot(post_json_with_runner_token(
                &uri,
                "runner-test-token",
                json!({"runnerId":runner,"tool":"read_calendar","arguments":arguments}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status().is_success(), allowed);
        if allowed {
            assert_eq!(read_json(response).await["events"][0]["status"], "saved");
        }
    }
    query("UPDATE cloud_agent_fallback_runs SET requester_account_id=$2 WHERE run_id=$1")
        .bind(&run)
        .bind(&peer.account_id)
        .execute(&pool)
        .await
        .unwrap();
    let denied = router.clone().oneshot(post_json_with_runner_token(&uri, "runner-test-token", json!({"runnerId":"calendar-runner","tool":"read_calendar","arguments":{"shareInConversation":true}}))).await.unwrap();
    assert_eq!(denied.status(), StatusCode::NOT_FOUND);
    // An agent-authored message cannot grant disclosure, even under the owner's account.
    query("UPDATE cloud_chat_messages SET message_kind='assistant' WHERE message_id::text=$1")
        .bind(&owner_request)
        .execute(&pool)
        .await
        .unwrap();
    let denied = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/calendar/read",
            &owner.token,
            input.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    query("UPDATE cloud_chat_messages SET message_kind='text' WHERE message_id::text=$1")
        .bind(&owner_request)
        .execute(&pool)
        .await
        .unwrap();
    query("UPDATE cloud_chat_conversation_members SET membership_state='left' WHERE conversation_id=$1 AND account_id=$2")
        .bind(conversation).bind(&owner.account_id).execute(&pool).await.unwrap();
    let denied = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/calendar/read",
            &owner.token,
            input,
        ))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
}
