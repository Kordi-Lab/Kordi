use super::*;
use kordi_provider::anthropic::capabilities::{
    ANTHROPIC_SUBSCRIPTION_MODEL_IDS, DEFAULT_ANTHROPIC_MODEL_ID,
};
use std::collections::HashSet;

const OPENAI_CODEX_OAUTH_MODEL_IDS: &[&str] = &[
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-6-astra",
    "gpt-5.5",
    "gpt-5.4-mini",
    "gpt-5.4",
    "gpt-5.3-codex-spark",
];

pub fn model_catalog_rank(provider: &str, model_id: &str) -> usize {
    match normalize_provider_for_model_selection(provider).as_str() {
        "openai" => OPENAI_CODEX_OAUTH_MODEL_IDS
            .iter()
            .position(|id| id.eq_ignore_ascii_case(model_id)),
        "anthropic" => ANTHROPIC_SUBSCRIPTION_MODEL_IDS
            .iter()
            .position(|id| *id == model_id),
        _ => None,
    }
    .unwrap_or(usize::MAX)
}

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
        "anthropic" => Some(ANTHROPIC_SUBSCRIPTION_MODEL_IDS),
        _ => None,
    }
}

#[cfg_attr(not(test), allow(dead_code, reason = "used by desktop library target"))]
pub fn model_id_allowed_for_active_auth(
    settings: &Settings,
    provider: &str,
    model_id: &str,
) -> bool {
    let normalized = normalize_provider_for_model_selection(provider);
    match active_oauth_model_ids_for_provider(settings, &normalized) {
        Some(_) if normalized == "anthropic" => {
            let trimmed = model_id.trim();
            trimmed
                .strip_prefix("claude-")
                .is_some_and(|suffix| !suffix.is_empty())
                && trimmed
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        }
        Some(ids) => ids
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(model_id.trim())),
        None => true,
    }
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
        "anthropic" => Some(DEFAULT_ANTHROPIC_MODEL_ID.to_string()),
        "openai" | "openai-codex" => {
            Some(kordi_core::agent_session::DEFAULT_OPENAI_MODEL_ID.to_string())
        }
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
    // startup default follows the active OpenAI auth path.
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
mod tests;
