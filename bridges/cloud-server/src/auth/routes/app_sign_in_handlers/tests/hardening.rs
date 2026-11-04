//! User approval for redirect codes, device revocation that survives
//! re-authorization, and the separate limit for refreshes.

use super::*;

fn device_key(seed: u8) -> String {
    let secret = p256::SecretKey::from_slice(&[seed; 32]).unwrap();
    URL_SAFE_NO_PAD.encode(secret.public_key().to_sec1_bytes())
}

/// Sign in on a device with a fixed key, as the app does after the user
/// approved it on the page.
async fn signed_in_with_key(harness: &Harness, account: &WebAccount, key: &str) -> Value {
    let pkce = pkce();
    let code = harness
        .code(&account.web_token, DESKTOP, LOOPBACK, &pkce)
        .await;
    let (status, body) = harness
        .form(
            "/v1/cloud/auth/app/token",
            &[
                ("grant_type", "authorization_code"),
                ("client_id", DESKTOP),
                ("code", &code),
                ("redirect_uri", LOOPBACK),
                ("code_verifier", &pkce.verifier),
                ("device_public_key", key),
                ("device_key_algorithm", "p256"),
                ("device_name", "Synthetic Mac"),
            ],
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

async fn revoked_reason(harness: &Harness, sign_in_id: &str) -> Option<String> {
    let row: (Option<String>,) =
        query_as("SELECT revoked_reason FROM cloud_app_sign_ins WHERE sign_in_id = $1")
            .bind(sign_in_id)
            .fetch_one(&harness.pool)
            .await
            .unwrap();
    row.0
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn redirect_codes_need_the_users_approval() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let pkce = pkce();
    for approved in [None, Some(Value::Bool(false)), Some(Value::from("true"))] {
        let mut body = authorize_body(DESKTOP, LOOPBACK, &pkce.challenge);
        match approved {
            Some(value) => body["approved"] = value,
            None => {
                body.as_object_mut().unwrap().remove("approved");
            }
        }
        let (status, body) = harness
            .web("/v1/cloud/auth/app/authorize", &account.web_token, body)
            .await;
        if status == StatusCode::BAD_REQUEST {
            assert_eq!(body["errorCode"], "approval_required", "{body}");
            assert!(body.get("redirectUrl").is_none());
        } else {
            // A non-boolean value is not a valid body at all.
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        }
    }
    let codes: (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_app_authorization_codes WHERE account_id = $1")
            .bind(&account.account_id)
            .fetch_one(&harness.pool)
            .await
            .unwrap();
    assert_eq!(codes.0, 0);
    // With the approval the page gets the redirect.
    harness
        .code(&account.web_token, DESKTOP, LOOPBACK, &pkce)
        .await;
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn revoking_a_device_ends_its_sign_ins_for_good() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let key = device_key(21);
    let first = signed_in_with_key(&harness, &account, &key).await;
    let device_id = token(&first, "device_id");

    let (status, body) = harness
        .json(
            "DELETE",
            &format!("/v1/cloud/auth/devices/{device_id}"),
            Some(&account.web_token),
            serde_json::json!({ "clientOperationId": uuid::Uuid::new_v4() }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        revoked_reason(&harness, &token(&first, "sign_in_id"))
            .await
            .as_deref(),
        Some("device_revoked")
    );

    // The same device key signs in again, which re-authorizes the device.
    let second = signed_in_with_key(&harness, &account, &key).await;
    assert_eq!(token(&second, "device_id"), device_id);
    let (status, body) = harness
        .refresh(DESKTOP, &token(&first, "refresh_token"))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"], "invalid_grant");
    assert_eq!(
        harness.me_status(&token(&first, "access_token")).await,
        StatusCode::UNAUTHORIZED
    );
    let (status, body) = harness
        .refresh(DESKTOP, &token(&second, "refresh_token"))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn sign_ins_from_before_any_device_revocation_stay_ended() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let key = device_key(22);
    let first = signed_in_with_key(&harness, &account, &key).await;
    // A revocation that does not go through the devices API still counts.
    query("UPDATE cloud_devices SET revoked_at = $1 WHERE device_id = $2")
        .bind(Utc::now().to_rfc3339())
        .bind(token(&first, "device_id"))
        .execute(&harness.pool)
        .await
        .unwrap();
    let second = signed_in_with_key(&harness, &account, &key).await;
    assert_eq!(token(&second, "device_id"), token(&first, "device_id"));
    let (status, body) = harness
        .refresh(DESKTOP, &token(&first, "refresh_token"))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        revoked_reason(&harness, &token(&first, "sign_in_id"))
            .await
            .as_deref(),
        Some("device_revoked")
    );
    let (status, body) = harness
        .refresh(DESKTOP, &token(&second, "refresh_token"))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn refresh_and_revoke_do_not_spend_the_sign_in_address_limit() {
    let limited = harness_with_limit(2).await;
    for _ in 0..4 {
        let (status, body) = limited.refresh(DESKTOP, "kordi_rt_unknown").await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let (status, body) = limited
            .form(
                "/v1/cloud/auth/app/revoke",
                &[("client_id", DESKTOP), ("token", "kordi_rt_unknown")],
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    // Sign-in requests still have the per-address limit.
    let mut last = StatusCode::OK;
    for _ in 0..3 {
        last = limited
            .exchange(DESKTOP, "unknown-code", LOOPBACK, "verifier")
            .await
            .0;
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
}
