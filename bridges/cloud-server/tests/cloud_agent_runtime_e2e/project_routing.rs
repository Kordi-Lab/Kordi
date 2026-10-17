use super::projects::put;
use super::*;

async fn signup_with_email(router: &axum::Router, email: &str) -> TestAccount {
    let response = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            Body::from(
                signup_email_fixture::with_proof(json!({
                    "email": email,
                    "password": "correct horse",
                    "displayName": "Owner",
                    "avatarSeed": "agent_runtime_avatar",
                }))
                .await
                .to_string(),
            ),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = read_json(response).await;
    TestAccount {
        account_id: body["account"]["accountId"].as_str().unwrap().to_string(),
        token: body["session"]["token"].as_str().unwrap().to_string(),
    }
}

/// Another signed-in Mac of the same account.
async fn sign_in_another_mac(router: &axum::Router, email: &str) -> String {
    let body = read_json(
        router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/login",
                Body::from(json!({"email":email,"password":"correct horse"}).to_string()),
            ))
            .await
            .unwrap(),
    )
    .await;
    body["session"]["token"].as_str().unwrap().to_string()
}

async fn device_of(router: &axum::Router, token: &str) -> String {
    let body = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/auth/devices", token))
            .await
            .unwrap(),
    )
    .await;
    body["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|device| device["currentDevice"] == true)
        .and_then(|device| device["deviceId"].as_str())
        .unwrap()
        .to_string()
}

async fn ready_mac(router: &axum::Router, pool: &sqlx_postgres::PgPool, token: &str, owner: &str) {
    for (path, body) in [
        ("/v1/cloud/presence/online", None),
        (
            "/v1/cloud/agent-runs/desktop/ready",
            Some(json!({"agentIds":[format!("cloud-agent:{owner}")]})),
        ),
    ] {
        let request = match body {
            Some(body) => post_json_with_token(path, token, body),
            None => post_with_token(path, token),
        };
        assert_eq!(
            router.clone().oneshot(request).await.unwrap().status(),
            StatusCode::OK
        );
    }
    // Explicit clock state: the test database may be reached over a slow link.
    sqlx_core::query::query("UPDATE cloud_agent_desktop_capabilities SET updated_at=now()+interval '10 minutes' WHERE agent_id=$1")
        .bind(format!("cloud-agent:{owner}")).execute(pool).await.unwrap();
    sqlx_core::query::query("UPDATE cloud_device_presence SET last_heartbeat_at=(now()+interval '10 minutes')::text WHERE account_id=$1")
        .bind(owner).execute(pool).await.unwrap();
}

async fn mark_mac_seen(pool: &sqlx_postgres::PgPool, device: &str, age: &str) {
    sqlx_core::query::query(&format!(
        "UPDATE cloud_project_devices SET updated_at=now()-interval '{age}' WHERE device_id=$1"
    ))
    .bind(device)
    .execute(pool)
    .await
    .unwrap();
}

fn reply_text(body: &str) -> String {
    let encoded = body.split_once(':').map(|(_, rest)| rest).unwrap_or(body);
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded.trim_end_matches('='))
        .unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["deliveryState"], "failed");
    value["text"].as_str().unwrap().to_string()
}

/// A project session sent while its project Mac is offline used to wait with
/// no reply: the cloud deferred to any ready Mac of the account, and only the
/// project Mac could claim. Now a Mac with the same project runs it, and with
/// none online the request fails at once with a reply that says what to open.
#[tokio::test]
async fn project_requests_run_on_a_mac_with_the_project_or_fail_with_a_reply() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let email = unique_email("project-second-mac");
    let owner = signup_with_email(&router, &email).await;
    let bound_mac = owner.token.clone();
    let project_mac = sign_in_another_mac(&router, &email).await;
    let other_mac = sign_in_another_mac(&router, &email).await;
    sqlx_core::query::query("UPDATE cloud_devices SET device_platform='macos', device_name='Studio Mac' WHERE account_id=$1")
        .bind(&owner.account_id)
        .execute(&pool)
        .await
        .unwrap();
    let bound_device = device_of(&router, &bound_mac).await;
    let project_device = device_of(&router, &project_mac).await;
    let other_device = device_of(&router, &other_mac).await;
    assert_ne!(bound_device, project_device);
    assert_ne!(project_device, other_device);

    let session = format!("project-second-mac-{}", uuid::Uuid::new_v4());
    let project = "c".repeat(64);
    for (token, catalog) in [
        (
            &bound_mac,
            json!([{"id":project,"name":"Trust","sessions":[session]}]),
        ),
        (
            &project_mac,
            json!([{"id":project,"name":"Trust","sessions":[]}]),
        ),
        (
            &other_mac,
            json!([{"id":"d".repeat(64),"name":"Other","sessions":[]}]),
        ),
    ] {
        assert_eq!(
            router
                .clone()
                .oneshot(put(
                    token,
                    "/v1/cloud/projects",
                    json!({ "projects": catalog })
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    for token in [&project_mac, &other_mac] {
        ready_mac(&router, &pool, token, &owner.account_id).await;
    }
    let conversation = create_test_conversation(
        &pool,
        &owner.account_id,
        &session,
        ConversationKind::Ai,
        vec![],
    )
    .await;
    let request = |id: &str| json!({"requestMessageId":id,"sessionId":session,"ownerAccountId":owner.account_id,"requesterAccountId":owner.account_id,"prompt":"hello","idempotencyKey":format!("request:{id}"),"claimId":uuid::Uuid::new_v4(),"bindsProject":true});
    let desktop_claim = |token: &str, body: Value| {
        router.clone().oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/claim",
            token,
            body,
        ))
    };

    // The project Mac is offline; another Mac has the same project folder.
    mark_mac_seen(&pool, &bound_device, "1 minute").await;
    let first = insert_test_message(&pool, &owner.account_id, conversation, "hello").await;
    let cloud = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &owner.token,
            request(&first),
        ))
        .await
        .unwrap();
    assert_eq!(cloud.status(), StatusCode::CONFLICT);
    assert_eq!(read_json(cloud).await["errorCode"], "owner_online");
    let without_project =
        read_json(desktop_claim(&other_mac, request(&first)).await.unwrap()).await;
    assert_eq!(without_project, json!({"acquired":false}));
    let with_project = read_json(desktop_claim(&project_mac, request(&first)).await.unwrap()).await;
    assert_eq!(with_project["acquired"], true);
    assert_eq!(with_project["project"]["id"], project);
    assert_eq!(with_project["project"]["name"], "Trust");

    // A build that cannot run a session in its own project folder never runs
    // another Mac's session, and the request still ends with a reply.
    let legacy = insert_test_message(&pool, &owner.account_id, conversation, "hello").await;
    let mut legacy_claim = request(&legacy);
    legacy_claim["bindsProject"] = json!(false);
    let legacy_claim = read_json(desktop_claim(&project_mac, legacy_claim).await.unwrap()).await;
    assert_eq!(legacy_claim["acquired"], false);
    assert_eq!(legacy_claim["errorCode"], "project_unavailable");

    // No Mac with the project is online: the request ends with a reply.
    mark_mac_seen(&pool, &project_device, "1 minute").await;
    let second = insert_test_message(&pool, &owner.account_id, conversation, "hello").await;
    let ended = read_json(desktop_claim(&other_mac, request(&second)).await.unwrap()).await;
    assert_eq!(ended["acquired"], false);
    assert_eq!(ended["errorCode"], "project_unavailable");
    assert_eq!(
        ended["message"],
        "Open Kordi on Studio Mac to run this task in Trust, or add the Trust folder in Kordi on this Mac."
    );
    let run_id = ended["runId"].as_str().unwrap().to_string();
    let (status, error_code, response_id): (String, Option<String>, Option<String>) =
        sqlx_core::query_as::query_as(
            "SELECT status, error_code, response_message_id FROM cloud_agent_fallback_runs WHERE run_id=$1",
        )
        .bind(&run_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        (status.as_str(), error_code.as_deref()),
        ("failed", Some("project_unavailable"))
    );
    let reply = message_body(&pool, &response_id.unwrap()).await;
    assert!(reply_text(&reply).starts_with("Open Kordi on Studio Mac"));
    // A later cloud claim for the same request returns the ended run; nothing queues.
    let again = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &owner.token,
            request(&second),
        ))
        .await
        .unwrap();
    assert_eq!(again.status(), StatusCode::OK);
    let again = read_json(again).await;
    assert_eq!(again["runId"], run_id);
    assert_eq!(again["status"], "failed");
    let queued: (i64,) = sqlx_core::query_as::query_as(
        "SELECT count(*) FROM cloud_agent_fallback_runs WHERE session_id=$1 AND status='queued'",
    )
    .bind(&session)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(queued.0, 0);

    // The project Mac itself is online while it asks, even with a late publish.
    let third = insert_test_message(&pool, &owner.account_id, conversation, "hello").await;
    ready_mac(&router, &pool, &bound_mac, &owner.account_id).await;
    mark_mac_seen(&pool, &bound_device, "1 minute").await;
    let bound = read_json(desktop_claim(&bound_mac, request(&third)).await.unwrap()).await;
    assert_eq!(bound["acquired"], true);
}
