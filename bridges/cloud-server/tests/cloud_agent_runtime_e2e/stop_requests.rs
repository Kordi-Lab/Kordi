//! The requester or owner stops a running agent request from any device.

use kordi_cloud_server::cloud_agent_runtime::runs::stop::{release_stopped_runs, STOPPED_TEXT};

use super::terminal_backfill::{encode, processing_desktop_turn, ready_accounts, replies};
use super::*;

fn stopped() -> (String, String) {
    ("cancelled".to_string(), STOPPED_TEXT.to_string())
}

async fn run_status(pool: &sqlx_postgres::PgPool, run_id: &str) -> String {
    let (status,): (String,) = sqlx_core::query_as::query_as(
        "SELECT status FROM cloud_agent_fallback_runs WHERE run_id=$1",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await
    .unwrap();
    status
}

async fn stop(router: &axum::Router, uri: &str, token: &str) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(post_with_token(uri, token))
        .await
        .unwrap();
    let status = response.status();
    (status, read_json(response).await)
}

/// A contact's request to an offline owner's agent, queued for Cloud.
async fn queued_request(
    router: &axum::Router,
    pool: &sqlx_postgres::PgPool,
    prefix: &str,
) -> (TestAccount, TestAccount, String, String, String) {
    let owner = signup(router, &format!("{prefix}-owner"), "Owner").await;
    let requester = signup(router, &format!("{prefix}-requester"), "Requester").await;
    accept_contacts(router, &requester, &owner).await;
    let offline = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
        .await
        .unwrap();
    assert_eq!(offline.status(), StatusCode::OK);
    let mut ids = [owner.account_id.clone(), requester.account_id.clone()];
    ids.sort();
    let session = format!("session:direct-person:{}:{}", ids[0], ids[1]);
    let conversation = create_test_conversation(
        pool,
        &requester.account_id,
        &session,
        ConversationKind::Direct,
        vec![owner.account_id.clone()],
    )
    .await;
    let request =
        insert_test_message(pool, &requester.account_id, conversation, "@Kordi plan").await;
    let claimed = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body_with_session(&owner, &requester, &request, &session),
        ))
        .await
        .unwrap();
    let claimed_status = claimed.status();
    let claimed = read_json(claimed).await;
    assert_eq!(claimed_status, StatusCode::OK, "{claimed}");
    assert_eq!(claimed["status"], "queued", "{claimed}");
    let run = claimed["runId"].as_str().unwrap().to_string();
    (owner, requester, session, request, run)
}

#[tokio::test]
async fn the_requester_stops_a_queued_run_and_every_device_gets_the_reply() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let (owner, requester, session, request, run) =
        queued_request(&router, &pool, "stop-queued").await;

    let (status, body) = stop(
        &router,
        &format!("/v1/cloud/agent-runs/request/{request}/stop"),
        &requester.token,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["runs"][0]["runId"], run);
    assert_eq!(body["runs"][0]["status"], "cancelled");
    assert_eq!(run_status(&pool, &run).await, "cancelled");
    assert_eq!(
        replies(&pool, &owner, &session, &request).await,
        vec![stopped()]
    );

    // A finished request cannot be stopped again.
    let (status, body) = stop(
        &router,
        &format!("/v1/cloud/agent-runs/{run}/stop"),
        &owner.token,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
}

#[tokio::test]
async fn an_unrelated_account_cannot_stop_a_run() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let (_, _, _, request, run) = queued_request(&router, &pool, "stop-foreign").await;
    let stranger = signup(&router, "stop-stranger", "Stranger").await;
    for uri in [
        format!("/v1/cloud/agent-runs/{run}/stop"),
        format!("/v1/cloud/agent-runs/request/{request}/stop"),
    ] {
        let (status, body) = stop(&router, &uri, &stranger.token).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: {body}");
    }
    assert_eq!(run_status(&pool, &run).await, "queued");
    let (status, _) = stop(
        &router,
        "/v1/cloud/agent-runs/car_missing/stop",
        &stranger.token,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_stop_reaches_the_desktop_holding_the_run() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let accounts = ready_accounts(&router, &pool).await;
    let owner = &accounts.owner;
    let turn = processing_desktop_turn(&router, &pool, &accounts, false).await;
    let renew = || {
        router.clone().oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/desktop/{}/renew", turn.run),
            &owner.token,
            json!({"claimId":turn.claim_id}),
        ))
    };
    let before = read_json(renew().await.unwrap()).await;
    assert_eq!(before, json!({"ok":true,"cancelRequested":false}));

    // The requester stops it from their phone.
    let (status, body) = stop(
        &router,
        &format!("/v1/cloud/agent-runs/{}/stop", turn.run),
        &accounts.peer.token,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["run"]["cancelRequested"], true);
    assert_eq!(body["run"]["executionBackend"], "desktop");
    assert_ne!(run_status(&pool, &turn.run).await, "cancelled");

    // The desktop's next renewal and admission carry the request.
    let after = read_json(renew().await.unwrap()).await;
    assert_eq!(after, json!({"ok":true,"cancelRequested":true}));
    let admitted = read_json(
        router
            .clone()
            .oneshot(post_json_with_token(
                &format!("/v1/cloud/agent-runs/desktop/{}/admit", turn.run),
                &owner.token,
                json!({"claimId":turn.claim_id}),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(admitted["cancelRequested"], true, "{admitted}");

    // The desktop stops the turn and publishes the cancelled reply.
    let cancelled = encode(
        "kordi-cloud-agent-response",
        json!({"kind":"agent-response","requestId":turn.canonical,"text":STOPPED_TEXT,"deliveryState":"cancelled"}),
    );
    let published = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/desktop/{}/progress", turn.run),
            &owner.token,
            json!({"claimId":turn.claim_id,"clientMessageId":uuid::Uuid::new_v4(),"body":cancelled}),
        ))
        .await
        .unwrap();
    assert_eq!(published.status(), StatusCode::OK);
    assert_eq!(run_status(&pool, &turn.run).await, "cancelled");
    let after = replies(&pool, owner, &turn.session, &turn.canonical).await;
    assert_eq!(after.last(), Some(&stopped()), "{after:?}");
}

#[tokio::test]
async fn a_desktop_that_ignores_a_stop_loses_the_run() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let accounts = ready_accounts(&router, &pool).await;
    let owner = &accounts.owner;
    let turn = processing_desktop_turn(&router, &pool, &accounts, true).await;
    let (status, body) = stop(
        &router,
        &format!("/v1/cloud/agent-runs/{}/stop", turn.run),
        &owner.token,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    sqlx_core::query::query(
        "UPDATE cloud_agent_fallback_runs SET cancel_requested_at=now()-interval '31 seconds' WHERE run_id=$1",
    )
    .bind(&turn.run)
    .execute(&pool)
    .await
    .unwrap();
    let renewed = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/desktop/{}/renew", turn.run),
            &owner.token,
            json!({"claimId":turn.claim_id}),
        ))
        .await
        .unwrap();
    assert_eq!(renewed.status(), StatusCode::CONFLICT);
    sqlx_core::query::query(
        "UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()-interval '1 second')::text WHERE run_id=$1",
    )
    .bind(&turn.run)
    .execute(&pool)
    .await
    .unwrap();
    release_stopped_runs(&pool).await.unwrap();
    assert_eq!(run_status(&pool, &turn.run).await, "cancelled");
    let after = replies(&pool, owner, &turn.session, &turn.canonical).await;
    assert!(after.contains(&stopped()), "{after:?}");
}

#[tokio::test]
async fn a_stop_ends_a_cloud_run_at_its_next_heartbeat() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let (owner, requester, session, request, run) =
        queued_request(&router, &pool, "stop-cloud").await;
    let runner = format!("runner-stop-{}", uuid::Uuid::new_v4().simple());
    let leased = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({"runnerId":runner,"canaryRunId":run}),
        ))
        .await
        .unwrap();
    assert_eq!(read_json(leased).await["run"]["runId"], run);
    let heartbeat = || {
        router.clone().oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run}/running"),
            "runner-test-token",
            json!({"runnerId":runner}),
        ))
    };
    let before = read_json(heartbeat().await.unwrap()).await;
    assert_eq!(before["run"]["cancelRequested"], false, "{before}");

    let (status, body) = stop(
        &router,
        &format!("/v1/cloud/agent-runs/request/{request}/stop"),
        &requester.token,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["runs"][0]["cancelRequested"], true);

    let after = read_json(heartbeat().await.unwrap()).await;
    assert_eq!(after["run"]["cancelRequested"], true, "{after}");
    assert_eq!(after["run"]["status"], "cancelled");
    assert_eq!(run_status(&pool, &run).await, "cancelled");
    assert_eq!(
        replies(&pool, &owner, &session, &request).await,
        vec![stopped()]
    );
    // A late completion from the runner cannot replace the stopped reply.
    let late = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run}/complete"),
            "runner-test-token",
            json!({"runnerId":runner,"responseText":"Late answer"}),
        ))
        .await
        .unwrap();
    assert_eq!(late.status(), StatusCode::NOT_FOUND);
}
