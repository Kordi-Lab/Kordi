use super::model_choice::{default_model_for_provider, OPENAI_CODEX_DEFAULT_MODEL};
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
fn codex_default_model_matches_the_omp_provider_catalog() {
    let catalog: Value = serde_json::from_str(include_str!(
        "../../../../../shared/omp-catalog/omp-provider-catalog.json"
    ))
    .unwrap();
    let default_model = catalog["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|provider| provider["id"] == "openai-codex")
        .and_then(|provider| provider["defaultModel"].as_str())
        .unwrap();
    assert_eq!(OPENAI_CODEX_DEFAULT_MODEL, default_model);
    assert_eq!(default_model_for_provider("openai-codex"), default_model);
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
