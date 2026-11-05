//! Setting and changing the password.

use super::*;

async fn login_status(harness: &Harness, email: &str, password: &str) -> StatusCode {
    harness
        .send(
            "POST",
            "/v1/cloud/auth/login",
            Auth::None,
            Some(json!({ "email": email, "password": password })),
        )
        .await
        .0
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn the_password_rule_applies() {
    let harness = harness().await;
    let current = strong_password();
    let account = harness.account(Some(&current), true).await;
    for weak in [
        "short1A",
        "alllowercase123",
        "ALLUPPERCASE123",
        "NoDigitsHere",
    ] {
        let (status, body) = harness
            .post(
                "/password",
                Auth::Web(&account.token),
                json!({ "newPassword": weak, "currentPassword": current }),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{weak}");
        assert_eq!(error_code(&body), "weak_password");
    }
    assert_eq!(
        login_status(&harness, &account.email, &current).await,
        StatusCode::OK
    );
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn changing_the_password_needs_the_current_one_and_ends_other_sessions() {
    let harness = harness().await;
    let current = strong_password();
    let account = harness.account(Some(&current), true).await;
    let mac = harness
        .device(&account.account_id, "Mac", Some("macos"), "confirmed")
        .await;
    let (mac_token, _) = harness.session(&account.account_id, &mac).await;
    let (_, access_token) = harness.app_sign_in(&account.account_id, &mac).await;
    let next = strong_password();

    let (status, body) = harness
        .post(
            "/password",
            Auth::Web(&account.token),
            json!({ "newPassword": next }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "current_password_required");
    let (status, body) = harness
        .post(
            "/password",
            Auth::Web(&account.token),
            json!({ "newPassword": next, "currentPassword": strong_password() }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "invalid_current_password");
    assert_eq!(
        harness
            .audit_count(
                &account.account_id,
                "account.security.password_check_failed"
            )
            .await,
        1
    );
    assert_eq!(harness.me_status(&mac_token).await, StatusCode::OK);

    let (status, body) = harness
        .post(
            "/password",
            Auth::Web(&account.token),
            json!({ "newPassword": next, "currentPassword": current }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["password"]["set"], true);
    assert_eq!(body["revokedSessions"], 2);
    assert_eq!(
        harness.me_status(&mac_token).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        harness.me_status(&access_token).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(harness.me_status(&account.token).await, StatusCode::OK);
    assert_eq!(
        login_status(&harness, &account.email, &current).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        login_status(&harness, &account.email, &next).await,
        StatusCode::OK
    );
    assert_eq!(
        harness
            .audit_count(&account.account_id, "account.password_changed")
            .await,
        1
    );
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn a_first_password_after_a_recent_sign_in_needs_no_code() {
    let harness = harness().await;
    let account = harness.account(None, true).await;
    let mac = harness
        .device(&account.account_id, "Mac", Some("macos"), "confirmed")
        .await;
    let (mac_token, _) = harness.session(&account.account_id, &mac).await;
    let password = strong_password();
    let (status, body) = harness
        .post(
            "/password",
            Auth::Web(&account.token),
            json!({ "newPassword": password }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["revokedSessions"], 0, "setting a first password");
    assert_eq!(harness.me_status(&mac_token).await, StatusCode::OK);
    assert_eq!(
        login_status(&harness, &account.email, &password).await,
        StatusCode::OK
    );
    assert_eq!(
        harness
            .audit_count(&account.account_id, "account.password_set")
            .await,
        1
    );
    let body = harness.overview(Auth::Web(&account.token)).await;
    assert_eq!(body["password"]["set"], true);
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn a_first_password_after_an_old_sign_in_needs_an_emailed_code() {
    let harness = harness().await;
    let account = harness.account(None, false).await;
    harness.age_session(&account.token_id, 30).await;
    let password = strong_password();

    let (status, body) = harness
        .post(
            "/password",
            Auth::Web(&account.token),
            json!({ "newPassword": password }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "reauthentication_required");
    assert_eq!(
        harness.overview(Auth::Web(&account.token)).await["recentSignIn"],
        false
    );

    let (status, challenge) = harness
        .post("/password/code", Auth::Web(&account.token), json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{challenge}");
    let sent = harness.sent_codes();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, account.email);
    let verification_id = challenge["verificationId"].as_str().unwrap();
    let wrong = if sent[0].1 == "000000" {
        "111111"
    } else {
        "000000"
    };
    let (status, body) = harness
        .post(
            "/password",
            Auth::Web(&account.token),
            json!({
                "newPassword": password,
                "verificationId": verification_id,
                "verificationCode": wrong,
            }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), "invalid_verification_code");
    let (status, body) = harness
        .post(
            "/password",
            Auth::Web(&account.token),
            json!({
                "newPassword": password,
                "verificationId": verification_id,
                "verificationCode": sent[0].1,
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let body = harness.overview(Auth::Web(&account.token)).await;
    assert_eq!(body["email"]["verified"], true, "the code proved the inbox");
    assert_eq!(
        login_status(&harness, &account.email, &password).await,
        StatusCode::OK
    );

    // With a password, the code route is closed.
    let (status, body) = harness
        .post("/password/code", Auth::Web(&account.token), json!({}))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), "current_password_required");
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn an_app_sign_in_counts_from_when_it_started() {
    let harness = harness().await;
    let account = harness.account(None, true).await;
    let mac = harness
        .device(&account.account_id, "Mac", Some("macos"), "confirmed")
        .await;
    let (sign_in_id, access_token) = harness.app_sign_in(&account.account_id, &mac).await;
    // The access token is new, but the sign-in started an hour ago.
    query("UPDATE cloud_app_sign_ins SET created_at = now() - INTERVAL '1 hour' WHERE sign_in_id = $1")
        .bind(&sign_in_id)
        .execute(&harness.pool)
        .await
        .unwrap();
    let (status, body) = harness
        .post(
            "/password",
            Auth::Bearer(&access_token),
            json!({ "newPassword": strong_password() }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "reauthentication_required");
}
