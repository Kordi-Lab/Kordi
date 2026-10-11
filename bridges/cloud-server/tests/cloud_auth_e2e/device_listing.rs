use super::*;

async fn insert_legacy_device(
    pool: &sqlx_postgres::PgPool,
    account_id: &str,
    name: &str,
) -> String {
    let device_id = format!("dev_{}", uuid::Uuid::new_v4().simple());
    let now = chrono::Utc::now().to_rfc3339();
    sqlx_core::query::query(
        "INSERT INTO cloud_devices \
         (device_id, account_id, device_name, device_public_key, device_key_algorithm, \
          authorization_state, confirmed_at, created_at, last_seen_at) \
         VALUES ($1, $2, $3, $4, 'legacy', 'confirmed', $5, $5, $5)",
    )
    .bind(&device_id)
    .bind(account_id)
    .bind(name)
    .bind(format!("legacy:{}", uuid::Uuid::new_v4().simple()))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    device_id
}

async fn insert_refresh_token(
    pool: &sqlx_postgres::PgPool,
    account_id: &str,
    device_id: &str,
    revoked: bool,
) {
    let now = chrono::Utc::now();
    let revoked_at = revoked.then(|| now.to_rfc3339());
    sqlx_core::query::query(
        "INSERT INTO cloud_refresh_tokens \
         (token_id, account_id, device_id, token_hash, created_at, expires_at, revoked_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(format!("tok_{}", uuid::Uuid::new_v4().simple()))
    .bind(account_id)
    .bind(device_id)
    .bind(format!("e2e-hash-{}", uuid::Uuid::new_v4().simple()))
    .bind(now.to_rfc3339())
    .bind((now + chrono::Duration::days(30)).to_rfc3339())
    .bind(revoked_at)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn device_list_hides_dead_legacy_rows_and_labels_placeholder_sign_ins() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(signup_email_fixture::state(pool.clone()));
    let router = fast_router(state);
    let signup = read_json(
        router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body(&unique_email("device-list-filter"), "correct horse").await,
            ))
            .await
            .unwrap(),
    )
    .await;
    let token = signup["session"]["token"].as_str().unwrap();
    let account_id = signup["account"]["accountId"].as_str().unwrap();
    let current_device_id = signup["session"]["deviceId"].as_str().unwrap();

    let live_legacy_id = insert_legacy_device(&pool, account_id, "oauth-google-device").await;
    insert_refresh_token(&pool, account_id, &live_legacy_id, false).await;
    let dead_legacy_id =
        insert_legacy_device(&pool, account_id, "cloud-email-password-device").await;
    insert_refresh_token(&pool, account_id, &dead_legacy_id, true).await;

    let response = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/auth/devices", token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    let devices = body["devices"].as_array().unwrap();

    assert_eq!(devices[0]["deviceId"], current_device_id);
    assert_eq!(devices[0]["currentDevice"], true);
    assert_eq!(devices[0]["sessionCount"], 1);

    let live = devices
        .iter()
        .find(|device| device["deviceId"] == live_legacy_id.as_str())
        .expect("legacy device with a live token is listed");
    assert_eq!(live["currentDevice"], false);
    assert_eq!(live["legacy"], true);
    assert_eq!(live["signInMethod"], "google");
    assert!(live["displayName"].is_null());
    assert_eq!(live["sessionCount"], 1);
    assert_eq!(live["online"], false);

    assert!(
        devices
            .iter()
            .all(|device| device["deviceId"] != dead_legacy_id.as_str()),
        "legacy device without a live token must be hidden"
    );
    assert_eq!(devices.len(), 2);
}
