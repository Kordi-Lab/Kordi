use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderAuthOptionSummary {
    pub profile_id: Option<String>,
    pub method: ProviderAuthMethod,
    pub source: AuthSource,
    pub account_label: Option<String>,
    pub authority: Option<String>,
    pub configured_at_ms: Option<i64>,
    pub updated_at_ms: Option<i64>,
    pub active: bool,
}

fn env_auth_methods_for_provider(provider: &str) -> Vec<ProviderAuthMethod> {
    match normalize_provider_for_model_selection(provider).as_str() {
        "anthropic" => {
            let mut methods = Vec::new();
            if env_value_is_set("ANTHROPIC_OAUTH_TOKEN") {
                methods.push(ProviderAuthMethod::OAuth);
            }
            if env_value_is_set("ANTHROPIC_API_KEY") {
                methods.push(ProviderAuthMethod::ApiKey);
            }
            methods
        }
        "openai" | "openai-codex" => std::env::var("OPENAI_API_KEY")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
            .then_some(ProviderAuthMethod::ApiKey)
            .into_iter()
            .collect(),
        "github-copilot" => ["GH_COPILOT_TOKEN", "GITHUB_COPILOT_TOKEN"]
            .iter()
            .any(|key| {
                std::env::var(key)
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false)
            })
            .then_some(ProviderAuthMethod::OAuth)
            .into_iter()
            .collect(),
        other => {
            let env_keys: &[&str] = match other {
                "lm-studio" => &["LM_STUDIO_API_KEY"],
                "ollama" => &["OLLAMA_API_KEY"],
                "google" => &["GOOGLE_API_KEY", "GEMINI_API_KEY"],
                "groq" => &["GROQ_API_KEY"],
                "xai" => &["XAI_API_KEY"],
                "openrouter" => &["OPENROUTER_API_KEY"],
                _ => &[],
            };
            env_keys
                .iter()
                .any(|key| {
                    std::env::var(key)
                        .map(|value| !value.trim().is_empty())
                        .unwrap_or(false)
                })
                .then_some(ProviderAuthMethod::ApiKey)
                .into_iter()
                .collect()
        }
    }
}

fn env_value_is_set(key: &str) -> bool {
    std::env::var(key)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

pub fn provider_auth_option_summaries(provider: &str) -> Vec<ProviderAuthOptionSummary> {
    let normalized = normalize_provider_for_model_selection(provider);
    let store = load_auth();
    let active_env_method = store.active_env_auth_methods.get(&normalized).copied();
    let mut options = stored_auth_profiles(&normalized)
        .into_iter()
        .map(|profile| ProviderAuthOptionSummary {
            profile_id: Some(profile.profile_id),
            method: profile.method,
            source: AuthSource::KordiAuth,
            account_label: profile.account_label,
            authority: profile.authority,
            configured_at_ms: profile.configured_at_ms,
            updated_at_ms: profile.updated_at_ms,
            active: profile.active,
        })
        .collect::<Vec<_>>();

    let stored_methods = stored_auth_methods(&normalized);
    let env_methods = env_auth_methods_for_provider(&normalized);
    let selected_env_method = active_env_method.filter(|method| env_methods.contains(method));
    let active_method = selected_env_method
        .or_else(|| active_auth_method(&normalized))
        .or_else(|| env_methods.first().copied());
    for method in env_methods {
        let active = selected_env_method == Some(method)
            || (active_env_method.is_none()
                && stored_methods.is_empty()
                && active_method == Some(method));
        options.push(ProviderAuthOptionSummary {
            profile_id: None,
            method,
            source: AuthSource::EnvVar,
            account_label: None,
            authority: None,
            configured_at_ms: None,
            updated_at_ms: None,
            active,
        });
    }

    options.sort_by(|left, right| {
        right
            .active
            .cmp(&left.active)
            .then_with(|| match (left.source, right.source) {
                (AuthSource::KordiAuth, AuthSource::EnvVar) => std::cmp::Ordering::Less,
                (AuthSource::EnvVar, AuthSource::KordiAuth) => std::cmp::Ordering::Greater,
                _ => std::cmp::Ordering::Equal,
            })
            .then_with(|| {
                right
                    .configured_at_ms
                    .or(right.updated_at_ms)
                    .unwrap_or_default()
                    .cmp(
                        &left
                            .configured_at_ms
                            .or(left.updated_at_ms)
                            .unwrap_or_default(),
                    )
            })
            .then_with(|| left.method.label().cmp(right.method.label()))
    });
    options
}

fn auth_methods_for_provider(provider: &str) -> (bool, bool) {
    let stored = stored_auth_methods(provider);
    let env = env_auth_methods_for_provider(provider);
    let has_oauth =
        stored.contains(&ProviderAuthMethod::OAuth) || env.contains(&ProviderAuthMethod::OAuth);
    let has_api_key =
        stored.contains(&ProviderAuthMethod::ApiKey) || env.contains(&ProviderAuthMethod::ApiKey);
    (has_oauth, has_api_key)
}

fn format_configured_time(timestamp_ms: Option<i64>) -> Option<String> {
    let timestamp_ms = timestamp_ms?;
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(timestamp_ms)
        .map(|dt| dt.format("%Y-%m-%d %H:%M UTC").to_string())
}

fn render_auth_option_summary(summary: &ProviderAuthOptionSummary) -> String {
    let mut parts = Vec::new();
    match (summary.method, summary.source) {
        (ProviderAuthMethod::ApiKey, AuthSource::EnvVar) => parts.push("API key (env)".to_string()),
        (ProviderAuthMethod::ApiKey, AuthSource::KordiAuth) => parts.push("API key".to_string()),
        (ProviderAuthMethod::OAuth, AuthSource::EnvVar) => parts.push("OAuth (env)".to_string()),
        (ProviderAuthMethod::OAuth, AuthSource::KordiAuth) => parts.push("OAuth".to_string()),
    }
    if let Some(account_label) = &summary.account_label {
        parts.push(account_label.clone());
    }
    if matches!(summary.source, AuthSource::KordiAuth)
        && matches!(summary.method, ProviderAuthMethod::ApiKey)
        && let Some(profile_id) = &summary.profile_id
    {
        let suffix = profile_id
            .chars()
            .rev()
            .take(6)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<String>();
        parts.push(format!("profile {suffix}"));
    }
    if let Some(authority) = &summary.authority {
        parts.push(authority.clone());
    }
    if let Some(saved_at) =
        format_configured_time(summary.configured_at_ms.or(summary.updated_at_ms))
    {
        parts.push(format!("saved {saved_at}"));
    }
    let detail = parts.join(" • ");
    if summary.active {
        format!("active: {detail}")
    } else {
        detail
    }
}

pub fn provider_model_selection_detail(provider: &str) -> String {
    let options = provider_auth_option_summaries(provider);
    if options.is_empty() {
        if provider_allows_no_auth(provider, local_openai_provider_base_url(provider)) {
            return "[local endpoint; no API key required]".to_string();
        }
        return "[not authenticated]".to_string();
    }
    options
        .iter()
        .map(render_auth_option_summary)
        .collect::<Vec<_>>()
        .join(" | ")
}

pub fn provider_auth_status_summary(provider: &str) -> String {
    let (has_oauth, has_api_key) = auth_methods_for_provider(provider);
    let active = provider_auth_option_summaries(provider)
        .into_iter()
        .find(|summary| summary.active)
        .map(|summary| summary.method)
        .or_else(|| active_auth_method(provider));
    let base = if has_oauth && has_api_key {
        "[OAuth + API key configured]".to_string()
    } else if has_oauth {
        "[OAuth configured]".to_string()
    } else if has_api_key {
        "[API key configured]".to_string()
    } else if provider_allows_no_auth(provider, local_openai_provider_base_url(provider)) {
        "[local endpoint; no API key required]".to_string()
    } else {
        "[not authenticated]".to_string()
    };

    match active {
        Some(method) if has_oauth && has_api_key => {
            format!("{base} • active: {}", method.label())
        }
        _ => base,
    }
}

pub fn add_cached_github_copilot_models(registry: &mut ModelRegistry) {
    for model_id in github_copilot_cached_models() {
        if registry.find("github-copilot", &model_id).is_none() {
            registry.add(Model {
                id: model_id.clone(),
                name: model_id.clone(),
                provider: "github-copilot".to_string(),
                api: kordi_provider::registry::ApiType::OpenaiCompletions,
                context_window: 128_000,
                max_tokens: 16_384,
                reasoning: true,
                input: vec![kordi_provider::registry::ModelInput::Text],
                base_url: Some(github_copilot_api_base_url()),
                cost: Default::default(),
            });
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthSource {
    KordiAuth,
    EnvVar,
}

impl AuthSource {
    pub fn label(self) -> &'static str {
        match self {
            AuthSource::KordiAuth => "kordi auth.json",
            AuthSource::EnvVar => "environment",
        }
    }
}

pub fn auth_source(provider: &str) -> Option<AuthSource> {
    let store = load_auth();
    let normalized = normalize_provider_for_model_selection(provider);
    let env_methods = env_auth_methods_for_provider(&normalized);
    if store
        .active_env_auth_methods
        .get(&normalized)
        .is_some_and(|method| env_methods.contains(method))
    {
        return Some(AuthSource::EnvVar);
    }
    if !stored_auth_methods_for_store(&store, provider).is_empty() {
        return Some(AuthSource::KordiAuth);
    }
    if !env_methods.is_empty() {
        return Some(AuthSource::EnvVar);
    }
    None
}

pub fn provider_has_auth(provider: &str) -> bool {
    auth_source(provider).is_some()
        || provider_allows_no_auth(provider, local_openai_provider_base_url(provider))
}

fn push_unique_provider(out: &mut Vec<String>, provider: &str) {
    let normalized = normalize_provider_for_model_selection(provider);
    if !out.iter().any(|existing| existing == &normalized) {
        out.push(normalized);
    }
}

fn settings_provider_base_url<'a>(settings: &'a Settings, provider: &str) -> Option<&'a str> {
    settings.providers.as_ref()?.iter().find_map(|configured| {
        provider_names_match(provider, &configured.name)
            .then_some(configured.base_url.as_deref())
            .flatten()
    })
}

fn settings_model_base_url<'a>(settings: &'a Settings, provider: &str) -> Option<&'a str> {
    settings.models.as_ref()?.iter().find_map(|model| {
        provider_names_match(provider, &model.provider)
            .then_some(model.base_url.as_deref())
            .flatten()
    })
}

fn settings_provider_has_env_auth(settings: &Settings, provider: &str) -> bool {
    settings.providers.as_ref().is_some_and(|providers| {
        providers.iter().any(|configured| {
            provider_names_match(provider, &configured.name)
                && configured.api_key_env.as_deref().is_some_and(|env_key| {
                    std::env::var(env_key)
                        .map(|value| !value.trim().is_empty())
                        .unwrap_or(false)
                })
        })
    })
}

pub fn provider_configured_for_settings(settings: &Settings, provider: &str) -> bool {
    provider_has_auth(provider)
        || settings_provider_has_env_auth(settings, provider)
        || provider_allows_no_auth(
            provider,
            settings_provider_base_url(settings, provider)
                .or_else(|| settings_model_base_url(settings, provider))
                .or_else(|| local_openai_provider_base_url(provider)),
        )
}

pub fn authenticated_providers() -> Vec<String> {
    let mut out = Vec::new();
    for provider in known_providers().iter().map(|(name, _, _)| *name) {
        if provider_has_auth(provider) {
            push_unique_provider(&mut out, provider);
        }
    }
    out
}

pub fn authenticated_providers_for_settings(settings: &Settings) -> Vec<String> {
    let mut out = authenticated_providers();

    if let Some(providers) = &settings.providers {
        for provider in providers {
            if provider_configured_for_settings(settings, &provider.name) {
                push_unique_provider(&mut out, &provider.name);
            }
        }
    }

    if let Some(models) = &settings.models {
        for model in models {
            if provider_configured_for_settings(settings, &model.provider) {
                push_unique_provider(&mut out, &model.provider);
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::{
        AuthSource, auth_source, authenticated_providers_for_settings,
        provider_auth_option_summaries, provider_auth_status_summary,
        provider_configured_for_settings, provider_model_selection_detail,
    };
    use crate::login::ProviderAuthMethod;
    use kordi_core::settings::{ProviderOverride, Settings};
    use serde_json::json;
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

        fn set_value(key: &'static str, value: &str) -> Self {
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

    #[test]
    fn anthropic_environment_options_report_oauth_precedence_and_both_methods() {
        let _lock = env_lock().lock().unwrap();
        let home = tempfile::tempdir().expect("home tempdir");
        let _home = EnvVarGuard::set_path("HOME", home.path());
        let _auth_path = EnvVarGuard::unset("KORDI_AUTH_PATH");
        let _storage_root = EnvVarGuard::unset("KORDI_STORAGE_ROOT");
        let _app_data_dir = EnvVarGuard::unset("APP_DATA_DIR");
        let _oauth = EnvVarGuard::set_value("ANTHROPIC_OAUTH_TOKEN", "env-oauth-token");
        let _api_key = EnvVarGuard::set_value("ANTHROPIC_API_KEY", "env-api-key");

        let summaries = provider_auth_option_summaries("anthropic");
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].source, AuthSource::EnvVar);
        assert_eq!(summaries[0].method, ProviderAuthMethod::OAuth);
        assert!(summaries[0].active);
        assert_eq!(summaries[1].source, AuthSource::EnvVar);
        assert_eq!(summaries[1].method, ProviderAuthMethod::ApiKey);
        assert!(!summaries[1].active);
        assert_eq!(
            provider_auth_status_summary("anthropic"),
            "[OAuth + API key configured] • active: OAuth"
        );
        let detail = provider_model_selection_detail("anthropic");
        assert!(detail.contains("active: OAuth (env)"));
        assert!(detail.contains("API key (env)"));
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
    fn provider_model_selection_detail_lists_env_and_saved_profiles() {
        let _lock = env_lock().lock().unwrap();
        let home = tempfile::tempdir().expect("home tempdir");
        let _home = EnvVarGuard::set_path("HOME", home.path());
        let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "openai-env-key");

        crate::login::save_oauth_credentials(
            "openai-codex",
            &crate::oauth::OAuthCredentials {
                access: "oauth-access".to_string(),
                refresh: "refresh-token".to_string(),
                expires: i64::MAX,
                extra: json!({"accountId": "acct_primary"}),
            },
        )
        .expect("save oauth credentials");

        let detail = provider_model_selection_detail("openai");
        assert!(detail.contains("active: OAuth • acct_primary • saved "));
        assert!(detail.contains("API key (env)"));
    }

    #[test]
    fn local_openai_providers_are_available_without_saved_auth() {
        let settings = Settings::default();

        assert_eq!(
            provider_model_selection_detail("lm-studio"),
            "[local endpoint; no API key required]"
        );
        assert_eq!(
            provider_auth_status_summary("ollama"),
            "[local endpoint; no API key required]"
        );
        assert!(provider_configured_for_settings(&settings, "lm-studio"));
        assert!(
            authenticated_providers_for_settings(&settings)
                .iter()
                .any(|provider| provider == "lm-studio")
        );
    }

    #[test]
    fn loopback_provider_settings_are_available_without_api_keys() {
        let settings = Settings {
            providers: Some(vec![ProviderOverride {
                name: "vllm-local".to_string(),
                base_url: Some("http://localhost:8000/v1".to_string()),
                api_key_env: None,
                api: Some("openai".to_string()),
                headers: None,
            }]),
            ..Settings::default()
        };

        assert!(provider_configured_for_settings(&settings, "vllm-local"));
        assert!(
            authenticated_providers_for_settings(&settings)
                .iter()
                .any(|provider| provider == "vllm-local")
        );
    }

    #[test]
    fn provider_auth_option_summaries_report_saved_profile_metadata() {
        let _lock = env_lock().lock().unwrap();
        let home = tempfile::tempdir().expect("home tempdir");
        let _home = EnvVarGuard::set_path("HOME", home.path());

        crate::login::save_oauth_credentials(
            "github-copilot",
            &crate::oauth::OAuthCredentials {
                access: "oauth-access".to_string(),
                refresh: "refresh-token".to_string(),
                expires: i64::MAX,
                extra: json!({"domain": "github.example.com", "login": "octocat"}),
            },
        )
        .expect("save oauth credentials");

        let summaries = provider_auth_option_summaries("github-copilot");
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].source, AuthSource::KordiAuth);
        assert_eq!(summaries[0].method, ProviderAuthMethod::OAuth);
        assert_eq!(summaries[0].account_label.as_deref(), Some("octocat"));
        assert_eq!(
            summaries[0].authority.as_deref(),
            Some("github.example.com")
        );
        assert!(summaries[0].configured_at_ms.is_some());
        assert!(summaries[0].active);
    }

    #[test]
    fn provider_auth_status_summary_keeps_compact_method_summary() {
        let _lock = env_lock().lock().unwrap();
        let home = tempfile::tempdir().expect("home tempdir");
        let _home = EnvVarGuard::set_path("HOME", home.path());
        let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "openai-env-key");

        crate::login::save_oauth_credentials(
            "openai-codex",
            &crate::oauth::OAuthCredentials {
                access: "oauth-access".to_string(),
                refresh: "refresh-token".to_string(),
                expires: i64::MAX,
                extra: json!({"accountId": "acct_primary"}),
            },
        )
        .expect("save oauth credentials");

        assert_eq!(
            provider_auth_status_summary("openai"),
            "[OAuth + API key configured] • active: OAuth"
        );
    }

    #[test]
    fn auth_source_prefers_saved_store_over_environment() {
        let _lock = env_lock().lock().unwrap();
        let home = tempfile::tempdir().expect("home tempdir");
        let _home = EnvVarGuard::set_path("HOME", home.path());
        let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "openai-env-key");

        crate::login::save_api_key("openai", "saved-key".to_string()).expect("save api key");
        assert_eq!(auth_source("openai"), Some(AuthSource::KordiAuth));
    }

    #[test]
    fn provider_auth_option_summaries_distinguish_multiple_saved_api_keys() {
        let _lock = env_lock().lock().unwrap();
        let home = tempfile::tempdir().expect("home tempdir");
        let _home = EnvVarGuard::set_path("HOME", home.path());

        crate::login::save_api_key("openrouter", "key-1111".to_string()).expect("save first");
        crate::login::save_api_key("openrouter", "key-2222".to_string()).expect("save second");

        let summaries = provider_auth_option_summaries("openrouter");
        assert_eq!(summaries.len(), 2);
        assert_eq!(
            summaries[0].account_label.as_deref(),
            Some("ending in 2222")
        );
        assert!(summaries[0].active);
        assert_eq!(
            summaries[1].account_label.as_deref(),
            Some("ending in 1111")
        );
        assert!(!summaries[1].active);
    }
}
