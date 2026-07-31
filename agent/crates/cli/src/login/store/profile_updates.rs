//! Timestamped API-key and OAuth profile upsert policy.

use super::models::{AuthEntry, AuthProfile, AuthStore};
use super::profile_selection::{
    auth_profile_matches, normalized_auth_provider, oauth_identity_from_entry, provider_storage_key,
};
use crate::login::ProviderAuthMethod;

pub(super) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub(super) fn upsert_api_key_profile(store: &mut AuthStore, provider: &str, key: String) -> String {
    let normalized = normalized_auth_provider(provider);
    let profiles = store.profiles.entry(normalized.clone()).or_default();
    let timestamp = now_ms();
    if let Some(profile) = profiles.iter_mut().find(|profile| {
        profile.method == ProviderAuthMethod::ApiKey
            && matches!(&profile.entry, AuthEntry::ApiKey { key: existing } if existing == &key)
    }) {
        profile.updated_at_ms = Some(timestamp);
        return profile.id.clone();
    }

    let profile_id = format!(
        "{}-{}",
        provider_storage_key(&normalized, ProviderAuthMethod::ApiKey),
        uuid::Uuid::new_v4()
    );
    profiles.push(AuthProfile {
        id: profile_id.clone(),
        method: ProviderAuthMethod::ApiKey,
        created_at_ms: Some(timestamp),
        updated_at_ms: Some(timestamp),
        entry: AuthEntry::ApiKey { key },
    });
    profile_id
}

fn select_oauth_profile_index_for_update(
    profiles: &[AuthProfile],
    provider: &str,
    active_profile_id: Option<&str>,
    new_entry: &AuthEntry,
) -> Option<usize> {
    let identity = oauth_identity_from_entry(provider, new_entry);
    if let Some(identity) = identity.as_deref() {
        return profiles.iter().enumerate().find_map(|(idx, profile)| {
            (profile.method == ProviderAuthMethod::OAuth
                && oauth_identity_from_entry(provider, &profile.entry).as_deref() == Some(identity))
            .then_some(idx)
        });
    }

    if let Some(active_profile_id) = active_profile_id
        && let Some((idx, _)) = profiles.iter().enumerate().find(|(_, profile)| {
            profile.id == active_profile_id
                && profile.method == ProviderAuthMethod::OAuth
                && auth_profile_matches(profile)
        })
    {
        return Some(idx);
    }

    let oauth_profiles = profiles
        .iter()
        .enumerate()
        .filter(|(_, profile)| {
            profile.method == ProviderAuthMethod::OAuth && auth_profile_matches(profile)
        })
        .collect::<Vec<_>>();
    if oauth_profiles.len() == 1 {
        return oauth_profiles.first().map(|(idx, _)| *idx);
    }

    None
}

pub(super) fn upsert_oauth_profile(
    store: &mut AuthStore,
    provider: &str,
    access: String,
    refresh: String,
    expires: i64,
    extra: serde_json::Value,
) -> String {
    let normalized = normalized_auth_provider(provider);
    let active_profile_id = store.active_auth_profiles.get(&normalized).cloned();
    let new_entry = AuthEntry::OAuth {
        access,
        refresh,
        expires,
        extra,
    };
    let profiles = store.profiles.entry(normalized.clone()).or_default();
    let idx = select_oauth_profile_index_for_update(
        profiles,
        &normalized,
        active_profile_id.as_deref(),
        &new_entry,
    );
    let timestamp = now_ms();
    if let Some(idx) = idx {
        let profile = &mut profiles[idx];
        profile.entry = new_entry;
        profile.updated_at_ms = Some(timestamp);
        return profile.id.clone();
    }

    let profile_id = format!(
        "{}-{}",
        provider_storage_key(&normalized, ProviderAuthMethod::OAuth),
        uuid::Uuid::new_v4()
    );
    profiles.push(AuthProfile {
        id: profile_id.clone(),
        method: ProviderAuthMethod::OAuth,
        created_at_ms: Some(timestamp),
        updated_at_ms: Some(timestamp),
        entry: new_entry,
    });
    profile_id
}
