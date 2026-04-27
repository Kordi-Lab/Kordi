pub(super) fn desktop_provider_base_url(
    settings: &kordi_core::settings::Settings,
    provider: &str,
) -> Option<String> {
    settings_provider_base_url(settings, provider)
        .or_else(|| settings_model_base_url(settings, provider))
        .or_else(|| {
            kordi_cli::login::local_openai_provider_base_url(provider).map(ToString::to_string)
        })
}

pub(super) fn has_explicit_settings(
    settings: &kordi_core::settings::Settings,
    provider: &str,
) -> bool {
    settings.providers.as_ref().is_some_and(|providers| {
        providers.iter().any(|configured| {
            kordi_cli::login::provider_names_match(provider, &configured.name)
                && (configured
                    .base_url
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|value| !value.is_empty())
                    || configured
                        .api_key_env
                        .as_deref()
                        .map(str::trim)
                        .is_some_and(|value| !value.is_empty())
                    || configured
                        .api
                        .as_deref()
                        .map(str::trim)
                        .is_some_and(|value| !value.is_empty())
                    || configured
                        .headers
                        .as_ref()
                        .is_some_and(|headers| !headers.is_empty()))
        })
    }) || settings.models.as_ref().is_some_and(|models| {
        models.iter().any(|model| {
            kordi_cli::login::provider_names_match(provider, &model.provider)
                && model
                    .base_url
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|value| !value.is_empty())
        })
    })
}

pub(super) fn base_url_for_port(provider: &str, port: u32) -> Result<String, String> {
    if port == 0 || port > u16::MAX as u32 {
        return Err("Port must be between 1 and 65535".to_string());
    }

    let normalized = kordi_cli::login::normalize_provider_for_model_selection(provider);
    if !kordi_cli::login::is_local_openai_provider(&normalized) {
        return Err(format!(
            "{provider} is not a local OpenAI-compatible provider"
        ));
    }

    Ok(format!("http://localhost:{port}/v1"))
}

fn settings_provider_base_url(
    settings: &kordi_core::settings::Settings,
    provider: &str,
) -> Option<String> {
    settings.providers.as_ref()?.iter().find_map(|configured| {
        (kordi_cli::login::provider_names_match(provider, &configured.name))
            .then(|| configured.base_url.as_deref().map(str::trim))
            .flatten()
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    })
}

fn settings_model_base_url(
    settings: &kordi_core::settings::Settings,
    provider: &str,
) -> Option<String> {
    settings.models.as_ref()?.iter().find_map(|model| {
        (kordi_cli::login::provider_names_match(provider, &model.provider))
            .then(|| model.base_url.as_deref().map(str::trim))
            .flatten()
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    })
}
