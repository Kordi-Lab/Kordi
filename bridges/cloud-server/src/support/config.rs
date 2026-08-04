use std::env;

pub const DEFAULT_SUPPORT_ACCOUNT_ID: &str = "acct_kordi_support";
pub const DEFAULT_SUPPORT_AGENT_ID: &str = "cloud_agent_kordi_support";
pub const DEFAULT_SUPPORT_NAME: &str = "Kordi Support";
pub const DEFAULT_SUPPORT_SUBTITLE: &str = "Ask questions or suggest improvements";

#[derive(Debug, Clone)]
pub struct PendingSupportConfig {
    pub owner_account_id: String,
    pub owner_email: String,
    pub agent_id: String,
    pub name: String,
    pub subtitle: String,
    pub inbox: String,
    pub default_model: Option<String>,
    pub default_auth_provider: Option<String>,
    pub default_auth_choice: Option<String>,
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
    pub default_model: Option<String>,
    pub default_auth_provider: Option<String>,
    pub default_auth_choice: Option<String>,
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

fn enabled(value: Option<String>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn optional(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn required_or_default(key: &str, default: &str) -> String {
    optional(key).unwrap_or_else(|| default.to_string())
}

impl PendingSupportConfig {
    pub fn from_env() -> Result<Option<Self>, SupportConfigError> {
        if !enabled(env::var("KORDI_SUPPORT_ENABLED").ok()) {
            return Ok(None);
        }

        let owner_email = optional("KORDI_SUPPORT_OWNER_EMAIL").ok_or(
            SupportConfigError::Invalid("KORDI_SUPPORT_OWNER_EMAIL is required"),
        )?;
        let inbox = optional("KORDI_SUPPORT_INBOX").unwrap_or_else(|| owner_email.clone());
        if !owner_email.contains('@') || !inbox.contains('@') {
            return Err(SupportConfigError::Invalid(
                "Kordi support email configuration is invalid",
            ));
        }

        Ok(Some(Self {
            owner_account_id: required_or_default(
                "KORDI_SUPPORT_OWNER_ACCOUNT_ID",
                DEFAULT_SUPPORT_ACCOUNT_ID,
            ),
            owner_email,
            agent_id: required_or_default("KORDI_SUPPORT_AGENT_ID", DEFAULT_SUPPORT_AGENT_ID),
            name: required_or_default("KORDI_SUPPORT_AGENT_NAME", DEFAULT_SUPPORT_NAME),
            subtitle: required_or_default("KORDI_SUPPORT_AGENT_SUBTITLE", DEFAULT_SUPPORT_SUBTITLE),
            inbox,
            default_model: optional("KORDI_SUPPORT_AGENT_DEFAULT_MODEL"),
            default_auth_provider: optional("KORDI_SUPPORT_AGENT_DEFAULT_AUTH_PROVIDER"),
            default_auth_choice: optional("KORDI_SUPPORT_AGENT_DEFAULT_AUTH_CHOICE"),
        }))
    }
}

impl SupportConfig {
    pub fn model_routing(&self) -> serde_json::Value {
        serde_json::json!({
            "defaultModel": self.default_model,
            "defaultAuthProvider": self.default_auth_provider,
            "defaultAuthChoice": self.default_auth_choice,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::enabled;

    #[test]
    fn support_feature_requires_an_explicit_enable_flag() {
        assert!(!enabled(None));
        assert!(!enabled(Some("false".into())));
        assert!(enabled(Some(" YES ".into())));
    }
}
