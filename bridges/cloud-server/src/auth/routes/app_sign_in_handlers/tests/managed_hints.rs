//! Managed device hints reach the sign-in page only when well formed. These
//! call the handler directly and need no database.

use super::*;
use axum::extract::Query;

async fn page_query(organization: Option<&str>, methods: Option<&str>) -> Vec<(String, String)> {
    let pkce = pkce();
    let params = AppAuthorizationParams {
        client_id: Some(IOS.to_string()),
        redirect_uri: Some("kordi://auth/callback".to_string()),
        response_type: Some("code".to_string()),
        code_challenge: Some(pkce.challenge),
        code_challenge_method: Some("S256".to_string()),
        state: Some("state-1".to_string()),
        organization_hint: organization.map(str::to_string),
        sign_in_methods: methods.map(str::to_string),
        ..Default::default()
    };
    let response = app_authorize_start(
        Extension(Arc::new(AppClientRegistry::builtin())),
        Query(params),
    )
    .await;
    assert!(response.status().is_redirection(), "{}", response.status());
    let location = response.headers()["location"].to_str().unwrap();
    url::Url::parse(location)
        .unwrap()
        .query_pairs()
        .filter(|(key, _)| key == "organization_hint" || key == "sign_in_methods")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect()
}

#[tokio::test]
async fn valid_hints_are_forwarded_to_the_sign_in_page() {
    let query = page_query(Some("example-research"), Some("google,email")).await;
    assert_eq!(
        query,
        vec![
            (
                "organization_hint".to_string(),
                "example-research".to_string()
            ),
            ("sign_in_methods".to_string(), "google,email".to_string()),
        ]
    );
}

#[tokio::test]
async fn invalid_hints_are_dropped_without_failing_the_sign_in() {
    assert!(page_query(None, None).await.is_empty());
    assert!(page_query(Some("Not an id"), Some("password"))
        .await
        .is_empty());
}
