//! The authenticated completion step that binds a grant to its account.

use super::*;

fn complete_request(token: &str, completion_code: &str) -> Request<Body> {
    authed(
        "POST",
        "/v1/cloud/connectors/oauth/complete",
        token,
        Some(json!({ "completionCode": completion_code })),
    )
}

async fn live_connectors(pool: &PgPool, account_id: &str) -> i64 {
    count_rows(
        pool,
        "SELECT COUNT(*) FROM cloud_connectors WHERE account_id = $1 AND status <> 'revoked'",
        account_id,
    )
    .await
}

async fn account_secrets(pool: &PgPool, account_id: &str) -> i64 {
    count_rows(
        pool,
        "SELECT COUNT(*) FROM cloud_connector_secrets s \
         JOIN cloud_connectors c USING (connector_id) WHERE c.account_id = $1",
        account_id,
    )
    .await
}

async fn pending_rows(pool: &PgPool, completion_code: &str) -> i64 {
    count_rows(
        pool,
        "SELECT COUNT(*) FROM cloud_connector_pending_grants WHERE completion_code = $1",
        completion_code,
    )
    .await
}

#[tokio::test]
async fn callback_parks_the_grant_until_its_account_completes_it() {
    let Some(pool) = pool().await else { return };
    let (runtime, _) = stub_runtime();
    let (owner, token) = signed_in_account(&pool, "complete_owner").await;
    let app = super::super::routes::routes(Arc::new(
        ServerState::new(pool.clone(), EventBus::noop()).with_connector_runtime(runtime.clone()),
    ));
    let code = pending_stub_grant(&pool, &runtime, &owner, ConnectorToolGroup::Read, "c1").await;

    // The callback alone connects nothing.
    assert_eq!(live_connectors(&pool, &owner).await, 0);
    assert_eq!(pending_rows(&pool, &code).await, 1);

    let completed = app
        .clone()
        .oneshot(complete_request(&token, &code))
        .await
        .unwrap();
    assert_eq!(completed.status(), StatusCode::OK);
    let body = body_json(completed).await;
    assert_eq!(body["connector"]["provider"], STUB.id);
    assert_eq!(body["connector"]["status"], "connected");
    assert_eq!(body["connector"]["readScopes"], json!(["stub.read"]));
    assert_no_secret_keys("POST oauth/complete", body.clone());
    assert_no_stub_credentials("POST oauth/complete", &body);
    assert_eq!(live_connectors(&pool, &owner).await, 1);
    assert_eq!(account_secrets(&pool, &owner).await, 1);
    assert_eq!(pending_rows(&pool, &code).await, 0);

    // The code is one-use.
    let replay = app.oneshot(complete_request(&token, &code)).await.unwrap();
    assert_eq!(replay.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        body_json(replay).await["errorCode"],
        "connector_grant_not_found"
    );
    assert_eq!(live_connectors(&pool, &owner).await, 1);
}

#[tokio::test]
async fn another_account_cannot_complete_a_grant() {
    let Some(pool) = pool().await else { return };
    let (runtime, _) = stub_runtime();
    let (owner, owner_token) = signed_in_account(&pool, "complete_victim").await;
    let (other, other_token) = signed_in_account(&pool, "complete_other").await;
    let app = super::super::routes::routes(Arc::new(
        ServerState::new(pool.clone(), EventBus::noop()).with_connector_runtime(runtime.clone()),
    ));
    let code = pending_stub_grant(&pool, &runtime, &owner, ConnectorToolGroup::Act, "c1").await;

    let refused = app
        .clone()
        .oneshot(complete_request(&other_token, &code))
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        body_json(refused).await["errorCode"],
        "connector_grant_mismatch"
    );
    for account in [&owner, &other] {
        assert_eq!(live_connectors(&pool, account).await, 0);
        assert_eq!(account_secrets(&pool, account).await, 0);
    }
    // The refused grant is discarded, so the owner cannot use it either.
    assert_eq!(pending_rows(&pool, &code).await, 0);
    let late = app
        .oneshot(complete_request(&owner_token, &code))
        .await
        .unwrap();
    assert_eq!(late.status(), StatusCode::NOT_FOUND);
    assert_eq!(live_connectors(&pool, &owner).await, 0);
}

#[tokio::test]
async fn expired_pending_grants_cannot_complete_and_are_swept() {
    let Some(pool) = pool().await else { return };
    let (runtime, _) = stub_runtime();
    let (owner, token) = signed_in_account(&pool, "complete_expired").await;
    let app = super::super::routes::routes(Arc::new(
        ServerState::new(pool.clone(), EventBus::noop()).with_connector_runtime(runtime.clone()),
    ));
    let expire = |code: String| {
        let pool = pool.clone();
        async move {
            query(
                "UPDATE cloud_connector_pending_grants \
                 SET expires_at = now() - interval '1 minute' WHERE completion_code = $1",
            )
            .bind(&code)
            .execute(&pool)
            .await
            .unwrap();
            code
        }
    };
    let stale =
        expire(pending_stub_grant(&pool, &runtime, &owner, ConnectorToolGroup::Read, "c1").await)
            .await;
    let expired = app.oneshot(complete_request(&token, &stale)).await.unwrap();
    assert_eq!(expired.status(), StatusCode::GONE);
    assert_eq!(
        body_json(expired).await["errorCode"],
        "connector_grant_expired"
    );
    assert_eq!(live_connectors(&pool, &owner).await, 0);

    let swept =
        expire(pending_stub_grant(&pool, &runtime, &owner, ConnectorToolGroup::Read, "c2").await)
            .await;
    let fresh = pending_stub_grant(&pool, &runtime, &owner, ConnectorToolGroup::Read, "c3").await;
    store::sweep_expired_pending_grants(&pool, Utc::now())
        .await
        .unwrap();
    assert_eq!(pending_rows(&pool, &swept).await, 0);
    assert_eq!(pending_rows(&pool, &fresh).await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn racing_first_grants_share_one_connector() {
    let Some(pool) = pool().await else { return };
    let (runtime, _) = stub_runtime();
    let (owner, _) = signed_in_account(&pool, "complete_race").await;
    let first = pending_stub_grant(&pool, &runtime, &owner, ConnectorToolGroup::Read, "c1").await;
    let second = pending_stub_grant(&pool, &runtime, &owner, ConnectorToolGroup::Read, "c2").await;
    let finish = |code: String| {
        let (pool, runtime, owner) = (pool.clone(), runtime.clone(), owner.clone());
        tokio::spawn(async move {
            oauth_complete::finish_grant(&pool, &runtime, &owner, &code)
                .await
                .map(|record| record.connector_id)
        })
    };
    let (a, b) = tokio::join!(finish(first), finish(second));
    let (a, b) = (a.unwrap().unwrap(), b.unwrap().unwrap());
    assert_eq!(
        a, b,
        "the second grant updates the connector the first made"
    );
    assert_eq!(live_connectors(&pool, &owner).await, 1);
}
