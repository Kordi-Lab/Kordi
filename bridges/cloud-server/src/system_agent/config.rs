//! Configuration for the System agent, the built-in plan agent.
//!
//! The System agent mirrors the Kordi Support agent's shape: a system-managed
//! account that runs on a Kordi-operated provider credential instead of any
//! member's own key. Everything here is read once at startup from the
//! environment.

use std::{env, fmt};

use crate::service_model::{vertex_configuration, ServiceCredential};

// Stored ids (account, agent, owner email, auth choice, snapshot) keep the
// old name so existing rows stay valid.
pub const DEFAULT_SYSTEM_AGENT_ACCOUNT_ID: &str = "acct_kordi_pip";
pub const DEFAULT_SYSTEM_AGENT_ID: &str = "cloud_agent_kordi_pip";
/// People see the plan agent as System, like every other server notice.
pub const DEFAULT_SYSTEM_AGENT_NAME: &str = crate::system_account::SYSTEM_DISPLAY_NAME;
pub const DEFAULT_SYSTEM_AGENT_SUBTITLE: &str = "Keeps plans in this chat honest";
pub const DEFAULT_SYSTEM_AGENT_OWNER_EMAIL: &str = "pip@kordi.ai";
pub const DEFAULT_SYSTEM_AGENT_OPENAI_MODEL: &str = "gpt-5.6-luna";

const SYSTEM_AGENT_OPENAI_PROVIDER: &str = "openai";
const SYSTEM_AGENT_OPENAI_AUTH_CHOICE: &str = "pip-service-api-key";
pub const DEFAULT_SYSTEM_AGENT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const SYSTEM_AGENT_OPENAI_SNAPSHOT_ID: &str = "pip-service-openai";

#[derive(Clone)]
pub struct SystemAgentProviderAuth {
    credential: ServiceCredential,
    model: String,
    base_url: String,
}

impl SystemAgentProviderAuth {
    pub fn openai_api_key(
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Result<Self, SystemAgentConfigError> {
        let api_key = api_key.into().trim().to_string();
        let model = model.into().trim().to_string();
        if api_key.is_empty() {
            return Err(SystemAgentConfigError::Invalid(
                "KORDI_SYSTEM_AGENT_OPENAI_API_KEY is required",
            ));
        }
        if model.is_empty() {
            return Err(SystemAgentConfigError::Invalid(
                "KORDI_SYSTEM_AGENT_OPENAI_MODEL is required",
            ));
        }
        Ok(Self {
            credential: ServiceCredential::ApiKey(api_key),
            model,
            base_url: DEFAULT_SYSTEM_AGENT_OPENAI_BASE_URL.to_string(),
        })
    }

    /// Points the credential at an OpenAI-compatible gateway.
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    pub fn provider(&self) -> &'static str {
        if self.credential.is_google_cloud() {
            "vertex-ai"
        } else {
            SYSTEM_AGENT_OPENAI_PROVIDER
        }
    }

    pub fn auth_choice(&self) -> &'static str {
        if self.credential.is_google_cloud() {
            "pip-service-google-cloud"
        } else {
            SYSTEM_AGENT_OPENAI_AUTH_CHOICE
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn snapshot_id(&self) -> &'static str {
        if self.credential.is_google_cloud() {
            "pip-service-vertex"
        } else {
            SYSTEM_AGENT_OPENAI_SNAPSHOT_ID
        }
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub(crate) fn credential(&self) -> &ServiceCredential {
        &self.credential
    }

    #[cfg(test)]
    pub(crate) fn api_key(&self) -> &str {
        self.credential.api_key()
    }
}

impl fmt::Debug for SystemAgentProviderAuth {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SystemAgentProviderAuth")
            .field("provider", &self.provider())
            .field("auth_choice", &self.auth_choice())
            .field("model", &self.model)
            .field("base_url", &self.base_url)
            .field("api_key", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone)]
pub struct PendingSystemAgentConfig {
    pub group_chat_enabled: bool,
    pub account_id: String,
    pub owner_email: String,
    pub agent_id: String,
    pub name: String,
    pub subtitle: String,
    pub provider_auth: SystemAgentProviderAuth,
}

#[derive(Debug, Clone)]
pub struct SystemAgentConfig {
    pub group_chat_enabled: bool,
    pub account_id: String,
    pub owner_email: String,
    pub agent_id: String,
    pub name: String,
    pub subtitle: String,
    pub(super) provider_auth: SystemAgentProviderAuth,
}

#[derive(Debug)]
pub enum SystemAgentConfigError {
    Invalid(&'static str),
    Database(sqlx_core::Error),
}

impl fmt::Display for SystemAgentConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "{message}"),
            Self::Database(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for SystemAgentConfigError {}

impl From<sqlx_core::Error> for SystemAgentConfigError {
    fn from(value: sqlx_core::Error) -> Self {
        Self::Database(value)
    }
}

fn enabled(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn switched_off(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        )
    })
}

/// Settings are named `KORDI_SYSTEM_AGENT_*`. The old `KORDI_PIP_*` names are
/// still read so existing deployments keep working; the new name wins.
const SETTING_PREFIXES: [&str; 2] = ["KORDI_SYSTEM_AGENT_", "KORDI_PIP_"];

/// The trimmed, non-empty value of the setting `suffix`, such as `ENABLED`.
fn setting(get: &mut impl FnMut(&str) -> Option<String>, suffix: &str) -> Option<String> {
    SETTING_PREFIXES
        .iter()
        .filter_map(|prefix| get(&format!("{prefix}{suffix}")))
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
}

fn validated_base_url(raw: Option<String>) -> Result<String, SystemAgentConfigError> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_SYSTEM_AGENT_OPENAI_BASE_URL.to_string());
    };
    let url = raw.trim().trim_end_matches('/');
    let loopback = ["http://127.0.0.1", "http://localhost"]
        .iter()
        .any(|prefix| {
            url.strip_prefix(prefix).is_some_and(|rest| {
                rest.is_empty() || rest.starts_with(':') || rest.starts_with('/')
            })
        });
    if url.len() > "https://".len() && url.starts_with("https://") || loopback {
        Ok(url.to_string())
    } else {
        Err(SystemAgentConfigError::Invalid(
            "KORDI_SYSTEM_AGENT_OPENAI_BASE_URL must be an https URL",
        ))
    }
}

fn required_or_default(
    get: &mut impl FnMut(&str) -> Option<String>,
    suffix: &str,
    default: &str,
) -> String {
    setting(get, suffix).unwrap_or_else(|| default.to_string())
}

impl PendingSystemAgentConfig {
    pub fn from_env() -> Result<Option<Self>, SystemAgentConfigError> {
        let config = Self::from_lookup(|key| env::var(key).ok())?;
        if let Some(config) = &config {
            config
                .provider_auth
                .credential()
                .validate_configuration()
                .map_err(SystemAgentConfigError::Invalid)?;
        }
        Ok(config)
    }

    pub fn from_lookup(
        mut get: impl FnMut(&str) -> Option<String>,
    ) -> Result<Option<Self>, SystemAgentConfigError> {
        // The System agent is always on once its key is configured;
        // KORDI_SYSTEM_AGENT_ENABLED=false is the only way to turn it off, and
        // =true without a key is an error.
        let switch = setting(&mut get, "ENABLED");
        if switched_off(switch.as_deref()) {
            return Ok(None);
        }
        let provider_auth = match setting(&mut get, "PROVIDER").as_deref() {
            Some("vertex-ai") => {
                let model = setting(&mut get, "VERTEX_MODEL");
                let (credential, base_url, model) = vertex_configuration(&mut get, model)
                    .map_err(SystemAgentConfigError::Invalid)?;
                SystemAgentProviderAuth {
                    credential,
                    base_url,
                    model,
                }
            }
            None | Some("openai") => {
                let Some(api_key) = setting(&mut get, "OPENAI_API_KEY") else {
                    return if enabled(switch.as_deref()) {
                        Err(SystemAgentConfigError::Invalid(
                            "KORDI_SYSTEM_AGENT_OPENAI_API_KEY is required",
                        ))
                    } else {
                        Ok(None)
                    };
                };
                let model = required_or_default(
                    &mut get,
                    "OPENAI_MODEL",
                    DEFAULT_SYSTEM_AGENT_OPENAI_MODEL,
                );
                let base_url = validated_base_url(setting(&mut get, "OPENAI_BASE_URL"))?;
                SystemAgentProviderAuth::openai_api_key(api_key, model)?.with_base_url(base_url)
            }
            Some(_) => {
                return Err(SystemAgentConfigError::Invalid(
                    "KORDI_SYSTEM_AGENT_PROVIDER must be openai or vertex-ai",
                ))
            }
        };
        let owner_email =
            required_or_default(&mut get, "OWNER_EMAIL", DEFAULT_SYSTEM_AGENT_OWNER_EMAIL);
        if !owner_email.contains('@') {
            return Err(SystemAgentConfigError::Invalid(
                "KORDI_SYSTEM_AGENT_OWNER_EMAIL must be an email address",
            ));
        }
        Ok(Some(Self {
            group_chat_enabled: !switched_off(setting(&mut get, "GROUP_CHAT_ENABLED").as_deref()),
            account_id: required_or_default(
                &mut get,
                "ACCOUNT_ID",
                DEFAULT_SYSTEM_AGENT_ACCOUNT_ID,
            ),
            owner_email,
            agent_id: required_or_default(&mut get, "AGENT_ID", DEFAULT_SYSTEM_AGENT_ID),
            name: required_or_default(&mut get, "AGENT_NAME", DEFAULT_SYSTEM_AGENT_NAME),
            subtitle: required_or_default(
                &mut get,
                "AGENT_SUBTITLE",
                DEFAULT_SYSTEM_AGENT_SUBTITLE,
            ),
            provider_auth,
        }))
    }
}

impl SystemAgentConfig {
    pub fn provider_auth(&self) -> &SystemAgentProviderAuth {
        &self.provider_auth
    }

    /// The runtime route stored on every System agent run so the runner
    /// selects the service credential instead of looking for a member snapshot.
    pub fn model_routing(&self) -> serde_json::Value {
        serde_json::json!({
            "defaultModel": self.provider_auth.model(),
            "defaultAuthProvider": self.provider_auth.provider(),
            "defaultAuthChoice": self.provider_auth.auth_choice(),
        })
    }
}

/// A System agent running as `account_id` with a synthetic key, for database
/// tests that drive the real sweep.
#[cfg(test)]
pub(crate) fn test_config(account_id: &str) -> SystemAgentConfig {
    SystemAgentConfig {
        group_chat_enabled: true,
        account_id: account_id.to_string(),
        owner_email: "system-agent-test@example.invalid".to_string(),
        agent_id: format!("system-agent-{account_id}"),
        name: DEFAULT_SYSTEM_AGENT_NAME.to_string(),
        subtitle: DEFAULT_SYSTEM_AGENT_SUBTITLE.to_string(),
        provider_auth: SystemAgentProviderAuth::openai_api_key("synthetic-key", "synthetic-model")
            .expect("synthetic System agent key"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn system_agent_is_off_without_a_key() {
        let values: HashMap<&str, &str> = HashMap::new();
        let config = PendingSystemAgentConfig::from_lookup(|key| {
            values.get(key).map(|value| value.to_string())
        })
        .unwrap();
        assert!(config.is_none());
    }

    #[test]
    fn system_agent_is_on_whenever_a_key_is_configured_unless_switched_off() {
        let on = HashMap::from([("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-test")]);
        assert!(PendingSystemAgentConfig::from_lookup(|key| on
            .get(key)
            .map(|value| value.to_string()))
        .unwrap()
        .is_some());
        let off = HashMap::from([
            ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-test"),
            ("KORDI_SYSTEM_AGENT_ENABLED", "false"),
        ]);
        assert!(PendingSystemAgentConfig::from_lookup(|key| off
            .get(key)
            .map(|value| value.to_string()))
        .unwrap()
        .is_none());
    }

    #[test]
    fn grounding_credentials_can_be_enabled_without_group_chat_automation() {
        for name in [
            "KORDI_SYSTEM_AGENT_GROUP_CHAT_ENABLED",
            "KORDI_PIP_GROUP_CHAT_ENABLED",
        ] {
            let config = configured(&[
                ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "synthetic-key"),
                (name, "false"),
            ])
            .expect("Grounding service remains available");
            assert!(!config.group_chat_enabled);
            assert_eq!(config.provider_auth.api_key(), "synthetic-key");
        }
        let config = configured(&[
            ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "synthetic-key"),
            ("KORDI_SYSTEM_AGENT_GROUP_CHAT_ENABLED", "true"),
            ("KORDI_PIP_GROUP_CHAT_ENABLED", "false"),
        ])
        .unwrap();
        assert!(
            config.group_chat_enabled,
            "the new setting takes precedence"
        );
    }

    #[test]
    fn enabled_system_agent_requires_its_own_api_key() {
        let values = HashMap::from([("KORDI_SYSTEM_AGENT_ENABLED", "true")]);
        let error = PendingSystemAgentConfig::from_lookup(|key| {
            values.get(key).map(|value| value.to_string())
        })
        .unwrap_err();
        assert!(matches!(error, SystemAgentConfigError::Invalid(_)));
    }

    #[test]
    fn defaults_fill_everything_but_the_key() {
        let values = HashMap::from([
            ("KORDI_SYSTEM_AGENT_ENABLED", "yes"),
            ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", " sk-test "),
        ]);
        let config = PendingSystemAgentConfig::from_lookup(|key| {
            values.get(key).map(|value| value.to_string())
        })
        .unwrap()
        .unwrap();
        assert!(config.group_chat_enabled);
        assert_eq!(config.account_id, DEFAULT_SYSTEM_AGENT_ACCOUNT_ID);
        assert_eq!(config.agent_id, DEFAULT_SYSTEM_AGENT_ID);
        assert_eq!(config.name, "System");
        assert_eq!(config.provider_auth.api_key(), "sk-test");
        assert_eq!(
            config.provider_auth.model(),
            DEFAULT_SYSTEM_AGENT_OPENAI_MODEL
        );
        assert!(!format!("{:?}", config.provider_auth).contains("sk-test"));
    }

    fn lookup(
        extra: Option<&'static str>,
    ) -> Result<PendingSystemAgentConfig, SystemAgentConfigError> {
        let mut values = HashMap::from([("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-test")]);
        if let Some(url) = extra {
            values.insert("KORDI_SYSTEM_AGENT_OPENAI_BASE_URL", url);
        }
        PendingSystemAgentConfig::from_lookup(|key| values.get(key).map(|value| value.to_string()))
            .map(|config| config.expect("configured"))
    }

    #[test]
    fn base_url_defaults_to_openai_when_unset() {
        let config = lookup(None).unwrap();
        assert_eq!(
            config.provider_auth.base_url(),
            DEFAULT_SYSTEM_AGENT_OPENAI_BASE_URL
        );
    }

    #[test]
    fn base_url_override_is_used_and_trailing_slash_stripped() {
        let config = lookup(Some(" https://gateway.example.invalid/v1/ ")).unwrap();
        assert_eq!(
            config.provider_auth.base_url(),
            "https://gateway.example.invalid/v1"
        );
        let config = lookup(Some("http://127.0.0.1:4000/v1")).unwrap();
        assert_eq!(config.provider_auth.base_url(), "http://127.0.0.1:4000/v1");
    }

    fn configured(values: &[(&str, &str)]) -> Option<PendingSystemAgentConfig> {
        let values: HashMap<&str, &str> = values.iter().copied().collect();
        PendingSystemAgentConfig::from_lookup(|key| values.get(key).map(|value| value.to_string()))
            .unwrap()
    }

    #[test]
    fn new_and_old_setting_names_are_both_read() {
        let new = configured(&[
            ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-new"),
            ("KORDI_SYSTEM_AGENT_OPENAI_MODEL", "model-new"),
        ])
        .unwrap();
        assert_eq!(new.provider_auth.api_key(), "sk-new");
        assert_eq!(new.provider_auth.model(), "model-new");
        let old = configured(&[
            ("KORDI_PIP_OPENAI_API_KEY", "sk-old"),
            ("KORDI_PIP_OPENAI_MODEL", "model-old"),
            ("KORDI_PIP_OWNER_EMAIL", "old@example.invalid"),
        ])
        .unwrap();
        assert_eq!(old.provider_auth.api_key(), "sk-old");
        assert_eq!(old.provider_auth.model(), "model-old");
        assert_eq!(old.owner_email, "old@example.invalid");
    }

    #[test]
    fn the_new_setting_name_wins_over_the_old_one() {
        let config = configured(&[
            ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-new"),
            ("KORDI_PIP_OPENAI_API_KEY", "sk-old"),
            ("KORDI_SYSTEM_AGENT_AGENT_NAME", " "),
            ("KORDI_PIP_AGENT_NAME", "Old name"),
        ])
        .unwrap();
        assert_eq!(config.provider_auth.api_key(), "sk-new");
        assert_eq!(config.name, "Old name", "a blank new value falls back");
        let on = [
            ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-new"),
            ("KORDI_SYSTEM_AGENT_ENABLED", "true"),
            ("KORDI_PIP_ENABLED", "false"),
        ];
        assert!(configured(&on).is_some());
    }

    #[test]
    fn either_enabled_name_switches_it_off() {
        for name in ["KORDI_SYSTEM_AGENT_ENABLED", "KORDI_PIP_ENABLED"] {
            let values = [
                ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-test"),
                (name, "false"),
            ];
            assert!(configured(&values).is_none(), "{name}");
        }
    }

    #[test]
    fn non_https_base_url_is_rejected() {
        for bad in [
            "http://gateway.example.invalid/v1",
            "ftp://x",
            "gateway.example.invalid",
            "http://localhost.evil.invalid/v1",
        ] {
            let error = lookup(Some(bad)).unwrap_err();
            assert!(
                matches!(error, SystemAgentConfigError::Invalid(m) if m == "KORDI_SYSTEM_AGENT_OPENAI_BASE_URL must be an https URL"),
                "{bad}"
            );
        }
    }
    #[test]
    fn vertex_service_uses_explicit_model_without_an_openai_key() {
        let mut values = HashMap::from([
            ("KORDI_SYSTEM_AGENT_ENABLED", "true"),
            ("KORDI_SYSTEM_AGENT_OWNER_EMAIL", "support@example.invalid"),
            ("KORDI_SYSTEM_AGENT_PROVIDER", "vertex-ai"),
            ("KORDI_SERVICE_VERTEX_PROJECT", "synthetic-project"),
            ("KORDI_SYSTEM_AGENT_VERTEX_MODEL", "google/synthetic-model"),
        ]);
        let config = PendingSystemAgentConfig::from_lookup(|key| {
            values.get(key).map(|value| value.to_string())
        })
        .unwrap()
        .unwrap();
        assert_eq!(config.provider_auth.provider(), "vertex-ai");
        assert_eq!(config.provider_auth.model(), "google/synthetic-model");
        assert!(config.provider_auth.credential().is_google_cloud());
        assert!(config
            .provider_auth
            .base_url()
            .starts_with("https://aiplatform.googleapis.com/"));
        // Selecting Vertex never silently falls back to an existing OpenAI key.
        values.insert("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "unused-secret");
        values.remove("KORDI_SYSTEM_AGENT_VERTEX_MODEL");
        assert!(PendingSystemAgentConfig::from_lookup(|key| values
            .get(key)
            .map(|value| value.to_string()))
        .is_err());
        values.insert("KORDI_SYSTEM_AGENT_ENABLED", "false");
        assert!(PendingSystemAgentConfig::from_lookup(|key| values
            .get(key)
            .map(|value| value.to_string()))
        .unwrap()
        .is_none());
    }

    #[test]
    fn service_rejects_unknown_provider() {
        let values = HashMap::from([
            ("KORDI_SYSTEM_AGENT_ENABLED", "true"),
            ("KORDI_SYSTEM_AGENT_OWNER_EMAIL", "support@example.invalid"),
            ("KORDI_SYSTEM_AGENT_PROVIDER", "typo"),
            ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "unused-secret"),
        ]);
        assert!(PendingSystemAgentConfig::from_lookup(|key| values
            .get(key)
            .map(|value| value.to_string()))
        .is_err());
    }
}
