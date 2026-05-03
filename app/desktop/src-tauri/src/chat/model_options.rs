use kordi_cli::desktop_runtime::DesktopChatModelOption;
use kordi_core::settings::Settings;

pub(super) const LM_STUDIO_DEFAULT_BASE_URL: &str = "http://localhost:1234/v1";
pub(super) const OLLAMA_DEFAULT_BASE_URL: &str = "http://localhost:11434/v1";

pub(super) async fn authenticated_model_options_with_local_runtime(
    cwd: &std::path::Path,
) -> Vec<DesktopChatModelOption> {
    let mut options = kordi_cli::desktop_runtime::authenticated_model_options(cwd).await;
    options.retain(|option| option.provider != "ollama");
    merge_lm_studio_running_model_options(cwd, &mut options).await;
    merge_ollama_running_model_options(cwd, &mut options).await;
    options
}

async fn merge_lm_studio_running_model_options(
    cwd: &std::path::Path,
    options: &mut Vec<DesktopChatModelOption>,
) {
    let settings = Settings::load_merged(cwd);
    let base_url = lm_studio_base_url(&settings);
    let Ok(model_ids) = crate::auth::lm_studio::loaded_model_ids_for_base_url(&base_url).await
    else {
        return;
    };

    for model_id in model_ids {
        if options
            .iter()
            .any(|option| option.provider == "lm-studio" && option.label == model_id)
        {
            continue;
        }
        options.push(DesktopChatModelOption {
            provider: "lm-studio".to_string(),
            provider_label: "LM Studio".to_string(),
            value: format!("lm-studio/{model_id}"),
            label: model_id.clone(),
            detail: "LM Studio • running local model".to_string(),
            thinking_levels: kordi_cli::desktop_runtime::desktop_thinking_levels_for_model_id(
                &settings,
                "lm-studio",
                &model_id,
            ),
        });
    }
}

async fn merge_ollama_running_model_options(
    cwd: &std::path::Path,
    options: &mut Vec<DesktopChatModelOption>,
) {
    let settings = Settings::load_merged(cwd);
    let base_url = local_provider_base_url(&settings, "ollama", OLLAMA_DEFAULT_BASE_URL);
    let Ok(model_ids) = crate::auth::ollama::running_model_ids_for_base_url(&base_url).await else {
        return;
    };

    for model_id in model_ids {
        if options
            .iter()
            .any(|option| option.provider == "ollama" && option.label == model_id)
        {
            continue;
        }
        options.push(DesktopChatModelOption {
            provider: "ollama".to_string(),
            provider_label: "Ollama".to_string(),
            value: format!("ollama/{model_id}"),
            label: model_id.clone(),
            detail: "Ollama • running local model".to_string(),
            thinking_levels: kordi_cli::desktop_runtime::desktop_thinking_levels_for_model_id(
                &settings, "ollama", &model_id,
            ),
        });
    }
}

pub(super) fn local_provider_port(settings: &Settings, provider: &str) -> Option<u32> {
    let fallback = if provider == "ollama" {
        OLLAMA_DEFAULT_BASE_URL
    } else {
        LM_STUDIO_DEFAULT_BASE_URL
    };
    let base_url = local_provider_base_url(settings, provider, fallback);
    let url = reqwest::Url::parse(&base_url).ok()?;
    url.port().map(u32::from)
}

fn lm_studio_base_url(settings: &Settings) -> String {
    local_provider_base_url(settings, "lm-studio", LM_STUDIO_DEFAULT_BASE_URL)
}

pub(super) fn local_provider_base_url(
    settings: &Settings,
    provider_name: &str,
    fallback: &str,
) -> String {
    settings
        .providers
        .as_ref()
        .and_then(|providers| {
            providers.iter().find_map(|provider| {
                kordi_cli::login::provider_names_match(provider_name, &provider.name)
                    .then(|| provider.base_url.as_deref().map(str::trim))
                    .flatten()
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
            })
        })
        .or_else(|| {
            settings.models.as_ref().and_then(|models| {
                models.iter().find_map(|model| {
                    kordi_cli::login::provider_names_match(provider_name, &model.provider)
                        .then(|| model.base_url.as_deref().map(str::trim))
                        .flatten()
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string)
                })
            })
        })
        .or_else(|| {
            kordi_cli::login::local_openai_provider_base_url(provider_name).map(ToString::to_string)
        })
        .unwrap_or_else(|| fallback.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_provider_base_url_prefers_provider_override() {
        let settings = Settings {
            providers: Some(vec![kordi_core::settings::ProviderOverride {
                name: "lm-studio".to_string(),
                base_url: Some("http://localhost:5678/v1".to_string()),
                api_key_env: None,
                api: None,
                headers: None,
            }]),
            ..Settings::default()
        };

        assert_eq!(
            local_provider_base_url(&settings, "lm-studio", LM_STUDIO_DEFAULT_BASE_URL,),
            "http://localhost:5678/v1",
        );
    }
}
