use super::*;

#[tokio::test]
async fn provider_auth_snapshot_create_current_revoke_and_audit() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "provider-auth-owner", "Owner").await;

    let create = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots",
            &owner.token,
            json!({
                "provider": "openai",
                "authChoice": "default",
                "payload": {
                    "accessToken": "secret-access-token",
                    "refreshToken": "secret-refresh-token"
                }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::CREATED);
    let created = read_json(create).await;
    let snapshot_id = created["snapshotId"].as_str().unwrap().to_string();
    assert_eq!(created["provider"], "openai");
    assert_eq!(created["authChoice"], "default");
    assert_eq!(created["revokedAt"], Value::Null);
    assert!(
        created.get("payload").is_none(),
        "snapshot response must not echo secrets"
    );

    let encrypted: (Vec<u8>,) = sqlx_core::query_as::query_as(
        "SELECT encrypted_payload FROM cloud_agent_provider_auth_snapshots WHERE snapshot_id = $1",
    )
    .bind(&snapshot_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let encrypted_text = String::from_utf8_lossy(&encrypted.0);
    assert!(!encrypted_text.contains("secret-access-token"));

    let current = router
        .clone()
        .oneshot(get_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/current?provider=openai&authChoice=default",
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(current.status(), StatusCode::OK);
    let current_body = read_json(current).await;
    assert_eq!(current_body["snapshot"]["snapshotId"], snapshot_id);
    assert!(current_body["snapshot"].get("payload").is_none());

    kordi_cloud_server::cloud_agent_runtime::provider_auth::record_snapshot_used(
        &pool,
        &snapshot_id,
        &owner.account_id,
        Some("car_test_run"),
    )
    .await
    .unwrap();

    let revoke = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/agent-provider-auth/snapshots/{snapshot_id}"),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(revoke.status(), StatusCode::OK);

    let current_after_revoke = router
        .clone()
        .oneshot(get_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/current?provider=openai&authChoice=default",
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(current_after_revoke.status(), StatusCode::OK);
    let current_after_revoke_body = read_json(current_after_revoke).await;
    assert_eq!(current_after_revoke_body["snapshot"], Value::Null);

    let audit_count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_provider_auth_snapshot_audit WHERE snapshot_id = $1 AND action IN ('created', 'used', 'revoked')",
    )
    .bind(&snapshot_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit_count.0, 3);
}

#[tokio::test]
async fn provider_auth_snapshot_is_account_scoped() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "provider-auth-owner-scope", "Owner").await;
    let other = signup(&router, "provider-auth-other-scope", "Other").await;

    let create = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots",
            &owner.token,
            json!({
                "provider": "openai",
                "authChoice": "default",
                "payload": { "accessToken": "owner-only" }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::CREATED);

    let other_current = router
        .clone()
        .oneshot(get_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/current?provider=openai&authChoice=default",
            &other.token,
        ))
        .await
        .unwrap();
    assert_eq!(other_current.status(), StatusCode::OK);
    let body = read_json(other_current).await;
    assert_eq!(body["snapshot"], Value::Null);
}

#[tokio::test]
async fn provider_auth_restore_is_fresh_session_account_scoped_and_device_encrypted() {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    use hkdf::Hkdf;
    use sha2::Sha256;
    use x25519_dalek::{PublicKey, StaticSecret};

    let Some(pool) = try_pool().await else { return };
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "provider-auth-restore-owner", "Owner").await;
    let other = signup(&router, "provider-auth-restore-other", "Other").await;

    let create = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots",
            &owner.token,
            json!({
                "provider": "anthropic",
                "authChoice": "profile:anthropic-oauth-owner",
                "payload": {
                    "apiMode": "anthropic-oauth",
                    "accessToken": "restore-access-secret",
                    "refreshToken": "restore-refresh-secret",
                    "expiresAt": 4102444800000_i64
                }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::CREATED);
    let snapshot_id = read_json(create).await["snapshotId"]
        .as_str()
        .unwrap()
        .to_string();

    let device_secret = StaticSecret::random_from_rng(rand::rngs::OsRng);
    let device_public = PublicKey::from(&device_secret);
    let restore = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/restore",
            &owner.token,
            json!({
                "devicePublicKey": base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(device_public.as_bytes())
            }),
        ))
        .await
        .unwrap();
    assert_eq!(restore.status(), StatusCode::OK);
    let body = read_json(restore).await;
    let serialized = body.to_string();
    assert!(!serialized.contains("restore-access-secret"));
    assert!(!serialized.contains("restore-refresh-secret"));
    assert_eq!(body["snapshotCount"], 1);

    let server_public_bytes: [u8; 32] = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(body["envelope"]["serverPublicKey"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let shared_secret = device_secret.diffie_hellman(&PublicKey::from(server_public_bytes));
    let salt = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(body["envelope"]["salt"].as_str().unwrap())
        .unwrap();
    let mut key_bytes = [0_u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), shared_secret.as_bytes())
        .expand(b"kordi-provider-auth-device-restore-v1", &mut key_bytes)
        .unwrap();
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let nonce = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(body["envelope"]["nonce"].as_str().unwrap())
        .unwrap();
    let ciphertext = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(body["envelope"]["ciphertext"].as_str().unwrap())
        .unwrap();
    let aad = format!(
        "kordi-provider-auth-device-restore-v1\0{}\0{}",
        owner.account_id,
        body["deviceId"].as_str().unwrap()
    );
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .unwrap();
    let bundle: Value = serde_json::from_slice(&plaintext).unwrap();
    assert_eq!(bundle["accountId"], owner.account_id);
    assert_eq!(bundle["snapshots"][0]["snapshotId"], snapshot_id);
    assert_eq!(
        bundle["snapshots"][0]["payload"]["accessToken"],
        "restore-access-secret"
    );

    let other_secret = StaticSecret::random_from_rng(rand::rngs::OsRng);
    let other_public = PublicKey::from(&other_secret);
    let other_restore = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/restore",
            &other.token,
            json!({
                "devicePublicKey": base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(other_public.as_bytes())
            }),
        ))
        .await
        .unwrap();
    assert_eq!(other_restore.status(), StatusCode::OK);
    let other_body = read_json(other_restore).await;
    assert_eq!(other_body["snapshotCount"], 0);
    assert_eq!(other_body["envelope"], Value::Null);

    let audit_count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_provider_auth_snapshot_audit \
         WHERE snapshot_id = $1 AND account_id = $2 AND action = 'restored'",
    )
    .bind(&snapshot_id)
    .bind(&owner.account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit_count.0, 1);

    sqlx_core::query::query(
        "UPDATE cloud_refresh_tokens SET created_at = $1 \
         WHERE account_id = $2 AND token_hash = $3",
    )
    .bind((chrono::Utc::now() - chrono::Duration::minutes(20)).to_rfc3339())
    .bind(&owner.account_id)
    .bind(kordi_cloud_server::auth::session::hash_session_token(
        &owner.token,
    ))
    .execute(&pool)
    .await
    .unwrap();
    let stale_restore = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/restore",
            &owner.token,
            json!({
                "devicePublicKey": base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(device_public.as_bytes())
            }),
        ))
        .await
        .unwrap();
    assert_eq!(stale_restore.status(), StatusCode::OK);
    assert_eq!(read_json(stale_restore).await["snapshotCount"], 1);

    let replacement_secret = StaticSecret::random_from_rng(rand::rngs::OsRng);
    let replacement_public = PublicKey::from(&replacement_secret);
    let replacement_restore = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/restore",
            &owner.token,
            json!({
                "devicePublicKey": base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(replacement_public.as_bytes())
            }),
        ))
        .await
        .unwrap();
    assert_eq!(replacement_restore.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        read_json(replacement_restore).await["errorCode"],
        "provider_auth_restore_device_key_mismatch"
    );
}

#[tokio::test]
async fn provider_auth_manifest_and_restore_track_api_key_add_update_and_removal() {
    use x25519_dalek::{PublicKey, StaticSecret};

    let Some(pool) = try_pool().await else { return };
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "provider-auth-lifecycle-owner", "Owner").await;
    let device_secret = StaticSecret::random_from_rng(rand::rngs::OsRng);
    let device_public = PublicKey::from(&device_secret);
    let encoded_device_key =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(device_public.as_bytes());

    let publish = |api_key: &str| {
        post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots",
            &owner.token,
            json!({
                "provider": "openrouter",
                "authChoice": "profile:cross-device-key",
                "payload": {
                    "apiKey": api_key,
                    "model": "openai/gpt-5.5",
                    "syncActive": true
                }
            }),
        )
    };
    let first = router.clone().oneshot(publish("key-one")).await.unwrap();
    assert_eq!(first.status(), StatusCode::CREATED);
    let first_snapshot_id = read_json(first).await["snapshotId"]
        .as_str()
        .unwrap()
        .to_string();

    let first_manifest = router
        .clone()
        .oneshot(get_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/manifest",
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(first_manifest.status(), StatusCode::OK);
    let first_manifest = read_json(first_manifest).await;
    assert_eq!(first_manifest["snapshots"].as_array().unwrap().len(), 1);
    let first_revision = first_manifest["syncRevision"].as_str().unwrap().to_string();

    let first_restore = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/restore",
            &owner.token,
            json!({ "devicePublicKey": encoded_device_key.clone() }),
        ))
        .await
        .unwrap();
    assert_eq!(first_restore.status(), StatusCode::OK);
    let first_restore = read_json(first_restore).await;
    assert_eq!(first_restore["snapshotCount"], 1);
    assert_eq!(first_restore["changed"], true);
    assert!(first_restore["envelope"].is_object());
    let restore_revision = first_restore["syncRevision"].as_str().unwrap().to_string();

    let unchanged = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/restore",
            &owner.token,
            json!({
                "devicePublicKey": encoded_device_key.clone(),
                "knownRevision": restore_revision.clone(),
            }),
        ))
        .await
        .unwrap();
    let unchanged = read_json(unchanged).await;
    assert_eq!(unchanged["changed"], false);
    assert_eq!(unchanged["envelope"], Value::Null);

    let duplicate = router.clone().oneshot(publish("key-one")).await.unwrap();
    assert_eq!(
        read_json(duplicate).await["snapshotId"],
        first_snapshot_id,
        "identical device publications must be idempotent",
    );
    let duplicate_manifest = read_json(
        router
            .clone()
            .oneshot(get_with_token(
                "/v1/cloud/agent-provider-auth/snapshots/manifest",
                &owner.token,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(duplicate_manifest["syncRevision"], first_revision);

    let updated = router.clone().oneshot(publish("key-two")).await.unwrap();
    let updated_snapshot_id = read_json(updated).await["snapshotId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(updated_snapshot_id, first_snapshot_id);
    let updated_restore = read_json(
        router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-provider-auth/snapshots/restore",
                &owner.token,
                json!({
                    "devicePublicKey": encoded_device_key.clone(),
                    "knownRevision": restore_revision,
                }),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(updated_restore["changed"], true);
    assert_eq!(updated_restore["snapshotCount"], 1);
    let updated_revision = updated_restore["syncRevision"]
        .as_str()
        .unwrap()
        .to_string();

    let revoke = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/agent-provider-auth/snapshots/{updated_snapshot_id}"),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(revoke.status(), StatusCode::OK);
    let removed_restore = read_json(
        router
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-provider-auth/snapshots/restore",
                &owner.token,
                json!({
                    "devicePublicKey": encoded_device_key,
                    "knownRevision": updated_revision,
                }),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(removed_restore["changed"], true);
    assert_eq!(removed_restore["snapshotCount"], 0);
    assert_eq!(removed_restore["envelope"], Value::Null);
}

#[tokio::test]
async fn provider_auth_material_is_run_scoped_runner_only_and_audited() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "provider-material-owner", "Owner").await;
    let requester = signup(&router, "provider-material-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;

    let snapshot = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots",
            &owner.token,
            json!({
                "provider": "openai",
                "authChoice": "default",
                "payload": {
                    "apiKey": "runner-secret",
                    "baseUrl": "https://api.openai.com/v1",
                    "model": "gpt-4.1-mini"
                }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(snapshot.status(), StatusCode::CREATED);
    let snapshot_id = read_json(snapshot).await["snapshotId"]
        .as_str()
        .unwrap()
        .to_string();

    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_provider_material"),
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::OK);
    let run_id = read_json(claim).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    let target_agent_id = format!("cloud_agent_provider_route_{}", owner.account_id);
    let now = chrono::Utc::now().to_rfc3339();
    sqlx_core::query::query(
        "INSERT INTO cloud_agent_definitions (
            agent_id, owner_account_id, access_scope, status, name, role,
            system_prompt, model_routing_json, created_at, updated_at
         ) VALUES ($1, $2, 'participant_conversations', 'active',
                   'Provider route agent', 'Assistant', 'Help.', $3, $4, $4)",
    )
    .bind(&target_agent_id)
    .bind(&owner.account_id)
    .bind(json!({
        "defaultAuthProvider": "openai",
        "defaultAuthChoice": "default",
        "defaultModel": "openai/gpt-5.4"
    }))
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();
    sqlx_core::query::query(
        "UPDATE cloud_agent_fallback_runs SET target_agent_id = $2 WHERE run_id = $1",
    )
    .bind(&run_id)
    .bind(&target_agent_id)
    .execute(&pool)
    .await
    .unwrap();
    cancel_other_queued_runs(&pool, &run_id).await;

    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": "runner-material" }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);

    let user_token_response = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            &requester.token,
            json!({ "runnerId": "runner-material" }),
        ))
        .await
        .unwrap();
    assert_eq!(user_token_response.status(), StatusCode::UNAUTHORIZED);

    let wrong_runner_response = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "runner-other" }),
        ))
        .await
        .unwrap();
    assert_eq!(wrong_runner_response.status(), StatusCode::NOT_FOUND);
    let wrong_runner_body = read_json(wrong_runner_response).await;
    assert_eq!(wrong_runner_body["errorCode"], "agent_run_not_found");

    let provider_auth = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "runner-material" }),
        ))
        .await
        .unwrap();
    assert_eq!(provider_auth.status(), StatusCode::OK);
    let body = read_json(provider_auth).await;
    assert_eq!(body["providerAuth"]["snapshotId"], snapshot_id);
    assert_eq!(body["providerAuth"]["provider"], "openai");
    assert_eq!(body["providerAuth"]["authChoice"], "default");
    assert_eq!(body["providerAuth"]["payload"]["apiKey"], "runner-secret");
    assert_eq!(
        body["providerAuth"]["payload"]["baseUrl"],
        "https://api.openai.com/v1"
    );
    assert_eq!(body["providerAuth"]["payload"]["model"], "openai/gpt-5.4");

    let audit_count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_provider_auth_snapshot_audit WHERE snapshot_id = $1 AND run_id = $2 AND action = 'used'",
    )
    .bind(&snapshot_id)
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit_count.0, 1);

    sqlx_core::query::query(
        "UPDATE cloud_agent_definitions SET model_routing_json = $2, updated_at = $3 \
         WHERE agent_id = $1",
    )
    .bind(&target_agent_id)
    .bind(json!({
        "defaultAuthProvider": "openai",
        "defaultAuthChoice": "profile:replaced-auth",
        "defaultModel": "openai/gpt-5.4"
    }))
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();
    let sole_replacement = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "runner-material" }),
        ))
        .await
        .unwrap();
    assert_eq!(sole_replacement.status(), StatusCode::OK);
    assert_eq!(
        read_json(sole_replacement).await["providerAuth"]["snapshotId"],
        snapshot_id
    );

    let second_snapshot = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots",
            &owner.token,
            json!({
                "provider": "openai",
                "authChoice": "profile:second-auth",
                "payload": {
                    "apiKey": "second-runner-secret",
                    "model": "openai/gpt-5.4"
                }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(second_snapshot.status(), StatusCode::CREATED);
    let second_snapshot_id = read_json(second_snapshot).await["snapshotId"]
        .as_str()
        .unwrap()
        .to_string();
    let ambiguous_replacement = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "runner-material" }),
        ))
        .await
        .unwrap();
    assert_eq!(ambiguous_replacement.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        read_json(ambiguous_replacement).await["errorCode"],
        "provider_auth_not_found"
    );
    let revoke_second = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/agent-provider-auth/snapshots/{second_snapshot_id}"),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(revoke_second.status(), StatusCode::OK);
    sqlx_core::query::query(
        "UPDATE cloud_agent_definitions SET model_routing_json = $2, updated_at = $3 \
         WHERE agent_id = $1",
    )
    .bind(&target_agent_id)
    .bind(json!({
        "defaultAuthProvider": "openai",
        "defaultAuthChoice": "default",
        "defaultModel": "openai/gpt-5.4"
    }))
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();

    let refresh = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth/refresh"),
            "runner-test-token",
            json!({
                "runnerId": "runner-material",
                "snapshotId": snapshot_id,
                "payload": {
                    "apiMode": "openai-codex-oauth",
                    "accessToken": "rotated-runner-secret",
                    "refreshToken": "rotated-refresh-secret",
                    "expiresAt": 4102444800000_i64,
                    "model": "openai/gpt-5.4"
                }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(refresh.status(), StatusCode::OK);
    let refreshed_body = read_json(refresh).await;
    assert_eq!(
        refreshed_body["providerAuth"]["payload"]["accessToken"],
        "rotated-runner-secret"
    );

    let fetched_after_refresh = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "runner-material" }),
        ))
        .await
        .unwrap();
    assert_eq!(fetched_after_refresh.status(), StatusCode::OK);
    assert_eq!(
        read_json(fetched_after_refresh).await["providerAuth"]["payload"]["accessToken"],
        "rotated-runner-secret"
    );
    let encrypted_after_refresh: (Vec<u8>,) = sqlx_core::query_as::query_as(
        "SELECT encrypted_payload FROM cloud_agent_provider_auth_snapshots WHERE snapshot_id = $1",
    )
    .bind(&snapshot_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!String::from_utf8_lossy(&encrypted_after_refresh.0).contains("rotated-runner-secret"));
    let refreshed_audit_count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_provider_auth_snapshot_audit WHERE snapshot_id = $1 AND run_id = $2 AND action = 'refreshed'",
    )
    .bind(&snapshot_id)
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(refreshed_audit_count.0, 1);

    sqlx_core::query::query(
        "UPDATE cloud_agent_provider_auth_snapshots \
         SET encryption_key_id = 'foreign-mirror-key:v1' WHERE snapshot_id = $1",
    )
    .bind(&snapshot_id)
    .execute(&pool)
    .await
    .unwrap();
    let incompatible_snapshot = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "runner-material" }),
        ))
        .await
        .unwrap();
    assert_eq!(incompatible_snapshot.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        read_json(incompatible_snapshot).await["errorCode"],
        "provider_auth_not_found"
    );
}

#[tokio::test]
async fn provider_auth_material_missing_snapshot_returns_not_found() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = test_router(state);
    let owner = signup(&router, "provider-material-missing-owner", "Owner").await;
    let requester = signup(&router, "provider-material-missing-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;

    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_provider_material_missing"),
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::OK);
    let run_id = read_json(claim).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    cancel_other_queued_runs(&pool, &run_id).await;

    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": "runner-material-missing" }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);

    let missing_snapshot_response = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            "runner-test-token",
            json!({ "runnerId": "runner-material-missing" }),
        ))
        .await
        .unwrap();
    assert_eq!(missing_snapshot_response.status(), StatusCode::NOT_FOUND);
    let body = read_json(missing_snapshot_response).await;
    assert_eq!(body["errorCode"], "provider_auth_not_found");
}
