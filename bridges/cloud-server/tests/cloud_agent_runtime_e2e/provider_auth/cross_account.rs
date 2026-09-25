//! One Kordi account can never list, read, revoke, test, or validate through
//! another account's saved provider accounts. Every credential is synthetic.

use super::login_session::login_router;
use super::omp_worker::{mock_worker, WorkerCall};
use super::route_safety::publish;
use super::route_test::{error_code, request_test_route, CODEX_MODEL};
use super::*;

#[tokio::test]
async fn saved_accounts_never_cross_to_another_kordi_account() {
    let Some(pool) = try_pool().await else { return };
    let (worker, _worker_env) = mock_worker().await;
    let router = login_router(&pool);
    let owner = signup(&router, "provider-cross-owner", "Owner").await;
    let intruder = signup(&router, "provider-cross-intruder", "Intruder").await;
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let owner_credential = format!("synthetic-cross-owner-{suffix}");
    let snapshot = publish(
        &router,
        &owner,
        json!({
            "provider": "openai-codex",
            "authChoice": "profile:work",
            "label": "Work",
            "payload": {
                "apiMode": "openai-codex-oauth",
                "accessToken": owner_credential,
                "expiresAtMs": "4102444800000"
            }
        }),
    )
    .await;
    let snapshot_id = snapshot["snapshotId"].as_str().unwrap().to_string();

    // Listing and the current-snapshot lookup only ever read the caller's rows.
    for path in [
        "/v1/cloud/agent-provider-auth/snapshots",
        "/v1/cloud/agent-provider-auth/snapshots?provider=openai-codex",
    ] {
        let listed = router
            .clone()
            .oneshot(get_with_token(path, &intruder.token))
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        assert_eq!(read_json(listed).await["snapshots"], json!([]), "{path}");
    }
    let current = router
        .clone()
        .oneshot(get_with_token(
            "/v1/cloud/agent-provider-auth/snapshots/current?provider=openai-codex&authChoice=profile:work",
            &intruder.token,
        ))
        .await
        .unwrap();
    assert_eq!(read_json(current).await["snapshot"], Value::Null);

    // Revoking another account's snapshot finds nothing and changes nothing.
    let revoke = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/agent-provider-auth/snapshots/{snapshot_id}?intent=explicit"),
            &intruder.token,
        ))
        .await
        .unwrap();
    assert_eq!(revoke.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        read_json(revoke).await["errorCode"],
        "provider_auth_snapshot_not_found"
    );
    let (live, revocations): (bool, i64) = sqlx_core::query_as::query_as(
        "SELECT snapshot.revoked_at IS NULL, \
                (SELECT COUNT(*)::BIGINT FROM cloud_agent_provider_auth_snapshot_audit audit \
                 WHERE audit.snapshot_id = snapshot.snapshot_id AND audit.action = 'revoked') \
         FROM cloud_agent_provider_auth_snapshots snapshot WHERE snapshot.snapshot_id = $1",
    )
    .bind(&snapshot_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((live, revocations), (true, 0));

    // A route test names the owner's choice but runs as the intruder's account.
    let (status, text) =
        request_test_route(&router, Some(&intruder.token), "profile:work", CODEX_MODEL).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{text}");
    assert_eq!(error_code(&text), "account_unavailable");
    assert!(!text.contains("synthetic-"), "{text}");
    assert!(worker.calls_for(&[owner_credential.as_str()]).is_empty());

    // Key validation checks only the pasted key; it never reads a saved account.
    let intruder_key = format!("synthetic-cross-intruder-{suffix}");
    let validated = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/validate-key",
            &intruder.token,
            json!({ "provider": "openai-codex", "apiKey": intruder_key }),
        ))
        .await
        .unwrap();
    assert_eq!(validated.status(), StatusCode::OK);
    assert_eq!(read_json(validated).await, json!({ "verified": true }));
    assert_eq!(worker.validations_of(&intruder_key), 1);
    assert_eq!(worker.validations_of(&owner_credential), 0);

    // The owner's account is untouched and still serves its own route test.
    let (status, text) =
        request_test_route(&router, Some(&owner.token), "profile:work", CODEX_MODEL).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert_eq!(
        worker.calls_for(&[owner_credential.as_str()]),
        vec![WorkerCall {
            auth_choice: "profile:work".into(),
            credential: owner_credential.clone(),
        }]
    );
    worker.assert_no_violations();
}
