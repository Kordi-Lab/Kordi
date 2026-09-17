//! Configuration for PiP, the built-in plan agent.
//!
//! PiP mirrors the Kordi Support agent's shape: a system-managed account that
//! runs on a Kordi-operated provider credential instead of any member's own
//! key. Everything here is read once at startup from the environment.

use std::{env, fmt};

pub const DEFAULT_PIP_ACCOUNT_ID: &str = "acct_kordi_pip";
pub const DEFAULT_PIP_AGENT_ID: &str = "cloud_agent_kordi_pip";
pub const DEFAULT_PIP_NAME: &str = "PiP";
pub const DEFAULT_PIP_SUBTITLE: &str = "Keeps plans in this chat honest";
pub const DEFAULT_PIP_OWNER_EMAIL: &str = "pip@kordi.ai";
pub const DEFAULT_PIP_OPENAI_MODEL: &str = "gpt-5.6-luna";

const PIP_OPENAI_PROVIDER: &str = "openai";
const PIP_OPENAI_AUTH_CHOICE: &str = "pip-service-api-key";
const PIP_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const PIP_OPENAI_SNAPSHOT_ID: &str = "pip-service-openai";

#[derive(Clone)]
pub struct PipProviderAuth {
    api_key: String,
    model: String,
}

impl PipProviderAuth {
    pub fn openai_api_key(
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Result<Self, PipConfigError> {
        let api_key = api_key.into().trim().to_string();
        let model = model.into().trim().to_string();
        if api_key.is_empty() {
            return Err(PipConfigError::Invalid(
                "KORDI_PIP_OPENAI_API_KEY is required",
            ));
        }
        if model.is_empty() {
            return Err(PipConfigError::Invalid(
                "KORDI_PIP_OPENAI_MODEL is required",
            ));
        }
        Ok(Self { api_key, model })
    }

    pub fn provider(&self) -> &'static str {
        PIP_OPENAI_PROVIDER
    }

    pub fn auth_choice(&self) -> &'static str {
        PIP_OPENAI_AUTH_CHOICE
    }

    pub fn base_url(&self) -> &'static str {
        PIP_OPENAI_BASE_URL
    }

    pub fn snapshot_id(&self) -> &'static str {
        PIP_OPENAI_SNAPSHOT_ID
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub(crate) fn api_key(&self) -> &str {
        &self.api_key
    }
}

impl fmt::Debug for PipProviderAuth {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PipProviderAuth")
            .field("provider", &self.provider())
            .field("auth_choice", &self.auth_choice())
            .field("model", &self.model)
            .field("api_key", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone)]
pub struct PendingPipConfig {
    pub account_id: String,
    pub owner_email: String,
    pub agent_id: String,
    pub name: String,
    pub subtitle: String,
    pub provider_auth: PipProviderAuth,
}

#[derive(Debug, Clone)]
pub struct PipConfig {
    pub account_id: String,
    pub owner_email: String,
    pub agent_id: String,
    pub name: String,
    pub subtitle: String,
    pub(super) provider_auth: PipProviderAuth,
}

#[derive(Debug)]
pub enum PipConfigError {
    Invalid(&'static str),
    Database(sqlx_core::Error),
}

impl fmt::Display for PipConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "{message}"),
            Self::Database(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for PipConfigError {}

impl From<sqlx_core::Error> for PipConfigError {
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

fn optional(get: &mut impl FnMut(&str) -> Option<String>, key: &str) -> Option<String> {
    get(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn required_or_default(
    get: &mut impl FnMut(&str) -> Option<String>,
    key: &str,
    default: &str,
) -> String {
    optional(get, key).unwrap_or_else(|| default.to_string())
}

impl PendingPipConfig {
    pub fn from_env() -> Result<Option<Self>, PipConfigError> {
        Self::from_lookup(|key| env::var(key).ok())
    }

    pub fn from_lookup(
        mut get: impl FnMut(&str) -> Option<String>,
    ) -> Result<Option<Self>, PipConfigError> {
        // PiP is always on once its key is configured; KORDI_PIP_ENABLED=false
        // is the only way to turn it off, and =true without a key is an error.
        let switch = get("KORDI_PIP_ENABLED");
        if switched_off(switch.as_deref()) {
            return Ok(None);
        }
        let Some(api_key) = optional(&mut get, "KORDI_PIP_OPENAI_API_KEY") else {
            return if enabled(switch.as_deref()) {
                Err(PipConfigError::Invalid(
                    "KORDI_PIP_OPENAI_API_KEY is required",
                ))
            } else {
                Ok(None)
            };
        };
        let model =
            required_or_default(&mut get, "KORDI_PIP_OPENAI_MODEL", DEFAULT_PIP_OPENAI_MODEL);
        let owner_email =
            required_or_default(&mut get, "KORDI_PIP_OWNER_EMAIL", DEFAULT_PIP_OWNER_EMAIL);
        if !owner_email.contains('@') {
            return Err(PipConfigError::Invalid(
                "KORDI_PIP_OWNER_EMAIL must be an email address",
            ));
        }
        Ok(Some(Self {
            account_id: required_or_default(
                &mut get,
                "KORDI_PIP_ACCOUNT_ID",
                DEFAULT_PIP_ACCOUNT_ID,
            ),
            owner_email,
            agent_id: required_or_default(&mut get, "KORDI_PIP_AGENT_ID", DEFAULT_PIP_AGENT_ID),
            name: required_or_default(&mut get, "KORDI_PIP_AGENT_NAME", DEFAULT_PIP_NAME),
            subtitle: required_or_default(
                &mut get,
                "KORDI_PIP_AGENT_SUBTITLE",
                DEFAULT_PIP_SUBTITLE,
            ),
            provider_auth: PipProviderAuth::openai_api_key(api_key, model)?,
        }))
    }
}

impl PipConfig {
    pub fn provider_auth(&self) -> &PipProviderAuth {
        &self.provider_auth
    }

    /// The runtime route stored on every PiP run so the runner selects the
    /// service credential instead of looking for a member snapshot.
    pub fn model_routing(&self) -> serde_json::Value {
        serde_json::json!({
            "defaultModel": self.provider_auth.model(),
            "defaultAuthProvider": self.provider_auth.provider(),
            "defaultAuthChoice": self.provider_auth.auth_choice(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn pip_is_off_without_a_key() {
        let values: HashMap<&str, &str> = HashMap::new();
        let config =
            PendingPipConfig::from_lookup(|key| values.get(key).map(|value| value.to_string()))
                .unwrap();
        assert!(config.is_none());
    }

    #[test]
    fn pip_is_on_whenever_a_key_is_configured_unless_switched_off() {
        let on = HashMap::from([("KORDI_PIP_OPENAI_API_KEY", "sk-test")]);
        assert!(
            PendingPipConfig::from_lookup(|key| on.get(key).map(|value| value.to_string()))
                .unwrap()
                .is_some()
        );
        let off = HashMap::from([
            ("KORDI_PIP_OPENAI_API_KEY", "sk-test"),
            ("KORDI_PIP_ENABLED", "false"),
        ]);
        assert!(
            PendingPipConfig::from_lookup(|key| off.get(key).map(|value| value.to_string()))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn enabled_pip_requires_its_own_api_key() {
        let values = HashMap::from([("KORDI_PIP_ENABLED", "true")]);
        let error =
            PendingPipConfig::from_lookup(|key| values.get(key).map(|value| value.to_string()))
                .unwrap_err();
        assert!(matches!(error, PipConfigError::Invalid(_)));
    }

    #[test]
    fn defaults_fill_everything_but_the_key() {
        let values = HashMap::from([
            ("KORDI_PIP_ENABLED", "yes"),
            ("KORDI_PIP_OPENAI_API_KEY", " sk-test "),
        ]);
        let config =
            PendingPipConfig::from_lookup(|key| values.get(key).map(|value| value.to_string()))
                .unwrap()
                .unwrap();
        assert_eq!(config.account_id, DEFAULT_PIP_ACCOUNT_ID);
        assert_eq!(config.agent_id, DEFAULT_PIP_AGENT_ID);
        assert_eq!(config.name, "PiP");
        assert_eq!(config.provider_auth.api_key(), "sk-test");
        assert_eq!(config.provider_auth.model(), DEFAULT_PIP_OPENAI_MODEL);
        assert!(!format!("{:?}", config.provider_auth).contains("sk-test"));
    }
}
