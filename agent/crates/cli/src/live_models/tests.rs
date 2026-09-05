use super::*;
use kordi_provider::anthropic::capabilities::ANTHROPIC_SUBSCRIPTION_MODEL_IDS;
use kordi_provider::registry::ApiType;
use std::sync::Mutex;

fn env_lock() -> &'static Mutex<()> {
    crate::login::auth_test_env_lock()
}

struct EnvVarGuard {
    key: &'static str,
    old: Option<std::ffi::OsString>,
}

impl EnvVarGuard {
    fn set_path(key: &'static str, value: &std::path::Path) -> Self {
        let old = std::env::var_os(key);
        unsafe { std::env::set_var(key, value) };
        Self { key, old }
    }

    fn unset(key: &'static str) -> Self {
        let old = std::env::var_os(key);
        unsafe { std::env::remove_var(key) };
        Self { key, old }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        if let Some(value) = &self.old {
            unsafe { std::env::set_var(self.key, value) };
        } else {
            unsafe { std::env::remove_var(self.key) };
        }
    }
}

#[test]
fn merge_live_model_ids_preserves_static_and_synthesizes_new_ids() {
    let registry = ModelRegistry::new();
    let static_models = registry
        .list()
        .iter()
        .filter(|model| model.provider == "openai" && model.id == "gpt-5.4")
        .cloned()
        .collect::<Vec<_>>();

    let merged = merge_live_model_ids(
        &registry,
        "openai",
        &static_models,
        vec!["gpt-5.4".to_string(), "gpt-5.5".to_string()],
    );

    assert!(merged.iter().any(|model| model.id == "gpt-5.4"));
    let live = merged
        .iter()
        .find(|model| model.id == "gpt-5.5")
        .expect("live model synthesized");
    assert_eq!(live.provider, "openai");
    assert_eq!(live.name, "gpt-5.5");
}

#[test]
fn merge_live_anthropic_models_keeps_curated_order_before_unknown_ids() {
    let registry = ModelRegistry::new();
    let static_models = registry
        .list()
        .iter()
        .filter(|model| model.provider == "anthropic")
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(static_models.len(), ANTHROPIC_SUBSCRIPTION_MODEL_IDS.len());

    let legacy_live_id = "claude-3-5-haiku-20241022";
    let merged = merge_live_model_ids(
        &registry,
        "anthropic",
        &static_models,
        vec![
            "claude-opus-4-8".to_string(),
            "claude-opus-4-8".to_string(),
            "CLAUDE-OPUS-4-8".to_string(),
            "claude-fable-5".to_string(),
            "claude-fable-5-1".to_string(),
            legacy_live_id.to_string(),
            legacy_live_id.to_string(),
        ],
    );
    let merged_ids = merged
        .iter()
        .map(|model| model.id.as_str())
        .collect::<Vec<_>>();

    assert_eq!(merged.len(), ANTHROPIC_SUBSCRIPTION_MODEL_IDS.len() + 1);
    assert_eq!(
        &merged_ids[..ANTHROPIC_SUBSCRIPTION_MODEL_IDS.len()],
        ANTHROPIC_SUBSCRIPTION_MODEL_IDS
    );
    assert_eq!(merged_ids.last(), Some(&legacy_live_id));
    let legacy = merged.last().expect("legacy live model synthesized");
    assert_eq!(legacy.provider, "anthropic");
    assert!(matches!(legacy.api, ApiType::AnthropicMessages));
    assert_eq!(
        merged_ids
            .iter()
            .filter(|model_id| model_id.eq_ignore_ascii_case("claude-opus-4-8"))
            .count(),
        1
    );
    assert!(merged_ids.contains(&"claude-opus-4-8"));
    assert_eq!(
        merged
            .iter()
            .find(|model| model.id == "claude-fable-5-1")
            .unwrap()
            .cost
            .cache_read,
        0.25,
    );
}

#[test]
fn anthropic_oauth_live_legacy_model_is_shown_and_selectable() {
    let _lock = env_lock().lock().expect("env lock");
    let home = tempfile::tempdir().expect("home tempdir");
    let _home_guard = EnvVarGuard::set_path("HOME", home.path());
    let _anthropic_api_key = EnvVarGuard::unset("ANTHROPIC_API_KEY");
    let _anthropic_oauth_token = EnvVarGuard::unset("ANTHROPIC_OAUTH_TOKEN");
    let _auth_path = EnvVarGuard::unset("KORDI_AUTH_PATH");
    let _storage_root = EnvVarGuard::unset("KORDI_STORAGE_ROOT");
    let _app_data_dir = EnvVarGuard::unset("APP_DATA_DIR");
    login::save_oauth_credentials(
        "anthropic",
        &crate::oauth::OAuthCredentials {
            access: "anthropic-oauth-access".to_string(),
            refresh: String::new(),
            expires: i64::MAX,
            extra: serde_json::json!({"accountId": "acct_test"}),
        },
    )
    .expect("save Anthropic OAuth");

    let settings = Settings::default();
    let registry = ModelRegistry::new();
    let static_models = registry
        .list()
        .iter()
        .filter(|model| model.provider == "anthropic")
        .cloned()
        .collect::<Vec<_>>();
    let auth_mode_static_models = login::model_candidates_for_provider_auth_mode(
        &registry,
        &settings,
        "anthropic",
        &static_models,
    );
    assert_eq!(
        auth_mode_static_models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        ANTHROPIC_SUBSCRIPTION_MODEL_IDS
    );

    let legacy_live_id = "claude-3-7-sonnet-20250219";
    let merged = merge_live_model_ids_with_settings(
        &registry,
        &settings,
        "anthropic",
        &auth_mode_static_models,
        vec![legacy_live_id.to_string()],
    );
    let legacy = merged
        .iter()
        .find(|model| model.id == legacy_live_id)
        .expect("legacy live model shown");
    assert_eq!(legacy.provider, "anthropic");
    assert!(matches!(legacy.api, ApiType::AnthropicMessages));
    assert!(login::model_id_allowed_for_active_auth(
        &settings,
        "anthropic",
        legacy_live_id
    ));
}

#[test]
fn accepts_provider_prefixed_model_ids_from_openai_compatible_catalogs() {
    assert!(looks_like_model_id("openai/gpt-5.5"));
    assert!(looks_like_model_id("anthropic/claude-opus-4-6"));
    assert!(looks_like_model_id("lmstudio-community/Qwen3-4B-Instruct"));
    assert!(looks_like_model_id("llama3.2:latest"));
}

#[test]
fn embedding_model_ids_are_not_chat_model_candidates() {
    assert!(looks_like_embedding_model_id(
        "text-embedding-nomic-embed-text-v1.5"
    ));
    assert!(looks_like_embedding_model_id(
        "nomic-ai/nomic-embed-text-v1.5"
    ));
    assert!(looks_like_embedding_model_id("all-minilm:latest"));
    assert!(looks_like_embedding_model_id("bge-m3:latest"));
    assert!(!looks_like_model_id("text-embedding-3-large"));
}

#[test]
fn model_id_extraction_keeps_safe_local_catalog_ids_for_provider_filtering() {
    let value = serde_json::json!({"id": "NousResearch/Hermes-3-Llama"});
    assert_eq!(
        model_id_from_json_object(&value).as_deref(),
        Some("NousResearch/Hermes-3-Llama")
    );
    assert!(!looks_like_model_id("NousResearch/Hermes-3-Llama"));
}

#[test]
fn merge_live_model_ids_synthesizes_local_providers_without_static_templates() {
    let registry = ModelRegistry::new();
    let merged = merge_live_model_ids(
        &registry,
        "lm-studio",
        &[],
        vec![
            "qwen3-coder-30b".to_string(),
            "NousResearch/Hermes-3-Llama".to_string(),
            "text-embedding-nomic-embed-text-v1.5".to_string(),
        ],
    );

    let model = merged
        .iter()
        .find(|model| model.id == "qwen3-coder-30b")
        .expect("local live model synthesized");
    assert_eq!(model.provider, "lm-studio");
    assert_eq!(model.base_url.as_deref(), Some("http://localhost:1234/v1"));
    assert!(
        merged
            .iter()
            .any(|model| model.id == "NousResearch/Hermes-3-Llama")
    );
    assert!(
        !merged
            .iter()
            .any(|model| model.id == "text-embedding-nomic-embed-text-v1.5")
    );
    assert_eq!(
        merged
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        ["NousResearch/Hermes-3-Llama", "qwen3-coder-30b"]
    );
}
