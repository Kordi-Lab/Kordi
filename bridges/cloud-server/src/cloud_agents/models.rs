use serde::{Deserialize, Serialize};

pub const CLOUD_AGENT_ACCESS_PRIVATE: &str = "private";
pub const CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS: &str = "participant_conversations";
pub const CLOUD_AGENT_STATUS_ACTIVE: &str = "active";
pub const CLOUD_AGENT_STATUS_ARCHIVED: &str = "archived";

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAgentDefinition {
    pub agent_id: String,
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
        assert_eq!(input.access_scope.as_deref(), Some("participant_conversations"));
    }

    #[test]
    fn access_scope_rejects_public_for_mvp() {
        assert!(clean_access_scope(Some("public")).is_err());
        assert!(clean_access_scope(Some("workspace")).is_err());
    }

    #[test]
    fn required_text_trims_and_limits() {
        assert_eq!(clean_required_text("  Docs Bot  ", "name", 32).unwrap(), "Docs Bot");
        assert!(clean_required_text("   ", "name", 32).is_err());
        assert!(clean_required_text("abcdef", "name", 3).is_err());
    }

    #[test]
    fn string_list_cleans_dedupes_and_caps() {
        assert_eq!(
            clean_string_list(vec![" one ".into(), "".into(), "one".into(), "two".into()], 4, 8),
            vec!["one".to_string(), "two".to_string()],
        );
        assert_eq!(clean_string_list(vec!["abcdef".into(), "two".into()], 1, 3), vec!["abc".to_string()]);
    }
}
