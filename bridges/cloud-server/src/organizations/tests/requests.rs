//! The organization on every request (organization-requests.md): the token
//! exchange, the `Kordi-Organization` header, and membership that ends while
//! a token is live. This is the logging phase, so no mismatch is refused.

use axum::body::Body;
use axum::http::Request;
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use super::{add, personal_organization, team, ORGS};
use crate::auth::app_sign_in::tokens::{rotate_refresh_token, start_sign_in};
use crate::auth::app_sign_in::RefreshOutcome;
use crate::common_ground::tests::db_fixture::{app, pool, signed_in};
use crate::organizations::token_exchange::ORGANIZATION_TOKEN_PATH;

const CLIENT: &str = "kordi-test-app";

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    token: &str,
    organization: Option<&str>,
    body: Option<Value>,
) -> (u16, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {token}"));
    if let Some(organization) = organization {
        request = request.header("kordi-organization", organization);
    }
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn switch(app: &Router, token: &str, organization: &str) -> (u16, Value) {
    let body = json!({ "organization_id": organization });
    call(
        app,
        "POST",
        ORGANIZATION_TOKEN_PATH,
        token,
        None,
        Some(body),
    )
    .await
}

fn ai_chat(organization: Option<&str>) -> Value {
    let mut body = json!({
        "client_operation_id": Uuid::now_v7(),
        "kind": "ai",
        "shared_title": "Planning",
        "client_session_id": format!("session:ai:{}", Uuid::now_v7()),
        "member_account_ids": [],
    });
    if let Some(organization) = organization {
        body["organization_id"] = json!(organization);
    }
    body
}

fn message() -> Value {
    json!({
        "client_message_id": Uuid::now_v7(),
        "kind": "text",
        "content": { "schema": 1, "blocks": [{ "type": "text", "text": "hello" }] },
        "reply_to_message_id": null
    })
}

/// An organization-scoped route without side effects.
const SCOPED: &str = "/v1/cloud/agents";

fn created(status: u16) -> bool {
    status == 200 || status == 201
}

async fn device_of(pool: &PgPool, account_id: &str) -> String {
    let (device,): (String,) =
        query_as("SELECT device_id FROM cloud_devices WHERE account_id = $1 LIMIT 1")
            .bind(account_id)
            .fetch_one(pool)
            .await
            .unwrap();
    device
}

async fn claim_of(pool: &PgPool, token_id: &str) -> Option<String> {
    let (claim,): (Option<String>,) =
        query_as("SELECT organization_id FROM cloud_refresh_tokens WHERE token_id = $1")
            .bind(token_id)
            .fetch_one(pool)
            .await
            .unwrap();
    claim
}

#[tokio::test]
async fn switching_keeps_the_sign_in_refresh_token_and_device() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, _) = signed_in(&pool, "req_switch").await;
    let organization = team(&pool, &alex).await;
    let device = device_of(&pool, &alex).await;
    let mut tx = pool.begin().await.unwrap();
    let issued = start_sign_in(&mut tx, &alex, &device, CLIENT)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let (status, body) = switch(&app, &issued.access_token, &organization).await;
    assert_eq!(status, 200, "{body}");
    let switched = body["access_token"].as_str().unwrap().to_string();
    assert_ne!(switched, issued.access_token);
    assert_eq!(body["token_type"], "Bearer");
    assert_eq!(body["account_id"], alex.as_str());
    assert_eq!(body["device_id"], device.as_str());
    assert_eq!(body["sign_in_id"], issued.sign_in_id.as_str());
    assert_eq!(body["organization_id"], organization.as_str());
    assert!(body.get("refresh_token").is_none(), "{body}");

    // The new token claims the team; the old one keeps its own claim.
    let (switched_id,): (String,) = query_as(
        "SELECT token_id FROM cloud_refresh_tokens WHERE app_sign_in_id = $1 AND token_id <> $2",
    )
    .bind(&issued.sign_in_id)
    .bind(&issued.access_token_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        claim_of(&pool, &switched_id).await.as_deref(),
        Some(organization.as_str())
    );
    assert_eq!(claim_of(&pool, &issued.access_token_id).await, None);
    for token in [&switched, &issued.access_token] {
        let (status, body) = call(&app, "GET", SCOPED, token, Some(&organization), None).await;
        assert_eq!(status, 200, "{body}");
    }

    // The refresh token was never rotated, and its next access token keeps
    // the organization the app switched to.
    match rotate_refresh_token(&pool, CLIENT, &issued.refresh_token)
        .await
        .unwrap()
    {
        RefreshOutcome::Issued(refreshed) => {
            assert_eq!(refreshed.sign_in_id, issued.sign_in_id);
            assert_eq!(refreshed.device_id, device);
            let claim = claim_of(&pool, &refreshed.access_token_id).await;
            assert_eq!(claim.as_deref(), Some(organization.as_str()));
        }
        other => panic!("refresh after a switch: {other:?}"),
    }

    // An organization the account is not in looks like one that does not
    // exist, and changes nothing.
    let (stranger, _) = signed_in(&pool, "req_switch_stranger").await;
    let foreign = team(&pool, &stranger).await;
    for target in [foreign.as_str(), "org_missing_example", ""] {
        let (status, body) = switch(&app, &switched, target).await;
        assert_eq!(status, 404, "{target}: {body}");
    }
}

#[tokio::test]
async fn an_older_session_switches_its_own_claim() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, token) = signed_in(&pool, "req_legacy").await;
    let organization = team(&pool, &alex).await;
    let (token_id,): (String,) =
        query_as("SELECT token_id FROM cloud_refresh_tokens WHERE account_id = $1")
            .bind(&alex)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(claim_of(&pool, &token_id).await, None);

    let (status, body) = switch(&app, &token, &organization).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["access_token"], token.as_str());
    assert!(body.get("sign_in_id").is_none(), "{body}");
    assert_eq!(
        claim_of(&pool, &token_id).await.as_deref(),
        Some(organization.as_str())
    );
    let personal = personal_organization(&pool, &alex).await;
    assert_eq!(switch(&app, &token, &personal).await.0, 200);
    assert_eq!(
        claim_of(&pool, &token_id).await.as_deref(),
        Some(personal.as_str())
    );
}

#[tokio::test]
async fn mismatches_are_logged_and_requests_continue() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, token) = signed_in(&pool, "req_log").await;
    let organization = team(&pool, &alex).await;
    for header in [
        None,
        Some(organization.as_str()),
        Some("org_missing_example"),
    ] {
        let (status, body) = call(&app, "GET", SCOPED, &token, header, None).await;
        assert_eq!(status, 200, "{header:?}: {body}");
    }
    // A token still in the personal organization creates and changes team
    // content as before.
    let chats = "/v2/chat/conversations";
    let body = Some(ai_chat(Some(&organization)));
    let (status, body) = call(&app, "POST", chats, &token, None, body).await;
    assert!(created(status), "{status} {body}");
    let chat = body["conversation"]["id"].as_str().unwrap().to_string();
    let path = format!("{chats}/{chat}/messages");
    let (status, body) = call(&app, "POST", &path, &token, None, Some(message())).await;
    assert!(created(status), "{status} {body}");
}

#[tokio::test]
async fn membership_that_ends_while_a_token_is_live_falls_back_to_personal() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "req_remove_owner").await;
    let (sam, sam_token) = signed_in(&pool, "req_remove_member").await;
    let organization = team(&pool, &alex).await;
    let (status, body) = add(&app, &pool, &alex_token, &organization, &sam, "member").await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(switch(&app, &sam_token, &organization).await.0, 200);

    let path = format!("{ORGS}/{organization}/members/{sam}");
    let (status, body) = call(&app, "DELETE", &path, &alex_token, None, None).await;
    assert_eq!(status, 204, "{body}");

    // The token keeps working, but the team is no longer its organization:
    // the claim is not checked active, and switching back is refused.
    let claim = crate::auth::session::lookup_session(&pool, &sam_token)
        .await
        .unwrap()
        .unwrap()
        .organization;
    assert_eq!(claim.claimed.as_deref(), Some(organization.as_str()));
    assert!(!claim.claim_active);
    let sam_personal = personal_organization(&pool, &sam).await;
    let resolved =
        crate::organizations::requests::RequestOrganization::resolve(&sam, &claim, None).unwrap();
    assert_eq!(resolved.organization_id, sam_personal);
    let (status, _) = call(&app, "GET", SCOPED, &sam_token, Some(&organization), None).await;
    assert_eq!(status, 200);
    let (status, _) = call(&app, "GET", ORGS, &sam_token, Some(&organization), None).await;
    assert_eq!(status, 200);
    assert_eq!(switch(&app, &sam_token, &organization).await.0, 404);
    assert_eq!(switch(&app, &sam_token, &sam_personal).await.0, 200);
}
