//! Contacts need both people's consent: requests, the one-sided add,
//! withdrawal, and removal.

use super::*;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

pub(super) async fn send_request(
    router: &axum::Router,
    token: &str,
    peer_account_id: &str,
) -> (StatusCode, serde_json::Value) {
    let response = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/contacts/requests",
            token,
            json!({ "peerAccountId": peer_account_id }),
        ))
        .await
        .unwrap();
    let status = response.status();
    (status, read_json(response).await)
}

pub(super) async fn post_status(router: &axum::Router, uri: &str, token: &str) -> StatusCode {
    router
        .clone()
        .oneshot(post_with_token(uri, token))
        .await
        .unwrap()
        .status()
}

/// `requester` asks `recipient`, who accepts. Returns the request id.
pub(super) async fn connect(
    router: &axum::Router,
    requester_token: &str,
    recipient_token: &str,
    recipient_id: &str,
) -> String {
    let (status, body) = send_request(router, requester_token, recipient_id).await;
    assert_eq!(status, StatusCode::CREATED, "got body {body}");
    let request_id = body["request"]["requestId"].as_str().unwrap().to_string();
    let accept = format!("/v1/cloud/contacts/requests/{request_id}/accept");
    assert_eq!(
        post_status(router, &accept, recipient_token).await,
        StatusCode::OK
    );
    request_id
}

pub(super) async fn contact_rows(pool: &PgPool, a: &str, b: &str) -> i64 {
    query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM cloud_contacts \
         WHERE (account_id = $1 AND peer_account_id = $2) \
            OR (account_id = $2 AND peer_account_id = $1)",
    )
    .bind(a)
    .bind(b)
    .fetch_one(pool)
    .await
    .unwrap()
    .0
}

pub(super) async fn request_status(pool: &PgPool, request_id: &str) -> String {
    query_as::<_, (String,)>("SELECT status FROM cloud_contact_requests WHERE request_id = $1")
        .bind(request_id)
        .fetch_one(pool)
        .await
        .unwrap()
        .0
}

/// `(accountId, reason)` of each `account.directory.changed` sync event.
pub(super) async fn directory_events(pool: &PgPool, account_id: &str) -> Vec<(String, String)> {
    query_as(
        "SELECT payload->>'accountId', COALESCE(payload->>'reason', '') \
         FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND event_type = 'account.directory.changed' \
         ORDER BY stream_seq",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn listed_ids(router: &axum::Router, uri: &str, key: &str, token: &str) -> Vec<String> {
    let body = read_json(
        router
            .clone()
            .oneshot(get_with_token(uri, token))
            .await
            .unwrap(),
    )
    .await;
    body[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["accountId"].as_str().unwrap().to_string())
        .collect()
}

pub(super) async fn contact_ids(router: &axum::Router, token: &str) -> Vec<String> {
    listed_ids(router, "/v1/cloud/contacts", "contacts", token).await
}

pub(super) async fn presence_ids(router: &axum::Router, token: &str) -> Vec<String> {
    listed_ids(router, "/v1/cloud/presence/contacts", "accounts", token).await
}

pub(super) async fn profile(
    router: &axum::Router,
    token: &str,
    account_id: &str,
) -> serde_json::Value {
    read_json(
        router
            .clone()
            .oneshot(get_with_token(
                &format!("/v1/cloud/accounts/{account_id}/profile"),
                token,
            ))
            .await
            .unwrap(),
    )
    .await
}

fn router_for(pool: &PgPool) -> axum::Router {
    fast_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())))
}

#[tokio::test]
async fn one_sided_add_sends_a_request_and_never_writes_contact_rows() {
    let Some(pool) = try_pool().await else { return };
    let router = router_for(&pool);
    let (a_token, a_id) = signup_account(&router, "consent-add-a").await;
    let (b_token, b_id) = signup_account(&router, "consent-add-b").await;
    let add = |token: &str, peer: &str| {
        post_json_with_token(
            "/v1/cloud/contacts",
            token,
            json!({ "peerAccountId": peer }),
        )
    };

    let first = router.clone().oneshot(add(&a_token, &b_id)).await.unwrap();
    assert_eq!(first.status(), StatusCode::ACCEPTED);
    let first = read_json(first).await;
    assert_eq!(first["status"], "requested");
    assert_eq!(first["request"]["direction"], "outgoing");
    assert_eq!(first["request"]["toAccountId"], b_id);
    let repeated = read_json(router.clone().oneshot(add(&a_token, &b_id)).await.unwrap()).await;
    assert_eq!(
        repeated["request"]["requestId"],
        first["request"]["requestId"]
    );
    assert_eq!(contact_rows(&pool, &a_id, &b_id).await, 0);
    assert!(!contact_ids(&router, &a_token).await.contains(&b_id));

    // The peer's add accepts the pending request instead.
    let accepted = router.clone().oneshot(add(&b_token, &a_id)).await.unwrap();
    assert_eq!(accepted.status(), StatusCode::NO_CONTENT);
    assert_eq!(contact_rows(&pool, &a_id, &b_id).await, 2);
    assert!(contact_ids(&router, &a_token).await.contains(&b_id));
    assert_eq!(
        request_status(&pool, first["request"]["requestId"].as_str().unwrap()).await,
        "accepted"
    );

    let again = router.clone().oneshot(add(&a_token, &b_id)).await.unwrap();
    assert_eq!(again.status(), StatusCode::NO_CONTENT);
    let (status, body) = send_request(&router, &a_token, &b_id).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["errorCode"], "already_contact");
}

#[tokio::test]
async fn a_stray_one_way_row_grants_nothing() {
    let Some(pool) = try_pool().await else { return };
    let router = router_for(&pool);
    let (a_token, a_id) = signup_account(&router, "consent-stray-a").await;
    let (b_token, b_id) = signup_account(&router, "consent-stray-b").await;
    sqlx_core::query::query(
        "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) VALUES ($1, $2, $3)",
    )
    .bind(&a_id)
    .bind(&b_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();
    for token in [&a_token, &b_token] {
        assert_eq!(
            post_status(&router, "/v1/cloud/presence/online", token).await,
            StatusCode::OK
        );
    }

    assert!(!contact_ids(&router, &a_token).await.contains(&b_id));
    assert!(!presence_ids(&router, &a_token).await.contains(&b_id));
    assert!(!presence_ids(&router, &b_token).await.contains(&a_id));
    let lookup = profile(&router, &a_token, &b_id).await;
    assert_eq!(lookup["isContact"], false);
    assert_eq!(lookup["isBlocked"], false);

    // `already_contact` needs both rows, so the request goes through.
    let (status, body) = send_request(&router, &a_token, &b_id).await;
    assert_eq!(status, StatusCode::CREATED, "got body {body}");
}

#[tokio::test]
async fn removing_a_contact_clears_both_rows_and_ends_their_direct_call() {
    let Some(pool) = try_pool().await else { return };
    let router = router_for(&pool);
    let (a_token, a_id) = signup_account(&router, "consent-remove-a").await;
    let (b_token, b_id) = signup_account(&router, "consent-remove-b").await;
    connect(&router, &a_token, &b_token, &b_id).await;
    assert_eq!(
        post_status(&router, "/v1/cloud/presence/online", &b_token).await,
        StatusCode::OK
    );
    assert!(presence_ids(&router, &a_token).await.contains(&b_id));

    // A ringing direct call, recorded the way the call service records one.
    let mut pair = [a_id.as_str(), b_id.as_str()];
    pair.sort_unstable();
    let (conversation_id,): (uuid::Uuid,) = query_as(
        "SELECT conversation_id FROM cloud_chat_conversations WHERE legacy_session_id = $1",
    )
    .bind(format!("session:direct-person:{}:{}", pair[0], pair[1]))
    .fetch_one(&pool)
    .await
    .unwrap();
    let call_id = uuid::Uuid::now_v7();
    kordi_cloud_server::chat_sync::store::send_message(
        &pool,
        &a_id,
        conversation_id,
        kordi_cloud_server::chat_sync::models::SendMessageRequest {
            client_message_id: call_id,
            kind: format!("call.started.{call_id}"),
            content: json!({ "schema": 1, "blocks": [{ "type": "text", "text": "Voice call" }] }),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .unwrap();
    sqlx_core::query::query(
        "INSERT INTO cloud_calls (call_id, conversation_id, created_by_account_id, \
         client_operation_id, call_kind, call_state, room_name) \
         VALUES ($1, $2, $3, $1, 'voice', 'ringing', 'room-' || $1::TEXT)",
    )
    .bind(call_id)
    .bind(conversation_id)
    .bind(&a_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx_core::query::query(
        "INSERT INTO cloud_call_participants (call_id, account_id, participant_state) \
         VALUES ($1, $2, 'joined'), ($1, $3, 'invited')",
    )
    .bind(call_id)
    .bind(&a_id)
    .bind(&b_id)
    .execute(&pool)
    .await
    .unwrap();

    let remove =
        |token: &str, peer: &str| delete_with_token(&format!("/v1/cloud/contacts/{peer}"), token);
    let removed = router
        .clone()
        .oneshot(remove(&b_token, &a_id))
        .await
        .unwrap();
    assert_eq!(removed.status(), StatusCode::NO_CONTENT);
    assert_eq!(contact_rows(&pool, &a_id, &b_id).await, 0);
    assert!(!contact_ids(&router, &a_token).await.contains(&b_id));
    assert!(!contact_ids(&router, &b_token).await.contains(&a_id));
    assert!(!presence_ids(&router, &a_token).await.contains(&b_id));
    let reason = |other: &str| (other.to_string(), "contact_removed".to_string());
    assert_eq!(directory_events(&pool, &a_id).await, vec![reason(&b_id)]);
    assert_eq!(directory_events(&pool, &b_id).await, vec![reason(&a_id)]);
    let (ended,): (bool,) =
        query_as("SELECT ended_at IS NOT NULL FROM cloud_calls WHERE call_id = $1")
            .bind(call_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(ended, "removing a contact ends their ringing direct call");
    let (messages,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_chat_messages WHERE conversation_id = $1")
            .bind(conversation_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(messages >= 2, "chat history stays readable");

    let repeated = router
        .clone()
        .oneshot(remove(&b_token, &a_id))
        .await
        .unwrap();
    assert_eq!(repeated.status(), StatusCode::NO_CONTENT);
    assert_eq!(directory_events(&pool, &a_id).await.len(), 1);
    let invalid = router
        .clone()
        .oneshot(remove(&b_token, "not-an-account"))
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    assert_eq!(read_json(invalid).await["errorCode"], "invalid_account_id");
}

#[tokio::test]
async fn only_the_sender_can_withdraw_and_a_withdrawn_request_cannot_be_accepted() {
    let Some(pool) = try_pool().await else { return };
    let router = router_for(&pool);
    let (a_token, _a_id) = signup_account(&router, "consent-withdraw-a").await;
    let (b_token, b_id) = signup_account(&router, "consent-withdraw-b").await;
    let (c_token, _c_id) = signup_account(&router, "consent-withdraw-c").await;
    let (_, body) = send_request(&router, &a_token, &b_id).await;
    let request_id = body["request"]["requestId"].as_str().unwrap().to_string();
    let withdraw = format!("/v1/cloud/contacts/requests/{request_id}/withdraw");

    for other in [&b_token, &c_token] {
        let response = router
            .clone()
            .oneshot(post_with_token(&withdraw, other))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(read_json(response).await["errorCode"], "not_found");
    }
    assert_eq!(
        post_status(&router, &withdraw, &a_token).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(request_status(&pool, &request_id).await, "withdrawn");
    let again = router
        .clone()
        .oneshot(post_with_token(&withdraw, &a_token))
        .await
        .unwrap();
    assert_eq!(again.status(), StatusCode::CONFLICT);
    assert_eq!(read_json(again).await["errorCode"], "request_decided");

    for action in ["accept", "reject"] {
        let path = format!("/v1/cloud/contacts/requests/{request_id}/{action}");
        assert_eq!(
            post_status(&router, &path, &b_token).await,
            StatusCode::CONFLICT
        );
    }
    let a_id = body["request"]["fromAccountId"].as_str().unwrap();
    assert_eq!(contact_rows(&pool, a_id, &b_id).await, 0);
    let listed = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/contacts/requests", &b_token))
            .await
            .unwrap(),
    )
    .await;
    assert!(listed["requests"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn concurrent_accept_and_withdraw_decide_a_request_once() {
    let Some(pool) = try_pool().await else { return };
    let router = router_for(&pool);
    for round in 0..8 {
        let (a_token, a_id) = signup_account(&router, "consent-race-a").await;
        let (b_token, b_id) = signup_account(&router, "consent-race-b").await;
        let (_, body) = send_request(&router, &a_token, &b_id).await;
        let request_id = body["request"]["requestId"].as_str().unwrap().to_string();
        let accept = format!("/v1/cloud/contacts/requests/{request_id}/accept");
        let withdraw = format!("/v1/cloud/contacts/requests/{request_id}/withdraw");
        let (accepted, withdrawn) = tokio::join!(
            post_status(&router, &accept, &b_token),
            post_status(&router, &withdraw, &a_token),
        );
        let status = request_status(&pool, &request_id).await;
        let rows = contact_rows(&pool, &a_id, &b_id).await;
        match (accepted, withdrawn) {
            (StatusCode::OK, StatusCode::CONFLICT) => {
                assert_eq!((status.as_str(), rows), ("accepted", 2), "round {round}");
            }
            (StatusCode::CONFLICT, StatusCode::NO_CONTENT) => {
                assert_eq!((status.as_str(), rows), ("withdrawn", 0), "round {round}");
            }
            other => panic!("round {round}: both or neither decided the request: {other:?}"),
        }
    }
}
