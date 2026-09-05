use super::*;
use crate::login::ProviderAuthMethod;
use crate::login::store::{AuthEntry, AuthProfile, AuthStore, save_auth};
use kordi_core::settings::{ProviderOverride, Settings};
use kordi_provider::anthropic::capabilities::{
    ANTHROPIC_SUBSCRIPTION_MODEL_IDS, DEFAULT_ANTHROPIC_MODEL_ID,
};
use std::collections::HashMap;
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

fn save_single_auth(provider: &str, method: ProviderAuthMethod) {
    let normalized = normalize_provider_for_model_selection(provider);
    let entry = match method {
        ProviderAuthMethod::OAuth => AuthEntry::OAuth {
            access: format!("{provider}-oauth-access"),
            refresh: String::new(),
            expires: i64::MAX,
            extra: serde_json::json!({"accountId": "acct_test"}),
        },
        ProviderAuthMethod::ApiKey => AuthEntry::ApiKey {
            key: format!("{provider}-api-key"),
        },
    };
    save_auth(&AuthStore {
        active_auth_methods: HashMap::from([(normalized.clone(), method)]),
        profiles: HashMap::from([(
            normalized,
            vec![AuthProfile {
                id: format!("{provider}-{:?}", method),
                method,
                created_at_ms: None,
                updated_at_ms: None,
                entry,
            }],
        )]),
        ..AuthStore::default()
    })
    .expect("save auth");
}

fn model_ids_for_provider(provider: &str) -> Vec<String> {
    authenticated_model_candidates(&Settings::default())
        .into_iter()
        .filter(|model| model.provider == provider)
        .map(|model| model.id)
        .collect()
}

fn isolated_auth_env() -> (
    tempfile::TempDir,
    EnvVarGuard,
    EnvVarGuard,
    EnvVarGuard,
    EnvVarGuard,
) {
    let home = tempfile::tempdir().expect("home tempdir");
    let home_guard = EnvVarGuard::set_path("HOME", home.path());
    let openai_env = EnvVarGuard::unset("OPENAI_API_KEY");
    let anthropic_env = EnvVarGuard::unset("ANTHROPIC_API_KEY");
    let anthropic_oauth_env = EnvVarGuard::unset("ANTHROPIC_OAUTH_TOKEN");
    (
        home,
        home_guard,
        openai_env,
        anthropic_env,
        anthropic_oauth_env,
    )
}

fn lm_studio_settings(default_model: &str) -> Settings {
    Settings {
        default_provider: Some("lm-studio".to_string()),
        default_model: Some(default_model.to_string()),
        providers: Some(vec![ProviderOverride {
            name: "lm-studio".to_string(),
            base_url: Some("http://localhost:1234/v1".to_string()),
            api_key_env: None,
            api: None,
            headers: None,
        }]),
        ..Settings::default()
    }
}

#[test]
fn local_default_model_with_publisher_slash_keeps_lm_studio_provider() {
    assert_eq!(
        preferred_startup_provider_and_model(&lm_studio_settings("google/gemma-4-e4b")),
        Some((
            "lm-studio".to_string(),
            "lm-studio/google/gemma-4-e4b".to_string(),
        )),
    );
}

#[test]
fn local_default_model_does_not_double_prefix_provider() {
    assert_eq!(
        preferred_startup_provider_and_model(&lm_studio_settings("lm-studio/google/gemma-4-e4b")),
        Some((
            "lm-studio".to_string(),
            "lm-studio/google/gemma-4-e4b".to_string(),
        )),
    );
}

#[test]
fn openai_codex_oauth_candidates_exclude_platform_only_models() {
    let _lock = env_lock().lock().expect("env lock");
    let (_home, _home_guard, _openai_env, _anthropic_env, _anthropic_oauth_env) =
        isolated_auth_env();
    save_single_auth("openai-codex", ProviderAuthMethod::OAuth);

    let model_ids = model_ids_for_provider("openai");

    assert_eq!(
        model_ids,
        [
            "gpt-6-astra",
            "gpt-5.6-luna",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.5",
            "gpt-5.4-mini",
            "gpt-5.4",
            "gpt-5.3-codex-spark",
        ]
    );
    assert!(!model_ids.contains(&"gpt-5.6".to_string()));
    assert!(!model_ids.contains(&"gpt-4o-mini".to_string()));
    assert!(!model_ids.contains(&"gpt-5".to_string()));
    assert!(!model_ids.contains(&"gpt-5-mini".to_string()));
    assert!(model_id_allowed_for_active_auth(
        &Settings::default(),
        "openai",
        "gpt-5.4"
    ));
    assert!(!model_id_allowed_for_active_auth(
        &Settings::default(),
        "openai",
        "gpt-5"
    ));
    assert_eq!(
        available_model_for_provider(&Settings::default(), "openai", Some("gpt-5")),
        Some("gpt-5.6-sol".to_string()),
    );
    assert_eq!(
        available_model_for_provider(&Settings::default(), "openai", Some("gpt-5.4")),
        Some("gpt-5.4".to_string()),
    );
    assert_eq!(
        available_model_for_provider(&Settings::default(), "openai", Some("gpt-5.2")),
        Some("gpt-5.6-sol".to_string()),
    );
}

#[test]
fn openai_api_key_candidates_keep_platform_models() {
    let _lock = env_lock().lock().expect("env lock");
    let (_home, _home_guard, _openai_env, _anthropic_env, _anthropic_oauth_env) =
        isolated_auth_env();
    save_single_auth("openai", ProviderAuthMethod::ApiKey);

    let model_ids = model_ids_for_provider("openai");

    assert!(model_ids.contains(&"gpt-4o-mini".to_string()));
    assert!(model_ids.contains(&"gpt-5".to_string()));
    assert!(model_ids.contains(&"gpt-5.5".to_string()));
    assert_eq!(
        available_model_for_provider(&Settings::default(), "openai", None),
        Some("gpt-5.6-sol".to_string()),
    );
}

#[test]
fn anthropic_oauth_candidates_follow_shared_subscription_catalog() {
    let _lock = env_lock().lock().expect("env lock");
    let (_home, _home_guard, _openai_env, _anthropic_env, _anthropic_oauth_env) =
        isolated_auth_env();
    save_single_auth("anthropic", ProviderAuthMethod::OAuth);

    let model_ids = model_ids_for_provider("anthropic");

    assert_eq!(
        model_ids,
        ANTHROPIC_SUBSCRIPTION_MODEL_IDS
            .iter()
            .map(|id| (*id).to_string())
            .collect::<Vec<_>>()
    );
    for model_id in ANTHROPIC_SUBSCRIPTION_MODEL_IDS {
        assert!(model_id_allowed_for_active_auth(
            &Settings::default(),
            "anthropic",
            model_id
        ));
    }
    assert_eq!(
        available_model_for_provider(&Settings::default(), "anthropic", Some("claude-sonnet-5")),
        Some("claude-sonnet-5".to_string())
    );
    assert_eq!(
        available_model_for_provider(
            &Settings::default(),
            "anthropic",
            Some("claude-3-5-haiku-20241022")
        ),
        Some(DEFAULT_ANTHROPIC_MODEL_ID.to_string())
    );
    assert_eq!(
        available_model_for_provider(
            &Settings::default(),
            "anthropic",
            Some("claude-unsupported-live-id")
        ),
        Some(DEFAULT_ANTHROPIC_MODEL_ID.to_string())
    );
}

#[test]
fn anthropic_oauth_allows_safe_claude_ids_and_rejects_malformed_ids() {
    let _lock = env_lock().lock().expect("env lock");
    let (_home, _home_guard, _openai_env, _anthropic_env, _anthropic_oauth_env) =
        isolated_auth_env();
    save_single_auth("anthropic", ProviderAuthMethod::OAuth);

    for model_id in [
        "claude-opus-4-8",
        "claude-3-7-sonnet-20250219",
        "  claude-saved_legacy.1  ",
    ] {
        assert!(
            model_id_allowed_for_active_auth(&Settings::default(), "anthropic", model_id),
            "{model_id}"
        );
    }
    for model_id in [
        "",
        "   ",
        "claude-",
        "gpt-5.5",
        "claude-opus/4-8",
        "claude-opus 4-8",
        "claude-opus@4-8",
    ] {
        assert!(
            !model_id_allowed_for_active_auth(&Settings::default(), "anthropic", model_id),
            "{model_id}"
        );
    }
}

#[test]
fn anthropic_api_key_candidates_follow_shared_registry_and_default() {
    let _lock = env_lock().lock().expect("env lock");
    let (_home, _home_guard, _openai_env, _anthropic_env, _anthropic_oauth_env) =
        isolated_auth_env();
    save_single_auth("anthropic", ProviderAuthMethod::ApiKey);

    let model_ids = model_ids_for_provider("anthropic");

    assert_eq!(
        model_ids,
        ANTHROPIC_SUBSCRIPTION_MODEL_IDS
            .iter()
            .map(|id| (*id).to_string())
            .collect::<Vec<_>>()
    );
    assert!(!model_ids.contains(&"claude-3-5-haiku-20241022".to_string()));
    assert!(!model_ids.contains(&"claude-haiku-4-20260115".to_string()));
    assert_eq!(
        available_model_for_provider(&Settings::default(), "anthropic", None),
        Some(DEFAULT_ANTHROPIC_MODEL_ID.to_string())
    );
}

#[test]
fn anthropic_catalog_rank_uses_shared_subscription_order() {
    for (rank, id) in ANTHROPIC_SUBSCRIPTION_MODEL_IDS.iter().enumerate() {
        assert_eq!(model_catalog_rank("anthropic", id), rank);
    }
    assert_eq!(
        model_catalog_rank("anthropic", "claude-unknown-live-id"),
        usize::MAX
    );
    assert_eq!(
        model_catalog_rank("anthropic", "CLAUDE-OPUS-4-8"),
        usize::MAX
    );
    assert_eq!(model_catalog_rank("openai", "GPT-5.5"), 4);
    assert_eq!(model_catalog_rank("google", "claude-opus-4-8"), usize::MAX);
}

#[test]
fn startup_fallback_uses_codex_compatible_model_when_openai_oauth_is_active() {
    let _lock = env_lock().lock().expect("env lock");
    let (_home, _home_guard, _openai_env, _anthropic_env, _anthropic_oauth_env) =
        isolated_auth_env();
    save_single_auth("openai-codex", ProviderAuthMethod::OAuth);
    let settings = Settings {
        default_provider: Some("openai".to_string()),
        default_model: Some("gpt-5".to_string()),
        ..Settings::default()
    };

    assert_eq!(
        preferred_startup_provider_and_model(&settings),
        Some(("openai".to_string(), "gpt-5.6-sol".to_string())),
    );

    let explicit_settings = Settings {
        default_provider: Some("openai".to_string()),
        default_model: Some("gpt-5.4".to_string()),
        ..Settings::default()
    };
    assert_eq!(
        preferred_startup_provider_and_model(&explicit_settings),
        Some(("openai".to_string(), "gpt-5.4".to_string())),
    );
}
