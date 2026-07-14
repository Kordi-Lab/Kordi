use super::*;
use std::collections::HashSet;

const OPENAI_CODEX_OAUTH_MODEL_IDS: &[&str] = &[
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.5",
    "gpt-5.4-mini",
    "gpt-5.4",
    "gpt-5.3-codex-spark",
];

pub fn model_catalog_rank(provider: &str, model_id: &str) -> usize {
    if normalize_provider_for_model_selection(provider) == "openai" {
        OPENAI_CODEX_OAUTH_MODEL_IDS
            .iter()
            .position(|id| id.eq_ignore_ascii_case(model_id))
            .unwrap_or(usize::MAX)
    } else {
        usize::MAX
    }
}

const ANTHROPIC_OAUTH_MODEL_IDS: &[&str] = &[
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-opus-4-20260115",
    "claude-sonnet-4-20260115",
    "claude-opus-4-20250514",
    "claude-sonnet-4-20250514",
    "claude-3-7-sonnet-20250219",
];

fn active_oauth_model_ids_for_provider(
    settings: &Settings,
    provider: &str,
) -> Option<&'static [&'static str]> {
    let normalized = normalize_provider_for_model_selection(provider);
    let auth_method = resolve_provider_auth(&normalized)
        .map(|auth| auth.method)
        .or_else(|| active_auth_method(&normalized));
    if auth_method != Some(ProviderAuthMethod::OAuth) {
        return None;
    }

    if !provider_configured_for_settings(settings, &normalized) {
        return None;
    }

    match normalized.as_str() {
        "openai" => Some(OPENAI_CODEX_OAUTH_MODEL_IDS),
        "anthropic" => Some(ANTHROPIC_OAUTH_MODEL_IDS),
        _ => None,
    }
}

#[cfg_attr(not(feature = "desktop-runtime"), allow(dead_code))]
pub fn model_id_allowed_for_active_auth(
    settings: &Settings,
    provider: &str,
    model_id: &str,
) -> bool {
    active_oauth_model_ids_for_provider(settings, provider)
        .map(|ids| {
            ids.iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(model_id.trim()))
        })
        .unwrap_or(true)
}

pub fn model_candidates_for_provider_auth_mode(
    registry: &ModelRegistry,
    settings: &Settings,
    provider: &str,
    static_models: &[Model],
) -> Vec<Model> {
    let normalized = normalize_provider_for_model_selection(provider);
    if let Some(model_ids) = active_oauth_model_ids_for_provider(settings, &normalized) {
        return model_ids
            .iter()
            .map(|model_id| {
                crate::runtime_model::resolve_or_synthesize_model_with_settings(
                    registry,
                    settings,
                    &normalized,
                    model_id,
                )
            })
            .collect();
    }

    static_models.to_vec()
}

pub fn authenticated_model_candidates(settings: &Settings) -> Vec<Model> {
    let available = authenticated_providers_for_settings(settings);
    if available.is_empty() {
        return Vec::new();
    }

    let mut registry = ModelRegistry::new();
    registry.load_custom_models(settings);
    add_cached_github_copilot_models(&mut registry);

    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for provider in available {
        let static_models = registry
            .list()
            .iter()
            .filter(|model| model.provider == provider)
            .cloned()
            .collect::<Vec<_>>();
        for model in
            model_candidates_for_provider_auth_mode(&registry, settings, &provider, &static_models)
        {
            if seen.insert((model.provider.clone(), model.id.clone())) {
                models.push(model);
            }
        }
    }
    models
}

fn resolve_available_model_for_provider(
    settings: &Settings,
    provider: &str,
    requested_model: Option<&str>,
) -> Option<String> {
    let provider = normalize_provider_for_model_selection(provider);
    let candidates = authenticated_model_candidates(settings);
    if !candidates.iter().any(|model| model.provider == provider) {
        return None;
    }

    if let Some(requested_model) = requested_model
        && let Some(model) = candidates.iter().find(|model| {
            model.provider == provider
                && (model.id.eq_ignore_ascii_case(requested_model)
                    || model.name.eq_ignore_ascii_case(requested_model))
        })
    {
        return Some(model.id.clone());
    }

    if let Some(preferred) = preferred_model_for_provider(&provider)
        && let Some(model) = candidates.iter().find(|model| {
            model.provider == provider
                && (model.id.eq_ignore_ascii_case(&preferred)
                    || model.name.eq_ignore_ascii_case(&preferred))
        })
    {
        return Some(model.id.clone());
    }

    candidates
        .into_iter()
        .find(|model| model.provider == provider)
        .map(|model| model.id)
}

pub fn available_model_for_provider(
    settings: &Settings,
    provider: &str,
    requested_model: Option<&str>,
) -> Option<String> {
    resolve_available_model_for_provider(settings, provider, requested_model)
}

pub fn preferred_available_model_for_provider(
    settings: &Settings,
    provider: &str,
) -> Option<String> {
    available_model_for_provider(settings, provider, None)
}

fn provider_prefixed_model_arg(provider: &str, model: &str) -> String {
    let trimmed = model.trim();
    if trimmed
        .strip_prefix(provider)
        .is_some_and(|rest| rest.starts_with('/'))
    {
        trimmed.to_string()
    } else {
        format!("{provider}/{trimmed}")
    }
}

fn preferred_model_for_provider(provider: &str) -> Option<String> {
    match provider {
        "anthropic" => Some("claude-opus-4-6".to_string()),
        "openai" | "openai-codex" => Some("gpt-5.5".to_string()),
        "google" => Some("gemini-3.1-pro".to_string()),
        "github-copilot" => {
            let cached = github_copilot_cached_models();
            cached
                .iter()
                .find(|id| id.contains("opus-4-6"))
                .cloned()
                .or_else(|| cached.iter().find(|id| id.contains("opus")).cloned())
                .or_else(|| Some("claude-opus-4-6".to_string()))
        }
        _ => None,
    }
}

pub fn preferred_startup_provider_and_model(
    settings: &kordi_core::settings::Settings,
) -> Option<(String, String)> {
    // If the user explicitly configured a default local provider/model, honor it
    // before registry checks. Local model ids often contain a publisher slash
    // (for example google/gemma-4-e4b), so return a provider-prefixed model arg
    // to prevent generic provider/model parsing from treating "google" as the
    // runtime provider.
    if let Some(provider) = settings.default_provider.as_deref() {
        let normalized = normalize_provider_for_model_selection(provider);
        if is_local_openai_provider(&normalized)
            && provider_configured_for_settings(settings, &normalized)
            && let Some(model) = settings
                .default_model
                .as_deref()
                .map(str::trim)
                .filter(|model| !model.is_empty())
        {
            return Some((
                normalized.clone(),
                provider_prefixed_model_arg(&normalized, model),
            ));
        }
        if let Some(model) = resolve_available_model_for_provider(
            settings,
            &normalized,
            settings.default_model.as_deref(),
        ) {
            return Some((normalized, model));
        }
    }

    // Otherwise prefer OpenAI first when it is authenticated, so the app's
    // startup default follows the active OpenAI auth path (ChatGPT OAuth prefers gpt-5.5).
    let openai_preferred = preferred_model_for_provider("openai");
    if let Some(model) =
        resolve_available_model_for_provider(settings, "openai", openai_preferred.as_deref())
    {
        return Some(("openai".to_string(), model));
    }
    if let Some(model) =
        resolve_available_model_for_provider(settings, "openai-codex", openai_preferred.as_deref())
    {
        return Some(("openai-codex".to_string(), model));
    }

    // Next prefer the most recently-used provider, if still authenticated.
    if let Some(provider) = load_auth().last_provider {
        let normalized = normalize_provider_for_model_selection(&provider);
        let requested_model = if settings.default_provider.as_deref() == Some(provider.as_str())
            || settings.default_provider.as_deref() == Some(normalized.as_str())
        {
            settings.default_model.as_deref()
        } else {
            None
        };
        if let Some(model) =
            resolve_available_model_for_provider(settings, &normalized, requested_model)
        {
            return Some((normalized, model));
        }
    }

    for provider in authenticated_providers_for_settings(settings) {
        if let Some(model) = preferred_available_model_for_provider(settings, &provider) {
            return Some((provider, model));
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::login::ProviderAuthMethod;
    use crate::login::store::{AuthEntry, AuthProfile, AuthStore, save_auth};
    use kordi_core::settings::{ProviderOverride, Settings};
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

    fn isolated_auth_env() -> (tempfile::TempDir, EnvVarGuard, EnvVarGuard, EnvVarGuard) {
        let home = tempfile::tempdir().expect("home tempdir");
        let home_guard = EnvVarGuard::set_path("HOME", home.path());
        let openai_env = EnvVarGuard::unset("OPENAI_API_KEY");
        let anthropic_env = EnvVarGuard::unset("ANTHROPIC_API_KEY");
        (home, home_guard, openai_env, anthropic_env)
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
            preferred_startup_provider_and_model(&lm_studio_settings(
                "lm-studio/google/gemma-4-e4b"
            )),
            Some((
                "lm-studio".to_string(),
                "lm-studio/google/gemma-4-e4b".to_string(),
            )),
        );
    }

    #[test]
    fn openai_codex_oauth_candidates_exclude_platform_only_models() {
        let _lock = env_lock().lock().expect("env lock");
        let (_home, _home_guard, _openai_env, _anthropic_env) = isolated_auth_env();
        save_single_auth("openai-codex", ProviderAuthMethod::OAuth);

        let model_ids = model_ids_for_provider("openai");

        assert_eq!(
            model_ids,
            [
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
        assert_eq!(
            available_model_for_provider(&Settings::default(), "openai", Some("gpt-5")),
            Some("gpt-5.5".to_string()),
        );
        assert_eq!(
            available_model_for_provider(&Settings::default(), "openai", Some("gpt-5.4")),
            Some("gpt-5.4".to_string()),
        );
        assert_eq!(
            available_model_for_provider(&Settings::default(), "openai", Some("gpt-5.2")),
            Some("gpt-5.5".to_string()),
        );
    }

    #[test]
    fn openai_api_key_candidates_keep_platform_models() {
        let _lock = env_lock().lock().expect("env lock");
        let (_home, _home_guard, _openai_env, _anthropic_env) = isolated_auth_env();
        save_single_auth("openai", ProviderAuthMethod::ApiKey);

        let model_ids = model_ids_for_provider("openai");

        assert!(model_ids.contains(&"gpt-4o-mini".to_string()));
        assert!(model_ids.contains(&"gpt-5".to_string()));
        assert!(model_ids.contains(&"gpt-5.5".to_string()));
        assert_eq!(
            available_model_for_provider(&Settings::default(), "openai", None),
            Some("gpt-5.5".to_string()),
        );
    }

    #[test]
    fn anthropic_oauth_candidates_exclude_api_only_models() {
        let _lock = env_lock().lock().expect("env lock");
        let (_home, _home_guard, _openai_env, _anthropic_env) = isolated_auth_env();
        save_single_auth("anthropic", ProviderAuthMethod::OAuth);

        let model_ids = model_ids_for_provider("anthropic");

        assert!(model_ids.contains(&"claude-opus-4-7".to_string()));
        assert!(model_ids.contains(&"claude-opus-4-6".to_string()));
        assert!(model_ids.contains(&"claude-sonnet-4-6".to_string()));
        assert!(model_id_allowed_for_active_auth(
            &Settings::default(),
            "anthropic",
            "claude-opus-4-7"
        ));
        assert!(!model_ids.contains(&"claude-3-5-haiku-20241022".to_string()));
        assert!(!model_ids.contains(&"claude-haiku-4-20260115".to_string()));
    }

    #[test]
    fn anthropic_api_key_candidates_keep_platform_models() {
        let _lock = env_lock().lock().expect("env lock");
        let (_home, _home_guard, _openai_env, _anthropic_env) = isolated_auth_env();
        save_single_auth("anthropic", ProviderAuthMethod::ApiKey);

        let model_ids = model_ids_for_provider("anthropic");

        assert!(model_ids.contains(&"claude-3-5-haiku-20241022".to_string()));
        assert!(model_ids.contains(&"claude-haiku-4-20260115".to_string()));
        assert!(model_ids.contains(&"claude-opus-4-6".to_string()));
    }

    #[test]
    fn startup_fallback_uses_codex_compatible_model_when_openai_oauth_is_active() {
        let _lock = env_lock().lock().expect("env lock");
        let (_home, _home_guard, _openai_env, _anthropic_env) = isolated_auth_env();
        save_single_auth("openai-codex", ProviderAuthMethod::OAuth);
        let settings = Settings {
            default_provider: Some("openai".to_string()),
            default_model: Some("gpt-5".to_string()),
            ..Settings::default()
        };

        assert_eq!(
            preferred_startup_provider_and_model(&settings),
            Some(("openai".to_string(), "gpt-5.5".to_string())),
        );
    }
}
