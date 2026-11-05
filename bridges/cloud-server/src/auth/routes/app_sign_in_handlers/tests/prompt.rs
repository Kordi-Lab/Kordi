//! `prompt=create` reaches the sign-in page; nothing else does. These call
//! the handler directly and need no database.

use super::*;
use axum::extract::Query;

async fn page_location(prompt: Option<&str>) -> url::Url {
    let pkce = pkce();
    let params = AppAuthorizationParams {
        client_id: Some(IOS.to_string()),
        redirect_uri: Some("kordi://auth/callback".to_string()),
        response_type: Some("code".to_string()),
        code_challenge: Some(pkce.challenge),
        code_challenge_method: Some("S256".to_string()),
        state: Some("state-1".to_string()),
        prompt: prompt.map(str::to_string),
        ..Default::default()
    };
    let response = app_authorize_start(
        Extension(Arc::new(AppClientRegistry::builtin())),
        Query(params),
    )
    .await;
    assert!(response.status().is_redirection(), "{}", response.status());
    let location = response.headers()["location"].to_str().unwrap();
    url::Url::parse(location).unwrap()
}

fn prompts(url: &url::Url) -> Vec<String> {
    url.query_pairs()
        .filter(|(key, _)| key == "prompt")
        .map(|(_, value)| value.into_owned())
        .collect()
}

#[tokio::test]
async fn create_is_forwarded_to_the_sign_in_page() {
    let url = page_location(Some("create")).await;
    assert_eq!(prompts(&url), vec!["create".to_string()]);
    assert!(url
        .query_pairs()
        .any(|(key, value)| key == "state" && value == "state-1"));
}

#[tokio::test]
async fn other_prompt_values_are_dropped() {
    for prompt in [
        None,
        Some("login"),
        Some("CREATE"),
        Some("create login"),
        Some(""),
    ] {
        let url = page_location(prompt).await;
        assert!(prompts(&url).is_empty(), "{prompt:?}");
    }
}

#[test]
fn only_an_exact_create_is_supported() {
    let params = |prompt: &str| AppAuthorizationParams {
        prompt: Some(prompt.to_string()),
        ..Default::default()
    };
    assert_eq!(params("create").sign_in_page_prompt(), Some("create"));
    assert_eq!(params("none").sign_in_page_prompt(), None);
    assert_eq!(
        AppAuthorizationParams::default().sign_in_page_prompt(),
        None
    );
}
