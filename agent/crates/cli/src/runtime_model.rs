use std::collections::HashMap;
use std::sync::Arc;

use kordi_core::settings::{ProviderOverride, Settings};
use kordi_provider::Provider;
use kordi_provider::anthropic::AnthropicProvider;
use kordi_provider::google::GoogleProvider;
use kordi_provider::openai::OpenAiProvider;
use kordi_provider::registry::{ApiType, Model, ModelInput, ModelRegistry};

use crate::login::{self, ResolvedProviderAuth};

pub(crate) struct ResolvedRuntimeConfig {
    pub provider: Arc<dyn Provider>,
    pub auth: Option<ResolvedProviderAuth>,
    pub api_key: String,
    pub base_url: String,
    pub headers: HashMap<String, String>,
}

fn api_type_from_settings_value(value: &str) -> ApiType {
    match value {
        "anthropic" | "anthropic-messages" => ApiType::AnthropicMessages,
        "openai-responses" => ApiType::OpenaiResponses,
        "google" | "google-generative" => ApiType::GoogleGenerative,
        _ => ApiType::OpenaiCompletions,
    }
}

pub(crate) fn provider_override_for_settings<'a>(
    settings: &'a Settings,
    provider_name: &str,
) -> Option<&'a ProviderOverride> {
    settings
        .providers
        .as_ref()?
        .iter()
        .find(|provider| login::provider_names_match(provider_name, &provider.name))
}

fn settings_model_override_base_url<'a>(
    settings: &'a Settings,
    provider_name: &str,
    model_id: &str,
) -> Option<&'a str> {
    settings.models.as_ref()?.iter().find_map(|model| {
        (login::provider_names_match(provider_name, &model.provider) && model.id == model_id)
            .then_some(model.base_url.as_deref())
            .flatten()
    })
}

pub(crate) fn provider_override_base_url(
    settings: &Settings,
    provider_name: &str,
) -> Option<String> {
    provider_override_for_settings(settings, provider_name)
        .and_then(|provider| provider.base_url.clone())
}

pub(crate) fn resolve_provider_auth_with_settings(
    settings: &Settings,
    provider_name: &str,
) -> Option<ResolvedProviderAuth> {
    login::resolve_provider_auth(provider_name).or_else(|| {
        let provider = provider_override_for_settings(settings, provider_name)?;
        let env_key = provider.api_key_env.as_deref()?;
        let credential = std::env::var(env_key).ok()?;
        (!credential.trim().is_empty()).then(|| ResolvedProviderAuth {
            source: login::AuthSource::EnvVar,
            credential_provider: env_key.to_string(),
            method: login::ProviderAuthMethod::ApiKey,
            credential,
            account_id: None,
            account_label: None,
            authority: None,
        })
    })
}

pub(crate) fn fallback_api_type_for_provider(provider: &str) -> ApiType {
    match login::normalize_provider_for_model_selection(provider).as_str() {
        "anthropic" => ApiType::AnthropicMessages,
        "google" => ApiType::GoogleGenerative,
        _ => ApiType::OpenaiCompletions,
    }
}

pub(crate) fn api_type_for_provider_with_settings(
    settings: &Settings,
    provider_name: &str,
) -> ApiType {
    provider_override_for_settings(settings, provider_name)
        .and_then(|provider| provider.api.as_deref())
        .map(api_type_from_settings_value)
        .unwrap_or_else(|| fallback_api_type_for_provider(provider_name))
}

pub(crate) fn fallback_base_url_for_api(api: &ApiType) -> String {
    match api {
        ApiType::AnthropicMessages => "https://api.anthropic.com".to_string(),
        ApiType::GoogleGenerative => "https://generativelanguage.googleapis.com".to_string(),
        _ => "https://api.openai.com/v1".to_string(),
    }
}

pub(crate) fn fallback_base_url_for_provider(provider_name: &str, api: &ApiType) -> String {
    login::local_openai_provider_base_url(provider_name)
        .map(ToString::to_string)
        .unwrap_or_else(|| fallback_base_url_for_api(api))
}

#[allow(dead_code)]
pub(crate) fn synthesize_model_candidate(
    registry: &ModelRegistry,
    provider_name: &str,
    model_id: &str,
) -> Model {
    synthesize_model_candidate_with_settings(
        registry,
        &Settings::default(),
        provider_name,
        model_id,
    )
}

pub(crate) fn synthesize_model_candidate_with_settings(
    registry: &ModelRegistry,
    settings: &Settings,
    provider_name: &str,
    model_id: &str,
) -> Model {
    if let Some(template) = registry
        .list()
        .iter()
        .find(|model| model.provider == provider_name)
        .cloned()
    {
        return Model {
            id: model_id.to_string(),
            name: model_id.to_string(),
            ..template
        };
    }

    let api = api_type_for_provider_with_settings(settings, provider_name);
    Model {
        id: model_id.to_string(),
        name: model_id.to_string(),
        provider: provider_name.to_string(),
        api: api.clone(),
        context_window: 128_000,
        max_tokens: 16_384,
        reasoning: false,
        input: vec![ModelInput::Text],
        base_url: Some(
            provider_override_base_url(settings, provider_name)
                .unwrap_or_else(|| fallback_base_url_for_provider(provider_name, &api)),
        ),
        cost: Default::default(),
    }
}

#[allow(dead_code)]
pub(crate) fn resolve_or_synthesize_model(
    registry: &ModelRegistry,
    provider_name: &str,
    model_id: &str,
) -> Model {
    resolve_or_synthesize_model_with_settings(
        registry,
        &Settings::default(),
        provider_name,
        model_id,
    )
}

pub(crate) fn resolve_or_synthesize_model_with_settings(
    registry: &ModelRegistry,
    settings: &Settings,
    provider_name: &str,
    model_id: &str,
) -> Model {
    let has_provider_template = registry
        .list()
        .iter()
        .any(|model| model.provider == provider_name);
    let should_keep_requested_provider = !has_provider_template
        || login::is_local_openai_provider(provider_name)
        || provider_override_for_settings(settings, provider_name).is_some();

    registry
        .find(provider_name, model_id)
        .cloned()
        .or_else(|| registry.find_fuzzy(model_id, Some(provider_name)).cloned())
        .or_else(|| {
            should_keep_requested_provider.then(|| {
                synthesize_model_candidate_with_settings(
                    registry,
                    settings,
                    provider_name,
                    model_id,
                )
            })
        })
        .or_else(|| registry.find_fuzzy(model_id, None).cloned())
        .unwrap_or_else(|| {
            synthesize_model_candidate_with_settings(registry, settings, provider_name, model_id)
        })
}

#[allow(dead_code)]
pub(crate) fn default_base_url_for_model(provider_name: &str, model: &Model) -> String {
    default_base_url_for_model_with_settings(&Settings::default(), provider_name, model)
}

pub(crate) fn default_base_url_for_model_with_settings(
    settings: &Settings,
    provider_name: &str,
    model: &Model,
) -> String {
    if provider_name == "github-copilot" {
        return login::github_copilot_api_base_url();
    }

    settings_model_override_base_url(settings, provider_name, &model.id)
        .map(ToString::to_string)
        .or_else(|| provider_override_base_url(settings, provider_name))
        .or_else(|| model.base_url.clone())
        .unwrap_or_else(|| fallback_base_url_for_provider(provider_name, &model.api))
}

pub(crate) fn provider_for_model(model: &Model) -> Arc<dyn Provider> {
    match model.api {
        ApiType::AnthropicMessages => Arc::new(AnthropicProvider::new()),
        ApiType::GoogleGenerative => Arc::new(GoogleProvider::new()),
        _ => Arc::new(OpenAiProvider::new()),
    }
}

pub(crate) fn runtime_headers_for_provider(provider_name: &str) -> HashMap<String, String> {
    if provider_name == "github-copilot" {
        login::github_copilot_runtime_headers()
    } else {
        HashMap::new()
    }
}

pub(crate) fn runtime_headers_for_provider_with_settings(
    settings: &Settings,
    provider_name: &str,
) -> HashMap<String, String> {
    let mut headers = runtime_headers_for_provider(provider_name);
    if let Some(provider) = provider_override_for_settings(settings, provider_name)
        && let Some(extra_headers) = &provider.headers
    {
        headers.extend(extra_headers.clone());
    }
    headers
}

#[allow(dead_code)]
pub(crate) fn build_runtime_config(
    model: &Model,
    auth: Option<ResolvedProviderAuth>,
) -> ResolvedRuntimeConfig {
    build_runtime_config_with_settings(model, &Settings::default(), auth)
}

pub(crate) fn build_runtime_config_with_settings(
    model: &Model,
    settings: &Settings,
    auth: Option<ResolvedProviderAuth>,
) -> ResolvedRuntimeConfig {
    let auth = auth.or_else(|| resolve_provider_auth_with_settings(settings, &model.provider));
    let api_key = auth
        .as_ref()
        .map(|resolved| resolved.credential.clone())
        .unwrap_or_default();
    let headers = runtime_headers_for_provider_with_settings(settings, &model.provider);

    ResolvedRuntimeConfig {
        provider: provider_for_model(model),
        auth,
        api_key,
        base_url: default_base_url_for_model_with_settings(settings, &model.provider, model),
        headers,
    }
}

#[allow(dead_code)]
pub(crate) fn resolve_runtime_config(model: &Model) -> ResolvedRuntimeConfig {
    build_runtime_config(model, login::resolve_provider_auth(&model.provider))
}

pub(crate) fn resolve_runtime_config_with_settings(
    model: &Model,
    settings: &Settings,
) -> ResolvedRuntimeConfig {
    build_runtime_config_with_settings(model, settings, None)
}

#[cfg(test)]
mod tests {
    use super::{
        default_base_url_for_model, default_base_url_for_model_with_settings,
        resolve_or_synthesize_model, resolve_or_synthesize_model_with_settings,
        resolve_runtime_config_with_settings,
    };
    use kordi_core::settings::{ProviderOverride, Settings};
    use kordi_provider::registry::{ApiType, ModelRegistry};
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
        fn set_value(key: &'static str, value: &str) -> Self {
            let old = std::env::var_os(key);
            unsafe { std::env::set_var(key, value) };
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
    fn resolve_or_synthesize_model_preserves_provider_runtime_shape_for_unknown_live_models() {
        let registry = ModelRegistry::new();
        let model = resolve_or_synthesize_model(&registry, "anthropic", "claude-opus-4-7");

        assert_eq!(model.provider, "anthropic");
        assert!(matches!(model.api, ApiType::AnthropicMessages));
        assert_eq!(
            default_base_url_for_model("anthropic", &model),
            "https://api.anthropic.com"
        );
    }

    #[test]
    fn local_openai_models_default_to_loopback_openai_compatible_bases() {
        let registry = ModelRegistry::new();

        let lm_studio = resolve_or_synthesize_model(&registry, "lm-studio", "qwen3-coder-30b");
        assert_eq!(lm_studio.provider, "lm-studio");
        assert!(matches!(lm_studio.api, ApiType::OpenaiCompletions));
        assert_eq!(
            default_base_url_for_model("lm-studio", &lm_studio),
            "http://localhost:1234/v1"
        );

        let ollama = resolve_or_synthesize_model(&registry, "ollama", "llama3.2");
        assert_eq!(
            default_base_url_for_model("ollama", &ollama),
            "http://localhost:11434/v1"
        );

        let openai_named_local_model =
            resolve_or_synthesize_model(&registry, "lm-studio", "gpt-5.4");
        assert_eq!(openai_named_local_model.provider, "lm-studio");
    }

    #[test]
    fn provider_settings_override_base_url_headers_and_env_key() {
        let _guard = env_lock().lock().expect("env lock");
        let _api_key = EnvVarGuard::set_value("CORP_LLM_KEY", "test-key");
        let registry = ModelRegistry::new();
        let settings = Settings {
            providers: Some(vec![ProviderOverride {
                name: "my-corp".to_string(),
                base_url: Some("https://llm.internal.example/v1".to_string()),
                api_key_env: Some("CORP_LLM_KEY".to_string()),
                api: Some("openai".to_string()),
                headers: Some(HashMap::from([(
                    "X-Team".to_string(),
                    "engineering".to_string(),
                )])),
            }]),
            ..Settings::default()
        };
        let model =
            resolve_or_synthesize_model_with_settings(&registry, &settings, "my-corp", "our-model");
        let runtime = resolve_runtime_config_with_settings(&model, &settings);

        assert_eq!(
            default_base_url_for_model_with_settings(&settings, "my-corp", &model),
            "https://llm.internal.example/v1"
        );
        assert_eq!(runtime.api_key, "test-key");
        assert_eq!(
            runtime.headers.get("X-Team").map(String::as_str),
            Some("engineering")
        );
    }
}
