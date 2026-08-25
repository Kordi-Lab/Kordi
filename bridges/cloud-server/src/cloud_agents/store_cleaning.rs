use chrono::{DateTime, Utc};

use crate::cloud_agents::models::{clean_optional_text, CloudAgentResource, CloudAgentSkill};
use crate::cloud_agents::store::CloudAgentStoreError;

pub(super) const BOUNDARY_MAX_ITEMS: usize = 12;

const SOURCE_SUMMARY_MAX_LEN: usize = 4_000;
const RESOURCE_MAX_ITEMS: usize = 24;
const RESOURCE_VALUE_MAX_LEN: usize = 4_000;
const SKILL_MAX_ITEMS: usize = 12;
const SKILL_FIELD_MAX_LEN: usize = 240;
const SKILL_CONTENT_MAX_LEN: usize = 96_000;

pub(super) fn timestamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339()
}

pub(super) fn clean_resources(resources: Vec<CloudAgentResource>) -> Vec<CloudAgentResource> {
    resources
        .into_iter()
        .filter_map(|resource| {
            let kind = resource.kind.trim();
            let value = resource.value.trim();
            if kind.is_empty() || value.is_empty() {
                return None;
            }
            Some(CloudAgentResource {
                kind: kind.chars().take(40).collect(),
                value: value.chars().take(RESOURCE_VALUE_MAX_LEN).collect(),
                title: clean_optional_text(resource.title.as_deref(), SKILL_FIELD_MAX_LEN)
                    .ok()
                    .flatten(),
                summary: clean_optional_text(resource.summary.as_deref(), SOURCE_SUMMARY_MAX_LEN)
                    .ok()
                    .flatten(),
            })
        })
        .take(RESOURCE_MAX_ITEMS)
        .collect()
}

pub(super) fn clean_skills(skills: Vec<CloudAgentSkill>) -> Vec<CloudAgentSkill> {
    let mut cleaned = Vec::new();
    for skill in skills {
        let name = skill.name.trim();
        let description = skill.description.trim();
        if name.is_empty()
            || description.is_empty()
            || cleaned
                .iter()
                .any(|entry: &CloudAgentSkill| entry.name == name)
        {
            continue;
        }
        cleaned.push(CloudAgentSkill {
            name: name.chars().take(SKILL_FIELD_MAX_LEN).collect(),
            description: description.chars().take(SKILL_FIELD_MAX_LEN).collect(),
            content: clean_optional_text(skill.content.as_deref(), SKILL_CONTENT_MAX_LEN)
                .ok()
                .flatten(),
        });
        if cleaned.len() >= SKILL_MAX_ITEMS {
            break;
        }
    }
    cleaned
}

pub(super) fn json_or_array<T: serde::Serialize>(
    value: &T,
) -> Result<serde_json::Value, CloudAgentStoreError> {
    serde_json::to_value(value).map_err(|err| CloudAgentStoreError::Invalid(err.to_string()))
}
