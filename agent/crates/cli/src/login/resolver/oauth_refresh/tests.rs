//! OAuth resolution, precedence, expiry, and persisted-choice regressions.

use super::{
    ResolvedProviderAuth, resolve_provider_auth, resolve_provider_auth_choice,
    resolve_provider_runtime_auth_choice,
};
use crate::login::ProviderAuthMethod;
use crate::login::store::{AuthEntry, AuthProfile, AuthStore, save_auth};
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
    fn set(key: &'static str, value: &std::path::Path) -> Self {
        let old = std::env::var_os(key);
        unsafe { std::env::set_var(key, value) };
        Self { key, old }
    }

    fn set_value(key: &'static str, value: &str) -> Self {
        let old = std::env::var_os(key);
        unsafe { std::env::set_var(key, value) };
        Self { key, old }
    }

    fn unset(key: &'static str) -> Self {
        let old = std::env::var_os(key);
        unsafe { std::env::remove_var(key) };
        Self { key, old }
    }
}

#[test]
fn anthropic_environment_defaults_to_oauth_and_allows_explicit_api_key_choice() {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let _home = EnvVarGuard::set("HOME", home.path());
    let _auth_path = EnvVarGuard::unset("KORDI_AUTH_PATH");
    let _storage_root = EnvVarGuard::unset("KORDI_STORAGE_ROOT");
    let _app_data_dir = EnvVarGuard::unset("APP_DATA_DIR");
    let _oauth = EnvVarGuard::set_value("ANTHROPIC_OAUTH_TOKEN", "env-oauth-token");
    let _api_key = EnvVarGuard::set_value("ANTHROPIC_API_KEY", "env-api-key");

    let automatic = resolve_provider_auth("anthropic").expect("automatic Anthropic auth");
    assert_eq!(automatic.source, crate::login::resolver::AuthSource::EnvVar);
    assert_eq!(automatic.method, ProviderAuthMethod::OAuth);
    assert_eq!(automatic.credential_provider, "anthropic-oauth");
    assert_eq!(automatic.credential, "env-oauth-token");

    let explicit = resolve_provider_auth_choice("anthropic", "env:api-key")
        .expect("explicit Anthropic API key");
    assert_eq!(explicit.source, crate::login::resolver::AuthSource::EnvVar);
    assert_eq!(explicit.method, ProviderAuthMethod::ApiKey);
    assert_eq!(explicit.credential_provider, "anthropic");
    assert_eq!(explicit.credential, "env-api-key");
}

#[test]
fn explicit_anthropic_environment_choice_persists_across_auth_store_reload() {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let _home = EnvVarGuard::set("HOME", home.path());
    let _auth_path = EnvVarGuard::unset("KORDI_AUTH_PATH");
    let _storage_root = EnvVarGuard::unset("KORDI_STORAGE_ROOT");
    let _app_data_dir = EnvVarGuard::unset("APP_DATA_DIR");
    let _oauth = EnvVarGuard::set_value("ANTHROPIC_OAUTH_TOKEN", "env-oauth-token");
    let _api_key = EnvVarGuard::set_value("ANTHROPIC_API_KEY", "env-api-key");

    assert!(
        crate::login::set_active_auth_choice("anthropic", "env:api-key")
            .expect("persist environment API-key choice")
    );

    let resolved = resolve_provider_auth("anthropic").expect("persisted Anthropic auth");
    assert_eq!(resolved.source, crate::login::resolver::AuthSource::EnvVar);
    assert_eq!(resolved.method, ProviderAuthMethod::ApiKey);
    assert_eq!(resolved.credential, "env-api-key");

    let summaries = crate::login::provider_auth_option_summaries("anthropic");
    assert!(summaries.iter().any(|summary| {
        summary.active
            && summary.source == crate::login::resolver::AuthSource::EnvVar
            && summary.method == ProviderAuthMethod::ApiKey
    }));
}

#[test]
fn explicit_saved_anthropic_profiles_win_over_both_environment_credentials() {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let _home = EnvVarGuard::set("HOME", home.path());
    let _auth_path = EnvVarGuard::unset("KORDI_AUTH_PATH");
    let _storage_root = EnvVarGuard::unset("KORDI_STORAGE_ROOT");
    let _app_data_dir = EnvVarGuard::unset("APP_DATA_DIR");
    let _oauth = EnvVarGuard::set_value("ANTHROPIC_OAUTH_TOKEN", "env-oauth-token");
    let _api_key = EnvVarGuard::set_value("ANTHROPIC_API_KEY", "env-api-key");

    let api_profile = AuthProfile {
        id: "saved-api".to_string(),
        method: ProviderAuthMethod::ApiKey,
        created_at_ms: Some(10),
        updated_at_ms: Some(10),
        entry: AuthEntry::ApiKey {
            key: "saved-api-key".to_string(),
        },
    };
    let oauth_profile = AuthProfile {
        id: "saved-oauth".to_string(),
        method: ProviderAuthMethod::OAuth,
        created_at_ms: Some(20),
        updated_at_ms: Some(20),
        entry: AuthEntry::OAuth {
            access: "saved-oauth-token".to_string(),
            refresh: String::new(),
            expires: i64::MAX,
            extra: serde_json::json!({}),
        },
    };

    for (profile_id, expected_method, expected_credential) in [
        ("saved-api", ProviderAuthMethod::ApiKey, "saved-api-key"),
        (
            "saved-oauth",
            ProviderAuthMethod::OAuth,
            "saved-oauth-token",
        ),
    ] {
        save_auth(&AuthStore {
            last_provider: Some("anthropic".to_string()),
            active_auth_methods: HashMap::from([("anthropic".to_string(), expected_method)]),
            active_auth_profiles: HashMap::from([(
                "anthropic".to_string(),
                profile_id.to_string(),
            )]),
            profiles: HashMap::from([(
                "anthropic".to_string(),
                vec![api_profile.clone(), oauth_profile.clone()],
            )]),
            ..AuthStore::default()
        })
        .expect("save Anthropic profiles");

        let resolved = resolve_provider_auth("anthropic").expect("saved Anthropic auth");
        assert_eq!(
            resolved.source,
            crate::login::resolver::AuthSource::KordiAuth
        );
        assert_eq!(resolved.method, expected_method);
        assert_eq!(resolved.credential, expected_credential);
    }

    let explicit_environment = resolve_provider_auth_choice("anthropic", "env:api-key")
        .expect("explicit environment API key");
    assert_eq!(
        explicit_environment.source,
        crate::login::resolver::AuthSource::EnvVar
    );
    assert_eq!(explicit_environment.credential, "env-api-key");
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
fn resolves_openai_provider_to_codex_oauth_when_only_oauth_is_configured() {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let _home = EnvVarGuard::set("HOME", home.path());

    let mut providers = HashMap::new();
    providers.insert(
        "openai-codex".to_string(),
        AuthEntry::OAuth {
            access: "oauth-access".to_string(),
            refresh: String::new(),
            expires: i64::MAX,
            extra: serde_json::json!({"accountId": "acct_test123"}),
        },
    );
    save_auth(&AuthStore {
        last_provider: Some("openai".to_string()),
        active_auth_methods: HashMap::new(),
        providers,
        ..AuthStore::default()
    })
    .expect("save auth");

    let resolved = resolve_provider_auth("openai").expect("resolved auth");
    assert_eq!(
        resolved,
        ResolvedProviderAuth {
            source: crate::login::resolver::AuthSource::KordiAuth,
            credential_provider: "openai-codex".to_string(),
            method: ProviderAuthMethod::OAuth,
            credential: "oauth-access".to_string(),
            account_id: Some("acct_test123".to_string()),
            account_label: Some("acct_test123".to_string()),
            authority: None,
        }
    );
}

#[test]
fn resolve_provider_auth_choice_can_pick_environment_api_key_over_saved_oauth() {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let _home = EnvVarGuard::set("HOME", home.path());
    unsafe { std::env::set_var("OPENAI_API_KEY", "env-openai-key") };

    let mut providers = HashMap::new();
    providers.insert(
        "openai-codex".to_string(),
        AuthEntry::OAuth {
            access: "oauth-access".to_string(),
            refresh: String::new(),
            expires: i64::MAX,
            extra: serde_json::json!({"accountId": "acct_test123"}),
        },
    );
    save_auth(&AuthStore {
        last_provider: Some("openai".to_string()),
        active_auth_methods: HashMap::new(),
        providers,
        ..AuthStore::default()
    })
    .expect("save auth");

    let resolved = resolve_provider_auth_choice("openai", "env:api-key").expect("resolved auth");
    assert_eq!(resolved.source, crate::login::resolver::AuthSource::EnvVar);
    assert_eq!(resolved.method, ProviderAuthMethod::ApiKey);
    assert_eq!(resolved.credential, "env-openai-key");
    unsafe { std::env::remove_var("OPENAI_API_KEY") };
}

#[test]
fn runtime_cloud_alias_resolves_matching_local_oauth_without_becoming_a_global_choice() {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let _home = EnvVarGuard::set("HOME", home.path());
    let _auth_path = EnvVarGuard::unset("KORDI_AUTH_PATH");
    let _storage_root = EnvVarGuard::unset("KORDI_STORAGE_ROOT");
    let _app_data_dir = EnvVarGuard::unset("APP_DATA_DIR");

    let oauth_profile = AuthProfile {
        id: "saved-codex-oauth".to_string(),
        method: ProviderAuthMethod::OAuth,
        created_at_ms: Some(20),
        updated_at_ms: Some(20),
        entry: AuthEntry::OAuth {
            access: "saved-codex-token".to_string(),
            refresh: String::new(),
            expires: i64::MAX,
            extra: serde_json::json!({"accountId": "acct_test123"}),
        },
    };
    save_auth(&AuthStore {
        last_provider: Some("openai".to_string()),
        active_auth_methods: HashMap::from([("openai".to_string(), ProviderAuthMethod::OAuth)]),
        active_auth_profiles: HashMap::from([("openai".to_string(), oauth_profile.id.clone())]),
        profiles: HashMap::from([("openai".to_string(), vec![oauth_profile])]),
        ..AuthStore::default()
    })
    .expect("save Codex OAuth profile");

    let resolved = resolve_provider_runtime_auth_choice("openai-codex", "local-active-oauth")
        .expect("resolve cloud runtime OAuth alias");
    assert_eq!(resolved.method, ProviderAuthMethod::OAuth);
    assert_eq!(resolved.credential_provider, "openai-codex");
    assert_eq!(resolved.credential, "saved-codex-token");
    assert!(resolve_provider_auth_choice("openai-codex", "local-active-oauth").is_none());
}

#[test]
fn expired_oauth_without_refresh_is_not_used() {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let _home = EnvVarGuard::set("HOME", home.path());

    let mut providers = HashMap::new();
    providers.insert(
        "anthropic-oauth".to_string(),
        AuthEntry::OAuth {
            access: "expired-oauth-access".to_string(),
            refresh: String::new(),
            expires: 1,
            extra: serde_json::json!({}),
        },
    );
    providers.insert(
        "anthropic".to_string(),
        AuthEntry::ApiKey {
            key: "api-key-secret".to_string(),
        },
    );
    save_auth(&AuthStore {
        last_provider: Some("anthropic".to_string()),
        active_auth_methods: HashMap::from([("anthropic".to_string(), ProviderAuthMethod::OAuth)]),
        providers,
        ..AuthStore::default()
    })
    .expect("save auth");

    let resolved = resolve_provider_auth("anthropic").expect("resolved auth");
    assert_eq!(resolved.method, ProviderAuthMethod::ApiKey);
    assert_eq!(resolved.credential, "api-key-secret");
}

#[test]
fn explicit_expired_oauth_profile_does_not_fall_back_to_api_key() {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let _home = EnvVarGuard::set("HOME", home.path());

    save_auth(&AuthStore {
        last_provider: Some("anthropic".to_string()),
        active_auth_methods: HashMap::from([("anthropic".to_string(), ProviderAuthMethod::OAuth)]),
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
                        key: "api-key-secret".to_string(),
                    },
                },
                AuthProfile {
                    id: "anthropic-oauth-profile".to_string(),
                    method: ProviderAuthMethod::OAuth,
                    created_at_ms: Some(20),
                    updated_at_ms: Some(20),
                    entry: AuthEntry::OAuth {
                        access: "expired-oauth-access".to_string(),
                        refresh: String::new(),
                        expires: 1,
                        extra: serde_json::json!({}),
                    },
                },
            ],
        )]),
        ..AuthStore::default()
    })
    .expect("save auth");

    assert!(resolve_provider_auth("anthropic").is_none());
}

#[test]
fn resolves_anthropic_to_active_api_key_when_both_methods_are_saved() {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let _home = EnvVarGuard::set("HOME", home.path());

    let mut providers = HashMap::new();
    providers.insert(
        "anthropic".to_string(),
        AuthEntry::ApiKey {
            key: "api-key-secret".to_string(),
        },
    );
    providers.insert(
        "anthropic-oauth".to_string(),
        AuthEntry::OAuth {
            access: "oauth-access".to_string(),
            refresh: String::new(),
            expires: i64::MAX,
            extra: serde_json::json!({}),
        },
    );
    save_auth(&AuthStore {
        last_provider: Some("anthropic".to_string()),
        active_auth_methods: HashMap::from([("anthropic".to_string(), ProviderAuthMethod::ApiKey)]),
        providers,
        ..AuthStore::default()
    })
    .expect("save auth");

    let resolved = resolve_provider_auth("anthropic").expect("resolved auth");
    assert_eq!(resolved.method, ProviderAuthMethod::ApiKey);
    assert_eq!(resolved.credential, "api-key-secret");
    assert_eq!(resolved.credential_provider, "anthropic");
}
