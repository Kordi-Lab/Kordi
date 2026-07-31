use super::models::{AUTH_STORE_VERSION, AuthEntry, AuthProfile, AuthStore, ProviderConfigRecord};
use super::profile_selection::{
    normalized_auth_provider, oauth_identity_from_entry, repair_active_auth_selections,
};
use crate::login::ProviderAuthMethod;

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

pub(super) fn migrate_loaded_store(store: &mut AuthStore) {
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
