//! Bounds on what one account can store: the number of live saved accounts
//! and the size of each payload. Every credential is synthetic.

use super::login_session::{login_request, login_router};
use super::omp_worker::mock_worker;
use super::*;

const MAX_LIVE_SNAPSHOTS: usize = 32;

async fn publish_key(
    router: &axum::Router,
    owner: &TestAccount,
    auth_choice: &str,
    api_key: &str,
) -> axum::response::Response {
    router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-provider-auth/snapshots?intent=explicit",
            &owner.token,
            json!({
                "provider": "groq",
                "authChoice": auth_choice,
                "payload": { "apiMode": "api-key", "apiKey": api_key }
            }),
        ))
        .await
        .unwrap()
}

#[tokio::test]
async fn an_account_holds_at_most_32_live_saved_accounts() {
    let Some(pool) = try_pool().await else { return };
    let (_worker, _worker_env) = mock_worker().await;
    let router = login_router(&pool);
    let owner = signup(&router, "publish-limit-owner", "Owner").await;
    let mut snapshot_ids = Vec::new();
    for index in 0..MAX_LIVE_SNAPSHOTS {
        let saved = publish_key(
            &router,
            &owner,
            &format!("cloud-api-key:{index}"),
            &format!("synthetic-limit-{index}"),
        )
        .await;
        assert_eq!(saved.status(), StatusCode::CREATED);
        snapshot_ids.push(read_json(saved).await["snapshotId"].clone());
    }

    let refused = publish_key(&router, &owner, "cloud-api-key:extra", "synthetic-extra").await;
    assert_eq!(refused.status(), StatusCode::CONFLICT);
    assert_eq!(
        read_json(refused).await["errorCode"],
        "provider_auth_limit_reached"
    );
    // A login would save one more account, so it is refused before it starts.
    let (status, body) = login_request(
        &router,
        &owner.token,
        "POST",
        "/start",
        Some(json!({ "provider": "groq", "label": "One too many" })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["errorCode"], "provider_auth_limit_reached");

    // Replacing a saved choice frees its own slot first.
    let replaced = publish_key(&router, &owner, "cloud-api-key:0", "synthetic-rotated").await;
    assert_eq!(replaced.status(), StatusCode::CREATED);
    let revoke = router
        .clone()
        .oneshot(delete_with_token(
            &format!(
                "/v1/cloud/agent-provider-auth/snapshots/{}?intent=explicit",
                snapshot_ids[1].as_str().unwrap()
            ),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(revoke.status(), StatusCode::OK);
    let extra = publish_key(&router, &owner, "cloud-api-key:extra", "synthetic-extra").await;
    assert_eq!(extra.status(), StatusCode::CREATED);
    let live: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND revoked_at IS NULL",
    )
    .bind(&owner.account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(live.0, MAX_LIVE_SNAPSHOTS as i64);
}

#[tokio::test]
async fn a_payload_larger_than_64_kib_is_refused() {
    let Some(pool) = try_pool().await else { return };
    let router = login_router(&pool);
    let owner = signup(&router, "publish-size-owner", "Owner").await;
    let refused = publish_key(&router, &owner, "cloud-api-key:big", &"k".repeat(64 * 1024)).await;
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        read_json(refused).await["errorCode"],
        "invalid_provider_auth_snapshot"
    );
}
