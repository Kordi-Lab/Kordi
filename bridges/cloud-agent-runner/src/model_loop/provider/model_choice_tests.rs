use super::model_choice::{
    default_model_for_provider, model_fits_provider, OPENAI_CODEX_DEFAULT_MODEL,
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
