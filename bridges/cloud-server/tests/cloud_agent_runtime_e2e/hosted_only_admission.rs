//! Runs bound to a hosted-only account skip the owner Mac admission window,
//! because only the cloud runner can hold that credential. Only the route the
//! run executes counts, so a contact's own request route cannot skip it.

use super::*;

/// Signs up an owner whose Mac is online and ready for its default agent.
async fn owner_with_ready_mac(
    router: &axum::Router,
    pool: &sqlx_postgres::PgPool,
    prefix: &str,
) -> TestAccount {
    let owner = signup(router, prefix, "Owner").await;
    sqlx_core::query::query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&owner.account_id)
        .execute(pool)
        .await
        .unwrap();
    let online = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/online", &owner.token))
        .await
        .unwrap();
    assert_eq!(online.status(), StatusCode::OK);
    let ready = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/ready",
            &owner.token,
            json!({ "agentIds": [format!("cloud-agent:{}", owner.account_id)] }),
        ))
        .await
        .unwrap();
    assert_eq!(ready.status(), StatusCode::OK);
    owner
}

/// Explicit clock state keeps the owner Mac ready and the requests inside its
/// admission window, even over a slow database connection.
async fn hold_admission_window(
    pool: &sqlx_postgres::PgPool,
    owner: &TestAccount,
    requests: Vec<String>,
) {
    sqlx_core::query::query(
        "UPDATE cloud_agent_desktop_capabilities SET updated_at=now()+interval '10 minutes' \
         WHERE agent_id=$1",
    )
    .bind(format!("cloud-agent:{}", owner.account_id))
    .execute(pool)
    .await
    .unwrap();
    sqlx_core::query::query(
        "UPDATE cloud_device_presence SET last_heartbeat_at=(now()+interval '10 minutes')::text \
         WHERE account_id=$1",
    )
    .bind(&owner.account_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx_core::query::query(
        "UPDATE cloud_chat_messages SET created_at=now()+interval '10 minutes' \
         WHERE message_id::text = ANY($1)",
    )
    .bind(requests)
    .execute(pool)
    .await
    .unwrap();
}

fn hosted_route(auth_choice: &str) -> Value {
    json!({
        "defaultModel": "openai/gpt-5.6-sol",
        "defaultAuthProvider": "openai",
        "defaultAuthChoice": auth_choice
    })
}

#[tokio::test]
async fn hosted_only_account_runs_skip_the_owner_mac_admission_window() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = owner_with_ready_mac(&router, &pool, "hosted-only-owner").await;
    let session = format!("session:self-agent:{}", uuid::Uuid::new_v4());
    let conversation = create_test_conversation(
        &pool,
        &owner.account_id,
        &session,
        ConversationKind::Ai,
        vec![],
    )
    .await;
    let local_request =
        insert_test_message(&pool, &owner.account_id, conversation, "Local request").await;
    let hosted_request =
        insert_test_message(&pool, &owner.account_id, conversation, "Hosted request").await;
    hold_admission_window(
        &pool,
        &owner,
        vec![local_request.clone(), hosted_request.clone()],
    )
    .await;
    let claim = |request: &str, auth_choice: &str| {
        router.clone().oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &owner.token,
            json!({
                "requestMessageId": request,
                "sessionId": session,
                "ownerAccountId": owner.account_id,
                "requesterAccountId": owner.account_id,
                "prompt": "Answer from the selected account",
                "runtimeRoute": hosted_route(auth_choice),
                "idempotencyKey": format!("hosted-only:{request}")
            }),
        ))
    };

    let local = claim(&local_request, "profile:work").await.unwrap();
    assert_eq!(local.status(), StatusCode::CONFLICT);
    assert_eq!(read_json(local).await["errorCode"], "owner_online");

    let hosted = claim(&hosted_request, "cloud-api-key:work").await.unwrap();
    assert_eq!(hosted.status(), StatusCode::OK);
    let run_id = read_json(hosted).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": "runner-hosted-only", "canaryRunId": run_id }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    let lease = read_json(lease).await;
    assert_eq!(lease["run"]["runId"], run_id.as_str());
    assert_eq!(
        lease["run"]["runtimeRoute"]["defaultAuthChoice"],
        "cloud-api-key:work"
    );
}

#[tokio::test]
async fn a_contacts_hosted_only_route_does_not_skip_the_owner_mac() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = owner_with_ready_mac(&router, &pool, "hosted-only-contact-owner").await;
    let contact = signup(&router, "hosted-only-contact", "Contact").await;
    accept_contacts(&router, &contact, &owner).await;
    let conversation = create_test_conversation(
        &pool,
        &contact.account_id,
        &format!(
            "session:direct-person:{}:{}",
            contact.account_id, owner.account_id
        ),
        ConversationKind::Direct,
        vec![owner.account_id.clone()],
    )
    .await;
    // The store orders the two accounts in a direct session ID.
    let (session,): (String,) = sqlx_core::query_as::query_as(
        "SELECT legacy_session_id FROM cloud_chat_conversations WHERE conversation_id = $1",
    )
    .bind(conversation)
    .fetch_one(&pool)
    .await
    .unwrap();
    let request =
        insert_test_message(&pool, &contact.account_id, conversation, "Contact request").await;
    hold_admission_window(&pool, &owner, vec![request.clone()]).await;

    // The owner's agent runs with the owner's route, so the contact's
    // hosted-only choice is ignored and the ready owner Mac keeps the turn.
    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &contact.token,
            json!({
                "requestMessageId": request,
                "sessionId": session,
                "ownerAccountId": owner.account_id,
                "requesterAccountId": contact.account_id,
                "prompt": "Answer from the owner's account",
                "runtimeRoute": hosted_route("cloud-api-key:owner-key"),
                "idempotencyKey": format!("hosted-only-contact:{request}")
            }),
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::CONFLICT);
    assert_eq!(read_json(claim).await["errorCode"], "owner_online");
}
