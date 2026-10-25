use super::model_choice::{
    default_model_for_provider, default_thinking_for_model, model_fits_provider,
    ANTHROPIC_DEFAULT_MODEL, OPENAI_CODEX_DEFAULT_MODEL,
};
use super::*;

fn codex_material(payload: Value) -> ProviderAuthMaterial {
    ProviderAuthMaterial {
        snapshot_id: "snap".to_string(),
        provider: "openai-codex".to_string(),
        auth_choice: "cloud-login:account".to_string(),
        payload,
    }
}

#[test]
fn codex_default_model_is_the_shared_chatgpt_default_and_a_known_codex_model() {
    assert_eq!(
        OPENAI_CODEX_DEFAULT_MODEL,
        kordi_core::agent_session::DEFAULT_OPENAI_MODEL_ID
    );
    assert_eq!(
        default_model_for_provider("openai-codex"),
        OPENAI_CODEX_DEFAULT_MODEL
    );
    assert!(model_fits_provider(
        OPENAI_CODEX_DEFAULT_MODEL,
        "openai-codex"
    ));
    let registry = kordi_provider::registry::ModelRegistry::new();
    assert!(
        registry
            .find("openai", OPENAI_CODEX_DEFAULT_MODEL)
            .is_some(),
        "the ChatGPT default model must exist in the provider registry"
    );
}

#[test]
fn codex_snapshot_without_a_model_uses_a_model_the_account_serves() {
    let config = OpenAiProviderConfig::from_material(&codex_material(json!({
        "apiMode": "openai-codex-oauth",
        "accessToken": "oauth-token",
        "accountId": "account-123"
    })))
    .unwrap();
    assert_eq!(config.model, OPENAI_CODEX_DEFAULT_MODEL);
    assert_ne!(config.model, "gpt-4.1-mini");
}

#[test]
fn codex_snapshot_keeps_a_stored_codex_model_and_replaces_another_vendor() {
    let stored = OpenAiProviderConfig::from_material(&codex_material(json!({
        "apiMode": "openai-codex-oauth",
        "accessToken": "oauth-token",
        "model": "gpt-5.6-sol"
    })))
    .unwrap();
    assert_eq!(stored.model, "gpt-5.6-sol");
    let foreign = OpenAiProviderConfig::from_material(&codex_material(json!({
        "apiMode": "openai-codex-oauth",
        "accessToken": "oauth-token",
        "model": "claude-sonnet-5"
    })))
    .unwrap();
    assert_eq!(foreign.model, OPENAI_CODEX_DEFAULT_MODEL);
}

#[test]
fn claude_default_is_the_shared_sonnet_55_default_at_medium_effort() {
    assert_eq!(ANTHROPIC_DEFAULT_MODEL, "claude-sonnet-5-5");
    assert_eq!(
        ANTHROPIC_DEFAULT_MODEL,
        kordi_core::agent_session::DEFAULT_ANTHROPIC_MODEL_ID
    );
    assert_eq!(
        default_model_for_provider("anthropic"),
        ANTHROPIC_DEFAULT_MODEL
    );
    let registry = kordi_provider::registry::ModelRegistry::new();
    assert!(
        registry
            .find("anthropic", ANTHROPIC_DEFAULT_MODEL)
            .is_some(),
        "the Claude default model must exist in the provider registry"
    );
    assert_eq!(
        default_thinking_for_model("anthropic", ANTHROPIC_DEFAULT_MODEL),
        Some("medium")
    );
    assert_eq!(
        default_thinking_for_model("anthropic", "claude-opus-4-8"),
        None
    );
    assert_eq!(default_thinking_for_model("openai", "gpt-6.1-sol"), None);
}

fn claude_material(payload: Value) -> ProviderAuthMaterial {
    ProviderAuthMaterial {
        snapshot_id: "snap".to_string(),
        provider: "anthropic".to_string(),
        auth_choice: "cloud-api-key:claude".to_string(),
        payload,
    }
}

fn route(model: Option<&str>, thinking: Option<&str>) -> AgentRuntimeRoute {
    AgentRuntimeRoute {
        default_model: model.map(str::to_string),
        thinking: thinking.map(str::to_string),
    }
}

#[test]
fn a_fresh_claude_run_uses_sonnet_55_at_medium_effort() {
    let mut fresh =
        OpenAiProviderConfig::from_material(&claude_material(json!({ "apiKey": "key" }))).unwrap();
    assert_eq!(fresh.model, ANTHROPIC_DEFAULT_MODEL);
    fresh
        .apply_runtime_route(&route(None, None), "anthropic")
        .unwrap();
    assert_eq!(fresh.thinking, "medium");

    let mut routed =
        OpenAiProviderConfig::from_material(&claude_material(json!({ "apiKey": "key" }))).unwrap();
    routed
        .apply_runtime_route(
            &route(Some("anthropic/claude-sonnet-5-5"), None),
            "anthropic",
        )
        .unwrap();
    assert_eq!(routed.thinking, "medium");
}

#[test]
fn a_named_claude_effort_or_another_claude_model_keeps_its_own_default() {
    for (model, thinking, expected) in [
        (Some("anthropic/claude-sonnet-5-5"), Some("xhigh"), "xhigh"),
        (
            Some("anthropic/claude-sonnet-5-5"),
            Some("default"),
            "default",
        ),
        (Some("anthropic/claude-opus-4-8"), None, "default"),
    ] {
        let mut config =
            OpenAiProviderConfig::from_material(&claude_material(json!({ "apiKey": "key" })))
                .unwrap();
        config
            .apply_runtime_route(&route(model, thinking), "anthropic")
            .unwrap();
        assert_eq!(config.thinking, expected, "{model:?} {thinking:?}");
    }
}

#[test]
fn claude_snapshot_keeps_its_stored_model_and_thinking() {
    let mut config = OpenAiProviderConfig::from_material(&claude_material(
        json!({ "apiKey": "key", "model": "claude-opus-4-8", "thinking": "high" }),
    ))
    .unwrap();
    config
        .apply_runtime_route(&route(None, None), "anthropic")
        .unwrap();
    assert_eq!(config.model, "claude-opus-4-8");
    assert_eq!(config.thinking, "high");
}
