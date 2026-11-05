//! Overview, cookie and bearer access, and session sign-outs.

use super::*;

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn overview_lists_email_password_providers_and_sessions() {
    let harness = harness().await;
    let account = harness.account(Some(&strong_password()), true).await;
    harness
        .link(&account.account_id, "google", &account.email)
        .await;
    let mac = harness
        .device(
            &account.account_id,
            "Studio Mac",
            Some("macos"),
            "confirmed",
        )
        .await;
    let (sign_in_id, access_token) = harness.app_sign_in(&account.account_id, &mac).await;

    let body = harness.overview(Auth::Web(&account.token)).await;
    assert_eq!(body["email"]["address"], account.email);
    assert_eq!(body["email"]["verified"], true);
    assert_eq!(body["password"]["set"], true);
    assert_eq!(body["providers"][0]["provider"], "google");
    assert_eq!(body["providers"][0]["email"], account.email);
    assert_eq!(body["canManageOtherSessions"], true);
    assert_eq!(body["recentSignIn"], true);
    let sessions = body["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2, "{body}");
    assert_eq!(sessions[0]["id"], account.token_id);
    assert_eq!(sessions[0]["current"], true);
    assert_eq!(sessions[0]["kind"], "web");
    assert_eq!(sessions[1]["id"], sign_in_id);
    assert_eq!(sessions[1]["kind"], "app");
    assert_eq!(sessions[1]["clientId"], "kordi-desktop");
    assert_eq!(sessions[1]["deviceName"], "Studio Mac");
    assert_eq!(sessions[1]["platform"], "macos");
    assert_eq!(sessions[1]["current"], false);
    assert!(sessions[1]["appName"].is_string());
    assert!(sessions[1]["lastUsedAt"].is_string());

    // The app reads the same page with its bearer token; its sign-in is
    // the current one there.
    let body = harness.overview(Auth::Bearer(&access_token)).await;
    let current: Vec<&Value> = body["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|session| session["current"] == true)
        .collect();
    assert_eq!(current.len(), 1);
    assert_eq!(current[0]["id"], sign_in_id);
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn cookie_writes_need_exact_origin_and_csrf() {
    let harness = harness().await;
    let account = harness.account(Some(&strong_password()), true).await;
    let path = "/sessions/revoke-others";

    let (status, body) = harness
        .post(path, Auth::WebWithoutCsrf(&account.token), json!({}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "csrf_token_invalid");
    let (status, body) = harness
        .post(path, Auth::WebFromOtherOrigin(&account.token), json!({}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "origin_mismatch");
    let (status, _) = harness.post(path, Auth::None, json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "no Origin, no cookie");
    let (status, _) = harness.send("GET", BASE, Auth::None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = harness
        .send(
            "DELETE",
            &format!("{BASE}/providers/google"),
            Auth::WebWithoutCsrf(&account.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // An app's access token never works as a cookie.
    let mac = harness
        .device(&account.account_id, "Mac", Some("macos"), "confirmed")
        .await;
    let (_, access_token) = harness.app_sign_in(&account.account_id, &mac).await;
    let (status, body) = harness
        .send("GET", BASE, Auth::Web(&access_token), None)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "web_session_required");
    assert_eq!(
        harness
            .audit_count(&account.account_id, "account.sessions.revoked_others")
            .await,
        0
    );
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn the_current_session_is_never_signed_out_here() {
    let harness = harness().await;
    let account = harness.account(Some(&strong_password()), true).await;
    let (status, body) = harness
        .post(
            &format!("/sessions/{}/revoke", account.token_id),
            Auth::Web(&account.token),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), "cannot_revoke_current_session");

    let mac = harness
        .device(&account.account_id, "Mac", Some("macos"), "confirmed")
        .await;
    let (sign_in_id, access_token) = harness.app_sign_in(&account.account_id, &mac).await;
    let (status, body) = harness
        .post(
            &format!("/sessions/{sign_in_id}/revoke"),
            Auth::Bearer(&access_token),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), "cannot_revoke_current_session");
    assert_eq!(harness.me_status(&access_token).await, StatusCode::OK);
    assert_eq!(harness.me_status(&account.token).await, StatusCode::OK);
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn signing_out_one_session_ends_only_that_session() {
    let harness = harness().await;
    let account = harness.account(Some(&strong_password()), true).await;
    let other = harness.account(Some(&strong_password()), true).await;
    let phone = harness
        .device(&account.account_id, "Phone", Some("ios"), "confirmed")
        .await;
    let (phone_token, phone_token_id) = harness.session(&account.account_id, &phone).await;
    let mac = harness
        .device(&account.account_id, "Mac", Some("macos"), "confirmed")
        .await;
    let (sign_in_id, access_token) = harness.app_sign_in(&account.account_id, &mac).await;

    let (status, _) = harness
        .post(
            &format!("/sessions/{phone_token_id}/revoke"),
            Auth::Web(&account.token),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        harness.me_status(&phone_token).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(harness.me_status(&access_token).await, StatusCode::OK);

    let (status, _) = harness
        .post(
            &format!("/sessions/{sign_in_id}/revoke"),
            Auth::Web(&account.token),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        harness.me_status(&access_token).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(harness.me_status(&account.token).await, StatusCode::OK);

    // Already ended, unknown, or another account's: not found.
    for id in [
        phone_token_id.as_str(),
        "cs_unknown",
        "nothing",
        other.token_id.as_str(),
    ] {
        let (status, body) = harness
            .post(
                &format!("/sessions/{id}/revoke"),
                Auth::Web(&account.token),
                json!({}),
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{id}");
        assert_eq!(error_code(&body), "session_not_found");
    }
    assert_eq!(harness.me_status(&other.token).await, StatusCode::OK);
    assert_eq!(
        harness
            .audit_count(&account.account_id, "account.session.revoked")
            .await,
        2
    );
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn a_device_under_review_cannot_sign_out_other_devices() {
    let harness = harness().await;
    let account = harness.account(Some(&strong_password()), true).await;
    let mac = harness
        .device(&account.account_id, "Mac", Some("macos"), "confirmed")
        .await;
    let (mac_token, mac_token_id) = harness.session(&account.account_id, &mac).await;
    query("UPDATE cloud_devices SET authorization_state = 'pending_review', confirmed_at = NULL WHERE device_id = $1")
        .bind(&account.device_id)
        .execute(&harness.pool)
        .await
        .unwrap();
    let (second_token, second_token_id) = harness
        .session(&account.account_id, &account.device_id)
        .await;

    let body = harness.overview(Auth::Web(&account.token)).await;
    assert_eq!(body["canManageOtherSessions"], false);
    let (status, body) = harness
        .post(
            "/sessions/revoke-others",
            Auth::Web(&account.token),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "device_review_required");
    let (status, _) = harness
        .post(
            &format!("/sessions/{mac_token_id}/revoke"),
            Auth::Web(&account.token),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(harness.me_status(&mac_token).await, StatusCode::OK);

    // Another session on this same device may still be signed out.
    let (status, _) = harness
        .post(
            &format!("/sessions/{second_token_id}/revoke"),
            Auth::Web(&account.token),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        harness.me_status(&second_token).await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn signing_out_other_devices_keeps_only_the_current_session() {
    let harness = harness().await;
    let account = harness.account(Some(&strong_password()), true).await;
    let mac = harness
        .device(&account.account_id, "Mac", Some("macos"), "confirmed")
        .await;
    let (mac_token, _) = harness.session(&account.account_id, &mac).await;
    let (sign_in_id, access_token) = harness.app_sign_in(&account.account_id, &mac).await;
    let (same_device_token, _) = harness
        .session(&account.account_id, &account.device_id)
        .await;

    let (status, body) = harness
        .post(
            "/sessions/revoke-others",
            Auth::Web(&account.token),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["revokedDevices"], 1);
    assert_eq!(body["revokedSessions"], 1, "the same-device session");
    for token in [&mac_token, &access_token, &same_device_token] {
        assert_eq!(harness.me_status(token).await, StatusCode::UNAUTHORIZED);
    }
    assert_eq!(harness.me_status(&account.token).await, StatusCode::OK);
    let (reason,): (Option<String>,) =
        query_as("SELECT revoked_reason FROM cloud_app_sign_ins WHERE sign_in_id = $1")
            .bind(&sign_in_id)
            .fetch_one(&harness.pool)
            .await
            .unwrap();
    assert_eq!(reason.as_deref(), Some("device_revoked"));
    let (revoked,): (bool,) =
        query_as("SELECT revoked_at IS NOT NULL FROM cloud_devices WHERE device_id = $1")
            .bind(&mac)
            .fetch_one(&harness.pool)
            .await
            .unwrap();
    assert!(revoked);
    let body = harness.overview(Auth::Web(&account.token)).await;
    assert_eq!(body["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(
        harness
            .audit_count(&account.account_id, "account.sessions.revoked_others")
            .await,
        1
    );
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn changes_are_limited_per_account() {
    let harness = harness().await;
    let account = harness.account(Some(&strong_password()), true).await;
    let mut limited = false;
    for _ in 0..31 {
        let (status, _) = harness
            .send(
                "DELETE",
                &format!("{BASE}/providers/github"),
                Auth::Web(&account.token),
                None,
            )
            .await;
        if status == StatusCode::TOO_MANY_REQUESTS {
            limited = true;
            break;
        }
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
    assert!(limited, "the 31st change in an hour is refused");
}
