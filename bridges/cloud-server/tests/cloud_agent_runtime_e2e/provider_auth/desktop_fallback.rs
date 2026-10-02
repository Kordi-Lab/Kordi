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
