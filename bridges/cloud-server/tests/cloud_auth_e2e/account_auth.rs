use super::*;

#[tokio::test]
async fn pool_init_runs_migrations() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping");
        return;
    };
    // After init_pool the migrations have run; a SELECT against
    // cloud_schema_versions should return at least the v1 row.
    let count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_schema_versions WHERE version >= 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(count.0 >= 1, "expected at least migration v1 to be applied");
}

#[tokio::test]
async fn signup_happy_path_returns_session_and_persists_account() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("signup-happy");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let response = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    let status = response.status();
    let body = read_json(response).await;
    assert_eq!(status, StatusCode::CREATED, "got body {body}");
    assert!(body["session"]["token"]
        .as_str()
        .unwrap()
        .starts_with("kordi_cs_"));
    assert_eq!(body["account"]["primaryEmail"], email);
    assert_eq!(body["account"]["passwordSet"], true);

    // Verify the row landed in Postgres.
    let row: (String, String) = sqlx_core::query_as::query_as(
        "SELECT account_id, primary_email FROM cloud_accounts WHERE LOWER(primary_email) = $1",
    )
    .bind(&email)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(row.0.starts_with("acct_"));
    assert_eq!(row.1, email);
}

#[tokio::test]
async fn signup_duplicate_email_returns_409() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("dupe-email");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);

    let _ = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    let second = router
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "another password"),
        ))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::CONFLICT);
    let body = read_json(second).await;
    assert_eq!(body["errorCode"], "email_in_use");
}

#[tokio::test]
async fn login_with_correct_password_returns_session_and_me_works() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("login");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);

    // signup
    let _ = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();

    // login
    let login_resp = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/login",
            Body::from(json!({"email": &email, "password": "correct horse"}).to_string()),
        ))
        .await
        .unwrap();
    assert_eq!(login_resp.status(), StatusCode::OK);
    let login_body = read_json(login_resp).await;
    let token = login_body["session"]["token"].as_str().unwrap().to_string();

    // /me
    let me_resp = router
        .oneshot(get_with_token("/v1/cloud/auth/me", &token))
        .await
        .unwrap();
    assert_eq!(me_resp.status(), StatusCode::OK);
    let me_body = read_json(me_resp).await;
    assert_eq!(me_body["primaryEmail"], email);
}

#[tokio::test]
async fn login_with_wrong_password_returns_401() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("wrong-pass");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);

    let _ = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();

    let bad = router
        .oneshot(post(
            "/v1/cloud/auth/login",
            Body::from(json!({"email": &email, "password": "WRONG"}).to_string()),
        ))
        .await
        .unwrap();
    assert_eq!(bad.status(), StatusCode::UNAUTHORIZED);
    let body = read_json(bad).await;
    assert_eq!(body["errorCode"], "invalid_credentials");
}

#[tokio::test]
async fn default_agent_name_persists_in_the_account_profile() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);
    let (token, account_id) = signup_account(&router, "default-agent-name").await;

    let updated = router
        .clone()
        .oneshot(patch_json_with_token(
            "/v1/cloud/auth/me",
            &token,
            json!({ "agentDisplayName": "BabyTREE" }),
        ))
        .await
        .unwrap();
    assert_eq!(updated.status(), StatusCode::OK);
    let updated = read_json(updated).await;
    assert_eq!(
        updated["defaultAgent"]["agentId"],
        format!("cloud-agent:{account_id}")
    );
    assert_eq!(updated["defaultAgent"]["displayName"], "BabyTREE");
    let marker = kordi_cloud_server::avatars::parse_generated_avatar_marker(
        updated["defaultAgent"]["avatarUrl"].as_str().unwrap(),
    )
    .unwrap();
    let avatar = router
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/v1/avatars/{}/{}/{}.png?v={}",
                    marker.renderer_version, marker.style, marker.seed, marker.version,
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(avatar.status(), StatusCode::OK);

    let current = read_json(
        router
            .oneshot(get_with_token("/v1/cloud/auth/me", &token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(current["defaultAgent"]["displayName"], "BabyTREE");
}
