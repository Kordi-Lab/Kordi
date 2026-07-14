use anyhow::{Result, anyhow, bail};
use kordi_core::agent_session::ThinkingLevel;
use kordi_core::settings::Settings;
use kordi_provider::openai::capabilities::{self as openai_capabilities, OpenAiAuthRoute};
use kordi_provider::registry::{Model, ModelRegistry};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use crate::login;
use crate::session_bootstrap::{SessionAuthChoiceOverride, SessionRuntimeSetup};

use super::DesktopChatModelOption;

const DESKTOP_MODEL_OPTIONS_CACHE_TTL: Duration = Duration::from_secs(300);

static DESKTOP_MODEL_OPTIONS_CACHE: OnceLock<
    StdMutex<HashMap<String, (Instant, Vec<DesktopChatModelOption>)>>,
> = OnceLock::new();

fn desktop_model_options_cache()
-> &'static StdMutex<HashMap<String, (Instant, Vec<DesktopChatModelOption>)>> {
    DESKTOP_MODEL_OPTIONS_CACHE.get_or_init(|| StdMutex::new(HashMap::new()))
}

pub fn clear_desktop_model_options_cache() {
    if let Ok(mut cache) = desktop_model_options_cache().lock() {
        cache.clear();
    }
}

fn desktop_model_options_cache_key(cwd: &Path, settings: &Settings) -> String {
    let mut parts = vec![cwd.display().to_string()];
    parts.push(format!(
        "default:{}:{}",
        settings.default_provider.as_deref().unwrap_or_default(),
        settings.default_model.as_deref().unwrap_or_default()
    ));
    for provider in login::authenticated_providers_for_settings(settings) {
        let active_method = login::active_auth_method(&provider)
            .map(|method| method.footer_label().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let active_option = login::provider_auth_option_summaries(&provider)
            .into_iter()
            .find(|option| option.active);
        let active_source = active_option
            .as_ref()
            .map(|option| option.source.label().to_string())
            .unwrap_or_else(|| "implicit".to_string());
        let active_identity = active_option
            .and_then(|option| {
                option
                    .profile_id
                    .or(option.account_label)
                    .or(option.authority)
            })
            .unwrap_or_else(|| "env-or-default".to_string());
        parts.push(format!(
            "auth:{provider}:{active_method}:{active_source}:{active_identity}"
        ));
    }
    if let Some(models) = &settings.models {
        for model in models {
            parts.push(format!(
                "model:{}:{}:{}:{}:{}",
                model.provider,
                model.id,
                model.reasoning.unwrap_or(false),
                model.api.as_deref().unwrap_or_default(),
                model.base_url.as_deref().unwrap_or_default()
            ));
        }
    }
    if let Some(providers) = &settings.providers {
        for provider in providers {
            let env_present = provider.api_key_env.as_deref().is_some_and(|env_key| {
                std::env::var(env_key)
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false)
            });
            parts.push(format!(
                "provider:{}:{}:{}:{}",
                provider.name,
                provider.base_url.as_deref().unwrap_or_default(),
                provider.api.as_deref().unwrap_or_default(),
                env_present
            ));
        }
    }
    parts.join("|")
}

const OFF_ONLY_THINKING_LEVELS: [ThinkingLevel; 1] = [ThinkingLevel::Off];
const DEFAULT_ONLY_THINKING_LEVELS: [ThinkingLevel; 1] = [ThinkingLevel::Default];
const LOCAL_EFFORT_THINKING_LEVELS: [ThinkingLevel; 3] = [
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
];
const STANDARD_THINKING_LEVELS: [ThinkingLevel; 5] = [
    ThinkingLevel::Off,
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
];
const XHIGH_THINKING_LEVELS: [ThinkingLevel; 6] = [
    ThinkingLevel::Off,
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::XHigh,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ThinkingControlMode {
    OffOnly,
    DefaultOnly,
    LocalEffort,
    Standard,
    XHigh,
}

fn normalized_model_capability_id(model: &Model) -> String {
    [
        model.provider.as_str(),
        model.id.as_str(),
        model.name.as_str(),
    ]
    .join("/")
    .to_ascii_lowercase()
    .replace([' ', '_'], "-")
}

fn normalized_local_provider_id(provider: &str) -> String {
    login::normalize_provider_for_model_selection(provider)
}

fn is_ollama_model(model: &Model) -> bool {
    normalized_local_provider_id(&model.provider) == "ollama"
}

fn local_model_matches_any(model: &Model, needles: &[&str]) -> bool {
    let id = normalized_model_capability_id(model);
    needles.iter().any(|needle| id.contains(needle))
}

// Ollama documents GPT-OSS as the local family with tunable `think` levels
// (`low`/`medium`/`high`) and no fully disabled mode. Other known local
// thinking families only expose a provider/model default in Kordi so we avoid
// presenting unsupported effort controls.
fn local_model_supports_effort_levels(model: &Model) -> bool {
    if !is_ollama_model(model) {
        return false;
    }
    local_model_matches_any(model, &["gpt-oss", "gptoss"])
}

fn local_model_supports_default_thinking(model: &Model) -> bool {
    local_model_matches_any(
        model,
        &[
            "thinking",
            "reasoning",
            "reasoner",
            "qwen3",
            "qwen-3",
            "qwq",
            "deepseek-r1",
            "deepseek-v3.1",
            "deepseek-v3-1",
            "deepseek-v31",
            "gemma-3n",
            "gemma3n",
            "gemma-4",
            "gemma4",
            "magistral",
            "phi-4-reasoning",
            "phi4-reasoning",
            "seed-oss",
            "seedoss",
            "glm-z1",
            "glmz1",
        ],
    ) || (!is_ollama_model(model) && local_model_matches_any(model, &["gpt-oss", "gptoss"]))
        || model.reasoning
}

fn local_thinking_control_mode(model: &Model) -> Option<ThinkingControlMode> {
    if !login::is_local_openai_provider(&model.provider) {
        return None;
    }

    if local_model_supports_effort_levels(model) {
        Some(ThinkingControlMode::LocalEffort)
    } else if local_model_supports_default_thinking(model) {
        Some(ThinkingControlMode::DefaultOnly)
    } else {
        Some(ThinkingControlMode::OffOnly)
    }
}

fn supports_xhigh(model: &Model) -> bool {
    if !model.reasoning || login::is_local_openai_provider(&model.provider) {
        return false;
    }

    let id = normalized_model_capability_id(model);
    [
        "gpt-5.2", "gpt-5-2", "gpt-5.3", "gpt-5-3", "gpt-5.4", "gpt-5-4", "gpt-5.5", "gpt-5-5",
    ]
    .iter()
    .any(|needle| id.contains(needle))
        || ((id.contains("claude-opus-4-6") || id.contains("claude-opus-4.6"))
            || (id.contains("claude-opus-4-7") || id.contains("claude-opus-4.7")))
        || (id.contains("deepseek")
            && (id.contains("v4-pro") || id.contains("v4pro") || id.contains("v4/pro")))
}

fn thinking_control_mode_for_model(model: &Model) -> ThinkingControlMode {
    if let Some(mode) = local_thinking_control_mode(model) {
        return mode;
    }

    if !model.reasoning {
        ThinkingControlMode::OffOnly
    } else if supports_xhigh(model) {
        ThinkingControlMode::XHigh
    } else {
        ThinkingControlMode::Standard
    }
}

fn openai_auth_route(method: Option<login::ProviderAuthMethod>) -> OpenAiAuthRoute {
    if method == Some(login::ProviderAuthMethod::OAuth) {
        OpenAiAuthRoute::CodexOAuth
    } else {
        OpenAiAuthRoute::Api
    }
}

fn available_thinking_levels_for_model(
    model: &Model,
    auth_method: Option<login::ProviderAuthMethod>,
) -> &'static [ThinkingLevel] {
    if model.reasoning && login::normalize_provider_for_model_selection(&model.provider) == "openai"
    {
        return openai_capabilities::thinking_levels(&model.id, openai_auth_route(auth_method));
    }

    match thinking_control_mode_for_model(model) {
        ThinkingControlMode::OffOnly => &OFF_ONLY_THINKING_LEVELS,
        ThinkingControlMode::DefaultOnly => &DEFAULT_ONLY_THINKING_LEVELS,
        ThinkingControlMode::LocalEffort => &LOCAL_EFFORT_THINKING_LEVELS,
        ThinkingControlMode::Standard => &STANDARD_THINKING_LEVELS,
        ThinkingControlMode::XHigh => &XHIGH_THINKING_LEVELS,
    }
}

pub fn desktop_thinking_levels_for_model(model: &Model) -> Vec<String> {
    desktop_thinking_levels_for_model_with_auth(model, None)
}

pub(super) fn desktop_thinking_levels_for_model_with_auth(
    model: &Model,
    auth_method: Option<login::ProviderAuthMethod>,
) -> Vec<String> {
    available_thinking_levels_for_model(model, auth_method)
        .iter()
        .map(|level| level.as_str().to_string())
        .collect()
}

pub fn desktop_thinking_levels_for_model_id(
    settings: &Settings,
    provider: &str,
    model_id: &str,
) -> Vec<String> {
    let mut registry = ModelRegistry::new();
    registry.load_custom_models(settings);
    login::add_cached_github_copilot_models(&mut registry);
    let model = crate::runtime_model::resolve_or_synthesize_model_with_settings(
        &registry, settings, provider, model_id,
    );
    let auth_method = login::resolve_provider_auth(provider)
        .map(|auth| auth.method)
        .or_else(|| login::active_auth_method(provider));
    desktop_thinking_levels_for_model_with_auth(&model, auth_method)
}

fn fallback_thinking_for_levels(levels: &[ThinkingLevel]) -> ThinkingLevel {
    if levels.contains(&ThinkingLevel::Off) {
        ThinkingLevel::Off
    } else if levels.contains(&ThinkingLevel::Default) {
        ThinkingLevel::Default
    } else if levels.contains(&ThinkingLevel::Medium) {
        ThinkingLevel::Medium
    } else {
        levels.first().copied().unwrap_or(ThinkingLevel::Off)
    }
}

pub(super) fn effective_thinking_for_model_with_auth(
    requested: ThinkingLevel,
    model: &Model,
    auth_method: Option<login::ProviderAuthMethod>,
) -> ThinkingLevel {
    if model.reasoning && login::normalize_provider_for_model_selection(&model.provider) == "openai"
    {
        return openai_capabilities::clamp_thinking_level(
            &model.id,
            openai_auth_route(auth_method),
            requested,
        );
    }

    let levels = available_thinking_levels_for_model(model, auth_method);
    if levels.contains(&requested) {
        requested
    } else if requested == ThinkingLevel::Max && levels.contains(&ThinkingLevel::XHigh) {
        ThinkingLevel::XHigh
    } else if requested == ThinkingLevel::Max && levels.contains(&ThinkingLevel::High) {
        ThinkingLevel::High
    } else if requested == ThinkingLevel::XHigh && levels.contains(&ThinkingLevel::High) {
        ThinkingLevel::High
    } else {
        fallback_thinking_for_levels(levels)
    }
}

pub(super) fn normalize_setup_thinking(setup: &mut SessionRuntimeSetup) {
    let requested = ThinkingLevel::parse(&setup.thinking_level).unwrap_or(ThinkingLevel::Off);
    setup.thinking_level = effective_thinking_for_model_with_auth(
        requested,
        &setup.model,
        setup.auth.as_ref().map(|auth| auth.method),
    )
    .as_str()
    .to_string();
}

pub(super) fn request_thinking_for_model_with_auth(
    thinking_level: &str,
    model: &Model,
    auth_method: Option<login::ProviderAuthMethod>,
) -> Option<String> {
    let requested = ThinkingLevel::parse(thinking_level).unwrap_or(ThinkingLevel::Off);
    let effective = effective_thinking_for_model_with_auth(requested, model, auth_method);
    match effective {
        ThinkingLevel::Off | ThinkingLevel::Default => None,
        other => other
            .reasoning_enabled()
            .then(|| other.as_str().to_string()),
    }
}

fn desktop_model_option_from_model(
    model: &Model,
    auth_method: Option<login::ProviderAuthMethod>,
) -> DesktopChatModelOption {
    DesktopChatModelOption {
        provider: model.provider.clone(),
        provider_label: login::provider_display_name(&model.provider).into_owned(),
        value: format!("{}/{}", model.provider, model.id),
        label: model.id.clone(),
        detail: format!(
            "{} • {}",
            login::provider_display_name(&model.provider),
            model.name
        ),
        thinking_levels: desktop_thinking_levels_for_model_with_auth(model, auth_method),
    }
}

pub async fn authenticated_model_options(cwd: &std::path::Path) -> Vec<DesktopChatModelOption> {
    let settings = Settings::load_merged(cwd);
    let cache_key = desktop_model_options_cache_key(cwd, &settings);
    if let Some(cached_options) = desktop_model_options_cache().lock().ok().and_then(|cache| {
        cache
            .get(&cache_key)
            .filter(|(cached_at, _)| cached_at.elapsed() <= DESKTOP_MODEL_OPTIONS_CACHE_TTL)
            .map(|(_, options)| options.clone())
    }) {
        return cached_options;
    }

    let mut models = crate::live_models::authenticated_model_candidates_with_live(&settings).await;
    if let (Some(default_provider), Some(default_model)) = (
        settings.default_provider.as_deref(),
        settings.default_model.as_deref(),
    ) {
        let provider = login::normalize_provider_for_model_selection(default_provider);
        let model_id = default_model
            .trim()
            .strip_prefix(&format!("{provider}/"))
            .unwrap_or_else(|| default_model.trim());
        if !model_id.is_empty()
            && login::model_id_allowed_for_active_auth(&settings, &provider, model_id)
            && !models
                .iter()
                .any(|model| model.provider == provider && model.id == model_id)
        {
            let mut registry = ModelRegistry::new();
            registry.load_custom_models(&settings);
            login::add_cached_github_copilot_models(&mut registry);
            if let Some(model) =
                synthesize_live_model_candidate(&registry, &settings, &provider, model_id)
            {
                models.push(model);
            }
        }
    }
    models.sort_by(|left, right| {
        left.provider
            .cmp(&right.provider)
            .then_with(|| left.id.cmp(&right.id))
    });

    let options = models
        .iter()
        .map(|model| {
            let auth_method = login::resolve_provider_auth(&model.provider)
                .map(|auth| auth.method)
                .or_else(|| login::active_auth_method(&model.provider));
            desktop_model_option_from_model(model, auth_method)
        })
        .collect::<Vec<_>>();

    if !options.is_empty()
        && let Ok(mut cache) = desktop_model_options_cache().lock()
    {
        cache.insert(cache_key, (Instant::now(), options.clone()));
    }

    options
}

fn synthesize_live_model_candidate(
    registry: &ModelRegistry,
    settings: &Settings,
    provider: &str,
    model_id: &str,
) -> Option<Model> {
    if !login::provider_configured_for_settings(settings, provider) {
        return None;
    }

    Some(
        crate::runtime_model::synthesize_model_candidate_with_settings(
            registry, settings, provider, model_id,
        ),
    )
}

pub(super) fn resolve_model_candidate(
    settings: &Settings,
    requested_model: &str,
    current_provider: Option<&str>,
) -> Result<Model> {
    let requested = requested_model.trim();
    if requested.is_empty() {
        bail!("Model cannot be empty");
    }

    let mut registry = ModelRegistry::new();
    registry.load_custom_models(settings);
    login::add_cached_github_copilot_models(&mut registry);

    let requested_prefix_is_configured_provider = requested
        .split_once('/')
        .map(|(provider, _)| login::normalize_provider_for_model_selection(provider))
        .is_some_and(|provider| login::provider_configured_for_settings(settings, &provider));

    if requested.contains('/')
        && let Some(provider) = current_provider
    {
        let normalized_provider = login::normalize_provider_for_model_selection(provider);
        if login::is_local_openai_provider(&normalized_provider)
            && !requested_prefix_is_configured_provider
            && !requested.starts_with(&format!("{normalized_provider}/"))
            && let Some(model) = synthesize_live_model_candidate(
                &registry,
                settings,
                &normalized_provider,
                requested,
            )
        {
            return Ok(model);
        }
    }

    if let Some((provider, model_id)) = requested.split_once('/') {
        if !login::model_id_allowed_for_active_auth(settings, provider, model_id) {
            bail!("Model is not available for the active {provider} auth method: {model_id}");
        }
        return registry
            .find(provider, model_id)
            .cloned()
            .filter(|_| login::provider_configured_for_settings(settings, provider))
            .or_else(|| {
                login::provider_configured_for_settings(settings, provider)
                    .then(|| registry.find_fuzzy(model_id, Some(provider)).cloned())
                    .flatten()
            })
            .or_else(|| synthesize_live_model_candidate(&registry, settings, provider, model_id))
            .ok_or_else(|| anyhow!("Unknown model: {requested}"));
    }

    let candidates = login::authenticated_model_candidates(settings);
    if let Some(provider) = current_provider {
        if let Some(model) = candidates.iter().find(|model| {
            model.provider == provider
                && (model.id.eq_ignore_ascii_case(requested)
                    || model.name.eq_ignore_ascii_case(requested))
        }) {
            return Ok(model.clone());
        }
        if login::model_id_allowed_for_active_auth(settings, provider, requested)
            && let Some(model) =
                synthesize_live_model_candidate(&registry, settings, provider, requested)
        {
            return Ok(model);
        }
    }

    candidates
        .iter()
        .find(|model| {
            model.id.eq_ignore_ascii_case(requested) || model.name.eq_ignore_ascii_case(requested)
        })
        .cloned()
        .ok_or_else(|| anyhow!("Unknown model: {requested}"))
}

pub(super) fn resolve_auth_choice_override_for_model(
    model_provider: &str,
    choice: &SessionAuthChoiceOverride,
) -> Option<crate::login::ResolvedProviderAuth> {
    let model_provider = login::normalize_provider_for_model_selection(model_provider);
    let auth_provider = login::normalize_provider_for_model_selection(&choice.provider);
    (model_provider == auth_provider)
        .then(|| login::resolve_provider_auth_choice(&choice.provider, &choice.choice))
        .flatten()
}
