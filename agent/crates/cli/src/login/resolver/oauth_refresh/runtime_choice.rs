use super::*;

#[allow(dead_code)]
fn resolve_provider_auth_method(
    provider: &str,
    method: ProviderAuthMethod,
) -> Option<ResolvedProviderAuth> {
    let normalized = normalize_provider_for_model_selection(provider);
    if normalized == "github-copilot" && method == ProviderAuthMethod::OAuth {
        return resolve_github_copilot_auth();
    }
    let store = load_auth();
    if store.active_env_auth_methods.get(&normalized).copied() == Some(method)
        && let Some(auth) = resolve_env_provider_auth(&normalized, method)
    {
        return Some(auth);
    }
    if let Some(profile) = stored_auth_profile_for_method(&store, &normalized, method)
        && let Some(auth) = resolve_stored_profile_auth(&normalized, profile)
    {
        return Some(auth);
    }
    resolve_env_provider_auth(&normalized, method)
}

/// Resolves the transport alias for one desktop runtime session.
///
/// The alias selects a credential method without exposing or persisting a local
/// desktop profile id.
#[allow(dead_code)]
pub fn resolve_provider_runtime_auth_choice(
    provider: &str,
    choice: &str,
) -> Option<ResolvedProviderAuth> {
    match choice {
        "local-active-oauth" => resolve_provider_auth_method(provider, ProviderAuthMethod::OAuth),
        "local-active-api-key" | "ios-api-key" => {
            resolve_provider_auth_method(provider, ProviderAuthMethod::ApiKey)
        }
        _ => resolve_provider_auth_choice(provider, choice),
    }
}
