//! A signed-in account proves it can read its primary email with an inbox code.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use async_trait::async_trait;
use kordi_cloud_server::auth::signup_email::{SignupCodeSender, SignupEmailService};

use super::*;

pub(super) const SEND: &str = "/v1/cloud/auth/email/verification/code";
pub(super) const VERIFY: &str = "/v1/cloud/auth/email/verification";

#[derive(Default)]
pub(super) struct Inbox {
    pub(super) codes: Mutex<HashMap<String, String>>,
    pub(super) fail: AtomicBool,
}

#[async_trait]
impl SignupCodeSender for Inbox {
    async fn send_code(&self, email: &str, code: &str) -> Result<(), &'static str> {
        if self.fail.load(Ordering::SeqCst) {
            return Err("Synthetic delivery failure");
        }
        self.codes
            .lock()
            .unwrap()
            .insert(email.to_string(), code.to_string());
        Ok(())
    }
}

pub(super) fn email_router(pool: sqlx_postgres::PgPool, inbox: Arc<Inbox>) -> axum::Router {
    let state = ServerState::new(pool, EventBus::noop()).with_signup_email(
        SignupEmailService::new(inbox, signup_email_fixture::KEY.to_vec()).unwrap(),
    );
    fast_router(Arc::new(state))
}

/// A password account whose email was never verified, as created before signup
/// required an inbox code. Returns its session token, id, and email.
pub(super) async fn legacy_account(
    router: &axum::Router,
    pool: &sqlx_postgres::PgPool,
    prefix: &str,
) -> (String, String, String) {
    let email = unique_email(prefix);
    let response = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse").await,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = read_json(response).await;
    let token = body["session"]["token"].as_str().unwrap().to_string();
    let account_id = body["account"]["accountId"].as_str().unwrap().to_string();
    sqlx_core::query::query(
        "UPDATE cloud_accounts SET primary_email_verified_at = NULL WHERE account_id = $1",
    )
    .bind(&account_id)
    .execute(pool)
    .await
    .unwrap();
    (token, account_id, email)
}

pub(super) async fn send(router: &axum::Router, token: &str) -> axum::response::Response {
    router
        .clone()
        .oneshot(post_json_with_token(SEND, token, json!({})))
        .await
        .unwrap()
}

pub(super) async fn verify(router: &axum::Router, token: &str, id: &str, code: &str) -> StatusCode {
    let response = router
        .clone()
        .oneshot(post_json_with_token(
            VERIFY,
            token,
            json!({ "verificationId": id, "verificationCode": code }),
        ))
        .await
        .unwrap();
    let status = response.status();
    if status == StatusCode::BAD_REQUEST {
        assert_eq!(
            read_json(response).await["errorCode"],
            "invalid_verification_code"
        );
    }
    status
}

async fn me_verified(router: &axum::Router, token: &str) -> bool {
    let response = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/auth/me", token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    assert!(body["accountId"].is_string());
    assert!(body["primaryEmail"].is_string());
    assert!(body["avatar"].is_object());
    assert!(body["defaultAgent"].is_object());
    assert!(body["passwordSet"].as_bool().unwrap());
    body["primaryEmailVerified"].as_bool().unwrap()
}

pub(super) async fn error_code(response: axum::response::Response) -> serde_json::Value {
    read_json(response).await["errorCode"].clone()
}

#[tokio::test]
async fn verification_routes_require_a_session() {
    let Some(pool) = try_pool().await else { return };
    let router = email_router(pool, Arc::new(Inbox::default()));
    for request in [
        post(SEND, Body::from("{}")),
        post(
            VERIFY,
            Body::from(
                json!({ "verificationId": "email_x", "verificationCode": "000000" }).to_string(),
            ),
        ),
    ] {
        assert_eq!(
            router.clone().oneshot(request).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn legacy_account_verifies_its_email_with_an_inbox_code() {
    let Some(pool) = try_pool().await else { return };
    let inbox = Arc::new(Inbox::default());
    let router = email_router(pool.clone(), inbox.clone());
    let (token, account_id, email) = legacy_account(&router, &pool, "legacy-verify").await;
    assert!(!me_verified(&router, &token).await);

    let response = send(&router, &token).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    assert_eq!(body["retryAfterSeconds"], 60);
    assert!(body["expiresAt"].is_string());
    assert!(body.get("code").is_none());
    assert!(body.get("verificationCode").is_none());
    let id = body["verificationId"].as_str().unwrap().to_string();
    let code = inbox.codes.lock().unwrap()[&email].clone();

    let wrong = if code == "000000" { "999999" } else { "000000" };
    assert_eq!(
        verify(&router, &token, &id, wrong).await,
        StatusCode::BAD_REQUEST
    );
    assert!(!me_verified(&router, &token).await);
    let (remaining,): (i32,) = sqlx_core::query_as::query_as(
        "SELECT attempts_remaining FROM cloud_account_email_codes WHERE account_id = $1",
    )
    .bind(&account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(remaining, 4, "a failed guess is committed");

    assert_eq!(
        verify(&router, &token, &id, &code).await,
        StatusCode::NO_CONTENT
    );
    assert!(me_verified(&router, &token).await);
    // This is the state OAuth email linking requires of an existing account.
    let (verified,): (bool,) = sqlx_core::query_as::query_as(
        "SELECT primary_email_verified_at IS NOT NULL FROM cloud_accounts \
         WHERE LOWER(primary_email) = $1",
    )
    .bind(&email)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(verified);

    let again = send(&router, &token).await;
    assert_eq!(again.status(), StatusCode::CONFLICT);
    assert_eq!(error_code(again).await, "email_already_verified");
    assert_eq!(
        verify(&router, &token, &id, &code).await,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn codes_for_another_account_do_not_verify() {
    let Some(pool) = try_pool().await else { return };
    let inbox = Arc::new(Inbox::default());
    let router = email_router(pool.clone(), inbox.clone());
    let (owner_token, _, owner_email) = legacy_account(&router, &pool, "code-owner").await;
    let (other_token, _, _) = legacy_account(&router, &pool, "code-other").await;
    let body = read_json(send(&router, &owner_token).await).await;
    let id = body["verificationId"].as_str().unwrap().to_string();
    let code = inbox.codes.lock().unwrap()[&owner_email].clone();
    assert_eq!(
        verify(&router, &other_token, &id, &code).await,
        StatusCode::BAD_REQUEST
    );
    assert!(!me_verified(&router, &other_token).await);
    assert_eq!(
        verify(&router, &owner_token, &id, &code).await,
        StatusCode::NO_CONTENT
    );
}

fn mentions_verification(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(map) => map
            .iter()
            .any(|(key, value)| key == "primaryEmailVerified" || mentions_verification(value)),
        serde_json::Value::Array(items) => items.iter().any(mentions_verification),
        _ => false,
    }
}

#[tokio::test]
async fn owner_account_payloads_report_verification() {
    let Some(pool) = try_pool().await else { return };
    let router = email_router(pool.clone(), Arc::new(Inbox::default()));
    let email = unique_email("owner-payloads");
    let signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse").await,
        ))
        .await
        .unwrap();
    assert_eq!(signup.status(), StatusCode::CREATED);
    let signup = read_json(signup).await;
    assert_eq!(signup["account"]["primaryEmailVerified"], true);
    let token = signup["session"]["token"].as_str().unwrap().to_string();
    let account_id = signup["account"]["accountId"].as_str().unwrap().to_string();
    assert!(me_verified(&router, &token).await);

    sqlx_core::query::query(
        "UPDATE cloud_accounts SET primary_email_verified_at = NULL WHERE account_id = $1",
    )
    .bind(&account_id)
    .execute(&pool)
    .await
    .unwrap();
    let login = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/login",
            Body::from(json!({ "email": &email, "password": "correct horse" }).to_string()),
        ))
        .await
        .unwrap();
    assert_eq!(login.status(), StatusCode::OK);
    assert_eq!(
        read_json(login).await["account"]["primaryEmailVerified"],
        false
    );
    let patch = router
        .clone()
        .oneshot(patch_json_with_token(
            "/v1/cloud/auth/me",
            &token,
            json!({ "displayName": "Owner Payloads" }),
        ))
        .await
        .unwrap();
    assert_eq!(patch.status(), StatusCode::OK);
    let patch = read_json(patch).await;
    assert_eq!(patch["displayName"], "Owner Payloads");
    assert_eq!(patch["primaryEmailVerified"], false);
}

#[tokio::test]
async fn payloads_about_other_accounts_omit_verification() {
    let Some(pool) = try_pool().await else { return };
    let router = email_router(pool, Arc::new(Inbox::default()));
    let (viewer_token, _) = signup_account(&router, "viewer").await;
    let (peer_token, peer_id) = signup_account(&router, "peer").await;
    let peer = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/auth/me", &peer_token))
            .await
            .unwrap(),
    )
    .await;
    let kordi_id = peer["kordiId"].as_str().unwrap();

    let profile = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/accounts/{kordi_id}/profile"),
            &viewer_token,
        ))
        .await
        .unwrap();
    assert_eq!(profile.status(), StatusCode::OK);
    let profile = read_json(profile).await;
    assert_eq!(profile["accountId"], peer_id);
    assert!(!mentions_verification(&profile));

    let request = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/contacts/requests",
            &viewer_token,
            json!({ "peerAccountId": &peer_id }),
        ))
        .await
        .unwrap();
    assert!(request.status().is_success());
    let request = read_json(request).await;
    assert!(request.to_string().contains(&peer_id));
    assert!(!mentions_verification(&request));
    for (path, token) in [
        ("/v1/cloud/contacts/requests", &peer_token),
        ("/v1/cloud/contacts/requests", &viewer_token),
        ("/v1/cloud/contacts", &viewer_token),
    ] {
        let response = router
            .clone()
            .oneshot(get_with_token(path, token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!mentions_verification(&read_json(response).await));
    }
}

#[tokio::test]
async fn signup_accounts_report_a_verified_email() {
    let Some(pool) = try_pool().await else { return };
    let router = email_router(pool, Arc::new(Inbox::default()));
    let (token, _) = signup_account(&router, "signup-verified").await;
    assert!(me_verified(&router, &token).await);
    assert_eq!(send(&router, &token).await.status(), StatusCode::CONFLICT);
}
