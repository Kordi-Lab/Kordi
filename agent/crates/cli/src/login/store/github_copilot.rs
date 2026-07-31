use super::models::{AuthEntry, AuthProfile, ProviderConfigRecord};
use super::persistence::{load_auth, save_auth};
use super::profile_selection::{auth_entry_authority, stored_auth_profile_for_method};
use super::profile_updates::now_ms;
use crate::login::ProviderAuthMethod;
use anyhow::Result;
use std::collections::HashMap;

/// Snapshot of the persisted GitHub Copilot login state used by session info,
/// auth menus, and post-login status messages.
///
/// The authority may come from either the dedicated provider config entry or
/// the last OAuth payload, while cached model/API fields are only populated
/// once an OAuth login has completed successfully.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GithubCopilotStatus {
    pub authority: Option<String>,
    pub login: Option<String>,
    pub api_base_url: Option<String>,
    pub cached_models: Vec<String>,
    pub github_access_expires_at: Option<i64>,
    pub github_refresh_expires_at: Option<i64>,
    pub copilot_expires_at: Option<i64>,
    pub has_oauth: bool,
}

pub fn save_github_copilot_config(domain: &str) -> Result<()> {
    let mut store = load_auth();
    let timestamp = now_ms();
    let normalized = normalize_github_domain(domain)?;
    match store.provider_configs.get_mut("github-copilot") {
        Some(config) => {
            config.domain = normalized;
            config.updated_at_ms = Some(timestamp);
        }
        None => {
            store.provider_configs.insert(
                "github-copilot".to_string(),
                ProviderConfigRecord {
                    domain: normalized,
                    created_at_ms: Some(timestamp),
                    updated_at_ms: Some(timestamp),
                },
            );
        }
    }
    save_auth(&store)
}

pub fn github_copilot_domain() -> Option<String> {
    let store = load_auth();
    store
        .provider_configs
        .get("github-copilot")
        .map(|config| config.domain.clone())
        .or_else(|| {
            stored_auth_profile_for_method(&store, "github-copilot", ProviderAuthMethod::OAuth)
                .and_then(|profile| auth_entry_authority("github-copilot", &profile.entry))
        })
}

pub fn github_copilot_api_base_url() -> String {
    let default = "https://api.githubcopilot.com".to_string();
    let store = load_auth();
    match stored_auth_profile_for_method(&store, "github-copilot", ProviderAuthMethod::OAuth) {
        Some(AuthProfile {
            entry: AuthEntry::OAuth { extra, .. },
            ..
        }) => extra
            .get("copilot_api_base_url")
            .and_then(|value| value.as_str())
            .map(ToString::to_string)
            .unwrap_or(default),
        _ => default,
    }
}

pub fn github_copilot_runtime_headers() -> HashMap<String, String> {
    crate::oauth::github_copilot::github_copilot_runtime_headers()
}

pub fn github_copilot_cached_models() -> Vec<String> {
    github_copilot_status().cached_models
}

/// Read the current GitHub Copilot login snapshot from the auth store.
///
/// This intentionally merges the provider-config-only case (enterprise host
/// saved but no OAuth token yet) with the full OAuth case so session info and
/// login UIs can explain exactly what has been configured.
pub fn github_copilot_status() -> GithubCopilotStatus {
    let store = load_auth();
    let config_authority = store
        .provider_configs
        .get("github-copilot")
        .map(|config| config.domain.clone());
    let Some(profile) =
        stored_auth_profile_for_method(&store, "github-copilot", ProviderAuthMethod::OAuth)
    else {
        return GithubCopilotStatus {
            authority: config_authority,
            ..GithubCopilotStatus::default()
        };
    };

    match &profile.entry {
        AuthEntry::OAuth { extra, .. } => GithubCopilotStatus {
            authority: extra
                .get("domain")
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
                .or(config_authority),
            login: extra
                .get("login")
                .and_then(|value| value.as_str())
                .map(ToString::to_string),
            api_base_url: extra
                .get("copilot_api_base_url")
                .and_then(|value| value.as_str())
                .map(ToString::to_string),
            cached_models: extra
                .get("copilot_models")
                .and_then(|value| value.as_array())
                .map(|models| {
                    models
                        .iter()
                        .filter_map(|value| value.as_str().map(ToString::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            github_access_expires_at: extra
                .get("github_access_expires_at")
                .and_then(|value| value.as_i64()),
            github_refresh_expires_at: extra
                .get("github_refresh_expires_at")
                .and_then(|value| value.as_i64()),
            copilot_expires_at: extra
                .get("copilot_expires_at")
                .and_then(|value| value.as_i64()),
            has_oauth: true,
        },
        AuthEntry::ApiKey { .. } | AuthEntry::ProviderConfig { .. } => GithubCopilotStatus {
            authority: config_authority,
            ..GithubCopilotStatus::default()
        },
    }
}

pub fn normalize_github_domain(input: &str) -> Result<String> {
    crate::oauth::github_copilot::normalize_authority(input)
}
