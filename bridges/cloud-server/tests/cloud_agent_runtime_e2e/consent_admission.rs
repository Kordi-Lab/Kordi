//! Agents answer only people allowed to use them: an owner's default agent
//! needs a mutual contact, a shared agent needs a common group, and a block
//! in either direction ends both. Runs already admitted are rechecked when
//! they are leased, read context, and finish.
use super::*;

const RUNNER: &str = "consent-runner";

fn direct_session(left: &TestAccount, right: &TestAccount) -> String {
    let mut ids = [left.account_id.as_str(), right.account_id.as_str()];
    ids.sort_unstable();
    format!("session:direct-person:{}:{}", ids[0], ids[1])
}

async fn claim(router: &axum::Router, caller: &TestAccount, body: Value) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &caller.token,
            body,
        ))
        .await
        .unwrap();
    let status = response.status();
    (status, read_json(response).await)
}

pub(super) async fn remove_contact(
    pool: &sqlx_postgres::PgPool,
    left: &TestAccount,
    right: &TestAccount,
) {
    sqlx_core::query::query(
        "DELETE FROM cloud_contacts WHERE (account_id = $1 AND peer_account_id = $2) \
         OR (account_id = $2 AND peer_account_id = $1)",
    )
    .bind(&left.account_id)
    .bind(&right.account_id)
    .execute(pool)
    .await
    .unwrap();
}

async fn block(pool: &sqlx_postgres::PgPool, blocker: &TestAccount, blocked: &TestAccount) {
    sqlx_core::query::query(
        "INSERT INTO cloud_account_blocks (blocker_account_id, blocked_account_id) VALUES ($1, $2)",
    )
    .bind(&blocker.account_id)
    .bind(&blocked.account_id)
    .execute(pool)
    .await
    .unwrap();
}

/// Two contacts, their direct chat, and `count` requests from `requester`.
async fn direct_requests(
    router: &axum::Router,
    pool: &sqlx_postgres::PgPool,
    label: &str,
    count: usize,
) -> (TestAccount, TestAccount, String, Vec<String>) {
    let owner = signup(router, &format!("{label}-owner"), "Owner").await;
    let requester = signup(router, &format!("{label}-requester"), "Requester").await;
    accept_contacts(router, &requester, &owner).await;
    let session = direct_session(&owner, &requester);
    let conversation =
        chat_store::conversation_id_for_session(pool, &requester.account_id, &session)
            .await
            .unwrap()
            .expect("accepting a request opens the direct chat");
    let mut requests = Vec::new();
    for index in 0..count {
        requests.push(
            insert_test_message(
                pool,
                &requester.account_id,
                conversation,
                &format!("@Kordi request {index}"),
            )
            .await,
        );
    }
    (owner, requester, session, requests)
}

pub(super) async fn run_state(
    pool: &sqlx_postgres::PgPool,
    run_id: &str,
) -> (String, Option<String>) {
    sqlx_core::query_as::query_as(
        "SELECT status, error_code FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn default_agents_answer_only_mutual_contacts() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let (owner, requester, _, requests) =
        direct_requests(&router, &pool, "consent-default", 3).await;
    let (status, _) = claim(
        &router,
        &requester,
        claim_body(&owner, &requester, &requests[0]),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // A one-way row (the owner removed the requester) grants nothing.
    sqlx_core::query::query(
        "DELETE FROM cloud_contacts WHERE account_id = $1 AND peer_account_id = $2",
    )
    .bind(&owner.account_id)
    .bind(&requester.account_id)
    .execute(&pool)
    .await
    .unwrap();
    let (status, body) = claim(
        &router,
        &requester,
        claim_body(&owner, &requester, &requests[1]),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["errorCode"], "agent_not_available");

    // Both rows again, but a block in either direction still refuses.
    sqlx_core::query::query(
        "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) VALUES ($1, $2, $3)",
    )
    .bind(&owner.account_id)
    .bind(&requester.account_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();
    block(&pool, &owner, &requester).await;
    let (status, body) = claim(
        &router,
        &requester,
        claim_body(&owner, &requester, &requests[2]),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
}

async fn shared_agent(pool: &sqlx_postgres::PgPool, owner: &TestAccount) -> String {
    let agent_id = format!("cloud_agent_{}", uuid::Uuid::new_v4().simple());
    sqlx_core::query::query(
        "INSERT INTO cloud_agent_definitions(agent_id, owner_account_id, access_scope, status, \
         name, role, system_prompt, created_at, updated_at, avatar_source, avatar_style, \
         avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, $2, 'participant_conversations', 'active', 'Helper', 'research', 'test', \
         'test', 'test', 'generated', 'thumbs', $1, 'test', 1, 'test')",
    )
    .bind(&agent_id)
    .bind(&owner.account_id)
    .execute(pool)
    .await
    .unwrap();
    agent_id
}

pub(super) fn group_request(
    session: &str,
    owner: &TestAccount,
    requester: &TestAccount,
    agent: &str,
) -> (String, String) {
    let request_id = format!("request-{}", uuid::Uuid::new_v4());
    let body = encode_test_cloud_group_envelope(json!({
        "kind": "group-message", "groupId": session, "groupSpaceId": session,
        "createdByAccountId": owner.account_id,
        "actor": {"accountId": requester.account_id, "displayName": "Requester"},
        "participants": [
            {"accountId": owner.account_id, "displayName": "Owner", "role": "admin"},
            {"accountId": requester.account_id, "displayName": "Requester", "role": "person"}
        ],
        "message": {"id": request_id, "senderAccountId": requester.account_id,
                    "senderKind": "human", "text": "@Helper please look",
                    "createdAtMs": chrono::Utc::now().timestamp_millis(),
                    "targetCloudAgentId": agent,
                    "targetCloudAgentOwnerAccountId": owner.account_id}
    }));
    (request_id, body)
}

#[tokio::test]
async fn group_members_use_shared_agents_but_not_default_agents_of_non_contacts() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "consent-shared-owner", "Owner").await;
    let friend = signup(&router, "consent-shared-friend", "Friend").await;
    let requester = signup(&router, "consent-shared-requester", "Requester").await;
    accept_contacts(&router, &owner, &friend).await;
    let session = format!("session:group:{}", uuid::Uuid::new_v4());
    let conversation = create_test_conversation(
        &pool,
        &owner.account_id,
        &session,
        ConversationKind::Group,
        vec![friend.account_id.clone()],
    )
    .await;
    // The requester joined through an invite link and is not the owner's contact.
    let mut transaction = pool.begin().await.unwrap();
    chat_store::accept_invited_conversation_member(
        &mut transaction,
        &owner.account_id,
        &session,
        &requester.account_id,
    )
    .await
    .unwrap();
    transaction.commit().await.unwrap();
    let helper = shared_agent(&pool, &owner).await;

    let (shared_request, body) = group_request(&session, &owner, &requester, &helper);
    insert_test_message(&pool, &requester.account_id, conversation, &body).await;
    let (status, body) = claim(
        &router,
        &requester,
        claim_body_with_session(&owner, &requester, &shared_request, &session),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let default_agent = format!("cloud-agent:{}", owner.account_id);
    let (default_request, body) = group_request(&session, &owner, &requester, &default_agent);
    let wire_id = insert_test_message(&pool, &requester.account_id, conversation, &body).await;
    let (status, body) = claim(
        &router,
        &requester,
        claim_body_with_session(&owner, &requester, &default_request, &session),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["errorCode"], "agent_not_available");

    // The owner's Mac refuses the same request.
    sqlx_core::query::query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&owner.account_id)
        .execute(&pool)
        .await
        .unwrap();
    let ready = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/ready",
            &owner.token,
            json!({"agentIds": [default_agent]}),
        ))
        .await
        .unwrap();
    assert_eq!(ready.status(), StatusCode::OK);
    let mut desktop_input = claim_body_with_session(&owner, &requester, &default_request, &session);
    desktop_input["claimId"] = json!(uuid::Uuid::new_v4());
    desktop_input["requestMessageId"] = json!(wire_id);
    let desktop = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/claim",
            &owner.token,
            desktop_input,
        ))
        .await
        .unwrap();
    assert_eq!(desktop.status(), StatusCode::FORBIDDEN);

    // A block ends shared-agent use too; group messaging itself continues.
    block(&pool, &owner, &requester).await;
    let (blocked_request, body) = group_request(&session, &owner, &requester, &helper);
    insert_test_message(&pool, &requester.account_id, conversation, &body).await;
    let (status, body) = claim(
        &router,
        &requester,
        claim_body_with_session(&owner, &requester, &blocked_request, &session),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
}

#[tokio::test]
async fn runs_stop_when_their_requester_loses_access() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let (owner, requester, session, requests) =
        direct_requests(&router, &pool, "consent-revoke", 2).await;
    let mut runs = Vec::new();
    for request in &requests {
        let (status, body) =
            claim(&router, &requester, claim_body(&owner, &requester, request)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        runs.push(body["runId"].as_str().unwrap().to_string());
    }
    let lease = |run_id: String| {
        let router = router.clone();
        async move {
            let response = router
                .oneshot(post_json_with_runner_token(
                    "/v1/cloud/agent-runs/lease",
                    "runner-test-token",
                    json!({"runnerId": RUNNER, "canaryRunId": run_id}),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            read_json(response).await
        }
    };
    let working = lease(runs[1].clone()).await;
    assert_eq!(working["run"]["status"], "leased");
    let run_token = lease_run_token(&working);
    let context = |runner_token: String| {
        let router = router.clone();
        let uri = format!("/v1/cloud/agent-runs/{}/context", runs[1]);
        let session = session.clone();
        async move {
            router
                .oneshot(post_json_with_run_token(
                    &uri,
                    "runner-test-token",
                    &runner_token,
                    json!({"runnerId": RUNNER, "tool": "read_session",
                           "arguments": {"sessionId": session, "mode": "index"}}),
                ))
                .await
                .unwrap()
                .status()
        }
    };
    let member_read = || {
        let router = router.clone();
        let body = json!({"sessionId": session, "sourceRequestId": requests[1],
                          "tool": "read_session",
                          "arguments": {"sessionId": session, "mode": "index"}});
        let token = owner.token.clone();
        async move {
            router
                .oneshot(post_json_with_token(
                    "/v1/cloud/agent-runs/desktop/read-context",
                    &token,
                    body,
                ))
                .await
                .unwrap()
                .status()
        }
    };
    assert_eq!(context(run_token.clone()).await, StatusCode::OK);
    assert_eq!(member_read().await, StatusCode::OK);

    remove_contact(&pool, &owner, &requester).await;

    // A queued run is cancelled when it is leased.
    let cancelled = lease(runs[0].clone()).await;
    assert_eq!(cancelled["run"]["status"], "cancelled");
    assert_eq!(cancelled["run"]["prompt"], "");
    assert_eq!(
        run_state(&pool, &runs[0]).await,
        (
            "cancelled".to_string(),
            Some("relationship_revoked".to_string())
        )
    );
    // A working run can no longer read the chat, and finishing cancels it.
    assert_eq!(context(run_token.clone()).await, StatusCode::NOT_FOUND);
    assert_eq!(member_read().await, StatusCode::NOT_FOUND);
    let complete = router
        .clone()
        .oneshot(post_json_with_run_token(
            &format!("/v1/cloud/agent-runs/{}/complete", runs[1]),
            "runner-test-token",
            &run_token,
            json!({"runnerId": RUNNER, "responseText": "This must not be delivered"}),
        ))
        .await
        .unwrap();
    assert_eq!(complete.status(), StatusCode::OK);
    let complete = read_json(complete).await;
    assert_eq!(complete["run"]["status"], "cancelled");
    assert!(complete["run"]["responseMessageId"].is_null());
    assert_eq!(
        run_state(&pool, &runs[1]).await,
        (
            "cancelled".to_string(),
            Some("relationship_revoked".to_string())
        )
    );
    let (delivered,): (i64,) = sqlx_core::query_as::query_as(
        "SELECT count(*) FROM cloud_chat_messages \
         WHERE content::text LIKE '%This must not be delivered%'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(delivered, 0);
}

#[tokio::test]
async fn owner_desktop_results_for_a_removed_contact_are_rejected_for_good() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let (owner, requester, session, requests) =
        direct_requests(&router, &pool, "consent-desktop", 1).await;
    sqlx_core::query::query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&owner.account_id)
        .execute(&pool)
        .await
        .unwrap();
    let ready = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/ready",
            &owner.token,
            json!({"agentIds": [format!("cloud-agent:{}", owner.account_id)]}),
        ))
        .await
        .unwrap();
    assert_eq!(ready.status(), StatusCode::OK);
    let claim_id = uuid::Uuid::new_v4();
    let mut input = claim_body_with_session(&owner, &requester, &requests[0], &session);
    input["claimId"] = json!(claim_id);
    let claimed = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/claim",
            &owner.token,
            input,
        ))
        .await
        .unwrap();
    assert_eq!(claimed.status(), StatusCode::OK);
    let claimed = read_json(claimed).await;
    assert_eq!(claimed["acquired"], true, "{claimed}");
    let run_id = claimed["runId"].as_str().unwrap().to_string();
    sqlx_core::query::query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()+interval '10 minutes')::text WHERE run_id=$1")
        .bind(&run_id)
        .execute(&pool)
        .await
        .unwrap();

    remove_contact(&pool, &owner, &requester).await;
    let body = format!(
        "kordi-cloud-agent-response:{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            json!({"kind": "agent-response", "requestId": requests[0],
                   "text": "Desktop result", "deliveryState": "complete"})
            .to_string()
        )
    );
    let progress = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/desktop/{run_id}/progress"),
            &owner.token,
            json!({"claimId": claim_id, "clientMessageId": uuid::Uuid::new_v4(), "body": body}),
        ))
        .await
        .unwrap();
    assert_eq!(progress.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        read_json(progress).await["errorCode"],
        "execution_progress_rejected"
    );
}
