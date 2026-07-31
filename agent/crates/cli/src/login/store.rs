use super::*;
use std::sync::{LazyLock, Mutex};

mod models;
mod profile_selection;
mod profile_updates;

use models::AUTH_STORE_VERSION;
pub use models::StoredAuthProfileSummary;
pub(super) use models::{AuthEntry, AuthProfile, AuthStore, ProviderConfigRecord};
#[cfg(test)]
use profile_selection::stored_auth_entry_for_method;
use profile_selection::{
    active_auth_method_for_store, auth_entry_authority, auth_profile_matches,
    normalized_auth_provider, oauth_identity_from_entry, repair_active_auth_selections,
    stored_auth_profiles_for_store,
};
pub(super) use profile_selection::{
    provider_storage_key, stored_auth_methods_for_store, stored_auth_profile_by_id,
    stored_auth_profile_for_method,
};
use profile_updates::{now_ms, upsert_api_key_profile, upsert_oauth_profile};

static AUTH_STORE_PROCESS_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

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

pub fn stored_auth_methods(provider: &str) -> Vec<ProviderAuthMethod> {
    let store = load_auth();
    stored_auth_methods_for_store(&store, provider)
}

pub fn stored_auth_profiles(provider: &str) -> Vec<StoredAuthProfileSummary> {
    let store = load_auth();
    stored_auth_profiles_for_store(&store, provider)
}

pub fn active_auth_method(provider: &str) -> Option<ProviderAuthMethod> {
    let store = load_auth();
    active_auth_method_for_store(&store, provider)
}

pub fn set_active_auth_profile(provider: &str, profile_id: &str) -> Result<bool> {
    let mut store = load_auth();
    let normalized = normalized_auth_provider(provider);
    let Some(profile) = stored_auth_profile_by_id(&store, &normalized, profile_id).cloned() else {
        return Ok(false);
    };
    if !auth_profile_matches(&profile) {
        return Ok(false);
    }
    store
        .active_auth_profiles
        .insert(normalized.clone(), profile.id.clone());
    store
        .active_auth_methods
        .insert(normalized.clone(), profile.method);
    store.active_env_auth_methods.remove(&normalized);
    store.last_provider = Some(normalized);
    save_auth(&store)?;
    Ok(true)
}

#[allow(dead_code)]
pub fn remove_auth_profile(provider: &str, profile_id: &str) -> Result<bool> {
    let mut store = load_auth();
    let normalized = normalized_auth_provider(provider);
    let Some(profiles) = store.profiles.get_mut(&normalized) else {
        return Ok(false);
    };

    let before_len = profiles.len();
    profiles.retain(|profile| profile.id != profile_id);
    let removed = profiles.len() != before_len;
    if !removed {
        return Ok(false);
    }

    if profiles.is_empty() {
        store.profiles.remove(&normalized);
    }

    repair_active_auth_selections(&mut store);
    if store.last_provider.as_deref() == Some(normalized.as_str())
        && !store.profiles.contains_key(&normalized)
    {
        store.last_provider = None;
    }
    save_auth(&store)?;
    Ok(true)
}

fn migrate_legacy_anthropic_oauth_if_needed(store: &mut AuthStore) {
    if store.providers.contains_key("anthropic-oauth") {
        return;
    }
    let should_migrate = matches!(
        store.providers.get("anthropic"),
        Some(AuthEntry::OAuth { access, .. }) if !access.trim().is_empty()
    );
    if should_migrate && let Some(entry) = store.providers.remove("anthropic") {
        store.providers.insert("anthropic-oauth".to_string(), entry);
    }
}

fn legacy_provider_and_method(
    key: &str,
    entry: &AuthEntry,
) -> Option<(String, ProviderAuthMethod)> {
    match entry {
        AuthEntry::ApiKey { .. } => {
            Some((normalized_auth_provider(key), ProviderAuthMethod::ApiKey))
        }
        AuthEntry::OAuth { .. } => Some((normalized_auth_provider(key), ProviderAuthMethod::OAuth)),
        AuthEntry::ProviderConfig { .. } => None,
    }
}

fn migrate_loaded_store(store: &mut AuthStore) {
    migrate_legacy_anthropic_oauth_if_needed(store);

    let legacy_entries = std::mem::take(&mut store.providers);
    for (key, entry) in legacy_entries {
        match entry {
            AuthEntry::ProviderConfig { domain } => {
                if key == "github-copilot" && !store.provider_configs.contains_key(&key) {
                    store.provider_configs.insert(
                        key,
                        ProviderConfigRecord {
                            domain,
                            created_at_ms: None,
                            updated_at_ms: None,
                        },
                    );
                }
            }
            other => {
                let Some((provider, method)) = legacy_provider_and_method(&key, &other) else {
                    continue;
                };
                let profiles = store.profiles.entry(provider).or_default();
                if profiles.iter().all(|profile| {
                    profile.method != method
                        || oauth_identity_from_entry(&key, &profile.entry)
                            != oauth_identity_from_entry(&key, &other)
                }) {
                    profiles.push(AuthProfile {
                        id: format!("legacy:{key}:{}", profiles.len()),
                        method,
                        created_at_ms: None,
                        updated_at_ms: None,
                        entry: other,
                    });
                }
            }
        }
    }

    repair_active_auth_selections(store);
    store.providers.clear();
    store.version = AUTH_STORE_VERSION;
}

pub fn remove_auth(provider: &str) -> Result<bool> {
    let mut store = load_auth();
    let normalized = normalized_auth_provider(provider);
    let removed_profiles = store.profiles.remove(&normalized).is_some();
    let removed_env_selection = store.active_env_auth_methods.remove(&normalized).is_some();
    let removed_config = if normalized == "github-copilot" {
        store.provider_configs.remove("github-copilot").is_some()
    } else {
        false
    };
    let removed = removed_profiles || removed_config || removed_env_selection;
    if removed {
        store.active_auth_methods.remove(&normalized);
        store.active_auth_profiles.remove(&normalized);
        if store.last_provider.as_deref() == Some(normalized.as_str()) {
            store.last_provider = None;
        }
        save_auth(&store)?;
    }
    Ok(removed)
}

/// Path to the shared CLI auth store used by both `kordi login` and the TUI
/// auth flows.
///
/// Example:
/// - on Linux this typically resolves under `~/.kordi/auth.json`
/// - legacy auth stores are migrated automatically when possible
pub fn auth_path() -> PathBuf {
    let global_settings = Settings::load_global();
    config::auth_path(&global_settings.storage)
}

// Public for the desktop library target; unused by the standalone CLI binary.
#[allow(dead_code)]
pub fn validate_auth_store() -> Result<()> {
    let path = auth_path();
    if !path.exists() {
        return Ok(());
    }

    let content = std::fs::read_to_string(&path)?;
    serde_json::from_str::<AuthStore>(&content)?;
    Ok(())
}

pub(super) fn load_auth() -> AuthStore {
    let path = auth_path();
    let mut store = if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
            Err(_) => AuthStore::default(),
        }
    } else {
        AuthStore::default()
    };
    migrate_loaded_store(&mut store);
    store
}

pub(super) fn save_auth(store: &AuthStore) -> Result<()> {
    let _guard = AUTH_STORE_PROCESS_LOCK
        .lock()
        .expect("auth store process lock");
    let path = auth_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut persisted = store.clone();
    migrate_loaded_store(&mut persisted);
    let content = serde_json::to_string_pretty(&persisted)?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("auth.json");
    let tmp_path = path.with_file_name(format!(
        ".{file_name}.tmp-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&tmp_path, &content)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(&tmp_path, perms)?;
    }

    #[cfg(windows)]
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }

    std::fs::rename(&tmp_path, &path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp_path);
    })?;

    Ok(())
}

pub fn save_api_key(provider: &str, key: String) -> Result<()> {
    let mut store = load_auth();
    let normalized = normalized_auth_provider(provider);
    let profile_id = upsert_api_key_profile(&mut store, provider, key);
    store.last_provider = Some(normalized.clone());
    store
        .active_auth_methods
        .insert(normalized.clone(), ProviderAuthMethod::ApiKey);
    store.active_env_auth_methods.remove(&normalized);
    store.active_auth_profiles.insert(normalized, profile_id);
    save_auth(&store)
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

pub(super) fn save_oauth_state(
    provider: &str,
    access: String,
    refresh: String,
    expires: i64,
    extra: serde_json::Value,
) -> Result<()> {
    let mut store = load_auth();
    let normalized = normalized_auth_provider(provider);
    let profile_id = upsert_oauth_profile(&mut store, provider, access, refresh, expires, extra);
    store.last_provider = Some(normalized.clone());
    store
        .active_auth_methods
        .insert(normalized.clone(), ProviderAuthMethod::OAuth);
    store.active_env_auth_methods.remove(&normalized);
    store.active_auth_profiles.insert(normalized, profile_id);
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

pub fn github_copilot_runtime_headers() -> std::collections::HashMap<String, String> {
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
        _ => GithubCopilotStatus {
            authority: config_authority,
            ..GithubCopilotStatus::default()
        },
    }
}

pub fn normalize_github_domain(input: &str) -> Result<String> {
    crate::oauth::github_copilot::normalize_authority(input)
}

pub fn configured_providers() -> Vec<String> {
    let store = load_auth();
    let mut providers = Vec::new();
    for provider in known_providers().iter().map(|(name, _, _)| *name) {
        let normalized = normalized_auth_provider(provider);
        let has_auth = !stored_auth_methods_for_store(&store, &normalized).is_empty();
        let has_config =
            normalized == "github-copilot" && store.provider_configs.contains_key("github-copilot");
        if (has_auth || has_config) && !providers.iter().any(|existing| existing == &normalized) {
            providers.push(normalized);
        }
    }
    providers.sort();
    providers
}

#[cfg(test)]
mod tests;
