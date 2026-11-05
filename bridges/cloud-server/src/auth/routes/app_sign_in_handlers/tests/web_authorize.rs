//! The web page side of authorization: cookie session checks and the
//! display-code fallback.

use super::*;

fn assert_oauth_error(status: StatusCode, body: &Value, expected: StatusCode, error: &str) {
    assert_eq!(status, expected, "{body}");
    assert_eq!(body["error"], error, "{body}");
    assert_eq!(body["errorCode"], error, "{body}");
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn display_code_is_exchanged_with_the_apps_verifier() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let pkce = pkce();
    let redirect_uri = "kordi://auth/callback";
    let uri = "/v1/cloud/auth/app/authorize/display-code";
    // The page must ask the user to confirm first.
    let (status, body) = harness
        .web(
            uri,
            &account.web_token,
            authorize_body(IOS, redirect_uri, &pkce.challenge),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"], "confirmation_required");
    let mut confirmed = authorize_body(IOS, redirect_uri, &pkce.challenge);
    confirmed["confirmed"] = Value::Bool(true);
    let (status, body) = harness.web(uri, &account.web_token, confirmed).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["expiresIn"], 60);
    assert_eq!(body["state"], "state-1");
    assert_eq!(body["clientId"], IOS);
    assert_eq!(body["appName"], "Kordi for iPhone");
    assert_eq!(body["warning"], DISPLAY_CODE_WARNING);
    let requested_at = chrono::DateTime::parse_from_rfc3339(body["requestedAt"].as_str().unwrap())
        .unwrap()
        .with_timezone(&Utc);
    assert!((Utc::now() - requested_at).num_seconds().abs() < 60);
    assert!(body.get("redirectUrl").is_none());
    let code = token(&body, "code");
    let (status, tokens) = harness
        .exchange(IOS, &code, redirect_uri, &pkce.verifier)
        .await;
    assert_eq!(status, StatusCode::OK, "{tokens}");
    assert_eq!(
        harness.me_status(&token(&tokens, "access_token")).await,
        StatusCode::OK
    );
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn authorizing_requires_the_cookie_origin_and_csrf_token() {
    use crate::auth::routes::web_session_handlers::{WEB_CSRF_HEADER, WEB_SESSION_COOKIE};
    let harness = harness().await;
    let account = harness.web_account().await;
    let pkce = pkce();
    let body = authorize_body(DESKTOP, LOOPBACK, &pkce.challenge);
    let without = |name: &str| -> Vec<(String, String)> {
        web_headers(&account.web_token)
            .into_iter()
            .filter(|(header, _)| !header.eq_ignore_ascii_case(name))
            .collect()
    };
    let replaced = |name: &str, value: &str| -> Vec<(String, String)> {
        let mut headers = without(name);
        headers.push((name.to_string(), value.to_string()));
        headers
    };
    let bearer_only = vec![
        (
            "Authorization".to_string(),
            format!("Bearer {}", account.web_token),
        ),
        ("Origin".to_string(), crate::distribution::public_origin()),
    ];
    let unknown_session = web_headers("kordi_cs_not-a-session");
    for (headers, expected, error) in [
        (without("Origin"), StatusCode::FORBIDDEN, "origin_mismatch"),
        (
            replaced("Origin", "https://evil.example.test"),
            StatusCode::FORBIDDEN,
            "origin_mismatch",
        ),
        (
            replaced(
                "Origin",
                &format!("{}.evil.example.test", crate::distribution::public_origin()),
            ),
            StatusCode::FORBIDDEN,
            "origin_mismatch",
        ),
        (
            without(WEB_CSRF_HEADER),
            StatusCode::FORBIDDEN,
            "csrf_token_invalid",
        ),
        (
            replaced(WEB_CSRF_HEADER, &"0".repeat(64)),
            StatusCode::FORBIDDEN,
            "csrf_token_invalid",
        ),
        (
            without("Cookie"),
            StatusCode::UNAUTHORIZED,
            "login_required",
        ),
        (bearer_only, StatusCode::UNAUTHORIZED, "login_required"),
        (unknown_session, StatusCode::UNAUTHORIZED, "login_required"),
    ] {
        for uri in [
            "/v1/cloud/auth/app/authorize",
            "/v1/cloud/auth/app/authorize/display-code",
        ] {
            let (status, response, _) = harness
                .send_with(
                    "POST",
                    uri,
                    headers.clone(),
                    Some(("application/json", body.to_string())),
                )
                .await;
            assert_oauth_error(status, &response, expected, error);
        }
    }
    // A CSRF token for another session does not match this cookie.
    let other = harness.web_account().await;
    let mut crossed = web_headers(&account.web_token);
    crossed.retain(|(name, _)| name != WEB_CSRF_HEADER);
    crossed.push((
        WEB_CSRF_HEADER.to_string(),
        crate::auth::routes::web_session_handlers::web_csrf_token(&other.web_token),
    ));
    let (status, response, _) = harness
        .send_with(
            "POST",
            "/v1/cloud/auth/app/authorize",
            crossed,
            Some(("application/json", body.to_string())),
        )
        .await;
    assert_oauth_error(
        status,
        &response,
        StatusCode::FORBIDDEN,
        "csrf_token_invalid",
    );
    assert!(WEB_SESSION_COOKIE.starts_with("__Host-"));

    // An app's own access token in the cookie may not authorize another app.
    let tokens = harness.signed_in(&account, DESKTOP, LOOPBACK).await;
    let mut display = authorize_body(IOS, "kordi://auth/callback", &pkce.challenge);
    display["confirmed"] = Value::Bool(true);
    let (status, response) = harness
        .web(
            "/v1/cloud/auth/app/authorize/display-code",
            &token(&tokens, "access_token"),
            display,
        )
        .await;
    assert_oauth_error(
        status,
        &response,
        StatusCode::FORBIDDEN,
        "web_session_required",
    );
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn display_codes_are_limited_per_account_and_app() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let pkce = pkce();
    let mut body = authorize_body(IOS, "kordi://auth/callback", &pkce.challenge);
    body["confirmed"] = Value::Bool(true);
    let uri = "/v1/cloud/auth/app/authorize/display-code";
    for _ in 0..5 {
        let (status, response) = harness.web(uri, &account.web_token, body.clone()).await;
        assert_eq!(status, StatusCode::OK, "{response}");
    }
    let (status, _) = harness.web(uri, &account.web_token, body.clone()).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    // Another app of the same account still has its own budget, and a
    // redirect code is not a display code.
    let mut desktop = authorize_body(DESKTOP, LOOPBACK, &pkce.challenge);
    desktop["confirmed"] = Value::Bool(true);
    let (status, _) = harness.web(uri, &account.web_token, desktop).await;
    assert_eq!(status, StatusCode::OK);
    harness
        .code(&account.web_token, IOS, "kordi://auth/callback", &pkce)
        .await;
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn code_redemption_is_limited_per_account_and_app() {
    let harness = harness().await;
    let account = harness.web_account().await;
    for _ in 0..10 {
        let pkce = pkce();
        let code = harness
            .code(&account.web_token, DESKTOP, LOOPBACK, &pkce)
            .await;
        let (status, _) = harness
            .exchange(DESKTOP, &code, LOOPBACK, &super::pkce().verifier)
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let pkce = pkce();
    let code = harness
        .code(&account.web_token, DESKTOP, LOOPBACK, &pkce)
        .await;
    let (status, _) = harness
        .exchange(DESKTOP, &code, LOOPBACK, &pkce.verifier)
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    // Another app of the same account keeps its own budget.
    let tokens = harness
        .signed_in(&account, IOS, "kordi://auth/callback")
        .await;
    assert!(tokens["access_token"].is_string());
}
