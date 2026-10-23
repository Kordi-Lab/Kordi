//! The sources a profile's card is built from, as the owner last picked
//! them. Stored on the profile so every device shows the same picks; only
//! the owner ever sees them.

use serde::{Deserialize, Serialize};

pub(in crate::common_ground) const MAX_DOCUMENTS: usize = 8;
const MAX_DOCUMENT_ID_CHARS: usize = 80;
const MAX_TEXT_CHARS: usize = 4000;
const DEVICE_SOURCES: [&str; 2] = ["calendar", "reminders"];

/// `{memory, connectors, device, agents, documents, links, notes}`.
/// Clients send fields they cannot act on (agent files on iOS) unchanged.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(in crate::common_ground) struct SourcePicks {
    pub memory: bool,
    /// Connector providers, such as `gmail`.
    pub connectors: Vec<String>,
    /// `calendar` and `reminders`.
    pub device: Vec<String>,
    pub agents: bool,
    /// Attachment ids of the account's own Kordi documents.
    pub documents: Vec<String>,
    pub links: String,
    pub notes: String,
}

fn dedupe(values: impl Iterator<Item = String>, limit: usize) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for value in values {
        if kept.len() == limit {
            break;
        }
        if !kept.contains(&value) {
            kept.push(value);
        }
    }
    kept
}

impl SourcePicks {
    /// Drops unknown connectors and device sources, keeps up to
    /// [`MAX_DOCUMENTS`] document ids, and caps links and notes.
    pub fn cleaned(self) -> Self {
        let connectors = self
            .connectors
            .into_iter()
            .map(|provider| provider.trim().to_string())
            .filter(|provider| crate::connectors::providers::provider_spec(provider).is_some());
        let device = self
            .device
            .into_iter()
            .map(|source| source.trim().to_string())
            .filter(|source| DEVICE_SOURCES.contains(&source.as_str()));
        let documents = self
            .documents
            .into_iter()
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty() && id.chars().count() <= MAX_DOCUMENT_ID_CHARS);
        Self {
            memory: self.memory,
            connectors: dedupe(
                connectors,
                crate::connectors::providers::PROVIDER_SPECS.len(),
            ),
            device: dedupe(device, DEVICE_SOURCES.len()),
            agents: self.agents,
            documents: dedupe(documents, MAX_DOCUMENTS),
            links: self.links.chars().take(MAX_TEXT_CHARS).collect(),
            notes: self.notes.chars().take(MAX_TEXT_CHARS).collect(),
        }
    }

    /// The stored JSON.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cleaning_keeps_known_picks_only() {
        let picks: SourcePicks = serde_json::from_value(json!({
            "memory": true,
            "connectors": ["gmail", "outlook", "gmail", " github "],
            "device": ["calendar", "photos", "reminders"],
            "documents": ["att_1", "", "a".repeat(81), "att_1", "att_2", "att_3", "att_4",
                          "att_5", "att_6", "att_7", "att_8", "att_9"],
            "links": "x".repeat(4001),
            "notes": "Notes",
        }))
        .unwrap();
        let cleaned = picks.cleaned();
        assert_eq!(cleaned.connectors, vec!["gmail", "github"]);
        assert_eq!(cleaned.device, vec!["calendar", "reminders"]);
        assert_eq!(cleaned.documents.len(), MAX_DOCUMENTS);
        assert_eq!(cleaned.documents[0], "att_1");
        assert_eq!(cleaned.documents[7], "att_8");
        assert_eq!(cleaned.links.chars().count(), 4000);
        assert!(cleaned.memory && !cleaned.agents);
        assert_eq!(
            cleaned.to_json(),
            json!({
                "memory": true, "connectors": ["gmail", "github"],
                "device": ["calendar", "reminders"], "agents": false,
                "documents": cleaned.documents, "links": cleaned.links, "notes": "Notes",
            })
        );
    }
}
