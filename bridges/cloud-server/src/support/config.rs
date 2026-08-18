use std::{env, fmt};

pub const DEFAULT_SUPPORT_ACCOUNT_ID: &str = "acct_kordi_support";
pub const DEFAULT_SUPPORT_AGENT_ID: &str = "cloud_agent_kordi_support";
pub const DEFAULT_SUPPORT_NAME: &str = "Kordi Support";
pub const DEFAULT_SUPPORT_SUBTITLE: &str = "Ask questions or suggest improvements";
pub const DEFAULT_SUPPORT_OPENAI_MODEL: &str = "gpt-5.6-luna";
const SUPPORT_OPENAI_PROVIDER: &str = "openai";
const SUPPORT_OPENAI_AUTH_CHOICE: &str = "support-service-api-key";
const SUPPORT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const SUPPORT_OPENAI_SNAPSHOT_ID: &str = "support-service-openai";

#[derive(Clone)]
pub struct SupportProviderAuth {
    api_key: String,
    model: String,
}

impl SupportProviderAuth {
    pub fn openai_api_key(
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Result<Self, SupportConfigError> {
        let api_key = api_key.into();
        let model = model.into();
        let api_key = api_key.trim().to_string();
        let model = model.trim().to_string();
        if api_key.is_empty() {
            return Err(SupportConfigError::Invalid(
                "KORDI_SUPPORT_OPENAI_API_KEY is required",
            ));
        }
        if model.is_empty() {
            return Err(SupportConfigError::Invalid(
                "KORDI_SUPPORT_OPENAI_MODEL is required",
            ));
        }
        Ok(Self { api_key, model })
    }

    pub fn provider(&self) -> &'static str {
        SUPPORT_OPENAI_PROVIDER
    }

    pub fn auth_choice(&self) -> &'static str {
        SUPPORT_OPENAI_AUTH_CHOICE
    }

    pub fn base_url(&self) -> &'static str {
        SUPPORT_OPENAI_BASE_URL
    }

    pub fn snapshot_id(&self) -> &'static str {
        SUPPORT_OPENAI_SNAPSHOT_ID
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub(crate) fn api_key(&self) -> &str {
        &self.api_key
    }
}

impl fmt::Debug for SupportProviderAuth {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SupportProviderAuth")
            .field("provider", &self.provider())
            .field("auth_choice", &self.auth_choice())
            .field("model", &self.model)
            .field("api_key", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone)]
pub struct PendingSupportConfig {
    pub owner_account_id: String,
    pub owner_email: String,
    pub agent_id: String,
    pub name: String,
    pub subtitle: String,
    pub inbox: String,
    pub provider_auth: SupportProviderAuth,
}

#[derive(Debug, Clone)]
pub struct SupportConfig {
    pub owner_account_id: String,
    pub owner_email: String,
    pub agent_id: String,
    pub name: String,
    pub subtitle: String,
    pub inbox: String,
    pub contact_created_at: String,
    pub(super) provider_auth: SupportProviderAuth,
}

#[derive(Debug)]
pub enum SupportConfigError {
    Invalid(&'static str),
    Database(sqlx_core::Error),
}

impl std::fmt::Display for SupportConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "{message}"),
            Self::Database(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for SupportConfigError {}

impl From<sqlx_core::Error> for SupportConfigError {
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

impl PendingSupportConfig {
    pub fn from_env() -> Result<Option<Self>, SupportConfigError> {
        Self::from_lookup(|key| env::var(key).ok())
    }

    fn from_lookup(
        mut get: impl FnMut(&str) -> Option<String>,
    ) -> Result<Option<Self>, SupportConfigError> {
        if !enabled(get("KORDI_SUPPORT_ENABLED").as_deref()) {
            return Ok(None);
        }

        let owner_email = optional(&mut get, "KORDI_SUPPORT_OWNER_EMAIL").ok_or(
            SupportConfigError::Invalid("KORDI_SUPPORT_OWNER_EMAIL is required"),
        )?;
        let inbox =
            optional(&mut get, "KORDI_SUPPORT_INBOX").unwrap_or_else(|| owner_email.clone());
        if !owner_email.contains('@') || !inbox.contains('@') {
            return Err(SupportConfigError::Invalid(
                "Kordi support email configuration is invalid",
            ));
        }
        let api_key = optional(&mut get, "KORDI_SUPPORT_OPENAI_API_KEY").ok_or(
            SupportConfigError::Invalid("KORDI_SUPPORT_OPENAI_API_KEY is required"),
        )?;
        let model = required_or_default(
            &mut get,
            "KORDI_SUPPORT_OPENAI_MODEL",
            DEFAULT_SUPPORT_OPENAI_MODEL,
        );

        Ok(Some(Self {
            owner_account_id: required_or_default(
                &mut get,
                "KORDI_SUPPORT_OWNER_ACCOUNT_ID",
                DEFAULT_SUPPORT_ACCOUNT_ID,
            ),
            owner_email,
            agent_id: required_or_default(
                &mut get,
                "KORDI_SUPPORT_AGENT_ID",
                DEFAULT_SUPPORT_AGENT_ID,
            ),
            name: required_or_default(&mut get, "KORDI_SUPPORT_AGENT_NAME", DEFAULT_SUPPORT_NAME),
            subtitle: required_or_default(
                &mut get,
                "KORDI_SUPPORT_AGENT_SUBTITLE",
                DEFAULT_SUPPORT_SUBTITLE,
            ),
            inbox,
            provider_auth: SupportProviderAuth::openai_api_key(api_key, model)?,
        }))
    }
}

impl SupportConfig {
    pub fn provider_auth(&self) -> &SupportProviderAuth {
        &self.provider_auth
    }

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
    fn support_feature_requires_an_explicit_enable_flag() {
        assert!(!enabled(None));
        assert!(!enabled(Some("false")));
        assert!(enabled(Some(" YES ")));
    }

    #[test]
    fn enabled_support_requires_a_dedicated_openai_api_key() {
        let values = HashMap::from([
            ("KORDI_SUPPORT_ENABLED", "true"),
            ("KORDI_SUPPORT_OWNER_EMAIL", "support@example.com"),
        ]);
        let error =
            PendingSupportConfig::from_lookup(|key| values.get(key).map(|value| value.to_string()))
                .unwrap_err();

        assert_eq!(
            error.to_string(),
            "KORDI_SUPPORT_OPENAI_API_KEY is required"
        );
    }

    #[test]
    fn support_api_key_is_redacted_and_owns_the_model_route() {
        let values = HashMap::from([
            ("KORDI_SUPPORT_ENABLED", "true"),
            ("KORDI_SUPPORT_OWNER_EMAIL", "support@example.com"),
            ("KORDI_SUPPORT_OPENAI_API_KEY", "secret-support-key"),
            ("KORDI_SUPPORT_OPENAI_MODEL", "gpt-5.6-luna"),
        ]);
        let config =
            PendingSupportConfig::from_lookup(|key| values.get(key).map(|value| value.to_string()))
                .unwrap()
                .unwrap();

        assert_eq!(config.provider_auth.provider(), "openai");
        assert_eq!(config.provider_auth.model(), "gpt-5.6-luna");
        assert_eq!(
            config.provider_auth.auth_choice(),
            "support-service-api-key"
        );
        let debug = format!("{config:?}");
        assert!(debug.contains("[REDACTED]"));
        assert!(!debug.contains("secret-support-key"));
    }
}
