//! Every way a browser sign-in request is refused.

use super::*;

fn assert_oauth_error(status: StatusCode, body: &Value, expected: StatusCode, error: &str) {
    assert_eq!(status, expected, "{body}");
    assert_eq!(body["error"], error, "{body}");
    assert_eq!(body["errorCode"], error, "{body}");
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn unknown_clients_and_redirect_uris_are_refused_without_a_redirect() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let pkce = pkce();
    for (client_id, redirect_uri, error) in [
        ("unknown-app", LOOPBACK, "invalid_client"),
        (IOS, LOOPBACK, "invalid_redirect_uri"),
        (
            DESKTOP,
            "http://localhost:53682/auth/callback",
            "invalid_redirect_uri",
        ),
        (
            DESKTOP,
            "https://app.example.test/auth/callback",
            "invalid_redirect_uri",
        ),
        (
            DESKTOP,
            "kordi-beta://auth/callback",
            "invalid_redirect_uri",
        ),
    ] {
        let (status, body) = harness
            .web(
                "/v1/cloud/auth/app/authorize",
                &account.web_token,
                authorize_body(client_id, redirect_uri, &pkce.challenge),
            )
            .await;
        assert_oauth_error(status, &body, StatusCode::BAD_REQUEST, error);

        let start = format!(
            "/v1/cloud/auth/app/authorize?response_type=code&client_id={client_id}\
             &redirect_uri={}&code_challenge={}&code_challenge_method=S256&state=s",
            url::form_urlencoded::byte_serialize(redirect_uri.as_bytes()).collect::<String>(),
            pkce.challenge
        );
        let (status, body, headers) = harness.send("GET", &start, None, None).await;
        assert_oauth_error(status, &body, StatusCode::BAD_REQUEST, error);
        assert!(headers.get("location").is_none());
    }
    let (status, body) = harness
        .exchange("unknown-app", "kordi_ac_x", LOOPBACK, &pkce.verifier)
        .await;
    assert_oauth_error(status, &body, StatusCode::UNAUTHORIZED, "invalid_client");
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn malformed_requests_return_the_error_to_the_app() {
    let harness = harness().await;
    let pkce = pkce();
    for (query, error) in [
        (
            format!(
                "response_type=token&code_challenge={}&code_challenge_method=S256&state=s",
                pkce.challenge
            ),
            "unsupported_response_type",
        ),
        (
            format!(
                "response_type=code&code_challenge={}&code_challenge_method=plain&state=s",
                pkce.challenge
            ),
            "invalid_request",
        ),
        (
            format!(
                "response_type=code&code_challenge={}&state=s",
                pkce.challenge
            ),
            "invalid_request",
        ),
        (
            "response_type=code&code_challenge=short&code_challenge_method=S256&state=s"
                .to_string(),
            "invalid_request",
        ),
        (
            format!(
                "response_type=code&code_challenge={}&code_challenge_method=S256",
                pkce.challenge
            ),
            "invalid_request",
        ),
    ] {
        let uri = format!(
            "/v1/cloud/auth/app/authorize?client_id={IOS}&redirect_uri=kordi%3A%2F%2Fauth%2Fcallback&{query}"
        );
        let (status, _, headers) = harness.send("GET", &uri, None, None).await;
        assert!(status.is_redirection(), "{query}");
        let location = url::Url::parse(headers.get("location").unwrap().to_str().unwrap()).unwrap();
        assert!(
            location.as_str().starts_with("kordi://auth/callback?"),
            "{location}"
        );
        let pairs: std::collections::HashMap<_, _> = location.query_pairs().into_owned().collect();
        assert_eq!(pairs["error"], error, "{query}");
        assert!(!pairs.contains_key("code"));
    }
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn a_wrong_verifier_burns_the_code() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let pkce = pkce();
    let code = harness
        .code(&account.web_token, DESKTOP, LOOPBACK, &pkce)
        .await;
    let (status, body) = harness
        .exchange(DESKTOP, &code, LOOPBACK, &super::pkce().verifier)
        .await;
    assert_oauth_error(status, &body, StatusCode::BAD_REQUEST, "invalid_grant");
    let (status, body) = harness
        .exchange(DESKTOP, &code, LOOPBACK, &pkce.verifier)
        .await;
    assert_oauth_error(status, &body, StatusCode::BAD_REQUEST, "invalid_grant");
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn a_mismatched_redirect_uri_or_client_burns_the_code() {
    let harness = harness().await;
    let account = harness.web_account().await;
    for (client_id, redirect_uri) in [
        (DESKTOP, "http://127.0.0.1:53683/auth/callback"),
        (DESKTOP, "kordi://auth/callback"),
        ("kordi-desktop-beta", LOOPBACK),
    ] {
        let pkce = pkce();
        let code = harness
            .code(&account.web_token, DESKTOP, LOOPBACK, &pkce)
            .await;
        let (status, body) = harness
            .exchange(client_id, &code, redirect_uri, &pkce.verifier)
            .await;
        assert_oauth_error(status, &body, StatusCode::BAD_REQUEST, "invalid_grant");
        let (status, body) = harness
            .exchange(DESKTOP, &code, LOOPBACK, &pkce.verifier)
            .await;
        assert_oauth_error(status, &body, StatusCode::BAD_REQUEST, "invalid_grant");
    }
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn an_expired_code_is_refused() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let pkce = pkce();
    let code = harness
        .code(&account.web_token, DESKTOP, LOOPBACK, &pkce)
        .await;
    query("UPDATE cloud_app_authorization_codes SET expires_at = $1 WHERE code_hash = $2")
        .bind(Utc::now() - ChronoDuration::seconds(1))
        .bind(crate::auth::app_sign_in::codes::hash_code(&code))
        .execute(&harness.pool)
        .await
        .unwrap();
    let (status, body) = harness
        .exchange(DESKTOP, &code, LOOPBACK, &pkce.verifier)
        .await;
    assert_oauth_error(status, &body, StatusCode::BAD_REQUEST, "invalid_grant");
    assert!(body["error_description"]
        .as_str()
        .unwrap()
        .contains("expired"));
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn reusing_a_code_revokes_what_it_issued() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let pkce = pkce();
    let code = harness
        .code(&account.web_token, DESKTOP, LOOPBACK, &pkce)
        .await;
    let (status, tokens) = harness
        .exchange(DESKTOP, &code, LOOPBACK, &pkce.verifier)
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = harness
        .exchange(DESKTOP, &code, LOOPBACK, &pkce.verifier)
        .await;
    assert_oauth_error(status, &body, StatusCode::BAD_REQUEST, "invalid_grant");
    assert_eq!(
        harness.me_status(&token(&tokens, "access_token")).await,
        StatusCode::UNAUTHORIZED
    );
    let (status, body) = harness
        .refresh(DESKTOP, &token(&tokens, "refresh_token"))
        .await;
    assert_oauth_error(status, &body, StatusCode::BAD_REQUEST, "invalid_grant");
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn reusing_a_rotated_refresh_token_revokes_the_sign_in() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let first = harness.signed_in(&account, DESKTOP, LOOPBACK).await;
    let (status, second) = harness
        .refresh(DESKTOP, &token(&first, "refresh_token"))
        .await;
    assert_eq!(status, StatusCode::OK);
    // The rotated token is presented again, as a thief holding a copy would.
    let (status, body) = harness
        .refresh(DESKTOP, &token(&first, "refresh_token"))
        .await;
    assert_oauth_error(status, &body, StatusCode::BAD_REQUEST, "invalid_grant");
    // The legitimate holder's newer tokens stop working too.
    let (status, body) = harness
        .refresh(DESKTOP, &token(&second, "refresh_token"))
        .await;
    assert_oauth_error(status, &body, StatusCode::BAD_REQUEST, "invalid_grant");
    for access in [
        token(&first, "access_token"),
        token(&second, "access_token"),
    ] {
        assert_eq!(harness.me_status(&access).await, StatusCode::UNAUTHORIZED);
    }
    let reason: (Option<String>,) =
        query_as("SELECT revoked_reason FROM cloud_app_sign_ins WHERE sign_in_id = $1")
            .bind(token(&first, "sign_in_id"))
            .fetch_one(&harness.pool)
            .await
            .unwrap();
    assert_eq!(reason.0.as_deref(), Some("refresh_token_reuse"));
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn refresh_is_refused_for_another_client_expiry_or_a_revoked_device() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let tokens = harness.signed_in(&account, DESKTOP, LOOPBACK).await;
    let refresh_token = token(&tokens, "refresh_token");
    let (status, body) = harness.refresh(IOS, &refresh_token).await;
    assert_oauth_error(status, &body, StatusCode::BAD_REQUEST, "invalid_grant");
    let (status, body) = harness.refresh("unknown-app", &refresh_token).await;
    assert_oauth_error(status, &body, StatusCode::UNAUTHORIZED, "invalid_client");
    let (status, body) = harness.refresh(DESKTOP, "kordi_rt_unknown").await;
    assert_oauth_error(status, &body, StatusCode::BAD_REQUEST, "invalid_grant");

    // An expired refresh token is refused but does not count as reuse.
    query("UPDATE cloud_app_refresh_tokens SET expires_at = $1 WHERE token_hash = $2")
        .bind(Utc::now() - ChronoDuration::seconds(1))
        .bind(crate::auth::app_sign_in::codes::hash_code(&refresh_token))
        .execute(&harness.pool)
        .await
        .unwrap();
    let (status, body) = harness.refresh(DESKTOP, &refresh_token).await;
    assert_oauth_error(status, &body, StatusCode::BAD_REQUEST, "invalid_grant");

    // A revoked device, as the existing devices API leaves it, ends the
    // sign-in on its next refresh.
    let other = harness.signed_in(&account, DESKTOP, LOOPBACK).await;
    query("UPDATE cloud_devices SET revoked_at = $1 WHERE device_id = $2")
        .bind(Utc::now().to_rfc3339())
        .bind(token(&other, "device_id"))
        .execute(&harness.pool)
        .await
        .unwrap();
    assert_eq!(
        harness.me_status(&token(&other, "access_token")).await,
        StatusCode::UNAUTHORIZED
    );
    let (status, body) = harness
        .refresh(DESKTOP, &token(&other, "refresh_token"))
        .await;
    assert_oauth_error(status, &body, StatusCode::BAD_REQUEST, "invalid_grant");
    let reason: (Option<String>,) =
        query_as("SELECT revoked_reason FROM cloud_app_sign_ins WHERE sign_in_id = $1")
            .bind(token(&other, "sign_in_id"))
            .fetch_one(&harness.pool)
            .await
            .unwrap();
    assert_eq!(reason.0.as_deref(), Some("device_revoked"));
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn sign_ins_are_revoked_only_by_their_account() {
    let harness = harness().await;
    let owner = harness.web_account().await;
    let stranger = harness.web_account().await;
    let tokens = harness
        .signed_in(&owner, IOS, "kordi://auth/callback")
        .await;
    let sign_in = format!(
        "/v1/cloud/auth/app/sign-ins/{}",
        token(&tokens, "sign_in_id")
    );
    let (status, _, _) = harness
        .send("DELETE", &sign_in, Some(&stranger.web_token), None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // A revocation request from another client is accepted but ignored.
    let (status, _) = harness
        .form(
            "/v1/cloud/auth/app/revoke",
            &[
                ("client_id", DESKTOP),
                ("token", &token(&tokens, "refresh_token")),
            ],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let access = token(&tokens, "access_token");
    assert_eq!(harness.me_status(&access).await, StatusCode::OK);

    let (status, _, _) = harness
        .send("DELETE", &sign_in, Some(&owner.web_token), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(harness.me_status(&access).await, StatusCode::UNAUTHORIZED);
    let (status, list, _) = harness
        .send(
            "GET",
            "/v1/cloud/auth/app/sign-ins",
            Some(&owner.web_token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list["signIns"].as_array().unwrap().len(), 0);
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn logout_with_an_app_access_token_ends_the_sign_in() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let tokens = harness.signed_in(&account, DESKTOP, LOOPBACK).await;
    let (status, _, _) = harness
        .send(
            "POST",
            "/v1/cloud/auth/logout",
            Some(&token(&tokens, "access_token")),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = harness
        .refresh(DESKTOP, &token(&tokens, "refresh_token"))
        .await;
    assert_oauth_error(status, &body, StatusCode::BAD_REQUEST, "invalid_grant");
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn token_requests_are_validated_and_rate_limited() {
    let harness = harness().await;
    let (status, body) = harness
        .form(
            "/v1/cloud/auth/app/token",
            &[("grant_type", "password"), ("client_id", DESKTOP)],
        )
        .await;
    assert_oauth_error(
        status,
        &body,
        StatusCode::BAD_REQUEST,
        "unsupported_grant_type",
    );
    let (status, body) = harness
        .form(
            "/v1/cloud/auth/app/token",
            &[
                ("grant_type", "refresh_token"),
                ("client_id", DESKTOP),
                ("client_id", IOS),
            ],
        )
        .await;
    assert_oauth_error(status, &body, StatusCode::BAD_REQUEST, "invalid_request");
    let (status, body) = harness
        .form(
            "/v1/cloud/auth/app/token",
            &[("grant_type", "authorization_code"), ("client_id", DESKTOP)],
        )
        .await;
    assert_oauth_error(status, &body, StatusCode::BAD_REQUEST, "invalid_request");

    let limited = harness_with_limit(2).await;
    let mut statuses = Vec::new();
    for _ in 0..3 {
        statuses.push(limited.refresh(DESKTOP, "kordi_rt_unknown").await.0);
    }
    assert_eq!(statuses.last(), Some(&StatusCode::TOO_MANY_REQUESTS));
}
