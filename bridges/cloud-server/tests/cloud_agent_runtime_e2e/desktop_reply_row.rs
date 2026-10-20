use super::*;

fn encode_response(value: Value) -> String {
    format!(
        "kordi-cloud-agent-response:{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
    )
}

#[tokio::test]
async fn desktop_progress_edits_one_reply_row_and_the_terminal_reply_wins() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let owner = signup(&router, "reply-row-owner", "Owner").await;
    let peer = signup(&router, "reply-row-peer", "Requester").await;
    accept_contacts(&router, &owner, &peer).await;
    sqlx_core::query::query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
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
    sqlx_core::query::query("UPDATE cloud_agent_desktop_capabilities SET updated_at=now()+interval '10 minutes' WHERE agent_id=$1").bind(&agent).execute(&pool).await.unwrap();
    let mut ids = [owner.account_id.clone(), peer.account_id.clone()];
    ids.sort();
    let session = format!("session:direct-person:{}:{}", ids[0], ids[1]);
    let conversation = create_test_conversation(
        &pool,
        &owner.account_id,
        &session,
        ConversationKind::Direct,
        vec![peer.account_id.clone()],
    )
    .await;
    let request = json!({"schemaVersion":1,"kind":"message","text":"Write a story","targetCloudAgentId":agent,"targetCloudAgentOwnerAccountId":owner.account_id});
    let wire = insert_test_message(
        &pool,
        &owner.account_id,
        conversation,
        &format!(
            "kordi-cloud-message:{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(request.to_string())
        ),
    )
    .await;
    let claim_id = uuid::Uuid::new_v4();
    let claimed = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/claim",
            &owner.token,
            json!({"claimId":claim_id,"requestMessageId":wire,"sessionId":session,"ownerAccountId":owner.account_id,"requesterAccountId":owner.account_id,"prompt":"Write a story","idempotencyKey":format!("reply-row:{claim_id}")}),
        ))
        .await
        .unwrap();
    let claimed = read_json(claimed).await;
    assert_eq!(claimed["acquired"], true);
    let run = claimed["runId"].as_str().unwrap().to_string();
    let uri = format!("/v1/cloud/agent-runs/desktop/{run}/progress");
    let publish = |state: &str, text: &str| json!({"claimId":claim_id,"clientMessageId":uuid::Uuid::new_v4(),"body":encode_response(json!({"kind":"agent-response","requestId":wire,"text":text,"deliveryState":state}))});
    let post = |body: Value| {
        let router = router.clone();
        let uri = uri.clone();
        let token = owner.token.clone();
        async move {
            let response = router
                .oneshot(post_json_with_token(&uri, &token, body))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            read_json(response).await
        }
    };
    let first = post(publish("processing", "")).await;
    let second = post(publish("processing", "Once upon")).await;
    assert_eq!(
        second["messageId"], first["messageId"],
        "progress edits the same row"
    );
    assert!(second["version"].as_i64() > first["version"].as_i64());
    let terminal = publish("cancelled", "Request stopped.");
    let ended = post(terminal.clone()).await;
    assert_eq!(
        ended["messageId"], first["messageId"],
        "the terminal reply replaces the row"
    );
    assert!(ended["body"].as_str().unwrap() == terminal["body"].as_str().unwrap());
    // A retry of the terminal reply after the run ended answers with the row.
    let retried = post(terminal).await;
    assert_eq!(retried["messageId"], first["messageId"]);
    // A late processing snapshot never reopens the ended request.
    let late = router
        .clone()
        .oneshot(post_json_with_token(
            &uri,
            &owner.token,
            publish("processing", "Once upon a time"),
        ))
        .await
        .unwrap();
    assert_ne!(late.status(), StatusCode::OK);
    let rows: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*) FROM cloud_chat_messages WHERE conversation_id=$1 AND sender_account_id=$2 AND content::text LIKE '%kordi-cloud-agent-response%'",
    )
    .bind(conversation)
    .bind(&owner.account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(rows.0, 1, "one reply row per request");
    let status: (String,) = sqlx_core::query_as::query_as(
        "SELECT status FROM cloud_agent_fallback_runs WHERE run_id=$1",
    )
    .bind(&run)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(status.0, "cancelled");
}
