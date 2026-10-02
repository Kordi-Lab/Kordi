//! Runs on hosted provider accounts go to the cloud runner when no ready
//! desktop can prove possession of its registered device key.

use super::*;

#[tokio::test]
async fn hosted_runs_fall_back_to_the_cloud_without_a_proving_desktop() {
    let Some((pool, router, mac)) = setup().await else {
        return;
    };
    // A desktop without a registered key cannot obtain a challenge.
    let legacy = signup(&router, "desktop-proof-legacy", "Legacy").await;
    sqlx_core::query::query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&legacy.account_id)
        .execute(&pool)
        .await
        .unwrap();
    ready(&router, &legacy, Some(true)).await;
    save_hosted_account(&router, &legacy).await;
    let (body, claim_id) = request(&pool, &legacy, HOSTED_ROUTE).await;
    assert_eq!(
        desktop_claim(&router, &legacy, &body, claim_id).await["acquired"],
        false
    );
    let cloud = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &legacy.token,
            body,
        ))
        .await
        .unwrap();
    assert_eq!(
        cloud.status(),
        StatusCode::OK,
        "the cloud runner takes the run"
    );
    // A keyless Mac that holds a lease, as in a project session that has no
    // cloud fallback, learns that it needs to register a key.
    let run = read_json(cloud).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    let (device,): (String,) = sqlx_core::query_as::query_as(
        "SELECT device_id FROM cloud_devices WHERE account_id=$1 AND revoked_at IS NULL",
    )
    .bind(&legacy.account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx_core::query::query("UPDATE cloud_agent_fallback_runs SET execution_backend='desktop',status='leased',claimed_by=$2,lease_expires_at=(now()+interval '1 minute')::text WHERE run_id=$1")
        .bind(&run).bind(format!("desktop:{device}:{claim_id}")).execute(&pool).await.unwrap();
    let response = challenge(&router, &legacy, &run, claim_id).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        read_json(response).await["errorCode"],
        "device_key_required"
    );
    let (status, body) = provider_auth(&router, &legacy, &run, claim_id, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["errorCode"], "device_key_required");

    // A desktop that publishes readiness without device proofs, as installed
    // releases do, keeps local-account runs and leaves hosted ones to Cloud.
    ready(&router, &mac.account, None).await;
    let (body, claim_id) = request(&pool, &mac.account, HOSTED_ROUTE).await;
    assert_eq!(
        desktop_claim(&router, &mac.account, &body, claim_id).await["acquired"],
        false
    );
    let cloud = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &mac.account.token,
            body,
        ))
        .await
        .unwrap();
    assert_eq!(cloud.status(), StatusCode::OK);
    let (body, claim_id) = request(&pool, &mac.account, "default").await;
    let cloud = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &mac.account.token,
            body.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(
        cloud.status(),
        StatusCode::CONFLICT,
        "the ready Mac keeps local-account runs"
    );
    assert_eq!(read_json(cloud).await["errorCode"], "owner_online");
    assert_eq!(
        desktop_claim(&router, &mac.account, &body, claim_id).await["acquired"],
        true
    );

    // With device proofs the ready Mac keeps hosted runs too.
    ready(&router, &mac.account, Some(true)).await;
    let (body, _) = request(&pool, &mac.account, HOSTED_ROUTE).await;
    let cloud = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &mac.account.token,
            body,
        ))
        .await
        .unwrap();
    assert_eq!(cloud.status(), StatusCode::CONFLICT);
    assert_eq!(read_json(cloud).await["errorCode"], "owner_online");
}

async fn cloud_claim(
    router: &axum::Router,
    account: &TestAccount,
    body: &Value,
) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &account.token,
            body.clone(),
        ))
        .await
        .unwrap();
    let status = response.status();
    (status, read_json(response).await)
}

/// An owner request whose admission route, as iOS, the web, or the Mac's own
/// fallback sends it, selects no hosted account, while the route the Mac binds
/// for the session does. A Mac that cannot use that hosted account hands the
/// request to Cloud, and admission returns that run instead of waiting on the
/// Mac.
async fn assert_mac_hands_off_its_hosted_route(
    router: &axum::Router,
    pool: &sqlx_postgres::PgPool,
    owner: &TestAccount,
) {
    let (hosted, claim_id) = request(pool, owner, HOSTED_ROUTE).await;
    let mut local = hosted.clone();
    local["runtimeRoute"]["defaultAuthChoice"] = json!("default");
    let mut model_only = hosted.clone();
    model_only["runtimeRoute"] = json!({"defaultModel":"openai/gpt-4.1-mini"});
    let mut absent = hosted.clone();
    absent.as_object_mut().unwrap().remove("runtimeRoute");

    for body in [&local, &model_only, &absent] {
        let (status, body) = cloud_claim(router, owner, body).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["errorCode"], "owner_online");
    }
    let handed = desktop_claim(router, owner, &hosted, claim_id).await;
    assert_eq!(handed["acquired"], false);
    assert_eq!(handed["executionBackend"], "cloud");
    let run = handed["runId"].as_str().unwrap().to_string();
    for body in [&local, &model_only, &absent] {
        let (status, body) = cloud_claim(router, owner, body).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["runId"], run.as_str());
        assert_eq!(body["executionBackend"], "cloud");
    }
    let again = desktop_claim(router, owner, &hosted, uuid::Uuid::new_v4()).await;
    assert_eq!(again["acquired"], false, "the Mac does not take it back");
    assert_eq!(again["runId"], run.as_str());

    // The cloud runner executes it on the route the Mac selected.
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": "runner-desktop-hand-off", "canaryRunId": run }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    let lease = read_json(lease).await;
    assert_eq!(lease["run"]["runId"], run.as_str());
    assert_eq!(
        lease["run"]["runtimeRoute"]["defaultAuthChoice"],
        HOSTED_ROUTE
    );
}

#[tokio::test]
async fn a_mac_that_cannot_prove_hands_its_hosted_route_to_the_cloud() {
    let Some((pool, router, mac)) = setup().await else {
        return;
    };
    // An installed release publishes readiness without device proofs.
    ready(&router, &mac.account, None).await;
    assert_mac_hands_off_its_hosted_route(&router, &pool, &mac.account).await;

    // A current release on a device that registered no key at sign-in.
    let keyless = signup(&router, "desktop-hand-off-keyless", "Keyless").await;
    sqlx_core::query::query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&keyless.account_id)
        .execute(&pool)
        .await
        .unwrap();
    ready(&router, &keyless, Some(true)).await;
    save_hosted_account(&router, &keyless).await;
    assert_mac_hands_off_its_hosted_route(&router, &pool, &keyless).await;
}

#[tokio::test]
async fn a_ready_mac_that_proves_keeps_runs_another_mac_cannot_prove() {
    let Some((pool, router, mac)) = setup().await else {
        return;
    };
    // A second Mac of the same account runs an installed release.
    let installed = sign_in_with_device_key(
        &router,
        "/v1/cloud/auth/login",
        &mac.email,
        &random_device_key(),
    )
    .await;
    ready(&router, &installed, None).await;
    let (hosted, claim_id) = request(&pool, &installed, HOSTED_ROUTE).await;
    assert_eq!(
        desktop_claim(&router, &installed, &hosted, claim_id).await,
        json!({"acquired":false})
    );
    let (queued,): (i64,) = sqlx_core::query_as::query_as(
        "SELECT count(*) FROM cloud_agent_fallback_runs WHERE request_message_id=$1",
    )
    .bind(hosted["requestMessageId"].as_str().unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(queued, 0, "the proving Mac may still claim it");
    let claimed = desktop_claim(&router, &mac.account, &hosted, uuid::Uuid::new_v4()).await;
    assert_eq!(claimed["acquired"], true);
}
