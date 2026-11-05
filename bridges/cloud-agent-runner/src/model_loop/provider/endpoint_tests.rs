//! Endpoint and protocol selection for hosted provider snapshots.

use super::*;

fn material(provider: &str, payload: Value) -> ProviderAuthMaterial {
    ProviderAuthMaterial {
        snapshot_id: "snap".to_string(),
        provider: provider.to_string(),
        auth_choice: "cloud-login:session".to_string(),
        payload,
    }
}

#[test]
fn a_provider_outside_the_endpoint_table_uses_its_own_base_url() {
    let config = OpenAiProviderConfig::from_material(&material(
        "mistral",
        json!({
            "apiMode": "api-key",
            "apiKey": "key",
            "baseUrl": "https://api.mistral.ai/v1/",
            "api": "openai-completions",
            "model": "mistral-large-latest"
        }),
    ))
    .unwrap();
    assert_eq!(config.provider, "mistral");
    assert_eq!(config.base_url, "https://api.mistral.ai/v1");
    assert_eq!(config.api_mode, OpenAiApiMode::ChatCompletions);
}

#[test]
fn a_provider_outside_the_endpoint_table_without_a_base_url_fails_closed() {
    for provider in ["mistral", "cerebras", "deepseek", "custom"] {
        let error = OpenAiProviderConfig::from_material(&material(
            provider,
            json!({ "apiMode": "api-key", "apiKey": "key", "model": "some-model" }),
        ))
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            format!(
                "provider error: Kordi Cloud cannot run {provider} yet: no endpoint is known for it."
            )
        );
    }
}

#[test]
fn a_known_provider_without_a_base_url_keeps_its_table_entry() {
    for (provider, base_url) in [
        ("groq", "https://api.groq.com/openai/v1"),
        ("xai", "https://api.x.ai/v1"),
        ("openrouter", "https://openrouter.ai/api/v1"),
        ("openai", "https://api.openai.com/v1"),
        ("anthropic", "https://api.anthropic.com"),
        ("google", "https://generativelanguage.googleapis.com"),
    ] {
        let config = OpenAiProviderConfig::from_material(&material(
            provider,
            json!({ "apiMode": "api-key", "apiKey": "key" }),
        ))
        .unwrap();
        assert_eq!(config.base_url, base_url, "{provider}");
    }
}

#[test]
fn an_api_kind_the_runner_does_not_speak_fails_closed() {
    for (provider, api) in [
        ("mistral", "mistral-conversations"),
        ("groq", "openai-responses"),
        ("github-copilot", "openai-responses"),
        ("zai", "anthropic-messages"),
        ("custom", "anthropic-messages"),
        ("anthropic", "openai-completions"),
        ("google", "google-gemini-cli"),
    ] {
        let error = OpenAiProviderConfig::from_material(&material(
            provider,
            json!({
                "apiKey": "key",
                "baseUrl": "https://llm.example.com/v1",
                "api": api,
                "model": "some-model"
            }),
        ))
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            format!("provider error: Kordi Cloud cannot run {provider} yet: its {api} API is not supported."),
        );
    }
    let hidden = OpenAiProviderConfig::from_material(&material(
        "groq",
        json!({ "apiKey": "key", "api": "Weird API\n", "model": "m" }),
    ))
    .unwrap_err();
    assert!(hidden.to_string().ends_with("its API is not supported."));
}

#[test]
fn each_client_accepts_the_api_kind_it_speaks() {
    for (provider, payload) in [
        (
            "groq",
            json!({ "apiKey": "key", "api": "openai-completions" }),
        ),
        (
            "openai",
            json!({ "apiKey": "key", "api": "openai-responses" }),
        ),
        ("xai", json!({ "apiKey": "key", "api": "openai-responses" })),
        (
            "openrouter",
            json!({ "apiKey": "key", "api": "openrouter" }),
        ),
        (
            "anthropic",
            json!({ "apiKey": "key", "api": "anthropic-messages" }),
        ),
        (
            "google",
            json!({ "apiKey": "key", "api": "google-generative-ai" }),
        ),
        (
            "openai-codex",
            json!({
                "apiMode": "openai-codex-oauth",
                "accessToken": "token",
                "api": "openai-codex-responses"
            }),
        ),
    ] {
        assert!(
            OpenAiProviderConfig::from_material(&material(provider, payload)).is_ok(),
            "{provider}"
        );
    }
}

#[test]
fn native_clients_drop_the_version_path_of_catalog_base_urls() {
    let google = OpenAiProviderConfig::from_material(&material(
        "google",
        json!({
            "apiKey": "key",
            "api": "google-generative-ai",
            "baseUrl": "https://generativelanguage.googleapis.com/v1beta"
        }),
    ))
    .unwrap();
    assert_eq!(google.base_url, "https://generativelanguage.googleapis.com");
    let anthropic = OpenAiProviderConfig::from_material(&material(
        "anthropic",
        json!({ "apiKey": "key", "baseUrl": "https://api.anthropic.com/v1/" }),
    ))
    .unwrap();
    assert_eq!(anthropic.base_url, "https://api.anthropic.com");
    let groq = OpenAiProviderConfig::from_material(&material(
        "groq",
        json!({ "apiKey": "key", "baseUrl": "https://api.groq.com/openai/v1" }),
    ))
    .unwrap();
    assert_eq!(groq.base_url, "https://api.groq.com/openai/v1");
}

#[test]
fn a_null_base_url_counts_as_missing() {
    let error = OpenAiProviderConfig::from_material(&material(
        "amazon-bedrock",
        json!({
            "apiMode": "api-key",
            "apiKey": "key",
            "baseUrl": null,
            "api": "openai-completions"
        }),
    ))
    .unwrap_err();
    assert!(error
        .to_string()
        .ends_with("cannot run amazon-bedrock yet: no endpoint is known for it."));
    let groq = OpenAiProviderConfig::from_material(&material(
        "groq",
        json!({ "apiMode": "api-key", "apiKey": "key", "baseUrl": null, "api": "openai-completions" }),
    ))
    .unwrap();
    assert_eq!(groq.base_url, "https://api.groq.com/openai/v1");
}

#[test]
fn a_structured_json_credential_fails_closed_instead_of_becoming_a_bearer_token() {
    for (provider, key) in [
        (
            "alibaba-token-plan",
            r#"{"apiKey":"synthetic","baseUrl":"https://llm.example.com/v1"}"#,
        ),
        (
            "cloudflare-ai-gateway",
            r#" {"accountId":"a","gatewayId":"g","apiKey":"synthetic"}"#,
        ),
    ] {
        let error = OpenAiProviderConfig::from_material(&material(
            provider,
            json!({
                "apiMode": "api-key",
                "apiKey": key,
                "baseUrl": "https://llm.example.com/v1",
                "api": "openai-completions"
            }),
        ))
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            format!(
                "provider error: Kordi Cloud cannot run {provider} yet: its structured credential is not supported."
            )
        );
        assert!(!error.to_string().contains("synthetic"));
    }
    // A key that merely starts with a brace but is not an object is a key.
    assert!(OpenAiProviderConfig::from_material(&material(
        "groq",
        json!({ "apiMode": "api-key", "apiKey": "{not-json", "api": "openai-completions" }),
    ))
    .is_ok());
}

#[test]
fn only_the_openai_api_counts_as_openai() {
    for url in [
        "https://api.openai.com/v1",
        "https://API.OPENAI.COM/v1/",
        " https://api.openai.com/v1 ",
        "https://eu.api.openai.com/v1",
        "https://us.api.openai.com/v1",
    ] {
        assert!(is_openai_api(url), "{url}");
    }
    for url in [
        "https://gateway.example.test/api/v1",
        "http://api.openai.com/v1",
        "https://api.openai.com",
        "https://api.openai.com/v2",
        "https://api.openai.com:8443/v1",
        "https://api.openai.com.example.test/v1",
        "https://evilapi.openai.com.example.test/v1",
        "not a url",
        "",
    ] {
        assert!(!is_openai_api(url), "{url}");
    }
}

/// The model the runner sends for `model` on an `openai` account at
/// `base_url`, for a member snapshot or a server service credential.
fn routed_model(base_url: &str, model: &str, service: bool) -> String {
    let mut payload = json!({ "apiKey": "key", "baseUrl": base_url });
    if service {
        payload["verbatimModel"] = json!(true);
    }
    let mut config = OpenAiProviderConfig::from_material(&material("openai", payload)).unwrap();
    assert_eq!(config.verbatim_model, service);
    config
        .apply_runtime_route(
            &AgentRuntimeRoute {
                default_model: Some(model.to_string()),
                thinking: None,
            },
            "openai",
        )
        .unwrap();
    config.model
}

const GATEWAY: &str = "https://gateway.example.test/api/v1";

#[test]
fn member_routes_keep_dropping_the_openai_prefix_on_any_endpoint() {
    for base_url in [
        "https://api.openai.com/v1",
        "https://eu.api.openai.com/v1",
        GATEWAY,
    ] {
        assert_eq!(
            routed_model(base_url, "openai/gpt-5.6-sol", false),
            "gpt-5.6-sol",
            "{base_url}"
        );
    }
    assert_eq!(
        routed_model(GATEWAY, "anthropic/claude-sonnet-5", false),
        "anthropic/claude-sonnet-5"
    );
}

#[test]
fn service_credentials_send_the_configured_model_verbatim_to_a_gateway() {
    assert_eq!(
        routed_model(GATEWAY, "openai/gpt-5.6-sol", true),
        "openai/gpt-5.6-sol"
    );
    assert_eq!(
        routed_model(GATEWAY, "anthropic/claude-sonnet-5", true),
        "anthropic/claude-sonnet-5"
    );
    assert_eq!(
        routed_model(GATEWAY, "synthetic-model", true),
        "synthetic-model"
    );
}

#[test]
fn service_credentials_on_the_openai_api_drop_the_openai_prefix() {
    for base_url in ["https://api.openai.com/v1", "https://eu.api.openai.com/v1"] {
        assert_eq!(
            routed_model(base_url, "openai/gpt-5.6-sol", true),
            "gpt-5.6-sol",
            "{base_url}"
        );
    }
}

#[test]
fn regional_openai_hosts_use_the_responses_api() {
    for (base_url, api) in [
        ("https://api.openai.com/v1", "openai-responses"),
        ("https://eu.api.openai.com/v1", "openai-responses"),
        (GATEWAY, "openai-completions"),
    ] {
        let config = OpenAiProviderConfig::from_material(&material(
            "openai",
            json!({ "apiKey": "key", "baseUrl": base_url }),
        ))
        .unwrap();
        assert_eq!(
            crate::model_loop::omp::api_for_provider(&config),
            api,
            "{base_url}"
        );
    }
}
