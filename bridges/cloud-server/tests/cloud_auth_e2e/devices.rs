use super::*;

async fn login_with_device(
    router: &axum::Router,
    email: &str,
    seed: u8,
    name: &str,
) -> serde_json::Value {
    read_json(
        router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/login",
                Body::from(
                    json!({
                        "email": email,
                        "password": "correct horse",
                        "device": device_registration(seed, name, "ios"),
                    })
                    .to_string(),
                ),
            ))
            .await
            .unwrap(),
    )
    .await
}

#[tokio::test]
async fn stable_installation_reauthentication_deduplicates_the_device() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("device-dedupe");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);
    let first = read_json(
        router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body_with_device(
                    &email,
                    "correct horse",
                    device_registration(7, "Test iPhone", "ios"),
                ),
            ))
            .await
            .unwrap(),
    )
    .await;
    let second = login_with_device(&router, &email, 7, "Renamed iPhone").await;

    assert_eq!(first["session"]["deviceId"], second["session"]["deviceId"]);
    let stored: (i64, Option<String>, Option<String>) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT, MAX(device_name), MAX(approximate_location) \
         FROM cloud_devices WHERE account_id = $1",
    )
    .bind(first["account"]["accountId"].as_str().unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored.0, 1);
    assert_eq!(stored.1.as_deref(), Some("Test iPhone"));
    assert_eq!(stored.2.as_deref(), Some("Riyadh, Saudi Arabia"));
}

#[tokio::test]
async fn current_device_metadata_upgrades_legacy_identity_and_preserves_coarse_location() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("device-metadata");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);
    let signup = read_json(
        router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body_with_device(
                    &email,
                    "correct horse",
                    device_registration(31, "Owner Mac", "macos"),
                ),
            ))
            .await
            .unwrap(),
    )
    .await;
    let token = signup["session"]["token"].as_str().unwrap();
    let device_id = signup["session"]["deviceId"].as_str().unwrap();
    sqlx_core::query::query(
        "UPDATE cloud_devices SET device_name = 'oauth-google-device' WHERE device_id = $1",
    )
    .bind(device_id)
    .execute(&pool)
    .await
    .unwrap();

    let response = router
        .clone()
        .oneshot(put_json_with_token(
            "/v1/cloud/auth/devices/current",
            token,
            json!({
                "displayName": "MacBook Pro",
                "platform": "macos",
                "osVersion": "26.0",
                "appVersion": "0.0.1-beta.12",
                "approximateLocation": "Riyadh, Saudi Arabia"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    let devices = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/auth/devices", token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(devices["devices"][0]["displayName"], "MacBook Pro");
    assert_eq!(devices["devices"][0]["platform"], "macos");
    assert_eq!(devices["devices"][0]["osVersion"], "26.0");
    assert_eq!(
        devices["devices"][0]["approximateLocation"],
        "Riyadh, Saudi Arabia"
    );
}

#[tokio::test]
async fn active_device_list_omits_week_inactive_authorizations() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("device-active-list");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);
    let owner = read_json(
        router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body_with_device(
                    &email,
                    "correct horse",
                    device_registration(32, "Owner iPhone", "ios"),
                ),
            ))
            .await
            .unwrap(),
    )
    .await;
    let valid_offline = login_with_device(&router, &email, 33, "Offline Mac").await;
    let fresh_online = login_with_device(&router, &email, 34, "Online Mac").await;
    let stale = login_with_device(&router, &email, 35, "oauth-google-device").await;
    let fresh_online_token = fresh_online["session"]["token"].as_str().unwrap();
    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token(
                "/v1/cloud/presence/online",
                fresh_online_token,
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let fresh_online_id = fresh_online["session"]["deviceId"].as_str().unwrap();
    let stale_token = stale["session"]["token"].as_str().unwrap();
    let stale_id = stale["session"]["deviceId"].as_str().unwrap();
    sqlx_core::query::query(
        "UPDATE cloud_refresh_tokens SET expires_at = $1 \
         WHERE device_id = $2",
    )
    .bind((chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339())
    .bind(fresh_online_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx_core::query::query(
        "UPDATE cloud_devices SET last_seen_at = $1 \
         WHERE device_id = $2",
    )
    .bind((chrono::Utc::now() - chrono::Duration::days(8)).to_rfc3339())
    .bind(stale_id)
    .execute(&pool)
    .await
    .unwrap();

    let response = router
        .clone()
        .oneshot(get_with_token(
            "/v1/cloud/auth/devices",
            owner["session"]["token"].as_str().unwrap(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    let listed_ids = body["devices"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|device| device["deviceId"].as_str())
        .collect::<Vec<_>>();

    assert_eq!(listed_ids.len(), 3);
    assert!(listed_ids.contains(&owner["session"]["deviceId"].as_str().unwrap()));
    assert!(listed_ids.contains(&valid_offline["session"]["deviceId"].as_str().unwrap()));
    assert!(listed_ids.contains(&fresh_online_id));
    assert!(!listed_ids.contains(&stale_id));
    assert_eq!(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/auth/me", stale_token))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );

    let reauthenticated = login_with_device(&router, &email, 35, "Restored iPhone").await;
    assert_eq!(
        reauthenticated["session"]["deviceId"].as_str().unwrap(),
        stale_id
    );
    assert_eq!(
        router
            .clone()
            .oneshot(get_with_token(
                "/v1/cloud/auth/me",
                reauthenticated["session"]["token"].as_str().unwrap(),
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/auth/me", stale_token))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn concurrent_distinct_installations_create_distinct_reviewable_devices() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("device-concurrent");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);
    let signup = read_json(
        router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body_with_device(
                    &email,
                    "correct horse",
                    device_registration(1, "Original Mac", "macos"),
                ),
            ))
            .await
            .unwrap(),
    )
    .await;
    let (second, third) = tokio::join!(
        login_with_device(&router, &email, 2, "Second iPhone"),
        login_with_device(&router, &email, 3, "Third iPhone"),
    );
    assert_ne!(second["session"]["deviceId"], third["session"]["deviceId"]);

    let token = signup["session"]["token"].as_str().unwrap();
    let response = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/auth/devices", token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    let devices = body["devices"].as_array().unwrap();
    assert_eq!(devices.len(), 3);
    assert_eq!(devices[0]["currentDevice"], true);
    assert_eq!(
        devices
            .iter()
            .filter(|device| device["authorizationState"] == "pending_review")
            .count(),
        2
    );
    assert!(devices
        .iter()
        .all(|device| device.get("publicKey").is_none()));
}

#[tokio::test]
async fn pending_device_cannot_manage_other_authorizations() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("device-pending-guard");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);
    let owner = read_json(
        router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body_with_device(
                    &email,
                    "correct horse",
                    device_registration(21, "Owner Mac", "macos"),
                ),
            ))
            .await
            .unwrap(),
    )
    .await;
    let first_pending = login_with_device(&router, &email, 22, "First iPhone").await;
    let second_pending = login_with_device(&router, &email, 23, "Second iPhone").await;
    let owner_token = owner["session"]["token"].as_str().unwrap();
    let owner_device_id = owner["session"]["deviceId"].as_str().unwrap();
    let pending_token = first_pending["session"]["token"].as_str().unwrap();
    let second_pending_device_id = second_pending["session"]["deviceId"].as_str().unwrap();

    let revoke_owner = router
        .clone()
        .oneshot(delete_json_with_token(
            &format!("/v1/cloud/auth/devices/{owner_device_id}"),
            pending_token,
            json!({"clientOperationId": uuid::Uuid::new_v4()}),
        ))
        .await
        .unwrap();
    assert_eq!(revoke_owner.status(), StatusCode::FORBIDDEN);

    let confirm_other = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/auth/devices/{second_pending_device_id}/confirm"),
            pending_token,
            json!({"clientOperationId": uuid::Uuid::new_v4()}),
        ))
        .await
        .unwrap();
    assert_eq!(confirm_other.status(), StatusCode::FORBIDDEN);

    let revoke_others = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/auth/devices/revoke-others",
            pending_token,
            json!({"clientOperationId": uuid::Uuid::new_v4()}),
        ))
        .await
        .unwrap();
    assert_eq!(revoke_others.status(), StatusCode::FORBIDDEN);

    let owner_confirmation = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/auth/devices/{second_pending_device_id}/confirm"),
            owner_token,
            json!({"clientOperationId": uuid::Uuid::new_v4()}),
        ))
        .await
        .unwrap();
    assert_eq!(owner_confirmation.status(), StatusCode::OK);

    let owner_still_active = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/auth/me", owner_token))
        .await
        .unwrap();
    assert_eq!(owner_still_active.status(), StatusCode::OK);
}

#[tokio::test]
async fn remote_revoke_is_atomic_idempotent_and_invalidates_the_target_token() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("device-revoke");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);
    let owner = read_json(
        router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body_with_device(
                    &email,
                    "correct horse",
                    device_registration(4, "Owner Mac", "macos"),
                ),
            ))
            .await
            .unwrap(),
    )
    .await;
    let target = login_with_device(&router, &email, 5, "Other iPhone").await;
    let owner_token = owner["session"]["token"].as_str().unwrap();
    let target_token = target["session"]["token"].as_str().unwrap();
    let target_device_id = target["session"]["deviceId"].as_str().unwrap();
    let operation_id = uuid::Uuid::new_v4();
    let path = format!("/v1/cloud/auth/devices/{target_device_id}");
    for _ in 0..2 {
        let response = router
            .clone()
            .oneshot(delete_json_with_token(
                &path,
                owner_token,
                json!({"clientOperationId": operation_id}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            read_json(response).await["affectedDeviceIds"][0],
            target_device_id
        );
    }

    let rejected = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/auth/me", target_token))
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);

    let atomic_state: (Option<String>, i64, i64, i64) = sqlx_core::query_as::query_as(
        "SELECT d.revoked_at, \
                (SELECT COUNT(*)::BIGINT FROM cloud_refresh_tokens t \
                 WHERE t.device_id = d.device_id AND t.revoked_at IS NOT NULL), \
                (SELECT COUNT(*)::BIGINT FROM cloud_audit_events a \
                 WHERE a.account_id = d.account_id AND a.event_type = 'device.revoked' \
                   AND a.metadata_json LIKE '%' || d.device_id || '%'), \
                (SELECT COUNT(*)::BIGINT FROM cloud_chat_user_sync_events e \
                 WHERE e.account_id = d.account_id AND e.event_type = 'device.revoked' \
                   AND e.payload->>'deviceId' = d.device_id) \
         FROM cloud_devices d WHERE d.device_id = $1",
    )
    .bind(target_device_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(atomic_state.0.is_some());
    assert_eq!(atomic_state.1, 1);
    assert_eq!(atomic_state.2, 1);
    assert_eq!(atomic_state.3, 1);
}

#[tokio::test]
async fn revoke_all_others_preserves_only_the_authenticated_caller() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("device-revoke-others");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);
    let owner = read_json(
        router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body_with_device(
                    &email,
                    "correct horse",
                    device_registration(8, "Owner Mac", "macos"),
                ),
            ))
            .await
            .unwrap(),
    )
    .await;
    let second = login_with_device(&router, &email, 9, "Phone A").await;
    let third = login_with_device(&router, &email, 10, "Phone B").await;
    let owner_token = owner["session"]["token"].as_str().unwrap();
    let response = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/auth/devices/revoke-others",
            owner_token,
            json!({"clientOperationId": uuid::Uuid::new_v4()}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    assert_eq!(body["affectedDeviceIds"].as_array().unwrap().len(), 2);

    assert_eq!(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/auth/me", owner_token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    for token in [
        second["session"]["token"].as_str().unwrap(),
        third["session"]["token"].as_str().unwrap(),
    ] {
        assert_eq!(
            router
                .clone()
                .oneshot(get_with_token("/v1/cloud/auth/me", token))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
}
