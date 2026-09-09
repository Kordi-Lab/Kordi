use super::*;

#[tokio::test]
async fn owner_can_stop_from_another_device_but_members_and_stale_executions_cannot() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "stop-owner", "Owner").await;
    let peer = signup(&router, "stop-peer", "Peer").await;
    let outsider = signup(&router, "stop-outsider", "Outsider").await;
    accept_contacts(&router, &owner, &peer).await;
    let parent_id = format!("session:group:{}", uuid::Uuid::new_v4());
    let parent = create_test_conversation(
        &pool,
        &owner.account_id,
        &parent_id,
        ConversationKind::Group,
        vec![peer.account_id.clone()],
    )
    .await;
    let id = uuid::Uuid::new_v4();
    sqlx_core::query::query("INSERT INTO cloud_agent_subsessions(subsession_id,parent_conversation_id,parent_session_id,parent_request_id,owner_account_id,publisher_device_id,agent_id,title,status,execution_started_at) VALUES($1,$2,$3,'initial',$4,'another-device',$5,'Stop fixture','running',to_timestamp(1))")
        .bind(id).bind(parent).bind(&parent_id).bind(&owner.account_id)
        .bind(format!("cloud-agent:{}",owner.account_id)).execute(&pool).await.unwrap();
    let uri = format!("/v1/cloud/agent-subsessions/{id}/stop");
    for status in ["queued", "leased", "running", "completed"] {
        let run = uuid::Uuid::new_v4().to_string();
        sqlx_core::query::query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at,subsession_id) VALUES($1,$1,$1,$2,$3,$3,$4,'Stop test',now()::text,now()::text,$5)")
            .bind(run).bind(id.to_string()).bind(&owner.account_id).bind(status).bind(id)
            .execute(&pool).await.unwrap();
    }
    for account in [&peer, &outsider] {
        let response = router
            .clone()
            .oneshot(post_json_with_token(
                &uri,
                &account.token,
                json!({"expectedStartedAtMs":1000}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
    let stale = router
        .clone()
        .oneshot(post_json_with_token(
            &uri,
            &owner.token,
            json!({"expectedStartedAtMs":2000}),
        ))
        .await
        .unwrap();
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    let uri_read = format!("/v1/cloud/agent-subsessions/{id}");
    let before = read_json(
        router
            .clone()
            .oneshot(get_with_token(&uri_read, &owner.token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(before["status"], "running");
    let response = router
        .clone()
        .oneshot(post_json_with_token(
            &uri,
            &owner.token,
            json!({"expectedStartedAtMs":1000}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let stopped = read_json(response).await;
    assert_eq!(stopped["status"], "stopped");
    assert_eq!(stopped["live"], false);
    let statuses: Vec<(String,)> = sqlx_core::query_as::query_as(
        "SELECT status FROM cloud_agent_fallback_runs WHERE subsession_id=$1 ORDER BY status",
    )
    .bind(id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        statuses,
        vec![
            ("cancelled".into(),),
            ("cancelled".into(),),
            ("cancelled".into(),),
            ("completed".into(),)
        ]
    );
    let repeated = read_json(
        router
            .clone()
            .oneshot(post_json_with_token(
                &uri,
                &owner.token,
                json!({"expectedStartedAtMs":1000}),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        repeated["version"], stopped["version"],
        "Stop is idempotent"
    );
    sqlx_core::query::query("UPDATE cloud_chat_conversation_members SET membership_state='left' WHERE conversation_id=$1 AND account_id=$2")
        .bind(parent).bind(&owner.account_id).execute(&pool).await.unwrap();
    let denied = router
        .clone()
        .oneshot(post_json_with_token(
            &uri,
            &owner.token,
            json!({"expectedStartedAtMs":1000}),
        ))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::NOT_FOUND);
}
