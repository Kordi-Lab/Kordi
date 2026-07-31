//! Pure profile lookup, selection, normalization, and active-choice repair policy.

use super::models::{AuthEntry, AuthProfile, AuthStore, StoredAuthProfileSummary};
use crate::login::{ProviderAuthMethod, normalize_provider_for_model_selection};

pub(super) fn normalized_auth_provider(provider: &str) -> String {
    normalize_provider_for_model_selection(provider)
}

pub(in crate::login) fn provider_storage_key(provider: &str, method: ProviderAuthMethod) -> String {
    let provider = normalized_auth_provider(provider);
    match (provider.as_str(), method) {
        ("openai", ProviderAuthMethod::OAuth) => "openai-codex".to_string(),
        ("openai", ProviderAuthMethod::ApiKey) => "openai".to_string(),
        ("anthropic", ProviderAuthMethod::OAuth) => "anthropic-oauth".to_string(),
        ("anthropic", ProviderAuthMethod::ApiKey) => "anthropic".to_string(),
        ("github-copilot", ProviderAuthMethod::OAuth) => "github-copilot".to_string(),
        (_, ProviderAuthMethod::ApiKey | ProviderAuthMethod::OAuth) => provider,
    }
}

fn auth_entry_matches_method(entry: &AuthEntry, method: ProviderAuthMethod) -> bool {
    match (entry, method) {
        (AuthEntry::ApiKey { key }, ProviderAuthMethod::ApiKey) => !key.trim().is_empty(),
        (AuthEntry::OAuth { access, .. }, ProviderAuthMethod::OAuth) => !access.trim().is_empty(),
        _ => false,
    }
}

pub(super) fn auth_profile_matches(profile: &AuthProfile) -> bool {
    auth_entry_matches_method(&profile.entry, profile.method)
}

fn profile_sort_key(profile: &AuthProfile) -> i64 {
    profile
        .updated_at_ms
        .or(profile.created_at_ms)
        .unwrap_or_default()
}

fn api_key_profile_label(key: &str) -> Option<String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return None;
    }
    let suffix = trimmed
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    (!suffix.is_empty()).then(|| format!("ending in {suffix}"))
}

fn auth_entry_account_label(provider: &str, entry: &AuthEntry) -> Option<String> {
    let normalized = normalized_auth_provider(provider);
    match entry {
        AuthEntry::ApiKey { key } => api_key_profile_label(key),
        AuthEntry::OAuth { extra, .. } => match normalized.as_str() {
            "github-copilot" => extra
                .get("login")
                .and_then(|value| value.as_str())
                .map(ToString::to_string),
            _ => extra
                .get("accountId")
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
                .or_else(|| {
                    extra
                        .get("login")
                        .and_then(|value| value.as_str())
                        .map(ToString::to_string)
                }),
        },
        AuthEntry::ProviderConfig { .. } => None,
    }
}

pub(super) fn auth_entry_authority(provider: &str, entry: &AuthEntry) -> Option<String> {
    let normalized = normalized_auth_provider(provider);
    match (normalized.as_str(), entry) {
        ("github-copilot", AuthEntry::OAuth { extra, .. }) => extra
            .get("domain")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        _ => None,
    }
}

pub(super) fn oauth_identity_from_entry(provider: &str, entry: &AuthEntry) -> Option<String> {
    let normalized = normalized_auth_provider(provider);
    let AuthEntry::OAuth { extra, .. } = entry else {
        return None;
    };

    match normalized.as_str() {
        "openai" | "anthropic" => extra
            .get("accountId")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("account:{value}")),
        "github-copilot" => {
            let authority = extra
                .get("domain")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty());
            let login = extra
                .get("login")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty());
            match (authority, login) {
                (Some(authority), Some(login)) => {
                    Some(format!("authority:{authority}|login:{login}"))
                }
                (Some(authority), None) => Some(format!("authority:{authority}")),
                (None, Some(login)) => Some(format!("login:{login}")),
                (None, None) => None,
            }
        }
        _ => extra
            .get("accountId")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("account:{value}"))
            .or_else(|| {
                extra
                    .get("login")
                    .and_then(|value| value.as_str())
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| format!("login:{value}"))
            }),
    }
}

fn best_profile_index_for_method(
    profiles: &[AuthProfile],
    method: ProviderAuthMethod,
    active_profile_id: Option<&str>,
) -> Option<usize> {
    if let Some(active_profile_id) = active_profile_id
        && let Some((idx, _)) = profiles.iter().enumerate().find(|(_, profile)| {
            profile.id == active_profile_id
                && profile.method == method
                && auth_profile_matches(profile)
        })
    {
        return Some(idx);
    }

    profiles
        .iter()
        .enumerate()
        .filter(|(_, profile)| profile.method == method && auth_profile_matches(profile))
        .max_by_key(|(_, profile)| profile_sort_key(profile))
        .map(|(idx, _)| idx)
}

pub(in crate::login) fn stored_auth_profile_for_method<'a>(
    store: &'a AuthStore,
    provider: &str,
    method: ProviderAuthMethod,
) -> Option<&'a AuthProfile> {
    let normalized = normalized_auth_provider(provider);
    let profiles = store.profiles.get(&normalized)?;
    let active_profile_id = store
        .active_auth_profiles
        .get(&normalized)
        .map(String::as_str);
    let idx = best_profile_index_for_method(profiles, method, active_profile_id)?;
    profiles.get(idx)
}

#[cfg(test)]
pub(super) fn stored_auth_entry_for_method<'a>(
    store: &'a AuthStore,
    provider: &str,
    method: ProviderAuthMethod,
) -> Option<&'a AuthEntry> {
    stored_auth_profile_for_method(store, provider, method).map(|profile| &profile.entry)
}

pub(in crate::login) fn stored_auth_methods_for_store(
    store: &AuthStore,
    provider: &str,
) -> Vec<ProviderAuthMethod> {
    let normalized = normalized_auth_provider(provider);
    let Some(profiles) = store.profiles.get(&normalized) else {
        return Vec::new();
    };

    [ProviderAuthMethod::OAuth, ProviderAuthMethod::ApiKey]
        .into_iter()
        .filter(|method| {
            profiles
                .iter()
                .any(|profile| profile.method == *method && auth_profile_matches(profile))
        })
        .collect()
}

pub(super) fn stored_auth_profiles_for_store(
    store: &AuthStore,
    provider: &str,
) -> Vec<StoredAuthProfileSummary> {
    let normalized = normalized_auth_provider(provider);
    let active_profile_id = store
        .active_auth_profiles
        .get(&normalized)
        .map(String::as_str);
    let mut profiles = store
        .profiles
        .get(&normalized)
        .into_iter()
        .flatten()
        .filter(|profile| auth_profile_matches(profile))
        .map(|profile| StoredAuthProfileSummary {
            profile_id: profile.id.clone(),
            method: profile.method,
            account_label: auth_entry_account_label(&normalized, &profile.entry),
            authority: auth_entry_authority(&normalized, &profile.entry),
            configured_at_ms: profile.created_at_ms,
            updated_at_ms: profile.updated_at_ms,
            active: active_profile_id == Some(profile.id.as_str()),
        })
        .collect::<Vec<_>>();
    profiles.sort_by(|left, right| {
        right
            .active
            .cmp(&left.active)
            .then_with(|| {
                right
                    .configured_at_ms
                    .or(right.updated_at_ms)
                    .unwrap_or_default()
                    .cmp(
                        &left
                            .configured_at_ms
                            .or(left.updated_at_ms)
                            .unwrap_or_default(),
                    )
            })
            .then_with(|| left.profile_id.cmp(&right.profile_id))
    });
    profiles
}

pub(in crate::login) fn stored_auth_profile_by_id<'a>(
    store: &'a AuthStore,
    provider: &str,
    profile_id: &str,
) -> Option<&'a AuthProfile> {
    let normalized = normalized_auth_provider(provider);
    store
        .profiles
        .get(&normalized)
        .and_then(|profiles| profiles.iter().find(|profile| profile.id == profile_id))
}

pub(super) fn active_auth_method_for_store(
    store: &AuthStore,
    provider: &str,
) -> Option<ProviderAuthMethod> {
    let normalized = normalized_auth_provider(provider);
    if let Some(method) = store.active_env_auth_methods.get(&normalized).copied() {
        return Some(method);
    }

    if let Some(active_profile_id) = store.active_auth_profiles.get(&normalized)
        && let Some(profile) = store.profiles.get(&normalized).and_then(|profiles| {
            profiles
                .iter()
                .find(|profile| profile.id == *active_profile_id)
        })
        && auth_profile_matches(profile)
    {
        return Some(profile.method);
    }

    if let Some(method) = store.active_auth_methods.get(&normalized).copied()
        && stored_auth_profile_for_method(store, &normalized, method).is_some()
    {
        return Some(method);
    }

    let methods = stored_auth_methods_for_store(store, &normalized);
    if methods.len() == 1 {
        return methods.first().copied();
    }
    if methods.contains(&ProviderAuthMethod::ApiKey) {
        return Some(ProviderAuthMethod::ApiKey);
    }
    methods.first().copied()
}

pub(super) fn repair_active_auth_selections(store: &mut AuthStore) {
    let mut providers = store.profiles.keys().cloned().collect::<Vec<_>>();
    providers.extend(store.active_auth_methods.keys().cloned());
    providers.extend(store.active_env_auth_methods.keys().cloned());
    providers.extend(store.active_auth_profiles.keys().cloned());
    providers.sort();
    providers.dedup();

    for provider in providers {
        if store.active_env_auth_methods.contains_key(&provider) {
            store.active_auth_methods.remove(&provider);
            store.active_auth_profiles.remove(&provider);
            continue;
        }

        let selected = store
            .active_auth_profiles
            .get(&provider)
            .and_then(|active_profile_id| {
                store.profiles.get(&provider).and_then(|profiles| {
                    profiles
                        .iter()
                        .find(|profile| {
                            profile.id == *active_profile_id && auth_profile_matches(profile)
                        })
                        .map(|profile| (profile.method, profile.id.clone()))
                })
            })
            .or_else(|| {
                store
                    .active_auth_methods
                    .get(&provider)
                    .copied()
                    .and_then(|method| {
                        store.profiles.get(&provider).and_then(|profiles| {
                            best_profile_index_for_method(profiles, method, None)
                                .and_then(|idx| profiles.get(idx))
                                .map(|profile| (method, profile.id.clone()))
                        })
                    })
            })
            .or_else(|| {
                [ProviderAuthMethod::ApiKey, ProviderAuthMethod::OAuth]
                    .into_iter()
                    .find_map(|method| {
                        store.profiles.get(&provider).and_then(|profiles| {
                            best_profile_index_for_method(profiles, method, None)
                                .and_then(|idx| profiles.get(idx))
                                .map(|profile| (method, profile.id.clone()))
                        })
                    })
            });

        if let Some((method, profile_id)) = selected {
            store.active_auth_methods.insert(provider.clone(), method);
            store
                .active_auth_profiles
                .insert(provider.clone(), profile_id);
        } else {
            store.active_auth_methods.remove(&provider);
            store.active_auth_profiles.remove(&provider);
        }
    }

    store.last_provider = store.last_provider.as_deref().map(normalized_auth_provider);
}
