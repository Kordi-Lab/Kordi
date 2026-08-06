use serde::{Deserialize, Serialize};

pub const CLOUD_AGENT_ACCESS_PRIVATE: &str = "private";
pub const CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS: &str = "participant_conversations";
pub const CLOUD_AGENT_STATUS_ACTIVE: &str = "active";
pub const CLOUD_AGENT_STATUS_ARCHIVED: &str = "archived";
pub const CLOUD_AGENT_PROACTIVE_SKILL_PACK_V1: &str = "proact-v1";
const PROACTIVE_SKILL_PACK_MANIFEST: &str =
    include_str!("../../../../shared/proactive/proact-v1.json");
const REQUIRED_PROACTIVE_SKILLS: &[&str] = &[
    "using-proactive-collaboration",
    "breakdown-judgement",
    "clarification-first",
    "plan-completion",
    "conflict-mediation",
    "constraint-reminder",
    "goal-refocusing",
    "loop-breaking",
    "participation-balancing",
    "risk-check",
];

fn default_proactive_skill_pack() -> String {
    CLOUD_AGENT_PROACTIVE_SKILL_PACK_V1.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudAgentProactiveConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_proactive_skill_pack")]
    pub skill_pack: String,
}

impl Default for CloudAgentProactiveConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            skill_pack: default_proactive_skill_pack(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudAgentMentionPermissions {
    #[serde(default)]
    pub people: bool,
    #[serde(default)]
    pub agents: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudAgentResource {
    pub kind: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudAgentSkill {
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAgentDefinition {
    pub agent_id: String,
    pub source_agent_id: Option<String>,
    pub owner_account_id: String,
    pub access_scope: String,
    pub status: String,
    pub name: String,
    pub role: String,
    pub description: Option<String>,
    pub system_prompt: String,
    pub source_summary: Option<String>,
    pub boundaries: Vec<String>,
    pub resources: Vec<CloudAgentResource>,
    pub skills: Vec<CloudAgentSkill>,
    pub model_routing: serde_json::Value,
    pub proactive: CloudAgentProactiveConfig,
    pub mention_permissions: CloudAgentMentionPermissions,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SharedCloudAgentSummary {
    pub agent_id: String,
    pub owner_account_id: String,
    pub owner_display_name: Option<String>,
    pub access_scope: String,
    pub name: String,
    pub role: String,
    pub description: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCloudAgentRequest {
    pub source_agent_id: Option<String>,
    pub access_scope: Option<String>,
    pub name: String,
    pub role: String,
    pub description: Option<String>,
    pub system_prompt: String,
    pub source_summary: Option<String>,
    #[serde(default)]
    pub boundaries: Vec<String>,
    #[serde(default)]
    pub resources: Vec<CloudAgentResource>,
    #[serde(default)]
    pub skills: Vec<CloudAgentSkill>,
    #[serde(default)]
    pub model_routing: Option<serde_json::Value>,
    #[serde(default)]
    pub proactive: Option<CloudAgentProactiveConfig>,
    #[serde(default)]
    pub mention_permissions: Option<CloudAgentMentionPermissions>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCloudAgentRequest {
    pub access_scope: Option<String>,
    pub name: Option<String>,
    pub role: Option<String>,
    pub description: Option<String>,
    pub system_prompt: Option<String>,
    pub source_summary: Option<String>,
    pub boundaries: Option<Vec<String>>,
    pub resources: Option<Vec<CloudAgentResource>>,
    pub skills: Option<Vec<CloudAgentSkill>>,
    pub model_routing: Option<serde_json::Value>,
    pub proactive: Option<CloudAgentProactiveConfig>,
    pub mention_permissions: Option<CloudAgentMentionPermissions>,
}

pub fn clean_proactive_config(
    value: Option<CloudAgentProactiveConfig>,
    access_scope: &str,
) -> Result<CloudAgentProactiveConfig, String> {
    let value = value.unwrap_or_default();
    let skill_pack = value.skill_pack.trim();
    if !value.enabled {
        if !skill_pack.is_empty() && skill_pack != CLOUD_AGENT_PROACTIVE_SKILL_PACK_V1 {
            return Err("Unsupported proactive collaboration skill pack.".to_string());
        }
        return Ok(CloudAgentProactiveConfig::default());
    }
    if access_scope != CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS {
        return Err(
            "Proactive collaboration requires access for people in this agent's chats.".to_string(),
        );
    }
    if skill_pack != CLOUD_AGENT_PROACTIVE_SKILL_PACK_V1 {
        return Err("Unsupported proactive collaboration skill pack.".to_string());
    }
    validate_proactive_skill_pack()?;
    Ok(CloudAgentProactiveConfig {
        enabled: true,
        skill_pack: default_proactive_skill_pack(),
    })
}

fn validate_proactive_skill_pack() -> Result<(), String> {
    let manifest: serde_json::Value = serde_json::from_str(PROACTIVE_SKILL_PACK_MANIFEST)
        .map_err(|_| "The proactive collaboration skill pack could not be loaded.".to_string())?;
    if manifest
        .get("schemaVersion")
        .and_then(serde_json::Value::as_i64)
        != Some(1)
        || manifest.get("id").and_then(serde_json::Value::as_str)
            != Some(CLOUD_AGENT_PROACTIVE_SKILL_PACK_V1)
        || manifest
            .get("rootSkill")
            .and_then(serde_json::Value::as_str)
            != Some("using-proactive-collaboration")
    {
        return Err(
            "The proactive collaboration skill pack has an unsupported version or root skill."
                .to_string(),
        );
    }
    if ["displayName", "description"].iter().any(|field| {
        manifest
            .get(*field)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .is_none_or(str::is_empty)
    }) {
        return Err("The proactive collaboration skill pack has invalid metadata.".to_string());
    }
    let skills = manifest
        .get("skills")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            "The proactive collaboration skill pack has no loadable skills.".to_string()
        })?;
    let mut names = std::collections::HashSet::new();
    for skill in skills {
        let name = skill
            .get("name")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let description = skill
            .get("description")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let instructions = skill
            .get("instructions")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if name.is_empty()
            || description.is_empty()
            || instructions.is_empty()
            || !names.insert(name)
        {
            return Err(
                "The proactive collaboration skill pack contains an invalid or duplicate skill."
                    .to_string(),
            );
        }
    }
    let missing = REQUIRED_PROACTIVE_SKILLS
        .iter()
        .filter(|name| !names.contains(**name))
        .copied()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(format!(
            "The proactive collaboration skill pack is missing: {}.",
            missing.join(", ")
        ));
    }
    Ok(())
}

pub fn clean_required_text(value: &str, field: &str, max_len: usize) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field} is required"));
    }
    if trimmed.len() > max_len {
        return Err(format!("{field} is too long"));
    }
    Ok(trimmed.to_string())
}

pub fn clean_optional_text(value: Option<&str>, max_len: usize) -> Result<Option<String>, String> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > max_len {
        return Err("value is too long".to_string());
    }
    Ok(Some(trimmed.to_string()))
}

pub fn clean_access_scope(value: Option<&str>) -> Result<String, String> {
    match value.unwrap_or(CLOUD_AGENT_ACCESS_PRIVATE).trim() {
        "" | CLOUD_AGENT_ACCESS_PRIVATE => Ok(CLOUD_AGENT_ACCESS_PRIVATE.to_string()),
        CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS => {
            Ok(CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS.to_string())
        }
        _ => Err("Unsupported Cloud Agent access scope".to_string()),
    }
}

pub fn clean_string_list(values: Vec<String>, max_items: usize, max_len: usize) -> Vec<String> {
    let mut cleaned = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() || cleaned.iter().any(|entry| entry == trimmed) {
            continue;
        }
        cleaned.push(trimmed.chars().take(max_len).collect::<String>());
        if cleaned.len() >= max_items {
            break;
        }
    }
    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_scope_defaults_to_private() {
        assert_eq!(clean_access_scope(None).unwrap(), "private");
        assert_eq!(clean_access_scope(Some("")).unwrap(), "private");
        assert_eq!(clean_access_scope(Some(" private ")).unwrap(), "private");
    }

    #[test]
    fn access_scope_accepts_participant_conversations() {
        assert_eq!(
            clean_access_scope(Some(" participant_conversations ")).unwrap(),
            "participant_conversations"
        );
    }

    #[test]
    fn update_request_accepts_access_scope_field() {
        let input: UpdateCloudAgentRequest = serde_json::from_value(serde_json::json!({
            "accessScope": "participant_conversations"
        }))
        .expect("deserialize update request");
        assert_eq!(
            input.access_scope.as_deref(),
            Some("participant_conversations")
        );
    }

    #[test]
    fn access_scope_rejects_public_for_mvp() {
        assert!(clean_access_scope(Some("public")).is_err());
        assert!(clean_access_scope(Some("workspace")).is_err());
    }

    #[test]
    fn proactive_requires_shared_access_and_known_pack() {
        let default = clean_proactive_config(None, CLOUD_AGENT_ACCESS_PRIVATE).unwrap();
        assert!(!default.enabled);
        assert_eq!(default.skill_pack, CLOUD_AGENT_PROACTIVE_SKILL_PACK_V1);
        validate_proactive_skill_pack().unwrap();
        let config = CloudAgentProactiveConfig {
            enabled: true,
            skill_pack: CLOUD_AGENT_PROACTIVE_SKILL_PACK_V1.to_string(),
        };
        assert!(clean_proactive_config(Some(config.clone()), CLOUD_AGENT_ACCESS_PRIVATE).is_err());
        assert!(
            clean_proactive_config(Some(config), CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS)
                .unwrap()
                .enabled
        );
    }

    #[test]
    fn mention_permissions_default_to_deny_for_new_agents() {
        assert_eq!(
            CloudAgentMentionPermissions::default(),
            CloudAgentMentionPermissions {
                people: false,
                agents: false,
            }
        );
    }

    #[test]
    fn required_text_trims_and_limits() {
        assert_eq!(
            clean_required_text("  Docs Bot  ", "name", 32).unwrap(),
            "Docs Bot"
        );
        assert!(clean_required_text("   ", "name", 32).is_err());
        assert!(clean_required_text("abcdef", "name", 3).is_err());
    }

    #[test]
    fn string_list_cleans_dedupes_and_caps() {
        assert_eq!(
            clean_string_list(
                vec![" one ".into(), "".into(), "one".into(), "two".into()],
                4,
                8
            ),
            vec!["one".to_string(), "two".to_string()],
        );
        assert_eq!(
            clean_string_list(vec!["abcdef".into(), "two".into()], 1, 3),
            vec!["abc".to_string()]
        );
    }
}
