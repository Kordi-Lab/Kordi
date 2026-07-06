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

#[test]
fn cloud_message_listing_uses_newest_window_before_oldest_first_display_order() {
    let routes_source = std::fs::read_to_string("src/auth/routes.rs").expect("read auth routes source");
    assert!(routes_source.contains("ORDER BY cm.created_at DESC"));
    assert!(routes_source.contains("ORDER BY created_at ASC"));
    assert!(routes_source.contains("FROM ("));
}

#[test]
fn cloud_message_listing_applies_durable_read_cursors() {
    let routes_source = std::fs::read_to_string("src/auth/routes.rs").expect("read auth routes source");
    let pool_source = std::fs::read_to_string("src/pg/pool.rs").expect("read pool source");
    assert!(routes_source.contains("cloud_read_cursors"));
    assert!(pool_source.contains("version: 28"));
    assert!(pool_source.contains("0028_cloud_read_cursors.sql"));
    assert!(routes_source.contains("peer_read_cursor"));
    assert!(routes_source.contains("session_read_cursor"));
    assert!(routes_source.contains("COALESCE(read_at"));
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
async fn session_read_marks_all_inbound_rows_for_that_session() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let reader_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&unique_email("session-read-reader"), "correct horse"),
        ))
        .await
        .unwrap();
    let reader_body = read_json(reader_signup).await;
    let reader_token = reader_body["session"]["token"].as_str().unwrap().to_string();
    let reader_account_id = reader_body["account"]["accountId"].as_str().unwrap().to_string();

    let peer_one_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&unique_email("session-read-peer-one"), "correct horse"),
        ))
        .await
        .unwrap();
    let peer_one_body = read_json(peer_one_signup).await;
    let peer_one_token = peer_one_body["session"]["token"].as_str().unwrap().to_string();
    let peer_one_account_id = peer_one_body["account"]["accountId"].as_str().unwrap().to_string();

    let peer_two_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&unique_email("session-read-peer-two"), "correct horse"),
        ))
        .await
        .unwrap();
    let peer_two_body = read_json(peer_two_signup).await;
    let peer_two_token = peer_two_body["session"]["token"].as_str().unwrap().to_string();
    let peer_two_account_id = peer_two_body["account"]["accountId"].as_str().unwrap().to_string();

    sqlx_core::query::query(
        "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) VALUES \
         ($1, $2, $4), ($2, $1, $4), ($1, $3, $4), ($3, $1, $4)",
    )
    .bind(&reader_account_id)
    .bind(&peer_one_account_id)
    .bind(&peer_two_account_id)
    .bind("2026-05-13T00:00:00Z")
    .execute(&pool)
    .await
    .unwrap();

    let session_id = format!("session:group:{}", uuid::Uuid::new_v4().simple());
    let other_session_id = format!("session:group:{}", uuid::Uuid::new_v4().simple());
    for (token, peer) in [
        (&peer_one_token, &reader_account_id),
        (&peer_two_token, &reader_account_id),
    ] {
        let response = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/messages",
                token,
                json!({ "peerAccountId": peer, "body": "group unread", "sessionId": session_id }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
    }
    let other_response = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &peer_one_token,
            json!({ "peerAccountId": reader_account_id, "body": "other unread", "sessionId": other_session_id }),
        ))
        .await
        .unwrap();
    assert_eq!(other_response.status(), StatusCode::CREATED);

    let read_resp = router
        .clone()
        .oneshot(post_with_token(
            &format!("/v1/cloud/sessions/{session_id}/read"),
            &reader_token,
        ))
        .await
        .unwrap();
    assert_eq!(read_resp.status(), StatusCode::NO_CONTENT);

    let read_counts: Vec<(String, i64)> = sqlx_core::query_as::query_as(
        "SELECT session_id, COUNT(*) FROM cloud_messages \
         WHERE to_account_id = $1 AND read_at IS NULL AND session_id IN ($2, $3) \
         GROUP BY session_id ORDER BY session_id",
    )
    .bind(&reader_account_id)
    .bind(&session_id)
    .bind(&other_session_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(read_counts, vec![(other_session_id, 1)]);

    let sync_resp = router
        .oneshot(get_with_token("/v1/cloud/sync?cursor=0", &peer_one_token))
        .await
        .unwrap();
    assert_eq!(sync_resp.status(), StatusCode::OK);
    let sync = read_json(sync_resp).await;
    assert!(sync["events"].as_array().unwrap().iter().any(|event| {
        event["eventType"] == "message.read"
            && event["peerAccountId"] == reader_account_id
            && event["payload"]["sessionId"] == session_id
    }));
}

#[tokio::test]
async fn session_read_cursor_marks_legacy_unread_rows_read_for_fresh_listing() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let reader_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&unique_email("session-cursor-reader"), "correct horse"),
        ))
        .await
        .unwrap();
    let reader_body = read_json(reader_signup).await;
    let reader_token = reader_body["session"]["token"].as_str().unwrap().to_string();
    let reader_account_id = reader_body["account"]["accountId"].as_str().unwrap().to_string();

    let peer_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&unique_email("session-cursor-peer"), "correct horse"),
        ))
        .await
        .unwrap();
    let peer_body = read_json(peer_signup).await;
    let peer_token = peer_body["session"]["token"].as_str().unwrap().to_string();
    let peer_account_id = peer_body["account"]["accountId"].as_str().unwrap().to_string();

    sqlx_core::query::query(
        "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) VALUES ($1, $2, $3), ($2, $1, $3)",
    )
    .bind(&reader_account_id)
    .bind(&peer_account_id)
    .bind("2026-05-13T00:00:00Z")
    .execute(&pool)
    .await
    .unwrap();

    let session_id = format!("session:group:{}", uuid::Uuid::new_v4().simple());
    let other_session_id = format!("session:group:{}", uuid::Uuid::new_v4().simple());
    let session_message = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &peer_token,
            json!({ "peerAccountId": reader_account_id.clone(), "body": "legacy unread", "sessionId": session_id.clone() }),
        ))
        .await
        .unwrap();
    assert_eq!(session_message.status(), StatusCode::CREATED);
    let session_message_id = read_json(session_message).await["message"]["messageId"].as_str().unwrap().to_string();

    let other_message = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &peer_token,
            json!({ "peerAccountId": reader_account_id.clone(), "body": "other unread", "sessionId": other_session_id.clone() }),
        ))
        .await
        .unwrap();
    assert_eq!(other_message.status(), StatusCode::CREATED);
    let other_message_id = read_json(other_message).await["message"]["messageId"].as_str().unwrap().to_string();

    let read_resp = router
        .clone()
        .oneshot(post_with_token(
            &format!("/v1/cloud/sessions/{session_id}/read"),
            &reader_token,
        ))
        .await
        .unwrap();
    assert_eq!(read_resp.status(), StatusCode::NO_CONTENT);

    sqlx_core::query::query("UPDATE cloud_messages SET read_at = NULL WHERE message_id = $1")
        .bind(&session_message_id)
        .execute(&pool)
        .await
        .unwrap();

    let list_resp = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/messages?peerAccountId={peer_account_id}"),
            &reader_token,
        ))
        .await
        .unwrap();
    assert_eq!(list_resp.status(), StatusCode::OK);
    let list = read_json(list_resp).await;
    let messages = list["messages"].as_array().unwrap();
    let session_row = messages
        .iter()
        .find(|message| message["messageId"] == session_message_id)
        .unwrap();
    assert!(session_row["readAt"].as_str().is_some());
    let other_row = messages
        .iter()
        .find(|message| message["messageId"] == other_message_id)
        .unwrap();
    assert!(other_row["readAt"].is_null());
}

#[tokio::test]
async fn logout_invalidates_session_token() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("logout");
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
    let token = read_json(signup_resp).await["session"]["token"]
        .as_str()
        .unwrap()
        .to_string();

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
}


#[tokio::test]
async fn presence_contacts_returns_self_and_accepted_contacts_only() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let a_email = unique_email("presence-a");
    let b_email = unique_email("presence-b");
    let c_email = unique_email("presence-c");

    let a = read_json(router.clone().oneshot(post("/v1/cloud/auth/signup", signup_body(&a_email, "correct horse"))).await.unwrap()).await;
    let b = read_json(router.clone().oneshot(post("/v1/cloud/auth/signup", signup_body(&b_email, "correct horse"))).await.unwrap()).await;
    let c = read_json(router.clone().oneshot(post("/v1/cloud/auth/signup", signup_body(&c_email, "correct horse"))).await.unwrap()).await;
    let a_token = a["session"]["token"].as_str().unwrap();
    let b_id = b["account"]["accountId"].as_str().unwrap();
    let c_id = c["account"]["accountId"].as_str().unwrap();

    let request_body = json!({ "peerAccountId": b_id });
    let request = read_json(router.clone().oneshot(post_json_with_token("/v1/cloud/contacts/requests", a_token, request_body)).await.unwrap()).await;
    let request_id = request["request"]["requestId"].as_str().unwrap();
    let b_token = b["session"]["token"].as_str().unwrap();
    let accept_path = format!("/v1/cloud/contacts/requests/{request_id}/accept");
    let accept_status = router.clone().oneshot(post_with_token(&accept_path, b_token)).await.unwrap().status();
    assert_eq!(accept_status, StatusCode::OK);

    let online_status = router.clone().oneshot(post_with_token("/v1/cloud/presence/online", a_token)).await.unwrap().status();
    assert_eq!(online_status, StatusCode::OK);

    let response = router.clone().oneshot(get_with_token("/v1/cloud/presence/contacts", a_token)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    let ids: Vec<String> = body["accounts"].as_array().unwrap().iter().map(|row| row["accountId"].as_str().unwrap().to_string()).collect();
    assert!(ids.contains(&a["account"]["accountId"].as_str().unwrap().to_string()));
    assert!(ids.contains(&b_id.to_string()));
    assert!(!ids.contains(&c_id.to_string()));
}

#[tokio::test]
async fn presence_rollup_stays_online_until_all_devices_offline() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);
    let email = unique_email("presence-rollup");
    let signup = read_json(router.clone().oneshot(post("/v1/cloud/auth/signup", signup_body(&email, "correct horse"))).await.unwrap()).await;
    let token = signup["session"]["token"].as_str().unwrap();

    assert_eq!(router.clone().oneshot(post_with_token("/v1/cloud/presence/online", token)).await.unwrap().status(), StatusCode::OK);
    let online = read_json(router.clone().oneshot(get_with_token("/v1/cloud/presence/contacts", token)).await.unwrap()).await;
    assert_eq!(online["accounts"][0]["status"], "online");

    assert_eq!(router.clone().oneshot(post_with_token("/v1/cloud/presence/offline", token)).await.unwrap().status(), StatusCode::OK);
    let offline = read_json(router.clone().oneshot(get_with_token("/v1/cloud/presence/contacts", token)).await.unwrap()).await;
    assert_eq!(offline["accounts"][0]["status"], "offline");
}
