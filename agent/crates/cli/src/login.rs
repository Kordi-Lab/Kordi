mod cli;
mod providers;
mod resolver;
mod store;

use anyhow::Result;
use kordi_core::settings::Settings;
use kordi_provider::registry::{Model, ModelRegistry};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::oauth::OAuthCredentials;

use providers::get_provider_status;
use store::{
    AuthEntry, AuthProfile, load_auth, provider_storage_key, save_auth,
    stored_auth_methods_for_store, stored_auth_profile_by_id, stored_auth_profile_for_method,
};

pub use cli::{handle_login, handle_logout, run_oauth_login, try_open_browser};
pub use providers::{
    ProviderAuthMethod, is_local_openai_provider, is_loopback_base_url, is_oauth_provider,
    known_providers, local_openai_provider_base_url, normalize_provider_for_model_selection,
    provider_allows_no_auth, provider_api_key_variant, provider_auth_method, provider_display_name,
    provider_login_hint, provider_meta, provider_names_match, provider_oauth_variant,
};
#[allow(unused_imports)]
pub use resolver::{
    AuthSource, ProviderAuthOptionSummary, ResolvedProviderAuth, add_cached_github_copilot_models,
    auth_source, authenticated_model_candidates, authenticated_providers,
    authenticated_providers_for_settings, available_model_for_provider,
    model_candidates_for_provider_auth_mode, model_catalog_rank, model_id_allowed_for_active_auth,
    preferred_available_model_for_provider, preferred_startup_provider_and_model,
    provider_auth_option_summaries, provider_auth_status_summary, provider_configured_for_settings,
    provider_model_selection_detail, resolve_provider_auth, resolve_provider_auth_choice,
};

#[cfg(test)]
pub(crate) use resolver::save_oauth_credentials;
pub use store::{
    GithubCopilotStatus, active_auth_method, auth_path, configured_providers,
    github_copilot_api_base_url, github_copilot_cached_models, github_copilot_domain,
    github_copilot_runtime_headers, normalize_github_domain, remove_auth, save_api_key,
    save_github_copilot_config, set_active_auth_profile, stored_auth_methods, stored_auth_profiles,
};

pub fn github_copilot_status() -> GithubCopilotStatus {
    store::github_copilot_status()
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub struct CloudOAuthSnapshotCredentials {
    pub refresh_token: Option<String>,
    pub access_token: String,
    pub access_expires_at_ms: i64,
    pub runtime_expires_at_ms: Option<i64>,
}

#[derive(Clone)]
pub struct CloudOAuthProfileImport {
    pub provider: String,
    pub profile_id: String,
    pub access: String,
    pub refresh: String,
    pub expires: i64,
    pub extra: serde_json::Value,
}

#[derive(Clone)]
pub enum CloudAuthProfileSecret {
    ApiKey {
        key: String,
    },
    OAuth {
        access: String,
        refresh: String,
        expires: i64,
        extra: serde_json::Value,
    },
}

#[derive(Clone)]
pub struct CloudAuthProfileImport {
    pub provider: String,
    pub profile_id: String,
    pub active: bool,
    pub secret: CloudAuthProfileSecret,
}

impl std::fmt::Debug for CloudAuthProfileImport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CloudAuthProfileImport")
            .field("provider", &self.provider)
            .field("profile_id", &self.profile_id)
            .field("active", &self.active)
            .field("secret", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CloudAuthProfileReconcileResult {
    pub imported_profiles: usize,
    pub removed_profiles: usize,
    pub selection_changed: bool,
}

pub fn reconcile_cloud_auth_profiles(
    imports: Vec<CloudAuthProfileImport>,
    previously_synced: &[(String, String)],
) -> Result<CloudAuthProfileReconcileResult> {
    let mut store = load_auth();
    let mut seen = HashSet::new();
    let mut incoming = HashSet::new();
    let mut result = CloudAuthProfileReconcileResult::default();
    let mut store_changed = false;
    let timestamp = chrono::Utc::now().timestamp_millis();

    for import in imports {
        let normalized = normalize_provider_for_model_selection(&import.provider);
        let profile_id = import.profile_id.trim();
        if profile_id.is_empty()
            || profile_id.len() > 200
            || !profile_id
                .chars()
                .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.'))
        {
            anyhow::bail!("Invalid Cloud auth restore profile id");
        }
        let dedupe_key = (normalized.clone(), profile_id.to_string());
        if !seen.insert(dedupe_key.clone()) {
            continue;
        }
        incoming.insert(dedupe_key);

        let (method, new_entry) = match import.secret {
            CloudAuthProfileSecret::ApiKey { key } => {
                if key.trim().is_empty() || key.len() > 64 * 1024 {
                    anyhow::bail!("Invalid Cloud auth restore API key");
                }
                (ProviderAuthMethod::ApiKey, AuthEntry::ApiKey { key })
            }
            CloudAuthProfileSecret::OAuth {
                access,
                refresh,
                expires,
                extra,
            } => {
                if !matches!(
                    normalized.as_str(),
                    "openai" | "anthropic" | "github-copilot"
                ) {
                    anyhow::bail!("Unsupported Cloud OAuth restore provider {normalized}");
                }
                if access.trim().is_empty() || access.len() > 64 * 1024 {
                    anyhow::bail!("Invalid Cloud OAuth restore access token");
                }
                if refresh.len() > 64 * 1024 || expires <= 0 || !extra.is_object() {
                    anyhow::bail!("Invalid Cloud OAuth restore payload");
                }
                (
                    ProviderAuthMethod::OAuth,
                    AuthEntry::OAuth {
                        access,
                        refresh,
                        expires,
                        extra,
                    },
                )
            }
        };

        let profiles = store.profiles.entry(normalized.clone()).or_default();
        match profiles.iter_mut().find(|profile| profile.id == profile_id) {
            Some(profile)
                if profile.method == method && auth_entries_match(&profile.entry, &new_entry) => {}
            Some(profile) => {
                profile.method = method;
                profile.entry = new_entry;
                profile.updated_at_ms = Some(timestamp);
                result.imported_profiles += 1;
                store_changed = true;
            }
            None => {
                profiles.push(AuthProfile {
                    id: profile_id.to_string(),
                    method,
                    created_at_ms: Some(timestamp),
                    updated_at_ms: Some(timestamp),
                    entry: new_entry,
                });
                result.imported_profiles += 1;
                store_changed = true;
            }
        }

        if import.active {
            result.selection_changed |=
                store.active_auth_methods.insert(normalized.clone(), method) != Some(method);
            result.selection_changed |= store
                .active_auth_profiles
                .insert(normalized.clone(), profile_id.to_string())
                .as_deref()
                != Some(profile_id);
            result.selection_changed |= store.active_env_auth_methods.remove(&normalized).is_some();
            result.selection_changed |= store.last_provider.as_deref() != Some(normalized.as_str());
            store.last_provider = Some(normalized);
        }
    }

    for (provider, profile_id) in previously_synced {
        let normalized = normalize_provider_for_model_selection(provider);
        if incoming.contains(&(normalized.clone(), profile_id.clone())) {
            continue;
        }
        let removed_active = store
            .active_auth_profiles
            .get(&normalized)
            .is_some_and(|active_profile| active_profile == profile_id);
        let remove_provider = {
            let Some(profiles) = store.profiles.get_mut(&normalized) else {
                continue;
            };
            let before_len = profiles.len();
            profiles.retain(|profile| profile.id != *profile_id);
            if profiles.len() == before_len {
                continue;
            }
            result.removed_profiles += 1;
            store_changed = true;
            profiles.is_empty()
        };
        result.selection_changed |= removed_active;
        if remove_provider {
            store.profiles.remove(&normalized);
        }
    }

    if result.selection_changed {
        store_changed = true;
    }
    if store_changed {
        store::repair_active_auth_selections(&mut store);
        if store
            .last_provider
            .as_ref()
            .is_some_and(|provider| !store.profiles.contains_key(provider))
        {
            store.last_provider = None;
        }
        save_auth(&store)?;
    }
    Ok(result)
}

impl std::fmt::Debug for CloudOAuthProfileImport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CloudOAuthProfileImport")
            .field("provider", &self.provider)
            .field("profile_id", &self.profile_id)
            .field("access", &"[REDACTED]")
            .field("refresh", &"[REDACTED]")
            .field("expires", &self.expires)
            .field("extra", &"[REDACTED]")
            .finish()
    }
}

pub fn import_cloud_oauth_profiles(imports: Vec<CloudOAuthProfileImport>) -> Result<usize> {
    let mut store = load_auth();
    let mut seen = HashSet::new();
    let mut preferred_profiles = HashMap::<String, String>::new();
    let mut changed_profiles = 0_usize;
    let mut store_changed = false;
    let mut preferred_last_provider = None;
    let timestamp = chrono::Utc::now().timestamp_millis();

    for import in imports {
        let normalized = normalize_provider_for_model_selection(&import.provider);
        if !matches!(
            normalized.as_str(),
            "openai" | "anthropic" | "github-copilot"
        ) {
            anyhow::bail!("Unsupported Cloud OAuth restore provider {normalized}");
        }
        let profile_id = import.profile_id.trim();
        if profile_id.is_empty()
            || profile_id.len() > 200
            || !profile_id
                .chars()
                .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.'))
        {
            anyhow::bail!("Invalid Cloud OAuth restore profile id");
        }
        if import.access.trim().is_empty() || import.access.len() > 64 * 1024 {
            anyhow::bail!("Invalid Cloud OAuth restore access token");
        }
        if import.refresh.len() > 64 * 1024 || import.expires <= 0 || !import.extra.is_object() {
            anyhow::bail!("Invalid Cloud OAuth restore payload");
        }
        let dedupe_key = (normalized.clone(), profile_id.to_string());
        if !seen.insert(dedupe_key) {
            continue;
        }
        preferred_profiles
            .entry(normalized.clone())
            .or_insert_with(|| profile_id.to_string());
        preferred_last_provider.get_or_insert_with(|| normalized.clone());
        let new_entry = AuthEntry::OAuth {
            access: import.access,
            refresh: import.refresh,
            expires: import.expires,
            extra: import.extra,
        };
        let profiles = store.profiles.entry(normalized).or_default();
        match profiles.iter_mut().find(|profile| profile.id == profile_id) {
            Some(profile) if auth_entries_match(&profile.entry, &new_entry) => {}
            Some(profile) => {
                profile.method = ProviderAuthMethod::OAuth;
                profile.entry = new_entry;
                profile.updated_at_ms = Some(timestamp);
                changed_profiles += 1;
                store_changed = true;
            }
            None => {
                profiles.push(AuthProfile {
                    id: profile_id.to_string(),
                    method: ProviderAuthMethod::OAuth,
                    created_at_ms: Some(timestamp),
                    updated_at_ms: Some(timestamp),
                    entry: new_entry,
                });
                changed_profiles += 1;
                store_changed = true;
            }
        }
    }

    for (provider, profile_id) in preferred_profiles {
        store_changed |= store
            .active_auth_methods
            .insert(provider.clone(), ProviderAuthMethod::OAuth)
            != Some(ProviderAuthMethod::OAuth);
        store_changed |= store.active_env_auth_methods.remove(&provider).is_some();
        store_changed |= store
            .active_auth_profiles
            .insert(provider, profile_id.clone())
            != Some(profile_id);
    }
    if let Some(preferred_last_provider) = preferred_last_provider {
        store_changed |= store.last_provider.as_deref() != Some(preferred_last_provider.as_str());
        store.last_provider = Some(preferred_last_provider);
    }
    if store_changed {
        save_auth(&store)?;
    }
    Ok(changed_profiles)
}

fn auth_entries_match(existing: &AuthEntry, incoming: &AuthEntry) -> bool {
    match (existing, incoming) {
        (AuthEntry::ApiKey { key: existing }, AuthEntry::ApiKey { key: incoming }) => {
            existing == incoming
        }
        (
            AuthEntry::OAuth {
                access: existing_access,
                refresh: existing_refresh,
                expires: existing_expires,
                extra: existing_extra,
            },
            AuthEntry::OAuth {
                access: incoming_access,
                refresh: incoming_refresh,
                expires: incoming_expires,
                extra: incoming_extra,
            },
        ) => {
            existing_access == incoming_access
                && existing_refresh == incoming_refresh
                && existing_expires == incoming_expires
                && existing_extra == incoming_extra
        }
        (
            AuthEntry::ProviderConfig { domain: existing },
            AuthEntry::ProviderConfig { domain: incoming },
        ) => existing == incoming,
        _ => false,
    }
}

/// Returns the durable OAuth material associated with the selected local auth
/// profile. Callers must keep this encrypted at rest and scoped to the active
/// Cloud account; environment-provided tokens intentionally have no durable
/// profile material to export.
#[allow(dead_code)]
pub fn cloud_oauth_snapshot_credentials(
    provider: &str,
    auth_choice: Option<&str>,
) -> Option<CloudOAuthSnapshotCredentials> {
    let normalized = normalize_provider_for_model_selection(provider);
    let store = load_auth();
    let profile = match auth_choice.map(str::trim).filter(|value| !value.is_empty()) {
        Some(choice) => {
            let profile_id = choice.strip_prefix("profile:")?;
            stored_auth_profile_by_id(&store, &normalized, profile_id)?
        }
        None => {
            if let Some(profile_id) = store.active_auth_profiles.get(&normalized) {
                stored_auth_profile_by_id(&store, &normalized, profile_id)?
            } else {
                stored_auth_profile_for_method(&store, &normalized, ProviderAuthMethod::OAuth)?
            }
        }
    };
    let AuthEntry::OAuth {
        access,
        refresh,
        expires,
        extra,
    } = &profile.entry
    else {
        return None;
    };
    Some(CloudOAuthSnapshotCredentials {
        refresh_token: (!refresh.trim().is_empty()).then(|| refresh.clone()),
        access_token: access.clone(),
        access_expires_at_ms: *expires,
        runtime_expires_at_ms: extra
            .get("copilot_expires_at")
            .and_then(serde_json::Value::as_i64),
    })
}

// The desktop crate consumes this through the library target; the CLI binary
// compiles the same module without calling it directly.
#[allow(unused_imports)]
pub use store::validate_auth_store;

#[allow(dead_code)]
pub fn remove_auth_profile(provider: &str, profile_id: &str) -> Result<bool> {
    store::remove_auth_profile(provider, profile_id)
}

#[allow(dead_code)]
pub fn set_active_auth_choice(provider: &str, choice: &str) -> Result<bool> {
    if let Some(profile_id) = choice.strip_prefix("profile:") {
        return set_active_auth_profile(provider, profile_id);
    }

    let normalized = normalize_provider_for_model_selection(provider);
    let Some(auth) = resolve_provider_auth_choice(&normalized, choice) else {
        return Ok(false);
    };

    let mut store = load_auth();
    store.active_auth_methods.remove(&normalized);
    store.active_auth_profiles.remove(&normalized);
    store
        .active_env_auth_methods
        .insert(normalized.clone(), auth.method);
    store.last_provider = Some(normalized);
    save_auth(&store)?;
    Ok(true)
}

#[cfg(test)]
pub(crate) fn auth_test_env_lock() -> &'static std::sync::Mutex<()> {
    use std::sync::{Mutex, OnceLock};

    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}
