//! Blocking: private to the blocker, ends the relationship, and refuses new
//! requests in both directions.

use super::contact_consent::{
    connect, contact_ids, contact_rows, directory_events, post_status, presence_ids, profile,
    request_status, send_request,
};
use super::*;

fn router_for(pool: &sqlx_postgres::PgPool) -> axum::Router {
    fast_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())))
}

async fn put_block(
    router: &axum::Router,
    token: &str,
    account_id: &str,
) -> (StatusCode, serde_json::Value) {
    let response = router
        .clone()
        .oneshot(put_json_with_token(
            &format!("/v1/cloud/blocks/{account_id}"),
            token,
            json!({}),
        ))
        .await
        .unwrap();
    let status = response.status();
    (status, read_json(response).await)
}

async fn unblock(router: &axum::Router, token: &str, account_id: &str) -> StatusCode {
    router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/blocks/{account_id}"),
            token,
        ))
        .await
        .unwrap()
        .status()
}

async fn blocks(router: &axum::Router, token: &str) -> serde_json::Value {
    read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/blocks", token))
            .await
            .unwrap(),
    )
    .await
}

#[tokio::test]
async fn blocking_ends_the_relationship_and_decides_pending_requests_silently() {
    let Some(pool) = try_pool().await else { return };
    let router = router_for(&pool);
    let (a_token, a_id) = signup_account(&router, "block-a").await;
    let (b_token, b_id) = signup_account(&router, "block-b").await;
    let (c_token, c_id) = signup_account(&router, "block-c").await;
    let (_, d_id) = signup_account(&router, "block-d").await;
    connect(&router, &a_token, &b_token, &b_id).await;
    let (_, inbound) = send_request(&router, &c_token, &a_id).await;
    let (_, outbound) = send_request(&router, &a_token, &d_id).await;
    for token in [&a_token, &b_token] {
        assert_eq!(
            post_status(&router, "/v1/cloud/presence/online", token).await,
            StatusCode::OK
        );
    }

    let (status, body) = put_block(&router, &a_token, &b_id).await;
    assert_eq!(status, StatusCode::OK, "got body {body}");
    assert_eq!(body["removedContact"], true);
    assert_eq!(body["block"]["accountId"], b_id);
    assert_eq!(contact_rows(&pool, &a_id, &b_id).await, 0);
    assert!(!contact_ids(&router, &a_token).await.contains(&b_id));
    assert!(!contact_ids(&router, &b_token).await.contains(&a_id));
    assert!(!presence_ids(&router, &a_token).await.contains(&b_id));
    assert!(!presence_ids(&router, &b_token).await.contains(&a_id));
    assert_eq!(
        directory_events(&pool, &a_id).await,
        vec![(b_id.clone(), "blocked".to_string())]
    );
    assert!(
        directory_events(&pool, &b_id).await.is_empty(),
        "the blocked account is never told"
    );

    let (status, repeated) = put_block(&router, &a_token, &b_id).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(repeated["removedContact"], false);
    assert_eq!(repeated["block"]["blockedAt"], body["block"]["blockedAt"]);
    assert_eq!(directory_events(&pool, &a_id).await.len(), 1);

    assert_eq!(put_block(&router, &a_token, &c_id).await.0, StatusCode::OK);
    assert_eq!(put_block(&router, &a_token, &d_id).await.0, StatusCode::OK);
    let id = |body: &serde_json::Value| body["request"]["requestId"].as_str().unwrap().to_string();
    assert_eq!(request_status(&pool, &id(&inbound)).await, "rejected");
    assert_eq!(request_status(&pool, &id(&outbound)).await, "withdrawn");

    // Newest first, with the documented shape.
    let listed = blocks(&router, &a_token).await;
    let rows = listed["blocks"].as_array().unwrap();
    let ids: Vec<&str> = rows
        .iter()
        .map(|row| row["accountId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![d_id.as_str(), c_id.as_str(), b_id.as_str()]);
    let mut keys: Vec<&str> = rows[0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "accountId",
            "avatarUrl",
            "blockedAt",
            "displayName",
            "kordiId"
        ]
    );
    assert!(blocks(&router, &b_token).await["blocks"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn requests_are_refused_both_ways_until_unblocked_and_contacts_stay_removed() {
    let Some(pool) = try_pool().await else { return };
    let router = router_for(&pool);
    let (a_token, a_id) = signup_account(&router, "block-direction-a").await;
    let (b_token, b_id) = signup_account(&router, "block-direction-b").await;
    connect(&router, &a_token, &b_token, &b_id).await;
    assert_eq!(put_block(&router, &a_token, &b_id).await.0, StatusCode::OK);

    let (status, body) = send_request(&router, &b_token, &a_id).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["errorCode"], "contact_request_unavailable");
    let (status, body) = send_request(&router, &a_token, &b_id).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["errorCode"], "blocked_account");
    let shim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/contacts",
            &b_token,
            json!({ "peerAccountId": a_id }),
        ))
        .await
        .unwrap();
    assert_eq!(shim.status(), StatusCode::FORBIDDEN);

    let viewer = profile(&router, &a_token, &b_id).await;
    assert_eq!(
        (viewer["isBlocked"].clone(), viewer["isContact"].clone()),
        (json!(true), json!(false))
    );
    assert_eq!(
        profile(&router, &b_token, &a_id).await["isBlocked"],
        false,
        "a lookup never shows that the viewer is blocked"
    );

    assert_eq!(
        unblock(&router, &a_token, &b_id).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        unblock(&router, &a_token, &b_id).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(contact_rows(&pool, &a_id, &b_id).await, 0);
    assert_eq!(
        directory_events(&pool, &a_id).await.last().unwrap().1,
        "unblocked"
    );
    assert_eq!(profile(&router, &a_token, &b_id).await["isBlocked"], false);
    let (status, _) = send_request(&router, &b_token, &a_id).await;
    assert_eq!(status, StatusCode::CREATED);
}

#[tokio::test]
async fn self_service_and_unknown_accounts_cannot_be_blocked() {
    let Some(pool) = try_pool().await else { return };
    let router = router_for(&pool);
    let (token, account_id) = signup_account(&router, "block-invalid").await;
    let (_, service_id) = signup_account(&router, "block-service-owner").await;
    sqlx_core::query::query(
        "INSERT INTO cloud_agent_definitions(agent_id, owner_account_id, status, name, role, \
         system_prompt, created_at, updated_at, avatar_source, avatar_style, avatar_seed, \
         avatar_renderer_version, avatar_version, avatar_updated_at, is_system_managed) \
         VALUES ($1, $2, 'active', 'Service', 'support', 'test', 'test', 'test', 'generated', \
         'thumbs', $1, 'test', 1, 'test', TRUE)",
    )
    .bind(format!("cloud_agent_{}", uuid::Uuid::new_v4().simple()))
    .bind(&service_id)
    .execute(&pool)
    .await
    .unwrap();

    for (target, status, code) in [
        (account_id.as_str(), StatusCode::BAD_REQUEST, "self_block"),
        (
            service_id.as_str(),
            StatusCode::BAD_REQUEST,
            "cannot_block_service",
        ),
        (
            "acct_missing_account",
            StatusCode::NOT_FOUND,
            "account_missing",
        ),
    ] {
        let (actual, body) = put_block(&router, &token, target).await;
        assert_eq!((actual, body["errorCode"].as_str()), (status, Some(code)));
    }
    assert!(blocks(&router, &token).await["blocks"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn accepting_while_the_requester_blocks_never_leaves_contact_rows() {
    let Some(pool) = try_pool().await else { return };
    let router = router_for(&pool);
    for round in 0..8 {
        let (a_token, a_id) = signup_account(&router, "block-race-a").await;
        let (b_token, b_id) = signup_account(&router, "block-race-b").await;
        let (_, body) = send_request(&router, &a_token, &b_id).await;
        let request_id = body["request"]["requestId"].as_str().unwrap().to_string();
        let accept = format!("/v1/cloud/contacts/requests/{request_id}/accept");
        let (accepted, (blocked, block_body)) = tokio::join!(
            post_status(&router, &accept, &b_token),
            put_block(&router, &a_token, &b_id),
        );
        assert_eq!(blocked, StatusCode::OK, "round {round}");
        assert_eq!(contact_rows(&pool, &a_id, &b_id).await, 0, "round {round}");
        match accepted {
            // Accepted first: the block then removed the new contact.
            StatusCode::OK => assert_eq!(block_body["removedContact"], true),
            // Blocked first: the request was withdrawn before the answer.
            StatusCode::CONFLICT => {
                assert_eq!(request_status(&pool, &request_id).await, "withdrawn")
            }
            other => panic!("round {round}: unexpected accept status {other}"),
        }
    }
    let (a_token, _) = signup_account(&router, "block-after-a").await;
    let (b_token, b_id) = signup_account(&router, "block-after-b").await;
    let (_, body) = send_request(&router, &a_token, &b_id).await;
    let request_id = body["request"]["requestId"].as_str().unwrap();
    let a_id = body["request"]["fromAccountId"].as_str().unwrap();
    assert_eq!(put_block(&router, &b_token, a_id).await.0, StatusCode::OK);
    let accept = format!("/v1/cloud/contacts/requests/{request_id}/accept");
    assert_eq!(
        post_status(&router, &accept, &b_token).await,
        StatusCode::CONFLICT
    );
    assert_eq!(contact_rows(&pool, a_id, &b_id).await, 0);
}
