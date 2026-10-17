use super::*;

fn put(token: &str, path: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method("PUT")
        .uri(path)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test]
async fn projects_are_private_device_bound_and_operations_are_claimed_once() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let owner = signup(&router, "project-owner", "Owner").await;
    let stranger = signup(&router, "project-stranger", "Other").await;
    let project_id = "a".repeat(64);
    let catalog =
        json!({"projects":[{"id":project_id,"name":"Example","sessions":["project-session"]}]});
    assert_eq!(
        router
            .clone()
            .oneshot(put(&owner.token, "/v1/cloud/projects", catalog.clone()))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    sqlx_core::query::query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&owner.account_id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        router
            .clone()
            .oneshot(put(&owner.token, "/v1/cloud/projects", catalog))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let rows = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/projects", &owner.token))
            .await
            .unwrap(),
    )
    .await;
    let device = rows["devices"][0]["id"].as_str().unwrap();
    assert_eq!(rows["devices"][0]["projects"][0]["name"], "Example");
    assert!(rows["devices"][0]["projects"][0]
        .get("workspaces")
        .is_none());
    let worktree = "b".repeat(64);
    for (workspaces, status) in [
        (json!({"other-session": worktree}), StatusCode::BAD_REQUEST),
        (
            json!({"project-session": "/private/path"}),
            StatusCode::BAD_REQUEST,
        ),
        (json!({"project-session": worktree}), StatusCode::OK),
    ] {
        let catalog = json!({"projects":[{"id":project_id,"name":"Example","sessions":["project-session"],"workspaces":workspaces}]});
        let response = router
            .clone()
            .oneshot(put(&owner.token, "/v1/cloud/projects", catalog))
            .await
            .unwrap();
        assert_eq!(response.status(), status);
    }
    let rows = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/projects", &owner.token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        rows["devices"][0]["projects"][0]["workspaces"],
        json!({"project-session": worktree})
    );
    assert_eq!(rows["devices"][0]["online"], true);
    let other = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/projects", &stranger.token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(other["devices"], json!([]));
    assert_eq!(
        kordi_cloud_server::projects::session_device(&pool, &owner.account_id, "project-session")
            .await
            .unwrap()
            .as_deref(),
        Some(device)
    );
    assert!(kordi_cloud_server::projects::session_device(
        &pool,
        &stranger.account_id,
        "project-session"
    )
    .await
    .unwrap()
    .is_none());
    let id = uuid::Uuid::new_v4().to_string();
    let action = json!({"commandId":id,"deviceId":device,"action":"repositories","page":1});
    assert_eq!(
        router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/projects/commands",
                &stranger.token,
                action.clone()
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/projects/commands",
                &owner.token,
                action.clone()
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/projects/commands",
                &owner.token,
                action
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let first = read_json(
        router
            .clone()
            .oneshot(post_with_token(
                "/v1/cloud/projects/commands/next",
                &owner.token,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(first["command"]["id"], id);
    let second = read_json(
        router
            .clone()
            .oneshot(post_with_token(
                "/v1/cloud/projects/commands/next",
                &owner.token,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert!(second["command"].is_null());
    let path = format!("/v1/cloud/projects/commands/{id}");
    assert_eq!(
        router
            .clone()
            .oneshot(put(
                &stranger.token,
                &path,
                json!({"result":{},"failed":false})
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        router
            .clone()
            .oneshot(put(
                &owner.token,
                &path,
                json!({"result":{"repositories":[],"hasMore":false},"failed":false})
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        read_json(
            router
                .clone()
                .oneshot(get_with_token(&path, &owner.token))
                .await
                .unwrap()
        )
        .await["status"],
        "completed"
    );
    assert_eq!(
        router
            .clone()
            .oneshot(get_with_token(&path, &stranger.token))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    sqlx_core::query::query(
        "UPDATE cloud_project_devices SET updated_at=now()-interval '1 minute' WHERE device_id=$1",
    )
    .bind(device)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/projects/commands",
                &owner.token,
                json!({"commandId":uuid::Uuid::new_v4(),"deviceId":device,"action":"importFolder"})
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
}

async fn set_project_device_seen(pool: &sqlx_postgres::PgPool, account: &str, age: &str) {
    sqlx_core::query::query(&format!(
        "UPDATE cloud_project_devices SET updated_at=now()-interval '{age}' WHERE account_id=$1"
    ))
    .bind(account)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn project_runs_use_the_cloud_only_while_the_project_mac_is_offline() {
    use kordi_cloud_server::cloud_agent_runtime::runs::{
        claim_run, claim_run_for_desktop, lease_canary_run, ClaimRunRequest,
    };
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let owner = signup(&router, "project-routing", "Owner").await;
    sqlx_core::query::query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&owner.account_id)
        .execute(&pool)
        .await
        .unwrap();
    let session = format!("project-test-{}", uuid::Uuid::new_v4());
    assert_eq!(
        router
            .clone()
            .oneshot(put(
                &owner.token,
                "/v1/cloud/projects",
                json!({"projects":[{"id":"b".repeat(64),"name":"Example","sessions":[session]}]})
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let device = kordi_cloud_server::projects::session_device(&pool, &owner.account_id, &session)
        .await
        .unwrap()
        .unwrap();

    // Online project Mac: the claim route defers to it and runners skip queued runs.
    let online_claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &owner.token,
            claim_body_with_session(&owner, &owner, &uuid::Uuid::new_v4().to_string(), &session),
        ))
        .await
        .unwrap();
    assert_eq!(online_claim.status(), StatusCode::CONFLICT);
    let online_claim = read_json(online_claim).await;
    assert_eq!(online_claim["errorCode"], "owner_online");
    assert_eq!(
        online_claim["message"],
        "The project Mac will handle this task."
    );
    let queued: ClaimRunRequest = serde_json::from_value(claim_body_with_session(
        &owner,
        &owner,
        &uuid::Uuid::new_v4().to_string(),
        &session,
    ))
    .unwrap();
    let queued = claim_run(&pool, &queued).await.unwrap();
    assert!(lease_canary_run(&pool, "project-runner", &queued.run_id)
        .await
        .unwrap()
        .is_none());

    // A different Mac never runs it; the project Mac does.
    let input: ClaimRunRequest = serde_json::from_value(json!({"requestMessageId":uuid::Uuid::new_v4().to_string(),"sessionId":session,"ownerAccountId":owner.account_id,"requesterAccountId":owner.account_id,"prompt":"Check workspace","idempotencyKey":uuid::Uuid::new_v4().to_string()})).unwrap();
    assert!(
        claim_run_for_desktop(&pool, &input, "desktop:another-device:claim")
            .await
            .unwrap_err()
            .to_string()
            .contains("project Mac")
    );
    let desktop = claim_run_for_desktop(&pool, &input, &format!("desktop:{device}:claim"))
        .await
        .unwrap();
    assert_eq!(desktop.execution_backend, "desktop");

    // Offline project Mac: the cloud answers without the project files.
    set_project_device_seen(&pool, &owner.account_id, "1 minute").await;
    let offline_claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &owner.token,
            claim_body_with_session(&owner, &owner, &uuid::Uuid::new_v4().to_string(), &session),
        ))
        .await
        .unwrap();
    assert_eq!(offline_claim.status(), StatusCode::OK);
    let run_id = read_json(offline_claim).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    let leased = lease_canary_run(&pool, "project-runner", &run_id)
        .await
        .unwrap()
        .expect("offline project run is leased by the cloud runner");
    assert_eq!(leased.run_id, run_id);
    assert!(leased
        .system_prompt
        .contains("This chat belongs to the project \"Example\""));
    let earlier = lease_canary_run(&pool, "project-runner", &queued.run_id)
        .await
        .unwrap()
        .expect("runs queued while the Mac was online run once it goes offline");
    assert!(earlier
        .system_prompt
        .contains("This chat belongs to the project \"Example\""));

    // A run the Mac claimed never moves to the cloud, even once its lease
    // lapses with the Mac offline; the lost-desktop sweep ends it instead.
    sqlx_core::query::query("UPDATE cloud_agent_fallback_runs SET status='running', lease_expires_at=(now()-interval '1 minute')::text WHERE run_id=$1")
        .bind(&desktop.run_id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(lease_canary_run(&pool, "project-runner", &desktop.run_id)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn another_mac_publishing_the_same_project_never_drops_this_macs_sessions() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let email = unique_email("project-two-macs");
    let signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            Body::from(
                signup_email_fixture::with_proof(json!({
                    "email": email, "password": "correct horse", "displayName": "Owner",
                    "avatarSeed": "agent_runtime_avatar",
                }))
                .await
                .to_string(),
            ),
        ))
        .await
        .unwrap();
    assert_eq!(signup.status(), StatusCode::CREATED);
    let first = read_json(signup).await;
    let login = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/login",
            Body::from(json!({"email": email, "password": "correct horse"}).to_string()),
        ))
        .await
        .unwrap();
    assert_eq!(login.status(), StatusCode::OK);
    let second = read_json(login).await;
    let account = first["account"]["accountId"].as_str().unwrap();
    let (mac_a, mac_b) = (
        first["session"]["token"].as_str().unwrap(),
        second["session"]["token"].as_str().unwrap(),
    );
    sqlx_core::query::query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(account)
        .execute(&pool)
        .await
        .unwrap();
    let project_id = "c".repeat(64);
    let publish = |token: &str, sessions: Value| {
        put(
            token,
            "/v1/cloud/projects",
            json!({"projects":[{"id":project_id,"name":"Example","sessions":sessions}]}),
        )
    };
    let status = router
        .clone()
        .oneshot(publish(mac_a, json!(["project-session", "fork-session"])))
        .await
        .unwrap()
        .status();
    assert_eq!(status, StatusCode::OK);
    let owner_device =
        kordi_cloud_server::projects::session_device(&pool, account, "project-session")
            .await
            .unwrap()
            .expect("the first Mac owns the session");
    // The second Mac bound the same folder but runs none of these sessions.
    for _ in 0..2 {
        let status = router
            .clone()
            .oneshot(publish(mac_b, json!([])))
            .await
            .unwrap()
            .status();
        assert_eq!(status, StatusCode::OK);
    }
    let rows = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/projects", mac_b))
            .await
            .unwrap(),
    )
    .await;
    let devices = rows["devices"].as_array().unwrap();
    assert_eq!(devices.len(), 2);
    let owner = devices
        .iter()
        .find(|device| device["id"] == owner_device.as_str())
        .unwrap();
    assert_eq!(
        owner["projects"][0]["sessions"],
        json!(["project-session", "fork-session"])
    );
    for session in ["project-session", "fork-session"] {
        assert_eq!(
            kordi_cloud_server::projects::session_device(&pool, account, session)
                .await
                .unwrap()
                .as_deref(),
            Some(owner_device.as_str())
        );
    }
}
