use super::*;

pub fn authenticated_model_candidates(settings: &Settings) -> Vec<Model> {
    let available = authenticated_providers_for_settings(settings);
    if available.is_empty() {
        return Vec::new();
    }

    let mut registry = ModelRegistry::new();
    registry.load_custom_models(settings);
    add_cached_github_copilot_models(&mut registry);
    registry
        .list()
        .iter()
        .filter(|model| available.iter().any(|provider| provider == &model.provider))
        .cloned()
        .collect()
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
        "openai" | "openai-codex" => {
            if resolve_provider_auth("openai")
                .as_ref()
                .is_some_and(|auth| matches!(auth.method, ProviderAuthMethod::OAuth))
            {
                Some("gpt-5.5".to_string())
            } else {
                Some("gpt-5.4".to_string())
            }
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
    use kordi_core::settings::{ProviderOverride, Settings};

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
}
