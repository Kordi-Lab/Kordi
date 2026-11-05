//! Unlinking sign-in providers.

use super::*;

async fn unlink(harness: &Harness, account: &Account, provider: &str) -> (StatusCode, Value) {
    harness
        .send(
            "DELETE",
            &format!("{BASE}/providers/{provider}"),
            Auth::Web(&account.token),
            None,
        )
        .await
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn the_last_sign_in_method_cannot_be_unlinked() {
    let harness = harness().await;
    let account = harness.account(None, true).await;
    harness
        .link(&account.account_id, "google", &account.email)
        .await;

    let (status, body) = unlink(&harness, &account, "google").await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error_code(&body), "last_sign_in_method");

    harness
        .link(&account.account_id, "github", &unique_email("github"))
        .await;
    let (status, _) = unlink(&harness, &account, "google").await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let body = harness.overview(Auth::Web(&account.token)).await;
    let providers = body["providers"].as_array().unwrap();
    assert_eq!(providers.len(), 1);
    assert_eq!(providers[0]["provider"], "github");

    let (status, body) = unlink(&harness, &account, "github").await;
    assert_eq!(status, StatusCode::CONFLICT, "github is now the last one");
    assert_eq!(error_code(&body), "last_sign_in_method");
    for provider in ["google", "unknown"] {
        let (status, body) = unlink(&harness, &account, provider).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{provider}");
        assert_eq!(error_code(&body), "provider_not_linked");
    }
    assert_eq!(
        harness
            .audit_count(&account.account_id, "account.provider_unlinked")
            .await,
        1
    );
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn a_password_is_a_sign_in_method() {
    let harness = harness().await;
    let account = harness.account(Some(&strong_password()), true).await;
    harness
        .link(&account.account_id, "google", &account.email)
        .await;
    let (status, _) = unlink(&harness, &account, "google").await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let body = harness.overview(Auth::Web(&account.token)).await;
    assert!(body["providers"].as_array().unwrap().is_empty());
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn another_accounts_provider_is_untouched() {
    let harness = harness().await;
    let account = harness.account(Some(&strong_password()), true).await;
    let other = harness.account(Some(&strong_password()), true).await;
    harness
        .link(&other.account_id, "google", &other.email)
        .await;
    let (status, _) = unlink(&harness, &account, "google").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let body = harness.overview(Auth::Web(&other.token)).await;
    assert_eq!(body["providers"].as_array().unwrap().len(), 1);
}
