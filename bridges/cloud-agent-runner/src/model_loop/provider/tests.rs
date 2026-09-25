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
fn provider_config_accepts_anthropic_oauth_material() {
    let material = ProviderAuthMaterial {
        snapshot_id: "snap-anthropic-oauth".to_string(),
        provider: "anthropic".to_string(),
        auth_choice: "local-active-oauth".to_string(),
        payload: json!({
            "apiMode": "anthropic-oauth",
            "accessToken": "oauth-token",
            "model": "claude-opus-4-1"
        }),
    };

    let config = OpenAiProviderConfig::from_material(&material).unwrap();

    assert_eq!(config.provider, "anthropic");
    assert_eq!(config.api_mode, OpenAiApiMode::AnthropicOAuth);
    assert_eq!(config.base_url, "https://api.anthropic.com");
    assert_eq!(config.model, "claude-opus-4-1");
    assert_eq!(config.request_options().auth_mode, ProviderAuthMode::OAuth);
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

    config
        .apply_runtime_route(
            &AgentRuntimeRoute {
                default_model: Some("openai-codex/gpt-5.6-sol".to_string()),
                thinking: Some("high".to_string()),
            },
            &material.provider,
        )
        .unwrap();

    assert_eq!(config.model, "gpt-5.6-sol");
    assert_eq!(config.thinking, "high");
    let request = completion_request_from_cloud_messages(
        &config,
        &[json!({"role": "system", "content": "Route instructions"})],
        &[],
    );
    assert!(request.system_prompt.starts_with("Route instructions\n\n"));
    assert!(request
        .system_prompt
        .contains("Selected model ID: \"gpt-5.6-sol\""));
    assert!(request
        .system_prompt
        .contains("Configured provider: \"openai\""));
    assert!(!request.system_prompt.contains("gpt-5.5"));
    assert_eq!(request.thinking.as_deref(), Some("high"));
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
            json!({"role":"system","content":[{"type":"text","text":"System B"}]}),
            json!({"role":"user","content":"Hello"}),
        ],
        &[json!({"type":"function","function":{"name":"read"}})],
    );

    assert_eq!(request.model, "gpt-5.5");
    assert!(request.system_prompt.starts_with("System A\nSystem B\n\n"));
    assert!(request
        .system_prompt
        .contains("Selected model ID: \"gpt-5.5\""));
    assert!(request
        .system_prompt
        .contains("Configured provider: \"openai\""));
    assert_eq!(
        request.messages,
        vec![json!({"role":"user","content":"Hello"})]
    );
    assert_eq!(request.tools.len(), 1);
    assert_eq!(request.thinking.as_deref(), Some("default"));
}

fn fixture_auth() -> OpenAiProviderConfig {
    OpenAiProviderConfig {
        provider: "openai".into(),
        api_key: "fixture".into(),
        base_url: "http://127.0.0.1:0".into(),
        model: "fixture-model".into(),
        thinking: "default".into(),
        api_mode: OpenAiApiMode::ChatCompletions,
        account_id: None,
    }
}

#[test]
fn cloud_model_context_escapes_stray_delimiters_instead_of_failing() {
    let request = completion_request_from_cloud_messages(
        &fixture_auth(),
        &[json!({"role":"system", "content":"private instructions\n<kordi_model_context>"})],
        &[],
    );
    assert!(request
        .system_prompt
        .starts_with("private instructions\n\\<kordi_model_context>\n\n<kordi_model_context>\n"));
    assert!(request
        .system_prompt
        .contains("Selected model ID: \"fixture-model\""));
    assert_eq!(request.model, "fixture-model");
}

#[test]
fn cloud_model_context_preserves_fenced_examples() {
    for example in [
        "<kordi_model_context>\nKeep this example\n</kordi_model_context>",
        "<kordi_model_context>",
    ] {
        let base = format!("Cloud instructions\n~~~text\n{example}\n~~~");
        let request = completion_request_from_cloud_messages(
            &fixture_auth(),
            &[json!({"role":"system", "content":base})],
            &[],
        );
        assert!(request.system_prompt.starts_with(&format!("{base}\n\n")));
        assert!(request
            .system_prompt
            .contains("Selected model ID: \"fixture-model\""));
        assert_eq!(request.model, "fixture-model");
    }
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

fn material(provider: &str, payload: Value) -> ProviderAuthMaterial {
    ProviderAuthMaterial {
        snapshot_id: "snap".to_string(),
        provider: provider.to_string(),
        auth_choice: "default".to_string(),
        payload,
    }
}

fn route(model: Option<&str>) -> AgentRuntimeRoute {
    AgentRuntimeRoute {
        default_model: model.map(ToString::to_string),
        thinking: None,
    }
}

#[test]
fn custom_snapshot_keeps_its_model_and_the_route_model_wins() {
    let custom = material(
        "custom",
        json!({
            "apiKey": "key",
            "baseUrl": "https://llm.example.com/v1",
            "model": "deepseek-chat"
        }),
    );
    let mut config = OpenAiProviderConfig::from_material(&custom).unwrap();
    assert_eq!(config.base_url, "https://llm.example.com/v1");
    assert_eq!(config.model, "deepseek-chat");
    config.apply_runtime_route(&route(None), "custom").unwrap();
    assert_eq!(config.model, "deepseek-chat");
    config
        .apply_runtime_route(&route(Some("custom/deepseek-reasoner")), "custom")
        .unwrap();
    assert_eq!(config.model, "deepseek-reasoner");
}

#[test]
fn custom_snapshot_without_a_model_fails_instead_of_using_a_default() {
    for payload in [
        json!({ "apiKey": "key", "baseUrl": "https://llm.example.com/v1" }),
        json!({ "apiKey": "key", "baseUrl": "https://llm.example.com/v1", "model": " " }),
        json!({ "apiKey": "key", "baseUrl": "https://llm.example.com/v1", "model": "m".repeat(161) }),
    ] {
        let mut config = OpenAiProviderConfig::from_material(&material("custom", payload)).unwrap();
        let error = config
            .apply_runtime_route(&route(None), "custom")
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            ModelLoopError::Provider(CUSTOM_MODEL_MISSING.to_string()).to_string()
        );
    }
    // A route model is enough on its own.
    let mut config = OpenAiProviderConfig::from_material(&material(
        "custom",
        json!({ "apiKey": "key", "baseUrl": "https://llm.example.com/v1" }),
    ))
    .unwrap();
    config
        .apply_runtime_route(&route(Some("custom/deepseek-chat")), "custom")
        .unwrap();
    assert_eq!(config.model, "deepseek-chat");
    // Owner-local custom endpoints stay rejected.
    let local = material(
        "custom",
        json!({ "apiKey": "key", "baseUrl": "http://192.168.1.20/v1", "model": "deepseek-chat" }),
    );
    let error = OpenAiProviderConfig::from_material(&local).unwrap_err();
    assert!(error.to_string().contains("owner-local provider endpoints"));
}

#[test]
fn providers_outside_the_known_families_keep_their_stored_models() {
    for (provider, model) in [
        ("cerebras", "llama-4-scout-17b"),
        ("mistral", "mistral-large-latest"),
        ("groq", "openai/gpt-oss-120b"),
        ("openrouter", "anthropic/claude-sonnet-5"),
        ("custom", "claude-sonnet-5"),
    ] {
        let config = OpenAiProviderConfig::from_material(&material(
            provider,
            json!({ "apiKey": "key", "baseUrl": "https://llm.example.com/v1", "model": model }),
        ))
        .unwrap();
        assert_eq!(config.model, model, "{provider}");
    }
}

#[test]
fn another_vendors_model_on_a_known_family_snapshot_is_replaced() {
    let openai = OpenAiProviderConfig::from_material(&material(
        "openai",
        json!({ "apiKey": "key", "model": "claude-sonnet-5" }),
    ))
    .unwrap();
    assert_eq!(openai.model, "gpt-4.1-mini");
    let anthropic = OpenAiProviderConfig::from_material(&material(
        "anthropic",
        json!({ "apiKey": "key", "model": "gpt-5.6-sol" }),
    ))
    .unwrap();
    assert_eq!(anthropic.model, "claude-sonnet-5");
}

#[test]
fn another_providers_model_is_rejected() {
    use super::model_choice::model_fits_provider;
    assert!(!model_fits_provider("gpt-5.6-sol", "anthropic"));
    assert!(!model_fits_provider("openai/gpt-5.6-sol", "anthropic"));
    assert!(!model_fits_provider("claude-sonnet-5", "openai"));
    assert!(model_fits_provider("claude-sonnet-5", "anthropic"));
    assert!(model_fits_provider("gpt-5.6-sol", "openai-codex"));
    assert!(model_fits_provider("llama-3.3-70b-versatile", "groq"));
}
