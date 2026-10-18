use super::*;

async fn signup_owner(router: &axum::Router, email: &str, seed: u8) -> serde_json::Value {
    read_json(
        router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body_with_device(
                    email,
                    "correct horse",
                    device_registration(seed, "Owner Mac", "macos"),
                )
                .await,
            ))
            .await
            .unwrap(),
    )
    .await
}

async fn login_installation(router: &axum::Router, email: &str, seed: u8) -> serde_json::Value {
    read_json(
        router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/login",
                Body::from(
                    json!({
                        "email": email,
                        "password": "correct horse",
                        "device": device_registration(seed, "MacBook Pro", "macos"),
                    })
                    .to_string(),
                ),
            ))
            .await
            .unwrap(),
    )
    .await
}

async fn list_devices(router: &axum::Router, token: &str) -> Vec<serde_json::Value> {
    let body = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/auth/devices", token))
            .await
            .unwrap(),
    )
    .await;
    body["devices"].as_array().unwrap().clone()
}

fn device<'a>(devices: &'a [serde_json::Value], device_id: &str) -> &'a serde_json::Value {
    devices
        .iter()
        .find(|device| device["deviceId"] == device_id)
        .unwrap()
}

async fn revoke_others(router: &axum::Router, token: &str) -> StatusCode {
    router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/auth/devices/revoke-others",
            token,
            json!({"clientOperationId": uuid::Uuid::new_v4()}),
        ))
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn pending_device_reports_its_review_window_and_confirms_after_it() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("device-review-window");
    let router = fast_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let owner = signup_owner(&router, &email, 41).await;
    let pending = login_installation(&router, &email, 42).await;
    let owner_token = owner["session"]["token"].as_str().unwrap();
    let pending_token = pending["session"]["token"].as_str().unwrap();
    let pending_id = pending["session"]["deviceId"].as_str().unwrap();

    let devices = list_devices(&router, owner_token).await;
    let row = device(&devices, pending_id);
    assert_eq!(row["authorizationState"], "pending_review");
    let review_ends_at =
        chrono::DateTime::parse_from_rfc3339(row["reviewEndsAt"].as_str().unwrap()).unwrap();
    let remaining = review_ends_at.with_timezone(&chrono::Utc) - chrono::Utc::now();
    assert!(remaining > chrono::Duration::hours(23) && remaining <= chrono::Duration::hours(24));
    assert!(
        device(&devices, owner["session"]["deviceId"].as_str().unwrap())["reviewEndsAt"].is_null()
    );
    assert_eq!(
        revoke_others(&router, pending_token).await,
        StatusCode::FORBIDDEN
    );

    sqlx_core::query::query("UPDATE cloud_devices SET review_started_at = $1 WHERE device_id = $2")
        .bind((chrono::Utc::now() - chrono::Duration::hours(25)).to_rfc3339())
        .bind(pending_id)
        .execute(&pool)
        .await
        .unwrap();

    let devices = list_devices(&router, pending_token).await;
    let row = device(&devices, pending_id);
    assert_eq!(row["authorizationState"], "confirmed");
    assert!(row["reviewEndsAt"].is_null());
    assert_eq!(revoke_others(&router, pending_token).await, StatusCode::OK);
}

#[tokio::test]
async fn pending_device_confirms_when_no_confirmed_device_can_approve_it() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("device-review-orphan");
    let router = fast_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let owner = signup_owner(&router, &email, 43).await;
    let pending = login_installation(&router, &email, 44).await;
    let pending_token = pending["session"]["token"].as_str().unwrap();
    let pending_id = pending["session"]["deviceId"].as_str().unwrap();

    // The confirmed installation still exists but holds no live session.
    sqlx_core::query::query("UPDATE cloud_refresh_tokens SET revoked_at = $1 WHERE device_id = $2")
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(owner["session"]["deviceId"].as_str().unwrap())
        .execute(&pool)
        .await
        .unwrap();

    let devices = list_devices(&router, pending_token).await;
    assert_eq!(
        device(&devices, pending_id)["authorizationState"],
        "confirmed"
    );
}

#[tokio::test]
async fn pending_device_waits_while_a_confirmed_device_can_approve_it() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("device-review-wait");
    let router = fast_router(Arc::new(signup_email_fixture::state(pool)));
    let _owner = signup_owner(&router, &email, 45).await;
    let pending = login_installation(&router, &email, 46).await;
    let pending_token = pending["session"]["token"].as_str().unwrap();
    let pending_id = pending["session"]["deviceId"].as_str().unwrap();

    let devices = list_devices(&router, pending_token).await;
    assert_eq!(
        device(&devices, pending_id)["authorizationState"],
        "pending_review"
    );
    assert_eq!(
        revoke_others(&router, pending_token).await,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn installations_on_the_same_machine_are_marked_without_exposing_the_id() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("device-same-machine");
    let router = fast_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let owner = signup_owner(&router, &email, 47).await;
    let sibling = login_installation(&router, &email, 48).await;
    let other = login_installation(&router, &email, 49).await;
    for (session, machine_id) in [
        (&owner, "machine-a"),
        (&sibling, "machine-a"),
        (&other, "machine-b"),
    ] {
        let response = router
            .clone()
            .oneshot(put_json_with_token(
                "/v1/cloud/auth/devices/current",
                session["session"]["token"].as_str().unwrap(),
                json!({"machineId": machine_id}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

    let devices = list_devices(&router, sibling["session"]["token"].as_str().unwrap()).await;
    assert_eq!(
        device(&devices, owner["session"]["deviceId"].as_str().unwrap())["sameMachine"],
        true
    );
    assert_eq!(
        device(&devices, other["session"]["deviceId"].as_str().unwrap())["sameMachine"],
        false
    );
    assert_eq!(
        device(&devices, sibling["session"]["deviceId"].as_str().unwrap())["sameMachine"],
        false
    );
    assert!(!serde_json::to_string(&devices)
        .unwrap()
        .contains("machine-a"));

    let stored: (Option<String>,) = sqlx_core::query_as::query_as(
        "SELECT machine_hash FROM cloud_devices WHERE device_id = $1",
    )
    .bind(owner["session"]["deviceId"].as_str().unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_ne!(stored.0.as_deref(), Some("machine-a"));
}
