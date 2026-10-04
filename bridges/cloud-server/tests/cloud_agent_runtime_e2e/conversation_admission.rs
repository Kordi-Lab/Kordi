//! A claimed run reads the conversation its session id names, so admission
//! requires both the requester and the owner to be active members of it.
use super::*;

fn direct_person_session(left: &TestAccount, right: &TestAccount) -> String {
    let mut ids = [left.account_id.as_str(), right.account_id.as_str()];
    ids.sort_unstable();
    format!("session:direct-person:{}:{}", ids[0], ids[1])
}

async fn go_offline(router: &axum::Router, account: &TestAccount) {
    let response = router
        .clone()
        .oneshot(post_with_token(
            "/v1/cloud/presence/offline",
            &account.token,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

async fn claim_as(
    router: &axum::Router,
    caller: &TestAccount,
    body: &Value,
) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &caller.token,
            body.clone(),
        ))
        .await
        .unwrap();
    let status = response.status();
    (status, read_json(response).await)
}

/// An Agent conversation that only its owner belongs to, with one message.
async fn private_agent_conversation(
    pool: &sqlx_postgres::PgPool,
    owner: &TestAccount,
) -> (String, String) {
    let session_id = format!("session:self-agent:{}", uuid::Uuid::new_v4().simple());
    let conversation_id = create_test_conversation(
        pool,
        &owner.account_id,
        &session_id,
        ConversationKind::Ai,
        Vec::new(),
    )
    .await;
    let message_id = insert_test_message(
        pool,
        &owner.account_id,
        conversation_id,
        "Private planning note for the owner only",
    )
    .await;
    (session_id, message_id)
}

async fn assert_refused(
    pool: &sqlx_postgres::PgPool,
    router: &axum::Router,
    caller: &TestAccount,
    body: Value,
) {
    let (status, response) = claim_as(router, caller, &body).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{response}");
    assert_eq!(response["errorCode"], "agent_not_available");
    assert_eq!(
        count_cloud_agent_runs_for_key(pool, body["idempotencyKey"].as_str().unwrap()).await,
        0
    );
}

#[tokio::test]
async fn contact_claim_requires_membership_in_the_owner_conversation() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "admission-owner", "Owner").await;
    let contact = signup(&router, "admission-contact", "Contact").await;
    accept_contacts(&router, &contact, &owner).await;
    go_offline(&router, &owner).await;
    let (session_id, owner_message_id) = private_agent_conversation(&pool, &owner).await;

    assert_refused(
        &pool,
        &router,
        &contact,
        claim_body_with_session(&owner, &contact, &owner_message_id, &session_id),
    )
    .await;
    let unknown_request = format!("msg_admission_{}", uuid::Uuid::new_v4().simple());
    assert_refused(
        &pool,
        &router,
        &contact,
        claim_body_with_session(&owner, &contact, &unknown_request, &session_id),
    )
    .await;
    // A session id without a conversation carries no membership, so it admits
    // only the owner's own run.
    let detached_session = format!("session:self-agent:{}", uuid::Uuid::new_v4().simple());
    assert_refused(
        &pool,
        &router,
        &contact,
        claim_body_with_session(&owner, &contact, &unknown_request, &detached_session),
    )
    .await;
}

#[tokio::test]
async fn non_contact_claim_is_refused_for_owner_conversations() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "admission-owner", "Owner").await;
    let contact = signup(&router, "admission-contact", "Contact").await;
    let outsider = signup(&router, "admission-outsider", "Outsider").await;
    accept_contacts(&router, &contact, &owner).await;
    go_offline(&router, &owner).await;
    let (private_session, owner_message_id) = private_agent_conversation(&pool, &owner).await;
    let direct_session = direct_person_session(&owner, &contact);

    for (session_id, request_id) in [
        (private_session.as_str(), owner_message_id.clone()),
        (
            direct_session.as_str(),
            format!("msg_outsider_{}", uuid::Uuid::new_v4().simple()),
        ),
    ] {
        assert_refused(
            &pool,
            &router,
            &outsider,
            claim_body_with_session(&owner, &outsider, &request_id, session_id),
        )
        .await;
    }
}

#[tokio::test]
async fn direct_message_member_can_claim_the_owner_agent() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "admission-owner", "Owner").await;
    let contact = signup(&router, "admission-contact", "Contact").await;
    accept_contacts(&router, &contact, &owner).await;
    go_offline(&router, &owner).await;
    let session_id = direct_person_session(&owner, &contact);
    let conversation_id = create_test_conversation(
        &pool,
        &contact.account_id,
        &session_id,
        ConversationKind::Direct,
        vec![owner.account_id.clone()],
    )
    .await;
    let request_id = insert_test_message(
        &pool,
        &contact.account_id,
        conversation_id,
        "@OwnerKordi summarize our plan",
    )
    .await;

    let body = claim_body_with_session(&owner, &contact, &request_id, &session_id);
    let (status, response) = claim_as(&router, &contact, &body).await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(response["executionBackend"], "cloud");
    assert_eq!(
        count_cloud_agent_runs_for_key(&pool, body["idempotencyKey"].as_str().unwrap()).await,
        1
    );
}

#[tokio::test]
async fn owner_claim_is_scoped_to_conversations_the_owner_belongs_to() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "admission-owner", "Owner").await;
    let other = signup(&router, "admission-other", "Other").await;
    accept_contacts(&router, &other, &owner).await;
    go_offline(&router, &owner).await;
    let (own_session, own_message_id) = private_agent_conversation(&pool, &owner).await;
    let (other_session, other_message_id) = private_agent_conversation(&pool, &other).await;

    let own = claim_body_with_session(&owner, &owner, &own_message_id, &own_session);
    let (status, response) = claim_as(&router, &owner, &own).await;
    assert_eq!(status, StatusCode::OK, "{response}");

    let detached_session = format!("session:self-agent:{}", uuid::Uuid::new_v4().simple());
    let detached_request = format!("msg_detached_{}", uuid::Uuid::new_v4().simple());
    let detached = claim_body_with_session(&owner, &owner, &detached_request, &detached_session);
    let (status, response) = claim_as(&router, &owner, &detached).await;
    assert_eq!(status, StatusCode::OK, "{response}");

    assert_refused(
        &pool,
        &router,
        &owner,
        claim_body_with_session(&owner, &owner, &other_message_id, &other_session),
    )
    .await;
}

#[tokio::test]
async fn scheduled_run_requires_the_owner_to_belong_to_the_task_conversation() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "admission-scheduled-owner", "Owner").await;
    let other = signup(&router, "admission-scheduled-other", "Other").await;
    let (other_session, _) = private_agent_conversation(&pool, &other).await;

    let created = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/scheduled-tasks",
            &owner.token,
            json!({
                "title": "Scoped check",
                "prompt": "Summarize the conversation.",
                "schedule": { "kind": "once", "at": "2099-01-01T00:00:00Z" },
                "targetRuntime": "cloud",
                "toolPayload": { "sessionId": other_session }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    let task_id = read_json(created).await["task"]["taskId"]
        .as_str()
        .unwrap()
        .to_string();

    let run_now = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/scheduled-tasks/{task_id}/run-now"),
            &owner.token,
            json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(run_now.status(), StatusCode::OK);
    let run = read_json(run_now).await["run"].clone();
    assert_eq!(run["status"], "failed", "{run}");
    let run_id = run["runId"].as_str().unwrap();
    assert_eq!(
        count_cloud_agent_runs_for_key(&pool, &format!("scheduled:{run_id}")).await,
        0
    );
}
