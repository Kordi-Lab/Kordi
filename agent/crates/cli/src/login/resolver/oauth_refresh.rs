//! Provider credential resolution and synchronous OAuth refresh coordination.

use super::store::{save_oauth_state, save_refreshed_oauth_profile};
use super::*;
mod github_copilot;
mod refresh_sync;
mod runtime_choice;
use github_copilot::{
    resolve_github_copilot_auth, resolve_github_copilot_env_auth,
    resolve_github_copilot_profile_auth,
};
use refresh_sync::{try_refresh_profile_sync, try_refresh_sync};
pub use runtime_choice::resolve_provider_runtime_auth_choice;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedProviderAuth {
    pub source: AuthSource,
    pub credential_provider: String,
    pub method: ProviderAuthMethod,
    pub credential: String,
    pub account_id: Option<String>,
    pub account_label: Option<String>,
    pub authority: Option<String>,
}
impl ResolvedProviderAuth {
    pub fn footer_badge(&self, provider: &str) -> String {
        let method = self.method.footer_label();
        match self.source {
            AuthSource::KordiAuth => format!("{provider}/{method}"),
            AuthSource::EnvVar => format!("{provider}/{method}(env)"),
        }
    }
}

pub fn save_oauth_credentials(provider: &str, creds: &OAuthCredentials) -> Result<()> {
    save_oauth_state(
        provider,
        creds.access.clone(),
        creds.refresh.clone(),
        creds.expires,
        creds.extra.clone(),
    )
}

fn resolve_stored_profile_auth(
    provider: &str,
    profile: &AuthProfile,
) -> Option<ResolvedProviderAuth> {
    let normalized = normalize_provider_for_model_selection(provider);
    match &profile.entry {
        AuthEntry::ApiKey { key } => Some(ResolvedProviderAuth {
            source: AuthSource::KordiAuth,
            credential_provider: provider_storage_key(&normalized, profile.method),
            method: profile.method,
            credential: key.clone(),
            account_id: None,
            account_label: None,
            authority: None,
        }),
        AuthEntry::OAuth {
            access,
            refresh,
            expires,
            extra,
        } => {
            let account_id = extra
                .get("accountId")
                .and_then(|value| value.as_str())
                .map(ToString::to_string);
            let authority = extra
                .get("domain")
                .and_then(|value| value.as_str())
                .map(ToString::to_string);
            let account_label = account_id.clone().or_else(|| {
                extra
                    .get("login")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string)
            });
            let now_ms = chrono::Utc::now().timestamp_millis();
            let credential_provider = provider_storage_key(&normalized, profile.method);
            let credential = if *expires > now_ms + 60_000 {
                access.clone()
            } else if !refresh.trim().is_empty() {
                try_refresh_profile_sync(&credential_provider, &profile.id, refresh.as_str())?
            } else {
                return None;
            };
            if credential.trim().is_empty() {
                return None;
            }
            Some(ResolvedProviderAuth {
                source: AuthSource::KordiAuth,
                credential_provider,
                method: profile.method,
                credential,
                account_id,
                account_label,
                authority,
            })
        }
        AuthEntry::ProviderConfig { .. } => None,
    }
}

fn resolve_env_provider_auth(
    provider: &str,
    method: ProviderAuthMethod,
) -> Option<ResolvedProviderAuth> {
    let normalized = normalize_provider_for_model_selection(provider);
    match (normalized.as_str(), method) {
        ("anthropic", ProviderAuthMethod::OAuth) => std::env::var("ANTHROPIC_OAUTH_TOKEN")
            .ok()
            .filter(|val| !val.trim().is_empty())
            .map(|val| ResolvedProviderAuth {
                source: AuthSource::EnvVar,
                credential_provider: provider_storage_key(&normalized, method),
                method,
                credential: val,
                account_id: None,
                account_label: None,
                authority: None,
            }),
        ("anthropic", ProviderAuthMethod::ApiKey) => std::env::var("ANTHROPIC_API_KEY")
            .ok()
            .filter(|val| !val.trim().is_empty())
            .map(|val| ResolvedProviderAuth {
                source: AuthSource::EnvVar,
                credential_provider: provider_storage_key(&normalized, method),
                method,
                credential: val,
                account_id: None,
                account_label: None,
                authority: None,
            }),
        ("openai" | "openai-codex", ProviderAuthMethod::ApiKey) => std::env::var("OPENAI_API_KEY")
            .ok()
            .filter(|val| !val.is_empty())
            .map(|val| ResolvedProviderAuth {
                source: AuthSource::EnvVar,
                credential_provider: normalized.clone(),
                method,
                credential: val,
                account_id: None,
                account_label: None,
                authority: None,
            }),
        ("lm-studio", ProviderAuthMethod::ApiKey) => std::env::var("LM_STUDIO_API_KEY")
            .ok()
            .filter(|val| !val.is_empty())
            .map(|val| ResolvedProviderAuth {
                source: AuthSource::EnvVar,
                credential_provider: normalized.clone(),
                method,
                credential: val,
                account_id: None,
                account_label: None,
                authority: None,
            }),
        ("ollama", ProviderAuthMethod::ApiKey) => std::env::var("OLLAMA_API_KEY")
            .ok()
            .filter(|val| !val.is_empty())
            .map(|val| ResolvedProviderAuth {
                source: AuthSource::EnvVar,
                credential_provider: normalized.clone(),
                method,
                credential: val,
                account_id: None,
                account_label: None,
                authority: None,
            }),
        ("google", ProviderAuthMethod::ApiKey) => ["GOOGLE_API_KEY", "GEMINI_API_KEY"]
            .into_iter()
            .find_map(|key| std::env::var(key).ok().filter(|val| !val.is_empty()))
            .map(|val| ResolvedProviderAuth {
                source: AuthSource::EnvVar,
                credential_provider: normalized.clone(),
                method,
                credential: val,
                account_id: None,
                account_label: None,
                authority: None,
            }),
        ("groq", ProviderAuthMethod::ApiKey) => std::env::var("GROQ_API_KEY")
            .ok()
            .filter(|val| !val.is_empty())
            .map(|val| ResolvedProviderAuth {
                source: AuthSource::EnvVar,
                credential_provider: normalized.clone(),
                method,
                credential: val,
                account_id: None,
                account_label: None,
                authority: None,
            }),
        ("xai", ProviderAuthMethod::ApiKey) => std::env::var("XAI_API_KEY")
            .ok()
            .filter(|val| !val.is_empty())
            .map(|val| ResolvedProviderAuth {
                source: AuthSource::EnvVar,
                credential_provider: normalized.clone(),
                method,
                credential: val,
                account_id: None,
                account_label: None,
                authority: None,
            }),
        ("openrouter", ProviderAuthMethod::ApiKey) => std::env::var("OPENROUTER_API_KEY")
            .ok()
            .filter(|val| !val.is_empty())
            .map(|val| ResolvedProviderAuth {
                source: AuthSource::EnvVar,
                credential_provider: normalized.clone(),
                method,
                credential: val,
                account_id: None,
                account_label: None,
                authority: None,
            }),
        ("github-copilot", ProviderAuthMethod::OAuth) => resolve_github_copilot_env_auth(),
        _ => None,
    }
}

pub fn resolve_provider_auth(provider: &str) -> Option<ResolvedProviderAuth> {
    let normalized = normalize_provider_for_model_selection(provider);
    if normalized == "github-copilot" {
        return resolve_github_copilot_auth();
    }

    let store = load_auth();
    if let Some(method) = store.active_env_auth_methods.get(&normalized).copied()
        && let Some(auth) = resolve_env_provider_auth(&normalized, method)
    {
        return Some(auth);
    }

    let explicit_active_profile = store.active_auth_profiles.get(&normalized).cloned();
    let explicit_active_method = store.active_auth_methods.get(&normalized).copied();
    if let Some(profile_id) = explicit_active_profile.as_deref() {
        let profile = stored_auth_profile_by_id(&store, &normalized, profile_id)?;
        return resolve_stored_profile_auth(&normalized, profile);
    }
    if let Some(method) = explicit_active_method {
        if let Some(profile) = stored_auth_profile_for_method(&store, &normalized, method)
            && let Some(auth) = resolve_stored_profile_auth(&normalized, profile)
        {
            return Some(auth);
        }
        if let Some(auth) = resolve_env_provider_auth(&normalized, method) {
            return Some(auth);
        }
    }

    let preferred_methods = match active_auth_method(&normalized) {
        Some(active) => match active {
            ProviderAuthMethod::OAuth => [ProviderAuthMethod::OAuth, ProviderAuthMethod::ApiKey],
            ProviderAuthMethod::ApiKey => [ProviderAuthMethod::ApiKey, ProviderAuthMethod::OAuth],
        },
        None => [ProviderAuthMethod::ApiKey, ProviderAuthMethod::OAuth],
    };

    for method in preferred_methods {
        if let Some(profile) = stored_auth_profile_for_method(&store, &normalized, method)
            && let Some(auth) = resolve_stored_profile_auth(&normalized, profile)
        {
            return Some(auth);
        }
    }

    [ProviderAuthMethod::OAuth, ProviderAuthMethod::ApiKey]
        .into_iter()
        .find_map(|method| resolve_env_provider_auth(&normalized, method))
}

pub fn resolve_provider_auth_choice(provider: &str, choice: &str) -> Option<ResolvedProviderAuth> {
    let normalized = normalize_provider_for_model_selection(provider);
    if let Some(profile_id) = choice.strip_prefix("profile:") {
        let store = load_auth();
        let profile = stored_auth_profile_by_id(&store, &normalized, profile_id)?;
        if normalized == "github-copilot" {
            return resolve_github_copilot_profile_auth(profile);
        }
        return resolve_stored_profile_auth(&normalized, profile);
    }
    if let Some(method) = choice
        .strip_prefix("env:")
        .and_then(parse_auth_method_choice)
    {
        return resolve_env_provider_auth(&normalized, method);
    }
    None
}

fn parse_auth_method_choice(value: &str) -> Option<ProviderAuthMethod> {
    match value {
        "oauth" => Some(ProviderAuthMethod::OAuth),
        "api-key" => Some(ProviderAuthMethod::ApiKey),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
