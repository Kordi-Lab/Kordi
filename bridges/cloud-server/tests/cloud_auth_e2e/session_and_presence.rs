use super::*;

#[tokio::test]
async fn logout_invalidates_session_token() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("logout");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);

    let signup_resp = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    let token = read_json(signup_resp).await["session"]["token"]
        .as_str()
        .unwrap()
        .to_string();

    let logout_resp = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/auth/logout", &token))
        .await
        .unwrap();
    assert_eq!(logout_resp.status(), StatusCode::NO_CONTENT);

    let me_after = router
        .oneshot(get_with_token("/v1/cloud/auth/me", &token))
        .await
        .unwrap();
    assert_eq!(me_after.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn presence_contacts_returns_self_and_accepted_contacts_only() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let a_email = unique_email("presence-a");
    let b_email = unique_email("presence-b");
    let c_email = unique_email("presence-c");

    let a = read_json(
        router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body(&a_email, "correct horse"),
            ))
            .await
            .unwrap(),
    )
    .await;
    let b = read_json(
        router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body(&b_email, "correct horse"),
            ))
            .await
            .unwrap(),
    )
    .await;
    let c = read_json(
        router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body(&c_email, "correct horse"),
            ))
            .await
            .unwrap(),
    )
    .await;
    let a_token = a["session"]["token"].as_str().unwrap();
    let b_id = b["account"]["accountId"].as_str().unwrap();
    let c_id = c["account"]["accountId"].as_str().unwrap();

    let request_body = json!({ "peerAccountId": b_id });
    let request = read_json(
        router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/contacts/requests",
                a_token,
                request_body,
            ))
            .await
            .unwrap(),
    )
    .await;
    let request_id = request["request"]["requestId"].as_str().unwrap();
    let b_token = b["session"]["token"].as_str().unwrap();
    let accept_path = format!("/v1/cloud/contacts/requests/{request_id}/accept");
    let accept_status = router
        .clone()
        .oneshot(post_with_token(&accept_path, b_token))
        .await
        .unwrap()
        .status();
    assert_eq!(accept_status, StatusCode::OK);

    let online_status = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/online", a_token))
        .await
        .unwrap()
        .status();
    assert_eq!(online_status, StatusCode::OK);

    let response = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/presence/contacts", a_token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    let ids: Vec<String> = body["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["accountId"].as_str().unwrap().to_string())
        .collect();
    assert!(ids.contains(&a["account"]["accountId"].as_str().unwrap().to_string()));
    assert!(ids.contains(&b_id.to_string()));
    assert!(!ids.contains(&c_id.to_string()));
}

#[tokio::test]
async fn presence_rollup_stays_online_until_all_devices_offline() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);
    let email = unique_email("presence-rollup");
    let signup = read_json(
        router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body(&email, "correct horse"),
            ))
            .await
            .unwrap(),
    )
    .await;
    let token = signup["session"]["token"].as_str().unwrap();

    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/online", token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let online = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/presence/contacts", token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(online["accounts"][0]["status"], "online");

    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let offline = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/presence/contacts", token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(offline["accounts"][0]["status"], "offline");
}
