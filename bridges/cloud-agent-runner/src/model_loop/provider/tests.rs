use super::*;

#[test]
fn openai_config_rejects_missing_provider_tokens() {
    let material = ProviderAuthMaterial {
        snapshot_id: "snap".to_string(),
        provider: "openai".to_string(),
        auth_choice: "default".to_string(),
        payload: json!({ "baseUrl": "https://api.openai.com/v1" }),
    };

    let error = CloudProviderConfig::from_material(&material).unwrap_err();
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

    let config = CloudProviderConfig::from_material(&material).unwrap();
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

    let error = CloudProviderConfig::from_material(&material).unwrap_err();
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

    let config = CloudProviderConfig::from_material(&material).unwrap();
    assert_eq!(config.api, CloudProviderApi::OpenAiCompatible);
    assert_eq!(config.auth_mode, ProviderAuthMode::OAuth);
    assert_eq!(config.api_key, "oauth-token");
    assert_eq!(config.account_id.as_deref(), Some("account-123"));
    assert_eq!(config.model, "gpt-5.5");

    let options = config.request_options();
    assert_eq!(options.auth_mode, ProviderAuthMode::OAuth);
    assert_eq!(options.auth_account_id.as_deref(), Some("account-123"));
    assert_eq!(options.base_url, "https://chatgpt.com/backend-api");
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

    let config = CloudProviderConfig::from_material(&material).unwrap();
    assert_eq!(config.model, "gpt-5.5");
}

#[test]
fn anthropic_oauth_snapshot_uses_anthropic_api_and_strips_provider_prefix() {
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

    let config = CloudProviderConfig::from_material(&material).unwrap();
    assert_eq!(config.api, CloudProviderApi::Anthropic);
    assert_eq!(config.auth_mode, ProviderAuthMode::OAuth);
    assert_eq!(config.base_url, "https://api.anthropic.com");
    assert_eq!(config.model, "claude-opus-4-8");
}

#[test]
fn anthropic_snapshot_rejects_a_stale_cross_provider_model_route() {
    let material = ProviderAuthMaterial {
        snapshot_id: "snap".to_string(),
        provider: "anthropic".to_string(),
        auth_choice: "local-active-oauth".to_string(),
        payload: json!({
            "apiMode": "anthropic-oauth",
            "accessToken": "oauth-token",
            "model": "openai/gpt-5.6-sol"
        }),
    };

    let config = CloudProviderConfig::from_material(&material).unwrap();
    assert_eq!(config.model, DEFAULT_ANTHROPIC_MODEL_ID);
}

#[test]
fn unknown_provider_fails_closed_before_selecting_an_endpoint() {
    let material = ProviderAuthMaterial {
        snapshot_id: "snap".to_string(),
        provider: "unknown-provider".to_string(),
        auth_choice: "default".to_string(),
        payload: json!({ "apiKey": "must-not-be-sent" }),
    };

    let error = CloudProviderConfig::from_material(&material).unwrap_err();
    assert!(error.to_string().contains("unsupported"));
}

#[test]
fn cloud_provider_debug_output_never_contains_credentials() {
    let config = CloudProviderConfig {
        api: CloudProviderApi::Anthropic,
        provider: "anthropic".to_string(),
        api_key: "secret-provider-token".to_string(),
        base_url: "https://api.anthropic.com".to_string(),
        model: "claude-opus-4-8".to_string(),
        auth_mode: ProviderAuthMode::OAuth,
        account_id: None,
    };

    let rendered = format!("{config:?}");
    assert!(rendered.contains("[redacted]"));
    assert!(!rendered.contains("secret-provider-token"));
}

#[test]
fn completion_request_uses_shared_provider_shape_without_rewriting_model() {
    let auth = CloudProviderConfig {
        api: CloudProviderApi::OpenAiCompatible,
        provider: "openai".to_string(),
        api_key: "token".to_string(),
        base_url: "https://chatgpt.com/backend-api".to_string(),
        model: "gpt-5.5".to_string(),
        auth_mode: ProviderAuthMode::OAuth,
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
