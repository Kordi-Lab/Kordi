//! Device code sign-in (RFC 8628) against a disposable database.

use super::*;
use crate::auth::device_code::DEVICE_CODE_GRANT_TYPE;

const DEVICE_NAME: &str = "Build Mac mini";

fn device_key() -> String {
    let secret = p256::SecretKey::from_slice(&[11_u8; 32]).unwrap();
    URL_SAFE_NO_PAD.encode(secret.public_key().to_sec1_bytes())
}

impl Harness {
    async fn request_code(&self, client_id: &str) -> (StatusCode, Value) {
        let key = device_key();
        self.form(
            "/v1/cloud/auth/device/code",
            &[
                ("client_id", client_id),
                ("device_name", DEVICE_NAME),
                ("device_platform", "macOS"),
                ("device_os_version", "26.1"),
                ("device_app_version", "0.0.2"),
                ("device_public_key", &key),
                ("device_key_algorithm", "p256"),
            ],
        )
        .await
    }

    async fn device_code(&self) -> (String, String) {
        let (status, body) = self.request_code(DESKTOP).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        (token(&body, "device_code"), token(&body, "user_code"))
    }

    async fn poll(&self, device_code: &str) -> (StatusCode, Value) {
        self.form(
            "/v1/cloud/auth/device/token",
            &[
                ("grant_type", DEVICE_CODE_GRANT_TYPE),
                ("client_id", DESKTOP),
                ("device_code", device_code),
            ],
        )
        .await
    }

    /// Poll as a device that waited its interval: clear the last poll time.
    async fn poll_later(&self, device_code: &str) -> (StatusCode, Value) {
        query("UPDATE cloud_device_authorizations SET last_polled_at = NULL WHERE device_code_hash = $1")
            .bind(crate::auth::app_sign_in::codes::hash_code(device_code))
            .execute(&self.pool)
            .await
            .unwrap();
        self.poll(device_code).await
    }

    async fn decide(
        &self,
        web_token: &str,
        user_code: &str,
        decision: &str,
    ) -> (StatusCode, Value) {
        self.web(
            "/v1/cloud/auth/device/decision",
            web_token,
            serde_json::json!({ "userCode": user_code, "decision": decision }),
        )
        .await
    }

    /// A configured team organization with `account_id` as a member.
    async fn configured_organization(&self, account_id: &str, setting: Option<bool>) -> String {
        let organization_id = format!("org_{}", uuid::Uuid::new_v4().simple());
        query(
            "INSERT INTO cloud_organizations \
             (organization_id, name, kind, config_id, device_code_sign_in) \
             VALUES ($1, 'Example Lab', 'team', $1, $2)",
        )
        .bind(&organization_id)
        .bind(setting)
        .execute(&self.pool)
        .await
        .unwrap();
        query(
            "INSERT INTO cloud_organization_members (organization_id, account_id, role) \
             VALUES ($1, $2, 'member')",
        )
        .bind(&organization_id)
        .bind(account_id)
        .execute(&self.pool)
        .await
        .unwrap();
        organization_id
    }
}

fn assert_poll_error(status: StatusCode, body: &Value, error: &str) {
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"], error, "{body}");
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn device_code_end_to_end() {
    let harness = harness().await;
    let account = harness.web_account().await;

    let (status, issued) = harness.request_code(DESKTOP).await;
    assert_eq!(status, StatusCode::OK, "{issued}");
    assert_eq!(issued["expires_in"], 900);
    assert_eq!(issued["interval"], 5);
    assert!(issued["verification_uri"]
        .as_str()
        .unwrap()
        .ends_with("/device"));
    let device_code = token(&issued, "device_code");
    let user_code = token(&issued, "user_code");
    assert_eq!(user_code.len(), 9);
    assert_eq!(&user_code[4..5], "-");

    // Only hashes are stored.
    let (device_hash, user_hash): (String, String) = query_as(
        "SELECT device_code_hash, user_code_hash FROM cloud_device_authorizations \
         WHERE device_code_hash = $1",
    )
    .bind(crate::auth::app_sign_in::codes::hash_code(&device_code))
    .fetch_one(&harness.pool)
    .await
    .unwrap();
    assert_ne!(device_hash, device_code);
    assert_eq!(
        user_hash,
        crate::auth::app_sign_in::codes::hash_code(&user_code.replace('-', ""))
    );
    let plaintext: (i64,) = query_as(
        "SELECT count(*) FROM cloud_device_authorizations t \
         WHERE to_jsonb(t)::text LIKE '%' || $1 || '%' OR to_jsonb(t)::text LIKE '%' || $2 || '%'",
    )
    .bind(&device_code)
    .bind(user_code.replace('-', ""))
    .fetch_one(&harness.pool)
    .await
    .unwrap();
    assert_eq!(plaintext.0, 0);

    // Waiting, then polling too fast.
    let (status, body) = harness.poll(&device_code).await;
    assert_poll_error(status, &body, "authorization_pending");
    let (status, body) = harness.poll(&device_code).await;
    assert_poll_error(status, &body, "slow_down");
    assert_eq!(body["interval"], 10);

    // The approval page shows the device and the warning; codes are typed
    // in any case.
    let (status, details) = harness
        .web(
            "/v1/cloud/auth/device/lookup",
            &account.web_token,
            serde_json::json!({ "userCode": user_code.to_lowercase() }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{details}");
    assert_eq!(details["deviceName"], DEVICE_NAME);
    assert_eq!(details["platform"], "macos");
    assert_eq!(details["osVersion"], "26.1");
    assert_eq!(details["appName"], "Kordi for Mac");
    assert_eq!(
        details["warning"],
        "Only continue if you started this sign-in yourself. Never enter a code someone sent you."
    );
    assert!(details["requestedAt"].as_str().is_some());

    let (status, body) = harness
        .decide(&account.web_token, &user_code, "approve")
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "approved");

    // The next poll receives the same token response as browser sign-in.
    let (status, tokens) = harness.poll(&device_code).await;
    assert_eq!(status, StatusCode::OK, "{tokens}");
    assert_eq!(tokens["token_type"], "Bearer");
    assert_eq!(tokens["account"]["accountId"], account.account_id);
    let access = token(&tokens, "access_token");
    assert!(access.starts_with(SESSION_TOKEN_PREFIX));
    assert!(token(&tokens, "refresh_token").starts_with("kordi_rt_"));
    assert_eq!(harness.me_status(&access).await, StatusCode::OK);

    // It is a normal device session: listed with the reported name and
    // refreshed through the ordinary token endpoint.
    let (status, devices, _) = harness
        .send("GET", "/v1/cloud/auth/devices", Some(&access), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{devices}");
    let listed = devices.to_string();
    assert!(listed.contains(DEVICE_NAME), "{listed}");
    let (status, refreshed) = harness
        .refresh(DESKTOP, &token(&tokens, "refresh_token"))
        .await;
    assert_eq!(status, StatusCode::OK, "{refreshed}");
    let access = token(&refreshed, "access_token");

    // A second redemption fails and revokes the sign-in it started.
    let (status, body) = harness.poll_later(&device_code).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"], "invalid_grant");
    assert_eq!(harness.me_status(&access).await, StatusCode::UNAUTHORIZED);

    // The code no longer resolves on the page.
    let (status, _) = harness
        .web(
            "/v1/cloud/auth/device/lookup",
            &account.web_token,
            serde_json::json!({ "userCode": user_code }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn denied_and_expired_codes() {
    let harness = harness().await;
    let account = harness.web_account().await;

    let (device_code, user_code) = harness.device_code().await;
    let (status, _) = harness.decide(&account.web_token, &user_code, "deny").await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = harness.poll(&device_code).await;
    assert_poll_error(status, &body, "access_denied");
    assert_eq!(body["reason"], "user_denied");
    // A decided code cannot be decided again.
    let (status, _) = harness
        .decide(&account.web_token, &user_code, "approve")
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (device_code, user_code) = harness.device_code().await;
    query(
        "UPDATE cloud_device_authorizations SET expires_at = now() - interval '1 second' \
         WHERE device_code_hash = $1",
    )
    .bind(crate::auth::app_sign_in::codes::hash_code(&device_code))
    .execute(&harness.pool)
    .await
    .unwrap();
    let (status, body) = harness.poll(&device_code).await;
    assert_poll_error(status, &body, "expired_token");
    let (status, _) = harness
        .decide(&account.web_token, &user_code, "approve")
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Unknown codes, other apps and other grants.
    let (status, body) = harness.poll("kordi_dc_unknown").await;
    assert_poll_error(status, &body, "invalid_grant");
    let (device_code, _) = harness.device_code().await;
    let (status, body) = harness
        .form(
            "/v1/cloud/auth/device/token",
            &[
                ("grant_type", DEVICE_CODE_GRANT_TYPE),
                ("client_id", "kordi-desktop-beta"),
                ("device_code", &device_code),
            ],
        )
        .await;
    assert_poll_error(status, &body, "invalid_grant");
    let (status, body) = harness
        .form(
            "/v1/cloud/auth/device/token",
            &[
                ("grant_type", "authorization_code"),
                ("client_id", DESKTOP),
                ("device_code", &device_code),
            ],
        )
        .await;
    assert_poll_error(status, &body, "unsupported_grant_type");
    let (status, body) = harness.request_code(IOS).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"], "invalid_client");
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn approval_page_requires_the_web_session() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let (_, user_code) = harness.device_code().await;
    let body = serde_json::json!({ "userCode": user_code, "decision": "approve" });

    // No cookie, a foreign origin, or a missing CSRF header all fail.
    let (status, _) = harness
        .json("POST", "/v1/cloud/auth/device/decision", None, body.clone())
        .await;
    assert!(status.is_client_error());
    let mut headers = web_headers(&account.web_token);
    headers.retain(|(name, _)| !name.eq_ignore_ascii_case("x-kordi-csrf-token"));
    let (status, _, _) = harness
        .send_with(
            "POST",
            "/v1/cloud/auth/device/decision",
            headers,
            Some(("application/json", body.to_string())),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // An app access token is not a web session.
    let app = harness.signed_in(&account, DESKTOP, LOOPBACK).await;
    let (status, _) = harness
        .web(
            "/v1/cloud/auth/device/decision",
            &token(&app, "access_token"),
            body,
        )
        .await;
    assert!(status.is_client_error());
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn organization_setting_blocks_device_sign_in() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let organization_id = harness
        .configured_organization(&account.account_id, None)
        .await;

    // A configured organization is off by default.
    let (device_code, user_code) = harness.device_code().await;
    let (status, body) = harness
        .decide(&account.web_token, &user_code, "approve")
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"], "device_code_not_allowed");
    assert!(body["message"].as_str().unwrap().contains("Example Lab"));
    let (status, body) = harness.poll(&device_code).await;
    assert_poll_error(status, &body, "access_denied");
    assert_eq!(body["reason"], "organization_policy");

    // An admin turns it on.
    query("UPDATE cloud_organizations SET device_code_sign_in = true WHERE organization_id = $1")
        .bind(&organization_id)
        .execute(&harness.pool)
        .await
        .unwrap();
    let (device_code, user_code) = harness.device_code().await;
    let (status, body) = harness
        .decide(&account.web_token, &user_code, "approve")
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Turned off again before the device polls: the poll is refused.
    query("UPDATE cloud_organizations SET device_code_sign_in = false WHERE organization_id = $1")
        .bind(&organization_id)
        .execute(&harness.pool)
        .await
        .unwrap();
    let (status, body) = harness.poll(&device_code).await;
    assert_poll_error(status, &body, "access_denied");
    assert_eq!(body["reason"], "organization_policy");
    let (sessions,): (i64,) =
        query_as("SELECT count(*) FROM cloud_app_sign_ins WHERE account_id = $1")
            .bind(&account.account_id)
            .fetch_one(&harness.pool)
            .await
            .unwrap();
    assert_eq!(sessions, 0);
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn personal_and_self_made_teams_allow_device_sign_in_by_default() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let blocked = |pool: PgPool, account_id: String| async move {
        crate::organizations::device_code_sign_in_blocked_by(&pool, &account_id)
            .await
            .unwrap()
    };
    assert_eq!(
        blocked(harness.pool.clone(), account.account_id.clone()).await,
        None
    );
    let team = format!("org_{}", uuid::Uuid::new_v4().simple());
    query("INSERT INTO cloud_organizations (organization_id, name, kind) VALUES ($1, 'Side project', 'team')")
        .bind(&team)
        .execute(&harness.pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_organization_members (organization_id, account_id, role) VALUES ($1, $2, 'owner')")
        .bind(&team)
        .bind(&account.account_id)
        .execute(&harness.pool)
        .await
        .unwrap();
    assert_eq!(
        blocked(harness.pool.clone(), account.account_id.clone()).await,
        None
    );
    // Any organization can turn it off, including a personal one.
    query("UPDATE cloud_organizations SET device_code_sign_in = false WHERE organization_id = $1")
        .bind(&team)
        .execute(&harness.pool)
        .await
        .unwrap();
    assert_eq!(
        blocked(harness.pool.clone(), account.account_id.clone())
            .await
            .as_deref(),
        Some("Side project")
    );
}
