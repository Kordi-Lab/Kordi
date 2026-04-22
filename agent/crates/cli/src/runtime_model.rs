use std::collections::HashMap;
use std::sync::Arc;

use bb_provider::Provider;
use bb_provider::anthropic::AnthropicProvider;
use bb_provider::google::GoogleProvider;
use bb_provider::openai::OpenAiProvider;
use bb_provider::registry::{ApiType, Model, ModelInput, ModelRegistry};

use crate::login::{self, ResolvedProviderAuth};

pub(crate) struct ResolvedRuntimeConfig {
    pub provider: Arc<dyn Provider>,
    pub auth: Option<ResolvedProviderAuth>,
    pub api_key: String,
    pub base_url: String,
    pub headers: HashMap<String, String>,
}

pub(crate) fn fallback_api_type_for_provider(provider: &str) -> ApiType {
    match login::normalize_provider_for_model_selection(provider).as_str() {
        "anthropic" => ApiType::AnthropicMessages,
        "google" => ApiType::GoogleGenerative,
        _ => ApiType::OpenaiCompletions,
    }
}

pub(crate) fn fallback_base_url_for_api(api: &ApiType) -> String {
    match api {
        ApiType::AnthropicMessages => "https://api.anthropic.com".to_string(),
        ApiType::GoogleGenerative => "https://generativelanguage.googleapis.com".to_string(),
        _ => "https://api.openai.com/v1".to_string(),
    }
}

pub(crate) fn synthesize_model_candidate(
    registry: &ModelRegistry,
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

    let api = fallback_api_type_for_provider(provider_name);
    Model {
        id: model_id.to_string(),
        name: model_id.to_string(),
        provider: provider_name.to_string(),
        api: api.clone(),
        context_window: 128_000,
        max_tokens: 16_384,
        reasoning: false,
        input: vec![ModelInput::Text],
        base_url: Some(fallback_base_url_for_api(&api)),
        cost: Default::default(),
    }
}

pub(crate) fn resolve_or_synthesize_model(
    registry: &ModelRegistry,
    provider_name: &str,
    model_id: &str,
) -> Model {
    registry
        .find(provider_name, model_id)
        .cloned()
        .or_else(|| registry.find_fuzzy(model_id, Some(provider_name)).cloned())
        .or_else(|| registry.find_fuzzy(model_id, None).cloned())
        .unwrap_or_else(|| synthesize_model_candidate(registry, provider_name, model_id))
}

pub(crate) fn default_base_url_for_model(provider_name: &str, model: &Model) -> String {
    if provider_name == "github-copilot" {
        return login::github_copilot_api_base_url();
    }

    model
        .base_url
        .clone()
        .unwrap_or_else(|| fallback_base_url_for_api(&model.api))
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

pub(crate) fn build_runtime_config(
    model: &Model,
    auth: Option<ResolvedProviderAuth>,
) -> ResolvedRuntimeConfig {
    let api_key = auth
        .as_ref()
        .map(|resolved| resolved.credential.clone())
        .unwrap_or_default();
    let headers = runtime_headers_for_provider(&model.provider);

    ResolvedRuntimeConfig {
        provider: provider_for_model(model),
        auth,
        api_key,
        base_url: default_base_url_for_model(&model.provider, model),
        headers,
    }
}

pub(crate) fn resolve_runtime_config(model: &Model) -> ResolvedRuntimeConfig {
    build_runtime_config(model, login::resolve_provider_auth(&model.provider))
}

#[cfg(test)]
mod tests {
    use super::{default_base_url_for_model, resolve_or_synthesize_model};
    use bb_provider::registry::{ApiType, ModelRegistry};

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
}
