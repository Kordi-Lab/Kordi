use super::{
    AUTH_STORE_VERSION, AuthEntry, AuthProfile, AuthStore, ProviderConfigRecord, load_auth,
    save_api_key, save_auth, save_oauth_state, stored_auth_entry_for_method,
    stored_auth_methods_for_store, stored_auth_profiles, validate_auth_store,
};
use crate::login::ProviderAuthMethod;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Mutex;

fn env_lock() -> &'static Mutex<()> {
    crate::login::auth_test_env_lock()
}

struct EnvVarGuard {
    key: &'static str,
    old: Option<std::ffi::OsString>,
}

impl EnvVarGuard {
    fn set_path(key: &'static str, value: &std::path::Path) -> Self {
        let old = std::env::var_os(key);
        unsafe { std::env::set_var(key, value) };
        Self { key, old }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        if let Some(value) = &self.old {
            unsafe { std::env::set_var(self.key, value) };
        } else {
            unsafe { std::env::remove_var(self.key) };
        }
    }
}

#[test]
fn auth_entry_debug_redacts_secret_fields() {
    let entry = AuthEntry::OAuth {
        access: "access-secret".to_string(),
        refresh: "refresh-secret".to_string(),
        expires: 123,
        extra: json!({"copilot_token": "runtime-secret"}),
    };

    let rendered = format!("{entry:?}");
    assert!(rendered.contains("[REDACTED]"));
    assert!(!rendered.contains("access-secret"));
    assert!(!rendered.contains("refresh-secret"));
    assert!(!rendered.contains("runtime-secret"));
}

#[test]
fn auth_store_debug_lists_provider_names_without_values() {
    let store = AuthStore {
        last_provider: Some("openai".to_string()),
        active_auth_methods: HashMap::new(),
        active_env_auth_methods: HashMap::new(),
        active_auth_profiles: HashMap::new(),
        profiles: HashMap::from([(
            "openai".to_string(),
            vec![AuthProfile {
                id: "openai-profile".to_string(),
                method: ProviderAuthMethod::ApiKey,
                created_at_ms: Some(123),
                updated_at_ms: Some(123),
                entry: AuthEntry::ApiKey {
                    key: "api-secret".to_string(),
                },
            }],
        )]),
        provider_configs: HashMap::new(),
        providers: HashMap::new(),
        version: AUTH_STORE_VERSION,
    };

    let rendered = format!("{store:?}");
    assert!(rendered.contains("openai"));
    assert!(!rendered.contains("api-secret"));
}

#[test]
fn auth_store_validation_rejects_malformed_persisted_credentials() {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let path = super::auth_path();
    std::fs::create_dir_all(path.parent().expect("auth parent")).expect("create auth parent");
    std::fs::write(&path, "{ malformed auth").expect("write malformed auth");

    assert!(validate_auth_store().is_err());
}

#[test]
fn saved_api_key_is_hydrated_from_disk_after_store_reload() {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let _home = EnvVarGuard::set_path("HOME", home.path());

    save_api_key("openrouter", "persisted-test-key".to_string()).expect("save API key");

    let reloaded = load_auth();
    assert!(matches!(
        stored_auth_entry_for_method(
            &reloaded,
            "openrouter",
            ProviderAuthMethod::ApiKey,
        ),
        Some(AuthEntry::ApiKey { key }) if key == "persisted-test-key"
    ));
}

#[test]
fn stored_auth_methods_distinguish_anthropic_api_key_and_oauth() {
    let store = AuthStore {
        last_provider: Some("anthropic".to_string()),
        active_auth_methods: HashMap::from([("anthropic".to_string(), ProviderAuthMethod::OAuth)]),
        active_env_auth_methods: HashMap::new(),
        active_auth_profiles: HashMap::from([(
            "anthropic".to_string(),
            "anthropic-oauth-profile".to_string(),
        )]),
        profiles: HashMap::from([(
            "anthropic".to_string(),
            vec![
                AuthProfile {
                    id: "anthropic-api-profile".to_string(),
                    method: ProviderAuthMethod::ApiKey,
                    created_at_ms: Some(10),
                    updated_at_ms: Some(10),
                    entry: AuthEntry::ApiKey {
                        key: "api-secret".to_string(),
                    },
                },
                AuthProfile {
                    id: "anthropic-oauth-profile".to_string(),
                    method: ProviderAuthMethod::OAuth,
                    created_at_ms: Some(20),
                    updated_at_ms: Some(20),
                    entry: AuthEntry::OAuth {
                        access: "oauth-secret".to_string(),
                        refresh: "refresh-secret".to_string(),
                        expires: i64::MAX,
                        extra: json!({}),
                    },
                },
            ],
        )]),
        provider_configs: HashMap::new(),
        providers: HashMap::new(),
        version: AUTH_STORE_VERSION,
    };

    assert_eq!(
        stored_auth_methods_for_store(&store, "anthropic"),
        vec![ProviderAuthMethod::OAuth, ProviderAuthMethod::ApiKey]
    );
    assert!(
        stored_auth_entry_for_method(&store, "anthropic", ProviderAuthMethod::ApiKey).is_some()
    );
    assert!(stored_auth_entry_for_method(&store, "anthropic", ProviderAuthMethod::OAuth).is_some());
}

#[test]
fn save_oauth_state_keeps_distinct_openai_accounts_with_timestamps() {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let _home = EnvVarGuard::set_path("HOME", home.path());

    save_oauth_state(
        "openai-codex",
        "oauth-access-1".to_string(),
        "refresh-1".to_string(),
        i64::MAX,
        json!({"accountId": "acct_primary"}),
    )
    .expect("save first openai oauth");
    save_oauth_state(
        "openai-codex",
        "oauth-access-2".to_string(),
        "refresh-2".to_string(),
        i64::MAX,
        json!({"accountId": "acct_secondary"}),
    )
    .expect("save second openai oauth");

    let store = load_auth();
    let profiles = stored_auth_profiles("openai");
    assert_eq!(profiles.len(), 2);
    assert_eq!(profiles[0].account_label.as_deref(), Some("acct_secondary"));
    assert!(profiles[0].active);
    assert!(
        profiles
            .iter()
            .all(|profile| profile.configured_at_ms.is_some())
    );
    assert_eq!(
        stored_auth_methods_for_store(&store, "openai"),
        vec![ProviderAuthMethod::OAuth]
    );
}

#[test]
fn save_api_key_reuses_existing_matching_profile_and_updates_timestamp() {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let _home = EnvVarGuard::set_path("HOME", home.path());

    save_api_key("openrouter", "key-1".to_string()).expect("save first key");
    let first = stored_auth_profiles("openrouter");
    assert_eq!(first.len(), 1);
    let first_profile_id = first[0].profile_id.clone();

    save_api_key("openrouter", "key-1".to_string()).expect("save second key");
    let second = stored_auth_profiles("openrouter");
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].profile_id, first_profile_id);
    assert!(second[0].updated_at_ms.is_some());
}

#[test]
fn save_api_key_keeps_distinct_profiles_for_distinct_keys() {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let _home = EnvVarGuard::set_path("HOME", home.path());

    save_api_key("openrouter", "key-1111".to_string()).expect("save first key");
    save_api_key("openrouter", "key-2222".to_string()).expect("save second key");

    let profiles = stored_auth_profiles("openrouter");
    assert_eq!(profiles.len(), 2);
    assert_eq!(profiles[0].account_label.as_deref(), Some("ending in 2222"));
    assert!(profiles[0].active);
    assert_eq!(profiles[1].account_label.as_deref(), Some("ending in 1111"));
    assert!(!profiles[1].active);
}

#[test]
fn legacy_flat_auth_store_migrates_to_profiles() {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let _home = EnvVarGuard::set_path("HOME", home.path());

    save_auth(&AuthStore {
        last_provider: Some("openai".to_string()),
        active_auth_methods: HashMap::from([("openai".to_string(), ProviderAuthMethod::OAuth)]),
        active_env_auth_methods: HashMap::new(),
        active_auth_profiles: HashMap::new(),
        profiles: HashMap::new(),
        provider_configs: HashMap::from([(
            "github-copilot".to_string(),
            ProviderConfigRecord {
                domain: "github.example.com".to_string(),
                created_at_ms: None,
                updated_at_ms: None,
            },
        )]),
        providers: HashMap::from([(
            "openai-codex".to_string(),
            AuthEntry::OAuth {
                access: "oauth-access".to_string(),
                refresh: "refresh-token".to_string(),
                expires: i64::MAX,
                extra: json!({"accountId": "acct_test123"}),
            },
        )]),
        version: 0,
    })
    .expect("save auth");

    let migrated = load_auth();
    assert!(migrated.providers.is_empty());
    let profiles = stored_auth_profiles("openai");
    assert_eq!(profiles.len(), 1);
    assert_eq!(profiles[0].account_label.as_deref(), Some("acct_test123"));
    assert_eq!(profiles[0].configured_at_ms, None);
}
