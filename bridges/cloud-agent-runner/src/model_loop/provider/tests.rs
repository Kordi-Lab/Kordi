use super::*;

#[test]
fn openai_config_rejects_missing_provider_tokens() {
    let material = ProviderAuthMaterial {
        snapshot_id: "snap".to_string(),
        provider: "openai".to_string(),
        auth_choice: "default".to_string(),
        payload: json!({ "baseUrl": "https://api.openai.com/v1" }),
    };

    let error = OpenAiProviderConfig::from_material(&material).unwrap_err();
    assert!(error.to_string().contains("provider token"));
}

#[test]
fn openai_config_allows_public_hosts_that_contain_localhost_text() {
    let material = ProviderAuthMaterial {
        snapshot_id: "snap".to_string(),
        provider: "openai".to_string(),
        auth_choice: "default".to_string(),
        payload: json!({
            "apiKey": "key",
            "baseUrl": "https://localhost-docs.example.com/v1"
        }),
    };

    let config = OpenAiProviderConfig::from_material(&material).unwrap();
    assert_eq!(config.base_url, "https://localhost-docs.example.com/v1");
}

#[test]
fn openai_config_rejects_owner_local_provider_endpoints() {
    let material = ProviderAuthMaterial {
        snapshot_id: "snap".to_string(),
        provider: "openai".to_string(),
        auth_choice: "default".to_string(),
        payload: json!({ "apiKey": "key", "baseUrl": "http://localhost:1234/v1" }),
    };

    let error = OpenAiProviderConfig::from_material(&material).unwrap_err();
    assert!(error.to_string().contains("owner-local provider endpoints"));
}

#[test]
fn openai_config_accepts_codex_oauth_material_and_preserves_model() {
    let material = ProviderAuthMaterial {
        snapshot_id: "snap".to_string(),
        provider: "openai-codex".to_string(),
        auth_choice: "local-active-oauth".to_string(),
        payload: json!({
            "apiMode": "openai-codex-oauth",
            "accessToken": "oauth-token",
            "accountId": "account-123",
            "model": "gpt-5.5"
        }),
    };

    let config = OpenAiProviderConfig::from_material(&material).unwrap();
    assert_eq!(config.api_mode, OpenAiApiMode::CodexOAuth);
    assert_eq!(config.api_key, "oauth-token");
    assert_eq!(config.account_id.as_deref(), Some("account-123"));
    assert_eq!(config.model, "gpt-5.5");

    let options = config.request_options();
    assert_eq!(options.auth_mode, ProviderAuthMode::OAuth);
    assert_eq!(options.auth_account_id.as_deref(), Some("account-123"));
    assert_eq!(options.base_url, "https://chatgpt.com/backend-api");
}

#[test]
fn provider_config_uses_native_anthropic_and_google_defaults() {
    let anthropic = OpenAiProviderConfig::from_material(&ProviderAuthMaterial {
        snapshot_id: "snap-anthropic".to_string(),
        provider: "anthropic".to_string(),
        auth_choice: "ios-api-key".to_string(),
        payload: json!({ "apiKey": "claude-key" }),
    })
    .unwrap();
    assert_eq!(anthropic.provider, "anthropic");
    assert_eq!(anthropic.base_url, "https://api.anthropic.com");
    assert_eq!(anthropic.model, "claude-sonnet-5");

    let google = OpenAiProviderConfig::from_material(&ProviderAuthMaterial {
        snapshot_id: "snap-google".to_string(),
        provider: "google-gemini".to_string(),
        auth_choice: "ios-api-key".to_string(),
        payload: json!({ "apiKey": "gemini-key" }),
    })
    .unwrap();
    assert_eq!(google.provider, "google");
    assert_eq!(google.base_url, "https://generativelanguage.googleapis.com");
    assert_eq!(google.model, "gemini-3.1-pro");
}

#[test]
fn codex_oauth_snapshot_strips_provider_prefix_from_route_model() {
    let material = ProviderAuthMaterial {
        snapshot_id: "snap".to_string(),
        provider: "openai-codex".to_string(),
        auth_choice: "local-active-oauth".to_string(),
        payload: json!({
            "apiMode": "openai-codex-oauth",
            "accessToken": "oauth-token",
            "accountId": "account-123",
            "model": "openai/gpt-5.5"
        }),
    };

    let config = OpenAiProviderConfig::from_material(&material).unwrap();

    assert_eq!(config.model, "gpt-5.5");
}

#[test]
fn session_runtime_route_overrides_model_and_thinking() {
    let material = ProviderAuthMaterial {
        snapshot_id: "snap".to_string(),
        provider: "openai-codex".to_string(),
        auth_choice: "local-active-oauth".to_string(),
        payload: json!({
            "apiMode": "openai-codex-oauth",
            "accessToken": "oauth-token",
            "accountId": "account-123",
            "model": "gpt-5.5",
            "thinking": "medium"
        }),
    };
    let mut config = OpenAiProviderConfig::from_material(&material).unwrap();

    config.apply_runtime_route(
        &AgentRuntimeRoute {
            default_model: Some("openai-codex/gpt-5.6-sol".to_string()),
            thinking: Some("high".to_string()),
        },
        &material.provider,
    );

    assert_eq!(config.model, "gpt-5.6-sol");
    assert_eq!(config.thinking, "high");
}

#[test]
fn completion_request_uses_shared_provider_shape_without_rewriting_model() {
    let auth = OpenAiProviderConfig {
        provider: "openai".to_string(),
        api_key: "token".to_string(),
        base_url: "https://chatgpt.com/backend-api".to_string(),
        model: "gpt-5.5".to_string(),
        thinking: "default".to_string(),
        api_mode: OpenAiApiMode::CodexOAuth,
        account_id: Some("acct".to_string()),
    };
    let request = completion_request_from_cloud_messages(
        &auth,
        &[
            json!({"role":"system","content":"System A"}),
            json!({"role":"user","content":"Hello"}),
        ],
        &[json!({"type":"function","function":{"name":"read"}})],
    );

    assert_eq!(request.model, "gpt-5.5");
    assert_eq!(request.system_prompt, "System A");
    assert_eq!(
        request.messages,
        vec![json!({"role":"user","content":"Hello"})]
    );
    assert_eq!(request.tools.len(), 1);
    assert_eq!(request.thinking.as_deref(), Some("default"));
}

#[test]
fn stream_events_convert_to_tool_call_response() {
    let response = model_response_from_stream_events(vec![
        StreamEvent::ToolCallStart {
            id: "call_1".to_string(),
            name: "read".to_string(),
        },
        StreamEvent::ToolCallDelta {
            id: "call_1".to_string(),
            arguments_delta: "{\"path\":\"file.txt\"}".to_string(),
        },
        StreamEvent::ToolCallEnd {
            id: "call_1".to_string(),
        },
        StreamEvent::Done,
    ])
    .unwrap();

    assert_eq!(
        response,
        ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: "call_1".to_string(),
            name: "read".to_string(),
            arguments: json!({"path":"file.txt"}),
        }])
    );
}

#[test]
fn stream_events_convert_to_final_text() {
    let response = model_response_from_stream_events(vec![
        StreamEvent::TextDelta {
            text: "hello".to_string(),
        },
        StreamEvent::TextDelta {
            text: " world".to_string(),
        },
        StreamEvent::Done,
    ])
    .unwrap();

    assert_eq!(
        response,
        ModelProviderResponse::FinalText("hello world".to_string())
    );
}
