use super::*;

#[test]
fn anthropic_oauth_material_uses_messages_api_and_oauth_auth() {
    let material = ProviderAuthMaterial {
        snapshot_id: "snap".to_string(),
        provider: "anthropic".to_string(),
        auth_choice: "local-active-oauth".to_string(),
        payload: json!({
            "apiMode": "anthropic-oauth",
            "accessToken": "oauth-token",
            "model": "anthropic/claude-opus-4-8"
        }),
    };

    let config = OpenAiProviderConfig::from_material(&material).unwrap();
    assert_eq!(config.api_mode, OpenAiApiMode::AnthropicOAuth);
    assert_eq!(config.base_url, "https://api.anthropic.com");
    assert_eq!(config.model, "claude-opus-4-8");
    assert_eq!(config.request_options().auth_mode, ProviderAuthMode::OAuth);
}

#[test]
fn github_copilot_oauth_material_uses_copilot_endpoint_and_headers() {
    let material = ProviderAuthMaterial {
        snapshot_id: "snap".to_string(),
        provider: "github-copilot".to_string(),
        auth_choice: "local-active-oauth".to_string(),
        payload: json!({
            "apiMode": "github-copilot-oauth",
            "accessToken": "copilot-token",
            "baseUrl": "https://api.githubcopilot.com",
            "headers": { "OpenAI-Organization": "github-copilot" },
            "model": "github-copilot/gpt-5.4"
        }),
    };

    let config = OpenAiProviderConfig::from_material(&material).unwrap();
    assert_eq!(config.api_mode, OpenAiApiMode::GithubCopilotOAuth);
    assert_eq!(config.base_url, "https://api.githubcopilot.com");
    assert_eq!(config.model, "gpt-5.4");
    assert_eq!(
        config
            .headers
            .get("OpenAI-Organization")
            .map(String::as_str),
        Some("github-copilot")
    );
    assert_eq!(config.request_options().auth_mode, ProviderAuthMode::ApiKey);
}
