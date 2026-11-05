//! Changing the primary email.

use super::*;

async fn start(harness: &Harness, account: &Account, body: Value) -> (StatusCode, Value) {
    harness
        .post("/email/change", Auth::Web(&account.token), body)
        .await
}

async fn verify(harness: &Harness, account: &Account, id: &str, code: &str) -> (StatusCode, Value) {
    harness
        .post(
            "/email/change/verify",
            Auth::Web(&account.token),
            json!({ "verificationId": id, "verificationCode": code }),
        )
        .await
}

fn other_code(code: &str) -> &'static str {
    if code == "000000" {
        "111111"
    } else {
        "000000"
    }
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn the_new_email_takes_effect_after_its_code() {
    let harness = harness().await;
    let password = strong_password();
    let account = harness.account(Some(&password), true).await;
    let new_email = unique_email("moved");

    let (status, body) = start(&harness, &account, json!({ "newEmail": new_email })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "current_password_required");
    let (status, body) = start(
        &harness,
        &account,
        json!({ "newEmail": account.email, "currentPassword": password }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), "email_unchanged");
    let (status, body) = start(
        &harness,
        &account,
        json!({ "newEmail": "not-an-email", "currentPassword": password }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), "invalid_email");

    let (status, challenge) = start(
        &harness,
        &account,
        json!({ "newEmail": new_email.to_uppercase(), "currentPassword": password }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{challenge}");
    let sent = harness.sent_codes();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, new_email, "the code goes to the new address");
    let id = challenge["verificationId"].as_str().unwrap();
    assert_eq!(
        harness.overview(Auth::Web(&account.token)).await["email"]["address"],
        account.email,
        "nothing changes before the code comes back"
    );

    let (status, body) = verify(&harness, &account, id, other_code(&sent[0].1)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), "invalid_verification_code");
    let (status, body) = verify(&harness, &account, id, &sent[0].1).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["email"]["address"], new_email);
    let body = harness.overview(Auth::Web(&account.token)).await;
    assert_eq!(body["email"]["address"], new_email);
    assert_eq!(body["email"]["verified"], true);
    let (status, _) = harness
        .send(
            "POST",
            "/v1/cloud/auth/login",
            Auth::None,
            Some(json!({ "email": new_email, "password": password })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    // A spent code cannot be used again.
    let (status, _) = verify(&harness, &account, id, &sent[0].1).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        harness
            .audit_count(&account.account_id, "account.email_changed")
            .await,
        1
    );
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn a_used_address_answers_like_any_other_and_gets_no_code() {
    let harness = harness().await;
    let password = strong_password();
    let account = harness.account(Some(&password), true).await;
    let owner = harness.account(None, true).await;
    let provider_owner = harness.account(None, true).await;
    let provider_email = unique_email("provider");
    harness
        .link(&provider_owner.account_id, "github", &provider_email)
        .await;

    for taken in [owner.email.as_str(), provider_email.as_str()] {
        let (status, challenge) = start(
            &harness,
            &account,
            json!({ "newEmail": taken, "currentPassword": password }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{challenge}");
        assert!(challenge["verificationId"].is_string());
        assert!(challenge["expiresAt"].is_string());
        assert!(harness.sent_codes().is_empty(), "no code for {taken}");
        let id = challenge["verificationId"].as_str().unwrap();
        let (status, body) = verify(&harness, &account, id, "123456").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error_code(&body), "invalid_verification_code");
    }
    assert_eq!(
        harness.overview(Auth::Web(&account.token)).await["email"]["address"],
        account.email
    );
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn an_address_claimed_during_the_change_is_refused() {
    let harness = harness().await;
    let password = strong_password();
    let account = harness.account(Some(&password), true).await;
    let new_email = unique_email("race");
    let (status, challenge) = start(
        &harness,
        &account,
        json!({ "newEmail": new_email, "currentPassword": password }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, code) = harness.sent_codes().remove(0);
    let other = harness.account(None, true).await;
    query("UPDATE cloud_accounts SET primary_email = $2 WHERE account_id = $1")
        .bind(&other.account_id)
        .bind(&new_email)
        .execute(&harness.pool)
        .await
        .unwrap();
    let (status, body) = verify(
        &harness,
        &account,
        challenge["verificationId"].as_str().unwrap(),
        &code,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error_code(&body), "email_not_available");
    assert_eq!(
        harness.overview(Auth::Web(&account.token)).await["email"]["address"],
        account.email
    );
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn without_a_password_an_old_sign_in_proves_itself_by_code() {
    let harness = harness().await;
    let account = harness.account(None, true).await;
    harness.age_session(&account.token_id, 30).await;
    let new_email = unique_email("passwordless");
    let (status, body) = start(&harness, &account, json!({ "newEmail": new_email })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "reauthentication_required");

    let (status, proof) = harness
        .post("/password/code", Auth::Web(&account.token), json!({}))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (to, code) = harness.sent_codes().remove(0);
    assert_eq!(
        to, account.email,
        "the proof code goes to the current email"
    );
    let (status, challenge) = start(
        &harness,
        &account,
        json!({
            "newEmail": new_email,
            "verificationId": proof["verificationId"],
            "verificationCode": code,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{challenge}");
    let (to, code) = harness.sent_codes().remove(0);
    assert_eq!(to, new_email);
    let (status, _) = verify(
        &harness,
        &account,
        challenge["verificationId"].as_str().unwrap(),
        &code,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}
