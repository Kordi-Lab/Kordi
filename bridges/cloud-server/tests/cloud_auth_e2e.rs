//! End-to-end integration tests against a real Postgres at `$DATABASE_URL`.
//!
//! Skipped (not failed) when `DATABASE_URL` is not set, so `cargo test` on
//! a developer laptop without the cluster port-forward still runs green.
//! In CI / local dev with the cluster, run:
//!
//!   kubectl -n kordi-cloud port-forward svc/postgres 5432:5432 &
//!   PG_PASS=$(kubectl -n kordi-cloud get secret postgres-credentials \
//!     -o jsonpath='{.data.password}' | base64 -d)
//!   DATABASE_URL="postgresql://kordi:$PG_PASS@127.0.0.1:5432/kordi_cloud" \
//!     cargo test -p kordi-cloud-server --test cloud_auth_e2e
//!
//! Each test uses uuid-suffixed emails / account ids so they don't collide
//! with each other or with existing data when run against a shared DB.

use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use base64::Engine as _;
use kordi_cloud_server::auth::password::PasswordHasherConfig;
use kordi_cloud_server::auth::rate_limit::{CloudRateLimitConfig, CloudRateLimiter};
use kordi_cloud_server::auth::routes::routes_with_config;
use kordi_cloud_server::events::EventBus;
use kordi_cloud_server::pg::init_pool;
use kordi_cloud_server::server::ServerState;
use serde_json::json;
use tower::util::ServiceExt;

async fn try_pool() -> Option<sqlx_postgres::PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    match init_pool(&url).await {
        Ok(pool) => Some(pool),
        Err(err) => {
            eprintln!("[cloud_auth_e2e] init_pool failed, skipping: {err}");
            None
        }
    }
}

fn fast_router(state: Arc<ServerState>) -> axum::Router {
    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig {
        per_ip_limit: 10_000,
        per_ip_window: Duration::from_secs(60),
        per_email_failure_limit: 5,
        per_email_lockout: Duration::from_secs(900),
    });
    routes_with_config(state, PasswordHasherConfig::for_tests(), limiter)
}

fn unique_email(prefix: &str) -> String {
    format!("{prefix}-{}@e2e.local", uuid::Uuid::new_v4().simple())
}

fn encode_group_control_for_test(value: serde_json::Value) -> String {
    format!(
        "kordi-cloud-group:{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&value).unwrap())
    )
}

fn signup_body(email: &str, password: &str) -> Body {
    Body::from(
        json!({
            "email": email,
            "password": password,
            "displayName": "E2E",
            "avatarUrl": "data:image/png;base64,iVBORw0KGgo=",
        })
        .to_string(),
    )
}

fn post(uri: &str, body: Body) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(body)
        .unwrap()
}

fn get_with_token(uri: &str, token: &str) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

fn post_with_token(uri: &str, token: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

fn post_json_with_token(uri: &str, token: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn put_with_token(uri: &str, token: &str) -> Request<Body> {
    Request::builder()
        .method("PUT")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

fn put_json_with_token(uri: &str, token: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("PUT")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn delete_with_token(uri: &str, token: &str) -> Request<Body> {
    Request::builder()
        .method("DELETE")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

async fn read_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    if bytes.is_empty() {
        return serde_json::Value::Null;
    }
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn pool_init_runs_migrations() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping");
        return;
    };
    // After init_pool the migrations have run; a SELECT against
    // cloud_schema_versions should return at least the v1 row.
    let count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_schema_versions WHERE version >= 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(count.0 >= 1, "expected at least migration v1 to be applied");
}

#[tokio::test]
async fn signup_happy_path_returns_session_and_persists_account() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("signup-happy");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let response = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    let status = response.status();
    let body = read_json(response).await;
    assert_eq!(status, StatusCode::CREATED, "got body {body}");
    assert!(body["session"]["token"]
        .as_str()
        .unwrap()
        .starts_with("kordi_cs_"));
    assert_eq!(body["account"]["primaryEmail"], email);
    assert_eq!(body["account"]["passwordSet"], true);

    // Verify the row landed in Postgres.
    let row: (String, String) = sqlx_core::query_as::query_as(
        "SELECT account_id, primary_email FROM cloud_accounts WHERE LOWER(primary_email) = $1",
    )
    .bind(&email)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(row.0.starts_with("acct_"));
    assert_eq!(row.1, email);
}

#[tokio::test]
async fn signup_duplicate_email_returns_409() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("dupe-email");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);

    let _ = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    let second = router
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "another password"),
        ))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::CONFLICT);
    let body = read_json(second).await;
    assert_eq!(body["errorCode"], "email_in_use");
}

#[tokio::test]
async fn login_with_correct_password_returns_session_and_me_works() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("login");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);

    // signup
    let _ = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();

    // login
    let login_resp = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/login",
            Body::from(json!({"email": &email, "password": "correct horse"}).to_string()),
        ))
        .await
        .unwrap();
    assert_eq!(login_resp.status(), StatusCode::OK);
    let login_body = read_json(login_resp).await;
    let token = login_body["session"]["token"].as_str().unwrap().to_string();

    // /me
    let me_resp = router
        .oneshot(get_with_token("/v1/cloud/auth/me", &token))
        .await
        .unwrap();
    assert_eq!(me_resp.status(), StatusCode::OK);
    let me_body = read_json(me_resp).await;
    assert_eq!(me_body["primaryEmail"], email);
}

#[tokio::test]
async fn login_with_wrong_password_returns_401() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("wrong-pass");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);

    let _ = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();

    let bad = router
        .oneshot(post(
            "/v1/cloud/auth/login",
            Body::from(json!({"email": &email, "password": "WRONG"}).to_string()),
        ))
        .await
        .unwrap();
    assert_eq!(bad.status(), StatusCode::UNAUTHORIZED);
    let body = read_json(bad).await;
    assert_eq!(body["errorCode"], "invalid_credentials");
}

#[tokio::test]
async fn cloud_self_messages_are_private_to_the_signed_in_account() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("self-message");
    let other_email = unique_email("self-message-other");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);

    let signup_resp = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    let signup_json = read_json(signup_resp).await;
    let token = signup_json["session"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    let account_id = signup_json["account"]["accountId"]
        .as_str()
        .unwrap()
        .to_string();

    let other_signup_resp = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&other_email, "correct horse"),
        ))
        .await
        .unwrap();
    let other_signup_body = read_json(other_signup_resp).await;
    let other_token = other_signup_body["session"]["token"]
        .as_str()
        .unwrap()
        .to_string();

    let send_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &token,
            json!({
                "peerAccountId": account_id,
                "body": "@Kordi remember this private note",
                "sessionId": "f51f7d19-8c8f-4228-9cdd-074ae9b2146e",
            }),
        ))
        .await
        .unwrap();
    let send_status = send_resp.status();
    let send_body = read_json(send_resp).await;
    assert_eq!(send_status, StatusCode::CREATED, "got body {send_body}");

    let self_list_resp = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/messages?peerAccountId={account_id}"),
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(self_list_resp.status(), StatusCode::OK);
    let self_list = read_json(self_list_resp).await;
    assert_eq!(self_list["messages"].as_array().unwrap().len(), 1);
    assert_eq!(
        self_list["messages"][0]["body"],
        "@Kordi remember this private note"
    );
    assert_eq!(
        self_list["messages"][0]["sessionId"],
        "f51f7d19-8c8f-4228-9cdd-074ae9b2146e"
    );
    assert_eq!(self_list["messages"][0]["fromAccountId"], account_id);
    assert_eq!(self_list["messages"][0]["toAccountId"], account_id);

    let other_list_resp = router
        .oneshot(get_with_token(
            &format!("/v1/cloud/messages?peerAccountId={account_id}"),
            &other_token,
        ))
        .await
        .unwrap();
    assert_eq!(other_list_resp.status(), StatusCode::OK);
    let other_list = read_json(other_list_resp).await;
    assert_eq!(other_list["messages"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn cloud_messages_preserve_attachment_metadata_and_enforce_attachment_ownership() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("attachments-owner");
    let other_email = unique_email("attachments-other");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let owner_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    let owner_body = read_json(owner_signup).await;
    let owner_token = owner_body["session"]["token"].as_str().unwrap().to_string();
    let owner_account_id = owner_body["account"]["accountId"]
        .as_str()
        .unwrap()
        .to_string();

    let other_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&other_email, "correct horse"),
        ))
        .await
        .unwrap();
    let other_body = read_json(other_signup).await;
    let other_token = other_body["session"]["token"].as_str().unwrap().to_string();
    let other_account_id = other_body["account"]["accountId"]
        .as_str()
        .unwrap()
        .to_string();

    sqlx_core::query::query(
        "INSERT INTO cloud_attachments \
         (attachment_id, owner_account_id, object_key, content_type, size_bytes, created_at, finalized_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $6)",
    )
    .bind("att_owner")
    .bind(&owner_account_id)
    .bind("attachments/test/att_owner")
    .bind("image/png")
    .bind(123_i64)
    .bind("2026-05-12T00:00:00Z")
    .execute(&pool)
    .await
    .unwrap();

    let send_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &owner_token,
            json!({
                "peerAccountId": owner_account_id,
                "body": "",
                "attachments": [{
                    "attachmentId": "att_owner",
                    "name": "screen.png",
                    "kind": "image",
                    "mimeType": "image/png",
                    "sizeBytes": 123
                }]
            }),
        ))
        .await
        .unwrap();
    let send_status = send_resp.status();
    let send_body = read_json(send_resp).await;
    assert_eq!(send_status, StatusCode::CREATED, "got body {send_body}");
    assert_eq!(send_body["message"]["body"], "");
    assert_eq!(
        send_body["message"]["attachments"][0]["attachmentId"],
        "att_owner"
    );
    assert_eq!(send_body["message"]["attachments"][0]["name"], "screen.png");
    assert!(send_body["message"]["attachments"][0]["downloadUrl"].is_null());
    assert!(send_body["message"]["attachments"][0]["previewUrl"].is_null());

    let list_resp = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/messages?peerAccountId={owner_account_id}"),
            &owner_token,
        ))
        .await
        .unwrap();
    let list_body = read_json(list_resp).await;
    assert_eq!(
        list_body["messages"][0]["attachments"][0]["attachmentId"],
        "att_owner"
    );
    assert!(list_body["messages"][0]["attachments"][0]["downloadUrl"].is_null());
    assert!(list_body["messages"][0]["attachments"][0]["previewUrl"].is_null());

    let forbidden_resp = router
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &other_token,
            json!({
                "peerAccountId": other_account_id,
                "body": "steal",
                "attachments": [{
                    "attachmentId": "att_owner",
                    "name": "screen.png",
                    "kind": "image"
                }]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(forbidden_resp.status(), StatusCode::FORBIDDEN);
    let forbidden_body = read_json(forbidden_resp).await;
    assert_eq!(forbidden_body["errorCode"], "invalid_attachment");
}

#[tokio::test]
async fn cloud_sync_returns_message_events_after_cursor() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("sync-msg-a");
    let peer_email = unique_email("sync-msg-b");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    let body = read_json(signup).await;
    let token = body["session"]["token"].as_str().unwrap().to_string();
    let account_id = body["account"]["accountId"].as_str().unwrap().to_string();

    let peer_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&peer_email, "correct horse"),
        ))
        .await
        .unwrap();
    let peer_body = read_json(peer_signup).await;
    let peer_token = peer_body["session"]["token"].as_str().unwrap().to_string();
    let peer_account_id = peer_body["account"]["accountId"]
        .as_str()
        .unwrap()
        .to_string();

    sqlx_core::query::query(
        "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) VALUES ($1, $2, $3), ($2, $1, $3)",
    )
    .bind(&account_id)
    .bind(&peer_account_id)
    .bind("2026-05-13T00:00:00Z")
    .execute(&pool)
    .await
    .unwrap();

    let send_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &token,
            json!({ "peerAccountId": peer_account_id, "body": "diff hello" }),
        ))
        .await
        .unwrap();
    assert_eq!(send_resp.status(), StatusCode::CREATED);
    let sent = read_json(send_resp).await;
    let message_id = sent["message"]["messageId"].as_str().unwrap();

    let sync_resp = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/sync?cursor=0", &token))
        .await
        .unwrap();
    assert_eq!(sync_resp.status(), StatusCode::OK);
    let sync = read_json(sync_resp).await;
    assert_eq!(sync["events"].as_array().unwrap().len(), 1);
    assert_eq!(sync["events"][0]["eventType"], "message.upsert");
    assert_eq!(sync["events"][0]["messageId"], message_id);
    assert_eq!(sync["events"][0]["peerAccountId"], peer_account_id);
    assert_eq!(
        sync["events"][0]["payload"]["message"]["body"],
        "diff hello"
    );
    assert!(sync["cursor"].as_str().unwrap().parse::<i64>().unwrap() > 0);

    let peer_sync_resp = router
        .oneshot(get_with_token("/v1/cloud/sync?cursor=0", &peer_token))
        .await
        .unwrap();
    assert_eq!(peer_sync_resp.status(), StatusCode::OK);
    let peer_sync = read_json(peer_sync_resp).await;
    assert_eq!(peer_sync["events"].as_array().unwrap().len(), 1);
    assert_eq!(peer_sync["events"][0]["eventType"], "message.upsert");
    assert_eq!(peer_sync["events"][0]["messageId"], message_id);
    assert_eq!(peer_sync["events"][0]["peerAccountId"], account_id);
}

#[tokio::test]
async fn cloud_session_visibility_hides_unhides_and_deletes_account_scoped_view() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("session-visibility-a");
    let peer_email = unique_email("session-visibility-b");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    let body = read_json(signup).await;
    let token = body["session"]["token"].as_str().unwrap().to_string();
    let account_id = body["account"]["accountId"].as_str().unwrap().to_string();

    let peer_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&peer_email, "correct horse"),
        ))
        .await
        .unwrap();
    let peer_body = read_json(peer_signup).await;
    let peer_token = peer_body["session"]["token"].as_str().unwrap().to_string();
    let peer_account_id = peer_body["account"]["accountId"]
        .as_str()
        .unwrap()
        .to_string();

    sqlx_core::query::query(
        "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) VALUES ($1, $2, $3), ($2, $1, $3)",
    )
    .bind(&account_id)
    .bind(&peer_account_id)
    .bind("2026-05-13T00:00:00Z")
    .execute(&pool)
    .await
    .unwrap();

    let source_session_id = format!("session:test-delete:{}", uuid::Uuid::new_v4().simple());
    let send_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &token,
            json!({ "peerAccountId": peer_account_id, "body": "hide then delete", "sessionId": source_session_id }),
        ))
        .await
        .unwrap();
    assert_eq!(send_resp.status(), StatusCode::CREATED);

    let encoded_session_id = source_session_id.replace(':', "%3A");
    let hide_resp = router
        .clone()
        .oneshot(put_with_token(
            &format!("/v1/cloud/sessions/{encoded_session_id}/hidden"),
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(hide_resp.status(), StatusCode::NO_CONTENT);

    let visibility_resp = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/sessions/visibility", &token))
        .await
        .unwrap();
    assert_eq!(visibility_resp.status(), StatusCode::OK);
    let visibility = read_json(visibility_resp).await;
    assert_eq!(visibility["hiddenSessionIds"], json!([source_session_id]));
    assert_eq!(visibility["deletedSessionIds"], json!([]));

    let unhide_resp = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/sessions/{encoded_session_id}/hidden"),
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(unhide_resp.status(), StatusCode::NO_CONTENT);
    let visibility_resp = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/sessions/visibility", &token))
        .await
        .unwrap();
    let visibility = read_json(visibility_resp).await;
    assert_eq!(visibility["hiddenSessionIds"], json!([]));

    let delete_resp = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/sessions/{encoded_session_id}"),
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(delete_resp.status(), StatusCode::NO_CONTENT);
    let visibility_resp = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/sessions/visibility", &token))
        .await
        .unwrap();
    let visibility = read_json(visibility_resp).await;
    assert_eq!(visibility["hiddenSessionIds"], json!([]));
    assert_eq!(visibility["deletedSessionIds"], json!([source_session_id]));

    let sync_resp = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/sync?cursor=0", &token))
        .await
        .unwrap();
    assert_eq!(sync_resp.status(), StatusCode::OK);
    let sync = read_json(sync_resp).await;
    assert!(sync["events"].as_array().unwrap().iter().any(|event| {
        event["eventType"] == "session.hidden" && event["payload"]["sessionId"] == source_session_id
    }));
    assert!(sync["events"].as_array().unwrap().iter().any(|event| {
        event["eventType"] == "session.unhidden"
            && event["payload"]["sessionId"] == source_session_id
    }));
    assert!(sync["events"].as_array().unwrap().iter().any(|event| {
        event["eventType"] == "session.deleted"
            && event["payload"]["sessionId"] == source_session_id
    }));

    let peer_messages_resp = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/messages?peerAccountId={account_id}"),
            &peer_token,
        ))
        .await
        .unwrap();
    assert_eq!(peer_messages_resp.status(), StatusCode::OK);
    let peer_messages = read_json(peer_messages_resp).await;
    assert_eq!(peer_messages["messages"].as_array().unwrap().len(), 1);
    assert_eq!(peer_messages["messages"][0]["body"], "hide then delete");

    let peer_update_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &peer_token,
            json!({ "peerAccountId": account_id, "body": "new update", "sessionId": source_session_id }),
        ))
        .await
        .unwrap();
    assert_eq!(peer_update_resp.status(), StatusCode::CREATED);

    let visibility_resp = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/sessions/visibility", &token))
        .await
        .unwrap();
    let visibility = read_json(visibility_resp).await;
    assert_eq!(visibility["deletedSessionIds"], json!([]));

    let sync_resp = router
        .oneshot(get_with_token("/v1/cloud/sync?cursor=0", &token))
        .await
        .unwrap();
    let sync = read_json(sync_resp).await;
    assert!(sync["events"].as_array().unwrap().iter().any(|event| {
        event["eventType"] == "message.upsert"
            && event["payload"]["message"]["body"] == "new update"
    }));
}

#[tokio::test]
async fn cloud_sync_paginates_and_advances_cursor() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("sync-page");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);

    let signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    let body = read_json(signup).await;
    let token = body["session"]["token"].as_str().unwrap().to_string();
    let account_id = body["account"]["accountId"].as_str().unwrap().to_string();

    for text in ["first diff", "second diff"] {
        let send_resp = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/messages",
                &token,
                json!({ "peerAccountId": account_id, "body": text }),
            ))
            .await
            .unwrap();
        assert_eq!(send_resp.status(), StatusCode::CREATED);
    }

    let page1_resp = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/sync?cursor=0&limit=1", &token))
        .await
        .unwrap();
    assert_eq!(page1_resp.status(), StatusCode::OK);
    let page1 = read_json(page1_resp).await;
    assert_eq!(page1["events"].as_array().unwrap().len(), 1);
    assert_eq!(page1["hasMore"], true);
    let cursor1 = page1["cursor"].as_str().unwrap();

    let page2_resp = router
        .oneshot(get_with_token(
            &format!("/v1/cloud/sync?cursor={cursor1}&limit=1"),
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(page2_resp.status(), StatusCode::OK);
    let page2 = read_json(page2_resp).await;
    assert_eq!(page2["events"].as_array().unwrap().len(), 1);
    assert_eq!(page2["hasMore"], false);
    assert!(
        page2["cursor"].as_str().unwrap().parse::<i64>().unwrap() > cursor1.parse::<i64>().unwrap()
    );
}

#[tokio::test]
async fn cloud_sync_returns_read_receipt_events() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("sync-read-a");
    let peer_email = unique_email("sync-read-b");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    let body = read_json(signup).await;
    let token = body["session"]["token"].as_str().unwrap().to_string();
    let account_id = body["account"]["accountId"].as_str().unwrap().to_string();

    let peer_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&peer_email, "correct horse"),
        ))
        .await
        .unwrap();
    let peer_body = read_json(peer_signup).await;
    let peer_token = peer_body["session"]["token"].as_str().unwrap().to_string();
    let peer_account_id = peer_body["account"]["accountId"]
        .as_str()
        .unwrap()
        .to_string();

    sqlx_core::query::query(
        "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) VALUES ($1, $2, $3), ($2, $1, $3)",
    )
    .bind(&account_id)
    .bind(&peer_account_id)
    .bind("2026-05-13T00:00:00Z")
    .execute(&pool)
    .await
    .unwrap();

    let send_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &token,
            json!({ "peerAccountId": peer_account_id, "body": "read me" }),
        ))
        .await
        .unwrap();
    assert_eq!(send_resp.status(), StatusCode::CREATED);
    let sent = read_json(send_resp).await;
    let message_id = sent["message"]["messageId"].as_str().unwrap().to_string();

    let read_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages/read",
            &peer_token,
            json!({ "peerAccountId": account_id }),
        ))
        .await
        .unwrap();
    assert_eq!(read_resp.status(), StatusCode::NO_CONTENT);

    let sync_resp = router
        .oneshot(get_with_token("/v1/cloud/sync?cursor=0", &token))
        .await
        .unwrap();
    assert_eq!(sync_resp.status(), StatusCode::OK);
    let sync = read_json(sync_resp).await;
    let read_event = sync["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["eventType"] == "message.read")
        .unwrap();
    assert_eq!(read_event["peerAccountId"], peer_account_id);
    assert_eq!(read_event["payload"]["readerAccountId"], peer_account_id);
    assert_eq!(
        read_event["payload"]["messageIds"].as_array().unwrap(),
        &vec![json!(message_id)]
    );
}

#[tokio::test]
async fn cloud_agent_runtime_status_records_offline_readonly_fallback() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("agent-runtime-status");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);

    let signup_resp = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    assert_eq!(signup_resp.status(), StatusCode::CREATED);
    let signup = read_json(signup_resp).await;
    let token = signup["session"]["token"].as_str().unwrap().to_string();
    let account_id = signup["account"]["accountId"].as_str().unwrap().to_string();

    let update_resp = router
        .clone()
        .oneshot(put_json_with_token(
            "/v1/cloud/agents/runtime-status",
            &token,
            json!({
                "reachabilityState": "offline",
                "localExecutionState": "paused",
                "readonlyFallbackEnabled": true,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(update_resp.status(), StatusCode::OK);
    let updated = read_json(update_resp).await;
    assert_eq!(updated["status"]["accountId"], account_id);
    assert_eq!(updated["status"]["reachabilityState"], "offline");
    assert_eq!(updated["status"]["localExecutionState"], "paused");
    assert_eq!(updated["status"]["readonlyFallbackEnabled"], true);

    let load_resp = router
        .oneshot(get_with_token(
            &format!("/v1/cloud/agents/{account_id}/runtime-status"),
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(load_resp.status(), StatusCode::OK);
    let loaded = read_json(load_resp).await;
    assert_eq!(loaded["status"]["accountId"], account_id);
    assert_eq!(loaded["status"]["reachabilityState"], "offline");
    assert_eq!(loaded["status"]["localExecutionState"], "paused");
    assert_eq!(loaded["status"]["readonlyFallbackEnabled"], true);
}

#[tokio::test]
async fn offline_agent_fallback_inserts_direct_paused_response() {
    let Some(pool) = try_pool().await else { return };
    let owner_email = unique_email("offline-agent-owner");
    let sender_email = unique_email("offline-agent-sender");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let owner_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&owner_email, "correct horse"),
        ))
        .await
        .unwrap();
    assert_eq!(owner_signup.status(), StatusCode::CREATED);
    let owner = read_json(owner_signup).await;
    let owner_token = owner["session"]["token"].as_str().unwrap().to_string();
    let owner_account_id = owner["account"]["accountId"].as_str().unwrap().to_string();

    let sender_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&sender_email, "correct horse"),
        ))
        .await
        .unwrap();
    assert_eq!(sender_signup.status(), StatusCode::CREATED);
    let sender = read_json(sender_signup).await;
    let sender_token = sender["session"]["token"].as_str().unwrap().to_string();
    let sender_account_id = sender["account"]["accountId"].as_str().unwrap().to_string();

    sqlx_core::query::query(
        "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) VALUES ($1, $2, $3), ($2, $1, $3)",
    )
    .bind(&owner_account_id)
    .bind(&sender_account_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();

    let status_resp = router
        .clone()
        .oneshot(put_json_with_token(
            "/v1/cloud/agents/runtime-status",
            &owner_token,
            json!({
                "reachabilityState": "offline",
                "localExecutionState": "paused",
                "readonlyFallbackEnabled": true,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(status_resp.status(), StatusCode::OK);

    let send_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &sender_token,
            json!({ "peerAccountId": owner_account_id, "body": "Can @E2E Kordi inspect my local files?" }),
        ))
        .await
        .unwrap();
    assert_eq!(send_resp.status(), StatusCode::CREATED);
    let sent = read_json(send_resp).await;
    let request_id = sent["message"]["messageId"].as_str().unwrap();

    let fresh_messages_resp = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/messages?peerAccountId={owner_account_id}"),
            &sender_token,
        ))
        .await
        .unwrap();
    assert_eq!(fresh_messages_resp.status(), StatusCode::OK);
    let fresh_listed = read_json(fresh_messages_resp).await;
    let fresh_response = fresh_listed["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| {
            message["fromAccountId"] == owner_account_id
                && message["body"]
                    .as_str()
                    .unwrap_or_default()
                    .starts_with("kordi-cloud-agent-response:")
        });
    assert!(fresh_response.is_none(), "fresh offline requests should stay processing before fallback claims them");

    sqlx_core::query::query(
        "UPDATE cloud_messages SET created_at = $1 WHERE message_id = $2",
    )
    .bind((chrono::Utc::now() - chrono::Duration::seconds(90)).to_rfc3339())
    .bind(request_id)
    .execute(&pool)
    .await
    .unwrap();

    let messages_resp = router
        .oneshot(get_with_token(
            &format!("/v1/cloud/messages?peerAccountId={owner_account_id}"),
            &sender_token,
        ))
        .await
        .unwrap();
    assert_eq!(messages_resp.status(), StatusCode::OK);
    let listed = read_json(messages_resp).await;
    let response = listed["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| {
            message["fromAccountId"] == owner_account_id
                && message["body"]
                    .as_str()
                    .unwrap_or_default()
                    .starts_with("kordi-cloud-agent-response:")
        })
        .expect("server fallback response should be inserted");
    let encoded = response["body"]
        .as_str()
        .unwrap()
        .trim_start_matches("kordi-cloud-agent-response:");
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .unwrap();
    let envelope: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
    assert_eq!(envelope["kind"], "agent-response");
    assert_eq!(envelope["requestId"], request_id);
    assert_eq!(envelope["deliveryState"], "failed");
    assert!(envelope["text"]
        .as_str()
        .unwrap()
        .contains("local execution is paused"));
}

#[tokio::test]
async fn offline_agent_fallback_claims_without_message_refresh() {
    std::env::set_var("KORDI_CLOUD_AGENT_FALLBACK_GRACE_SECONDS", "1");
    let Some(pool) = try_pool().await else { return };
    let owner_email = unique_email("offline-agent-owner-background");
    let sender_email = unique_email("offline-agent-sender-background");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let owner_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&owner_email, "correct horse"),
        ))
        .await
        .unwrap();
    assert_eq!(owner_signup.status(), StatusCode::CREATED);
    let owner = read_json(owner_signup).await;
    let owner_token = owner["session"]["token"].as_str().unwrap().to_string();
    let owner_account_id = owner["account"]["accountId"].as_str().unwrap().to_string();

    let sender_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&sender_email, "correct horse"),
        ))
        .await
        .unwrap();
    assert_eq!(sender_signup.status(), StatusCode::CREATED);
    let sender = read_json(sender_signup).await;
    let sender_token = sender["session"]["token"].as_str().unwrap().to_string();
    let sender_account_id = sender["account"]["accountId"].as_str().unwrap().to_string();

    sqlx_core::query::query(
        "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) VALUES ($1, $2, $3), ($2, $1, $3)",
    )
    .bind(&owner_account_id)
    .bind(&sender_account_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();

    let status_resp = router
        .clone()
        .oneshot(put_json_with_token(
            "/v1/cloud/agents/runtime-status",
            &owner_token,
            json!({
                "reachabilityState": "offline",
                "localExecutionState": "paused",
                "readonlyFallbackEnabled": true,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(status_resp.status(), StatusCode::OK);

    let send_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &sender_token,
            json!({ "peerAccountId": owner_account_id, "body": "Can @E2E Kordi answer after logout?" }),
        ))
        .await
        .unwrap();
    assert_eq!(send_resp.status(), StatusCode::CREATED);
    let sent = read_json(send_resp).await;
    let request_id = sent["message"]["messageId"].as_str().unwrap().to_string();

    for _ in 0..30 {
        let response_row: Option<(String,)> = sqlx_core::query_as::query_as(
            "SELECT body FROM cloud_messages \
             WHERE from_account_id = $1 AND to_account_id = $2 \
               AND body LIKE 'kordi-cloud-agent-response:%' \
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(&owner_account_id)
        .bind(&sender_account_id)
        .fetch_optional(&pool)
        .await
        .unwrap();
        if let Some((body,)) = response_row {
            let encoded = body.trim_start_matches("kordi-cloud-agent-response:");
            let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(encoded)
                .unwrap();
            let envelope: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
            assert_eq!(envelope["requestId"], request_id);
            assert_eq!(envelope["deliveryState"], "failed");
            std::env::remove_var("KORDI_CLOUD_AGENT_FALLBACK_GRACE_SECONDS");
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    std::env::remove_var("KORDI_CLOUD_AGENT_FALLBACK_GRACE_SECONDS");

    panic!("offline cloud agent fallback was not claimed without a message refresh");
}

#[tokio::test]
async fn offline_group_agent_fallback_inserts_group_agent_response() {
    std::env::set_var("KORDI_CLOUD_AGENT_FALLBACK_GRACE_SECONDS", "1");
    let Some(pool) = try_pool().await else { return };
    let owner_email = unique_email("offline-group-agent-owner");
    let sender_email = unique_email("offline-group-agent-sender");
    let observer_email = unique_email("offline-group-agent-observer");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let owner_signup = router
        .clone()
        .oneshot(post("/v1/cloud/auth/signup", signup_body(&owner_email, "correct horse")))
        .await
        .unwrap();
    assert_eq!(owner_signup.status(), StatusCode::CREATED);
    let owner = read_json(owner_signup).await;
    let owner_token = owner["session"]["token"].as_str().unwrap().to_string();
    let owner_account_id = owner["account"]["accountId"].as_str().unwrap().to_string();

    let sender_signup = router
        .clone()
        .oneshot(post("/v1/cloud/auth/signup", signup_body(&sender_email, "correct horse")))
        .await
        .unwrap();
    assert_eq!(sender_signup.status(), StatusCode::CREATED);
    let sender = read_json(sender_signup).await;
    let sender_token = sender["session"]["token"].as_str().unwrap().to_string();
    let sender_account_id = sender["account"]["accountId"].as_str().unwrap().to_string();

    let observer_signup = router
        .clone()
        .oneshot(post("/v1/cloud/auth/signup", signup_body(&observer_email, "correct horse")))
        .await
        .unwrap();
    assert_eq!(observer_signup.status(), StatusCode::CREATED);
    let observer = read_json(observer_signup).await;
    let observer_account_id = observer["account"]["accountId"].as_str().unwrap().to_string();

    let status_resp = router
        .clone()
        .oneshot(put_json_with_token(
            "/v1/cloud/agents/runtime-status",
            &owner_token,
            json!({
                "reachabilityState": "offline",
                "localExecutionState": "paused",
                "readonlyFallbackEnabled": true,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(status_resp.status(), StatusCode::OK);

    let group_id = format!("session:group:{}", uuid::Uuid::new_v4());
    let request_group_message_id = format!("msg:ui:{}", uuid::Uuid::new_v4());
    let created_at_ms = chrono::Utc::now().timestamp_millis();
    let participants = json!([
        { "accountId": sender_account_id, "displayName": "Sender", "avatarUrl": null, "role": "admin" },
        { "accountId": owner_account_id, "displayName": "E2E", "avatarUrl": null, "role": "person" },
        { "accountId": observer_account_id, "displayName": "Observer", "avatarUrl": null, "role": "person" }
    ]);
    let body = encode_group_control_for_test(json!({
        "kind": "group-message",
        "groupId": group_id,
        "groupSpaceId": group_id,
        "groupTitle": null,
        "createdByAccountId": sender_account_id,
        "actor": { "accountId": sender_account_id, "displayName": "Sender", "avatarUrl": null, "role": "person" },
        "participants": participants,
        "message": {
            "id": request_group_message_id,
            "senderAccountId": sender_account_id,
            "text": "Can @E2EKordi answer in this group?",
            "createdAtMs": created_at_ms,
            "senderKind": "human"
        }
    }));

    let send_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &sender_token,
            json!({
                "peerAccountId": owner_account_id,
                "body": body,
                "sessionId": group_id,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(send_resp.status(), StatusCode::CREATED);

    for _ in 0..30 {
        let rows: Vec<(String, String, String)> = sqlx_core::query_as::query_as(
            "SELECT message_id, to_account_id, body FROM cloud_messages \
             WHERE from_account_id = $1 AND body LIKE 'kordi-cloud-group:%' \
             ORDER BY created_at ASC",
        )
        .bind(&owner_account_id)
        .fetch_all(&pool)
        .await
        .unwrap();
        for (_message_id, to_account_id, body) in rows {
            let encoded = body.trim_start_matches("kordi-cloud-group:");
            let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(encoded)
                .unwrap();
            let envelope: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
            let message = &envelope["message"];
            if message["senderKind"] == "agent"
                && message["senderAccountId"] == owner_account_id
                && message["requestId"] == request_group_message_id
            {
                assert_eq!(message["deliveryState"], "failed");
                assert_ne!(to_account_id, owner_account_id);
                std::env::remove_var("KORDI_CLOUD_AGENT_FALLBACK_GRACE_SECONDS");
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    std::env::remove_var("KORDI_CLOUD_AGENT_FALLBACK_GRACE_SECONDS");

    panic!("offline group cloud agent fallback was not inserted");
}

#[tokio::test]
async fn stale_online_agent_fallback_is_claimed_on_message_refresh() {
    let Some(pool) = try_pool().await else { return };
    let owner_email = unique_email("stale-agent-owner");
    let sender_email = unique_email("stale-agent-sender");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let owner_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&owner_email, "correct horse"),
        ))
        .await
        .unwrap();
    assert_eq!(owner_signup.status(), StatusCode::CREATED);
    let owner = read_json(owner_signup).await;
    let owner_token = owner["session"]["token"].as_str().unwrap().to_string();
    let owner_account_id = owner["account"]["accountId"].as_str().unwrap().to_string();

    let sender_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&sender_email, "correct horse"),
        ))
        .await
        .unwrap();
    assert_eq!(sender_signup.status(), StatusCode::CREATED);
    let sender = read_json(sender_signup).await;
    let sender_token = sender["session"]["token"].as_str().unwrap().to_string();
    let sender_account_id = sender["account"]["accountId"].as_str().unwrap().to_string();

    sqlx_core::query::query(
        "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) VALUES ($1, $2, $3), ($2, $1, $3)",
    )
    .bind(&owner_account_id)
    .bind(&sender_account_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();

    let status_resp = router
        .clone()
        .oneshot(put_json_with_token(
            "/v1/cloud/agents/runtime-status",
            &owner_token,
            json!({
                "reachabilityState": "online",
                "localExecutionState": "available",
                "readonlyFallbackEnabled": true,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(status_resp.status(), StatusCode::OK);

    sqlx_core::query::query(
        "UPDATE cloud_agent_runtime_status SET updated_at = $1 WHERE account_id = $2",
    )
    .bind((chrono::Utc::now() - chrono::Duration::seconds(30)).to_rfc3339())
    .bind(&owner_account_id)
    .execute(&pool)
    .await
    .unwrap();

    let send_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &sender_token,
            json!({ "peerAccountId": owner_account_id, "body": "Can @E2E Kordi answer after going stale?" }),
        ))
        .await
        .unwrap();
    assert_eq!(send_resp.status(), StatusCode::CREATED);
    let sent = read_json(send_resp).await;
    let request_id = sent["message"]["messageId"].as_str().unwrap().to_string();

    let immediate_responses: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*) FROM cloud_messages WHERE from_account_id = $1 AND to_account_id = $2 AND body LIKE 'kordi-cloud-agent-response:%'",
    )
    .bind(&owner_account_id)
    .bind(&sender_account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(immediate_responses.0, 0, "fresh requests to a stale-online runtime should not get an immediate hard-coded fallback");

    let pre_refresh_responses: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*) FROM cloud_messages WHERE from_account_id = $1 AND to_account_id = $2 AND body LIKE 'kordi-cloud-agent-response:%'",
    )
    .bind(&owner_account_id)
    .bind(&sender_account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(pre_refresh_responses.0, 0, "test must prove refresh performs the claim");

    let fresh_messages_resp = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/messages?peerAccountId={owner_account_id}"),
            &sender_token,
        ))
        .await
        .unwrap();
    assert_eq!(fresh_messages_resp.status(), StatusCode::OK);
    let fresh_listed = read_json(fresh_messages_resp).await;
    let fresh_response = fresh_listed["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| {
            message["fromAccountId"] == owner_account_id
                && message["body"]
                    .as_str()
                    .unwrap_or_default()
                    .starts_with("kordi-cloud-agent-response:")
        });
    assert!(fresh_response.is_none(), "fresh requests to a stale-online runtime should stay pending so the real desktop agent can answer first");

    sqlx_core::query::query(
        "UPDATE cloud_messages SET created_at = $1 WHERE message_id = $2",
    )
    .bind((chrono::Utc::now() - chrono::Duration::seconds(90)).to_rfc3339())
    .bind(&request_id)
    .execute(&pool)
    .await
    .unwrap();

    let messages_resp = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/messages?peerAccountId={owner_account_id}"),
            &sender_token,
        ))
        .await
        .unwrap();
    assert_eq!(messages_resp.status(), StatusCode::OK);
    let listed = read_json(messages_resp).await;
    let response = listed["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| {
            message["fromAccountId"] == owner_account_id
                && message["body"]
                    .as_str()
                    .unwrap_or_default()
                    .starts_with("kordi-cloud-agent-response:")
        })
        .expect("refresh should claim stale online fallback request");
    let encoded = response["body"]
        .as_str()
        .unwrap()
        .trim_start_matches("kordi-cloud-agent-response:");
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .unwrap();
    let envelope: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
    assert_eq!(envelope["requestId"], request_id);
    assert_eq!(envelope["deliveryState"], "failed");
}

#[tokio::test]
async fn cloud_agent_provider_auth_snapshot_is_owner_scoped_and_does_not_return_secret_json() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("agent-auth-snapshot");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let signup_resp = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    assert_eq!(signup_resp.status(), StatusCode::CREATED);
    let signup = read_json(signup_resp).await;
    let token = signup["session"]["token"].as_str().unwrap().to_string();
    let account_id = signup["account"]["accountId"].as_str().unwrap().to_string();

    let snapshot_resp = router
        .clone()
        .oneshot(put_json_with_token(
            "/v1/cloud/agents/provider-auth-snapshot",
            &token,
            json!({
                "formatVersion": 2,
                "authJson": {
                    "version": 2,
                    "profiles": {
                        "openai": [{ "id": "profile-openai", "type": "api_key", "key": "sk-test" }]
                    },
                    "active_auth_profiles": { "openai": "profile-openai" },
                    "active_auth_methods": { "openai": "api_key" }
                },
                "activeProvider": "openai",
                "activeProfileId": "profile-openai",
            }),
        ))
        .await
        .unwrap();
    assert_eq!(snapshot_resp.status(), StatusCode::OK);
    let snapshot = read_json(snapshot_resp).await;
    assert_eq!(snapshot["snapshot"]["accountId"], account_id);
    assert_eq!(snapshot["snapshot"]["formatVersion"], 2);
    assert_eq!(snapshot["snapshot"]["activeProvider"], "openai");
    assert!(snapshot["snapshot"].get("authJson").is_none());

    let stored: (serde_json::Value,) = sqlx_core::query_as::query_as(
        "SELECT auth_json FROM cloud_agent_provider_auth_snapshots WHERE account_id = $1",
    )
    .bind(&account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored.0["profiles"]["openai"][0]["key"], "sk-test");
}

#[tokio::test]
async fn logout_invalidates_session_token() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("logout");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let signup_resp = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    let signup = read_json(signup_resp).await;
    let token = signup["session"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    let account_id = signup["account"]["accountId"].as_str().unwrap().to_string();

    let runtime_resp = router
        .clone()
        .oneshot(put_json_with_token(
            "/v1/cloud/agents/runtime-status",
            &token,
            json!({
                "reachabilityState": "online",
                "localExecutionState": "available",
                "readonlyFallbackEnabled": true,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(runtime_resp.status(), StatusCode::OK);

    let snapshot_resp = router
        .clone()
        .oneshot(put_json_with_token(
            "/v1/cloud/agents/provider-auth-snapshot",
            &token,
            json!({
                "formatVersion": 2,
                "authJson": {
                    "version": 2,
                    "profiles": {
                        "openai": [{ "id": "profile-openai", "type": "api_key", "key": "sk-test" }]
                    },
                    "active_auth_profiles": { "openai": "profile-openai" }
                },
                "activeProvider": "openai",
                "activeProfileId": "profile-openai",
            }),
        ))
        .await
        .unwrap();
    assert_eq!(snapshot_resp.status(), StatusCode::OK);

    let pre_logout_snapshot_rows: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*) FROM cloud_agent_provider_auth_snapshots WHERE account_id = $1",
    )
    .bind(&account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(pre_logout_snapshot_rows.0, 1);

    let pre_logout_runtime_rows: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*) FROM cloud_agent_runtime_status WHERE account_id = $1",
    )
    .bind(&account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(pre_logout_runtime_rows.0, 1);

    let logout_resp = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/auth/logout", &token))
        .await
        .unwrap();
    assert_eq!(logout_resp.status(), StatusCode::NO_CONTENT);

    let me_after = router
        .oneshot(get_with_token("/v1/cloud/auth/me", &token))
        .await
        .unwrap();
    assert_eq!(me_after.status(), StatusCode::UNAUTHORIZED);

    let snapshot_rows: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*) FROM cloud_agent_provider_auth_snapshots WHERE account_id = $1",
    )
    .bind(&account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(snapshot_rows.0, 1, "logout preserves provider auth for server-side read-only replies");

    let runtime_row: (String, String, bool,) = sqlx_core::query_as::query_as(
        "SELECT reachability_state, local_execution_state, readonly_fallback_enabled \
         FROM cloud_agent_runtime_status WHERE account_id = $1",
    )
    .bind(&account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(runtime_row.0, "offline");
    assert_eq!(runtime_row.1, "paused");
    assert!(runtime_row.2, "logout keeps the cloud read-only fallback reachable");
}
