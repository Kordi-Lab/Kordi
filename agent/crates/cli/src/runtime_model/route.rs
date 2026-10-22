use super::*;

/// Keep search bound to the same resolved route as the active model turn.
pub(crate) fn web_search_runtime(
    provider: &Arc<dyn Provider>,
    model: &Model,
    api_key: &str,
    base_url: &str,
    headers: &HashMap<String, String>,
    auth: Option<&ResolvedProviderAuth>,
) -> kordi_tools::WebSearchRuntime {
    let (auth_mode, auth_account_id) = crate::compaction_exec::compaction_auth_options(auth);
    kordi_tools::WebSearchRuntime {
        provider: provider.clone(),
        model: model.clone(),
        api_key: api_key.to_string(),
        base_url: base_url.to_string(),
        headers: headers.clone(),
        auth_mode,
        auth_account_id,
        enabled: !api_key.is_empty(),
    }
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
