//! The account routes from the kordi.ai pages: the web session cookie, the
//! exact Origin and the CSRF header on state-changing requests.

use axum::body::Body;
use axum::http::Request;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use super::{harness, ACCOUNT_ORGS};
use crate::auth::routes::{web_csrf_token, WEB_CSRF_HEADER, WEB_SESSION_COOKIE};
use crate::common_ground::tests::db_fixture::signed_in;

async fn browser(
    app: &axum::Router,
    method: &str,
    path: &str,
    headers: &[(&str, String)],
    body: Option<Value>,
) -> (u16, Value) {
    let mut request = Request::builder().method(method).uri(path);
    for (name, value) in headers {
        request = request.header(*name, value);
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

#[tokio::test]
async fn the_web_session_cookie_reaches_the_account_routes() {
    let Some(h) = harness(|_| {}, &[]).await else {
        return;
    };
    let (account, token) = signed_in(&h.pool, "web_cookie").await;
    let cookie = ("cookie", format!("{WEB_SESSION_COOKIE}={token}"));
    let origin = ("origin", crate::distribution::public_origin());
    let csrf = (WEB_CSRF_HEADER, web_csrf_token(&token));

    // A read needs only the cookie.
    let (status, body) = browser(
        &h.app,
        "GET",
        ACCOUNT_ORGS,
        std::slice::from_ref(&cookie),
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert!(body["configured"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["id"] == h.config_id() && entry["admission"] == "join"));
    let (status, _) = browser(&h.app, "GET", ACCOUNT_ORGS, &[], None).await;
    assert_eq!(status, 401);

    let submit = format!("{ACCOUNT_ORGS}/{}/join-requests", h.config_id());
    let request = json!({"fields": {"affiliation": "Example Lab"}});
    let (status, body) = browser(
        &h.app,
        "POST",
        &submit,
        &[cookie.clone(), origin.clone()],
        Some(request.clone()),
    )
    .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (403, Some("csrf_token_invalid"))
    );
    let wrong_origin = ("origin", "https://evil.example.test".to_string());
    let (status, body) = browser(
        &h.app,
        "POST",
        &submit,
        &[cookie.clone(), wrong_origin, csrf.clone()],
        Some(request.clone()),
    )
    .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (403, Some("origin_mismatch"))
    );
    let forged = (WEB_CSRF_HEADER, web_csrf_token("kordi_cs_other"));
    let (status, _) = browser(
        &h.app,
        "POST",
        &submit,
        &[cookie.clone(), origin.clone(), forged],
        Some(request.clone()),
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(h.role(&account).await, None);

    let (status, body) = browser(
        &h.app,
        "POST",
        &submit,
        &[cookie, origin, csrf],
        Some(request),
    )
    .await;
    assert_eq!(status, 201, "{body}");

    // Bearer sessions keep working on the same route.
    let (status, body) = browser(
        &h.app,
        "GET",
        ACCOUNT_ORGS,
        &[("authorization", format!("Bearer {token}"))],
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
}
