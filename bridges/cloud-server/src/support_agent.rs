use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};

pub const DEFAULT_SUPPORT_AGENT_ID: &str = "cloud_agent_kordi_support";
pub const DEFAULT_SUPPORT_AGENT_NAME: &str = "Kordi Support";
pub const DEFAULT_SUPPORT_AGENT_DESCRIPTION: &str =
    "Ask questions about Kordi or suggest improvements.";
const CLOUD_DIRECT_MESSAGE_PREFIX: &str = "kordi-cloud-message:";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupportAgentConfig {
    pub enabled: bool,
    pub owner_account_id: String,
    pub agent_id: String,
    pub name: String,
    pub description: String,
    pub default_model: Option<String>,
    pub default_auth_provider: Option<String>,
    pub default_auth_choice: Option<String>,
}

impl SupportAgentConfig {
    pub fn from_env() -> Option<Self> {
        let enabled = std::env::var("KORDI_SUPPORT_AGENT_ENABLED")
            .map(|value| {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes"
                )
            })
            .unwrap_or(false);
        if !enabled {
            return None;
        }
        let owner_account_id = std::env::var("KORDI_SUPPORT_AGENT_OWNER_ACCOUNT_ID")
            .ok()?
            .trim()
            .to_string();
        if owner_account_id.is_empty() {
            return None;
        }
        Some(Self {
            enabled,
            owner_account_id,
            agent_id: std::env::var("KORDI_SUPPORT_AGENT_ID")
                .unwrap_or_else(|_| DEFAULT_SUPPORT_AGENT_ID.to_string())
                .trim()
                .to_string(),
            name: std::env::var("KORDI_SUPPORT_AGENT_NAME")
                .unwrap_or_else(|_| DEFAULT_SUPPORT_AGENT_NAME.to_string())
                .trim()
                .to_string(),
            description: std::env::var("KORDI_SUPPORT_AGENT_DESCRIPTION")
                .unwrap_or_else(|_| DEFAULT_SUPPORT_AGENT_DESCRIPTION.to_string())
                .trim()
                .to_string(),
            default_model: env_optional("KORDI_SUPPORT_AGENT_DEFAULT_MODEL"),
            default_auth_provider: env_optional("KORDI_SUPPORT_AGENT_DEFAULT_AUTH_PROVIDER"),
            default_auth_choice: env_optional("KORDI_SUPPORT_AGENT_DEFAULT_AUTH_CHOICE"),
        })
    }

    pub fn model_routing_json(&self) -> serde_json::Value {
        serde_json::json!({
            "defaultModel": self.default_model,
            "defaultAuthProvider": self.default_auth_provider,
            "defaultAuthChoice": self.default_auth_choice,
        })
    }
}

fn env_optional(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn support_agent_system_prompt() -> String {
    r#"You are Kordi Support, the official help agent for Kordi.

Your job:
- Answer questions about how to use Kordi clearly and concisely.
- Help users understand chats, contacts, groups, agents, tasks, reminders, pins, artifacts, Cloud sync, and provider setup.
- Accept product suggestions and summarize them back to the user.
- Be honest when something is not implemented or when you need a human maintainer.

Boundaries:
- Do not reveal provider keys, server internals, raw runtime ids, or hidden Cloud infrastructure details.
- Do not claim to create GitHub issues or admin tickets unless a tool explicitly confirms that happened.
- Do not access private user data outside the current support conversation.
"#
    .trim()
    .to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupportContactSummaryFields {
    pub contact_id: String,
    pub account_id: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub created_at: String,
    pub target_cloud_agent_id: String,
    pub target_cloud_agent_name: String,
    pub target_cloud_agent_owner_account_id: String,
    pub target_cloud_agent_owner_name: String,
}

pub fn support_agent_contact_summary(
    config: &SupportAgentConfig,
    created_at: String,
) -> SupportContactSummaryFields {
    SupportContactSummaryFields {
        contact_id: "cloud-system:kordi-support".to_string(),
        account_id: config.owner_account_id.clone(),
        display_name: config.name.clone(),
        avatar_url: None,
        created_at,
        target_cloud_agent_id: config.agent_id.clone(),
        target_cloud_agent_name: config.name.clone(),
        target_cloud_agent_owner_account_id: config.owner_account_id.clone(),
        target_cloud_agent_owner_name: "Kordi".to_string(),
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SupportDirectMessageEnvelope {
    pub schema_version: i64,
    pub kind: String,
    pub text: String,
    #[serde(default)]
    pub target_cloud_agent_id: Option<String>,
    #[serde(default)]
    pub target_cloud_agent_name: Option<String>,
    #[serde(default)]
    pub target_cloud_agent_owner_account_id: Option<String>,
    #[serde(default)]
    pub target_cloud_agent_owner_name: Option<String>,
}

pub fn parse_support_direct_message(body: &str) -> Option<SupportDirectMessageEnvelope> {
    let encoded = body.trim().strip_prefix(CLOUD_DIRECT_MESSAGE_PREFIX)?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn message_targets_support_agent(
    body: &str,
    peer_account_id: &str,
    config: &SupportAgentConfig,
) -> bool {
    let Some(envelope) = parse_support_direct_message(body) else {
        return false;
    };
    envelope.kind == "message"
        && envelope.target_cloud_agent_id.as_deref() == Some(config.agent_id.as_str())
        && envelope.target_cloud_agent_owner_account_id.as_deref()
            == Some(config.owner_account_id.as_str())
        && peer_account_id == config.owner_account_id
}

#[cfg(test)]
pub fn encode_support_direct_message_for_tests(
    text: &str,
    agent_id: &str,
    owner_account_id: &str,
) -> String {
    let body = serde_json::json!({
        "schemaVersion": 1,
        "kind": "message",
        "text": text,
        "targetCloudAgentId": agent_id,
        "targetCloudAgentOwnerAccountId": owner_account_id,
        "targetCloudAgentName": DEFAULT_SUPPORT_AGENT_NAME,
        "targetCloudAgentOwnerName": "Kordi",
    });
    format!(
        "{}{}",
        CLOUD_DIRECT_MESSAGE_PREFIX,
        URL_SAFE_NO_PAD.encode(body.to_string())
    )
}
