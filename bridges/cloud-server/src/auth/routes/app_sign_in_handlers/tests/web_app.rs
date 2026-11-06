//! Browser application access through the existing cookie-session contract.
use super::*;

fn cookie(token: &str) -> (String, String) {
    (
        "Cookie".to_string(),
        format!("{WEB_SESSION_COOKIE}={token}"),
    )
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn browser_application_api_checks_csrf_and_account_binding() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let bound = (
        "X-Kordi-Web-Account".to_string(),
        account.account_id.clone(),
    );
    let origin = ("Origin".to_string(), crate::distribution::public_origin());
    let csrf = (
        WEB_CSRF_HEADER.to_string(),
        web_csrf_token(&account.web_token),
    );
    let (status, body, headers) = harness
        .send_with(
            "GET",
            "/v1/cloud/auth/me",
            vec![cookie(&account.web_token), bound.clone()],
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["accountId"], account.account_id);
    assert_eq!(headers.get("cache-control").unwrap(), "no-store");

    for extra in [
        vec![],
        vec![origin.clone()],
        vec![csrf.clone()],
        vec![
            (
                "Origin".to_string(),
                "https://other.example.test".to_string(),
            ),
            csrf.clone(),
        ],
        vec![
            origin.clone(),
            (WEB_CSRF_HEADER.to_string(), "wrong".to_string()),
        ],
    ] {
        let mut headers = vec![cookie(&account.web_token), bound.clone()];
        headers.extend(extra);
        let (status, body, _) = harness
            .send_with(
                "PATCH",
                "/v1/cloud/auth/me",
                headers,
                Some((
                    "application/json",
                    "{\"displayName\":\"Web changed\"}".to_string(),
                )),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    }
    let (status, body, _) = harness
        .send_with(
            "PATCH",
            "/v1/cloud/auth/me",
            vec![cookie(&account.web_token), bound.clone(), origin, csrf],
            Some((
                "application/json",
                "{\"displayName\":\"Web changed\"}".to_string(),
            )),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["displayName"], "Web changed");
    let (status, body, _) = harness
        .send_with(
            "GET",
            "/v1/cloud/auth/me",
            vec![
                cookie(&account.web_token),
                (
                    "Kordi-Organization".to_string(),
                    "org_another_tab".to_string(),
                ),
            ],
            None,
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["errorCode"], "organization_mismatch");
    assert!(body["organizationId"].is_string());
    for (extra, expected) in [
        (
            (
                "X-Kordi-Web-Account".to_string(),
                "acct_someone_else".to_string(),
            ),
            StatusCode::FORBIDDEN,
        ),
        (
            ("Authorization".to_string(), "Bearer invalid".to_string()),
            StatusCode::UNAUTHORIZED,
        ),
    ] {
        let (status, body, _) = harness
            .send_with(
                "GET",
                "/v1/cloud/auth/me",
                vec![cookie(&account.web_token), extra],
                None,
            )
            .await;
        assert_eq!(status, expected, "{body}");
    }
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn browser_application_restores_organization_without_exposing_session_token() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let (status, body, _) = harness
        .send_with(
            "GET",
            "/v1/cloud/auth/web/session",
            vec![cookie(&account.web_token)],
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["session"]["deviceId"].is_string());
    assert!(body["session"].get("token").is_none());
    let organization = body["session"]["organizationId"].as_str().unwrap();
    let (status, switched) = harness
        .web(
            "/v1/cloud/auth/organization-token",
            &account.web_token,
            serde_json::json!({"organization_id": organization}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{switched}");
    assert_eq!(switched["account_id"], account.account_id);
    assert_eq!(switched["organization_id"], organization);
    assert!(switched.get("access_token").is_none());
    assert!(!switched.to_string().contains(&account.web_token));
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn stale_browser_tab_cannot_log_out_the_new_cookie_account() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let mut headers = web_headers(&account.web_token);
    headers.push((
        "X-Kordi-Web-Account".to_string(),
        "acct_previous".to_string(),
    ));
    let (status, body, response_headers) = harness
        .send_with("POST", "/v1/cloud/auth/web/logout", headers, None)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(response_headers.get("set-cookie").is_none());
    let (status, _, _) = harness
        .send_with(
            "GET",
            "/v1/cloud/auth/web/session",
            vec![cookie(&account.web_token)],
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn browser_socket_requires_public_origin_and_a_matching_web_account() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let state = ServerState::new(harness.pool.clone(), crate::events::EventBus::noop());
    let mut headers = HeaderMap::new();
    headers.insert("Cookie", cookie(&account.web_token).1.parse().unwrap());
    for origin in [None, Some("https://other.example.test"), Some("null")] {
        headers.remove("Origin");
        if let Some(origin) = origin {
            headers.insert("Origin", origin.parse().unwrap());
        }
        let rejected = crate::auth::routes::web_socket_session(&state, &headers, None).await;
        assert!(matches!(rejected, Err(response) if response.status() == StatusCode::FORBIDDEN));
    }
    headers.insert(
        "Origin",
        crate::distribution::public_origin().parse().unwrap(),
    );
    let accepted =
        crate::auth::routes::web_socket_session(&state, &headers, Some(&account.account_id)).await;
    assert!(matches!(accepted, Ok(session) if session.account_id == account.account_id));
    let rejected =
        crate::auth::routes::web_socket_session(&state, &headers, Some("acct_someone_else")).await;
    assert!(matches!(rejected, Err(response) if response.status() == StatusCode::UNAUTHORIZED));

    let pkce = pkce();
    let code = harness
        .code(&account.web_token, DESKTOP, LOOPBACK, &pkce)
        .await;
    let (status, tokens) = harness
        .exchange(DESKTOP, &code, LOOPBACK, &pkce.verifier)
        .await;
    assert_eq!(status, StatusCode::OK, "{tokens}");
    headers.insert(
        "Cookie",
        cookie(tokens["access_token"].as_str().unwrap())
            .1
            .parse()
            .unwrap(),
    );
    let rejected = crate::auth::routes::web_socket_session(&state, &headers, None).await;
    assert!(matches!(rejected, Err(response) if response.status() == StatusCode::FORBIDDEN));
}
