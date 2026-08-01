//! Serialized authentication-store records and secret-redacting debug views.

use crate::login::ProviderAuthMethod;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub(in crate::login) const AUTH_STORE_VERSION: u32 = 3;

#[derive(Clone, Serialize, Deserialize, Default)]
pub(in crate::login) struct AuthStore {
    #[serde(default)]
    pub(in crate::login) version: u32,
    #[serde(default)]
    pub(in crate::login) last_provider: Option<String>,
    #[serde(default)]
    pub(in crate::login) active_auth_methods: HashMap<String, ProviderAuthMethod>,
    #[serde(default)]
    pub(in crate::login) active_env_auth_methods: HashMap<String, ProviderAuthMethod>,
    #[serde(default)]
    pub(in crate::login) active_auth_profiles: HashMap<String, String>,
    #[serde(default)]
    pub(in crate::login) profiles: HashMap<String, Vec<AuthProfile>>,
    #[serde(default)]
    pub(in crate::login) provider_configs: HashMap<String, ProviderConfigRecord>,
    #[serde(flatten)]
    pub(in crate::login) providers: HashMap<String, AuthEntry>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub(in crate::login) enum AuthEntry {
    #[serde(rename = "api_key")]
    ApiKey { key: String },
    #[serde(rename = "oauth")]
    OAuth {
        access: String,
        refresh: String,
        expires: i64,
        #[serde(flatten)]
        extra: serde_json::Value,
    },
    #[serde(rename = "provider_config")]
    ProviderConfig { domain: String },
}

#[derive(Clone, Serialize, Deserialize)]
pub(in crate::login) struct AuthProfile {
    pub(in crate::login) id: String,
    pub(in crate::login) method: ProviderAuthMethod,
    #[serde(default)]
    pub(in crate::login) created_at_ms: Option<i64>,
    #[serde(default)]
    pub(in crate::login) updated_at_ms: Option<i64>,
    #[serde(flatten)]
    pub(in crate::login) entry: AuthEntry,
}

#[derive(Clone, Serialize, Deserialize, Default)]
pub(in crate::login) struct ProviderConfigRecord {
    pub(in crate::login) domain: String,
    #[serde(default)]
    pub(in crate::login) created_at_ms: Option<i64>,
    #[serde(default)]
    pub(in crate::login) updated_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredAuthProfileSummary {
    pub profile_id: String,
    pub method: ProviderAuthMethod,
    pub account_label: Option<String>,
    pub authority: Option<String>,
    pub configured_at_ms: Option<i64>,
    pub updated_at_ms: Option<i64>,
    pub active: bool,
}

impl std::fmt::Debug for AuthStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut provider_names = self.profiles.keys().cloned().collect::<Vec<_>>();
        provider_names.extend(self.provider_configs.keys().cloned());
        provider_names.extend(self.providers.keys().cloned());
        provider_names.sort();
        provider_names.dedup();
        f.debug_struct("AuthStore")
            .field("version", &self.version)
            .field("last_provider", &self.last_provider)
            .field("active_auth_methods", &self.active_auth_methods)
            .field("active_env_auth_methods", &self.active_env_auth_methods)
            .field("active_auth_profiles", &self.active_auth_profiles)
            .field("providers", &provider_names)
            .finish()
    }
}

impl std::fmt::Debug for AuthEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ApiKey { .. } => f
                .debug_struct("ApiKey")
                .field("key", &"[REDACTED]")
                .finish(),
            Self::OAuth { expires, .. } => f
                .debug_struct("OAuth")
                .field("access", &"[REDACTED]")
                .field("refresh", &"[REDACTED]")
                .field("expires", expires)
                .field("extra", &"[REDACTED]")
                .finish(),
            Self::ProviderConfig { domain } => f
                .debug_struct("ProviderConfig")
                .field("domain", domain)
                .finish(),
        }
    }
}
