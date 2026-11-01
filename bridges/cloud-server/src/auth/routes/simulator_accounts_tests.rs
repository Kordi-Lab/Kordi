use super::*;
use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use futures_util::FutureExt;
use serde_json::{json, Value};
use sqlx_postgres::PgPoolOptions;
use std::panic::AssertUnwindSafe;
use tower::ServiceExt;

const TOKEN: &str = "synthetic-account-operator-token-at-least-32";
fn app(pool: PgPool, token: Option<&str>) -> Router {
    configured(
        pool,
        PasswordHasherConfig::for_tests(),
        Arc::new(CloudRateLimiter::default()),
        token,
    )
}
fn request(body: Value, token: Option<&str>) -> Request<Body> {
    let mut request = Request::builder()
        .method("POST")
        .uri(PATH)
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    request.body(Body::from(body.to_string())).unwrap()
}
async fn json_body(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap()
}

#[tokio::test]
async fn disabled_unauthorized_and_invalid_requests_never_need_a_database() {
    let pool = PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(10))
        .connect_lazy("postgres://synthetic:synthetic@127.0.0.1:1/synthetic")
        .unwrap();
    for token in [None, Some("too-short")] {
        let response = app(pool.clone(), token)
            .oneshot(request(json!({"displayName":"Synthetic"}), Some(TOKEN)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
    let router = app(pool, Some(TOKEN));
    for token in [None, Some("synthetic-incorrect-token-at-least-32")] {
        let response = router
            .clone()
            .oneshot(request(json!({"displayName":"Synthetic"}), token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    for name in [
        "".to_string(),
        " ".into(),
        "a".repeat(81),
        "Bad\nName".into(),
    ] {
        let response = router
            .clone()
            .oneshot(request(json!({"displayName":name}), Some(TOKEN)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    for field in ["accountId", "email", "loginId", "password"] {
        let mut body = json!({"displayName":"Synthetic"});
        body[field] = json!("existing-identity");
        let response = router
            .clone()
            .oneshot(request(body, Some(TOKEN)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }
    let response = router
        .oneshot(request(
            json!({"displayName":"a".repeat(2048)}),
            Some(TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
#[ignore = "requires task-owned PostgreSQL"]
async fn name_only_provisioning_creates_new_unverified_account_with_normal_login() {
    let url = std::env::var("KORDI_SIM_TEST_DATABASE_URL")
        .expect("explicit isolated simulator test database required");
    let pool = crate::pg::init_pool(&url).await.unwrap();
    let name = format!("Synthetic provisioning {}", uuid::Uuid::new_v4().simple());
    let result = AssertUnwindSafe(tokio::time::timeout(
        std::time::Duration::from_secs(30),
        exercise(&pool, &name),
    ))
    .catch_unwind()
    .await;
    // Exact unique fixture name owns both newly created accounts, their profiles and sessions.
    query("DELETE FROM cloud_audit_events WHERE account_id IN (SELECT account_id FROM cloud_accounts WHERE display_name=$1)").bind(&name).execute(&pool).await.unwrap();
    query("DELETE FROM cloud_chat_conversations WHERE created_by_account_id IN (SELECT account_id FROM cloud_accounts WHERE display_name=$1)").bind(&name).execute(&pool).await.unwrap();
    query("DELETE FROM cloud_accounts WHERE display_name=$1")
        .bind(&name)
        .execute(&pool)
        .await
        .unwrap();
    match result {
        Ok(result) => result.expect("bounded account provisioning test"),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
async fn exercise(pool: &PgPool, name: &str) {
    let router = app(pool.clone(), Some(TOKEN));
    let denied = router
        .clone()
        .oneshot(request(
            json!({"displayName":name}),
            Some("synthetic-wrong-token-at-least-32"),
        ))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    let count: (i64,) = query_as("SELECT count(*) FROM cloud_accounts WHERE display_name=$1")
        .bind(name)
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(count.0, 0);
    let mut credentials = Vec::new();
    for _ in 0..2 {
        let response = router
            .clone()
            .oneshot(request(json!({"displayName":name}), Some(TOKEN)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(
            response.headers()[axum::http::header::CACHE_CONTROL],
            "no-store"
        );
        credentials.push(json_body(response).await);
    }
    assert!(credentials[0]["accountId"] != credentials[1]["accountId"]);
    assert!(credentials[0]["loginId"] != credentials[1]["loginId"]);
    let credential = &credentials[0];
    let id = credential["accountId"].as_str().unwrap();
    let login_id = credential["loginId"].as_str().unwrap();
    let password = credential["password"].as_str().unwrap();
    assert!(login_id.ends_with("@example.invalid"));
    assert!(password.len() >= 40);
    validate_email(login_id).unwrap();
    validate_password_strength(password).unwrap();
    let row: (String,Option<String>,String,String,i64) = query_as("SELECT account.password_hash,account.primary_email_verified_at,account.avatar_source,account.avatar_seed,(SELECT count(*) FROM cloud_default_agent_profiles profile WHERE profile.owner_account_id=account.account_id) FROM cloud_accounts account WHERE account.account_id=$1")
        .bind(id).fetch_one(pool).await.unwrap();
    assert!(verify_password(&row.0, password).unwrap());
    assert!(row.0 != password);
    assert!(row.1.is_none());
    assert_eq!(row.2, "generated");
    assert!(!row.3.is_empty());
    assert_eq!(row.4, 1);
    let audits: Vec<(String,)> = query_as("SELECT metadata_json FROM cloud_audit_events WHERE account_id=$1 AND event_type='simulator.account_created'")
        .bind(id).fetch_all(pool).await.unwrap();
    assert_eq!(audits.len(), 1);
    let metadata: Value = serde_json::from_str(&audits[0].0).unwrap();
    assert_eq!(metadata, json!({"synthetic":true,"method":"operator"}));
    let state = Arc::new(ServerState::new(
        pool.clone(),
        crate::events::EventBus::noop(),
    ));
    let auth = super::super::routes_with_config(
        state.clone(),
        PasswordHasherConfig::for_tests(),
        CloudRateLimiter::default(),
    )
    .merge(crate::chat_sync::routes::routes(state));
    let response = auth
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/cloud/auth/login")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email":login_id,"password":password}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let login = json_body(response).await;
    let session_token = login["session"]["token"].as_str().unwrap();
    for path in ["/v1/cloud/auth/devices", "/v1/cloud/auth/me"] {
        let response = auth
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header("authorization", format!("Bearer {session_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    let confirmed: (i64,) = query_as("SELECT count(*) FROM cloud_devices WHERE account_id=$1 AND authorization_state='confirmed' AND revoked_at IS NULL").bind(id).fetch_one(pool).await.unwrap();
    assert_eq!(confirmed.0, 1);
    let peer = credentials[1]["accountId"].as_str().unwrap();
    query("INSERT INTO cloud_contacts(account_id,peer_account_id,created_at) VALUES ($1,$2,$3),($2,$1,$3)")
        .bind(id).bind(peer).bind(Utc::now().to_rfc3339()).execute(pool).await.unwrap();
    let conversation = authenticated_post(&auth,"/v2/chat/conversations",session_token,json!({
        "client_operation_id":uuid::Uuid::new_v4(),"kind":"group","shared_title":"Synthetic provisioning test",
        "client_session_id":format!("simulator-provisioning-{}",uuid::Uuid::new_v4()),"member_account_ids":[peer]
    })).await;
    let conversation_id = conversation["conversation"]["id"].as_str().unwrap();
    let sent = authenticated_post(&auth,&format!("/v2/chat/conversations/{conversation_id}/messages"),session_token,json!({
        "client_message_id":uuid::Uuid::new_v4(),"kind":"text","content":{"schema":1,"blocks":[{"type":"text","text":"Synthetic provisioned account can chat."}]},"reply_to_message_id":null,"attachment_ids":[]
    })).await;
    assert!(sent["message"]["sender_account_id"] == id);
}

async fn authenticated_post(router: &Router, path: &str, token: &str, body: Value) -> Value {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(response.status().is_success());
    json_body(response).await
}
